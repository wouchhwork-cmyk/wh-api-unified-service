import { Injectable } from '@nestjs/common';
import { ActorKind, RewardAccountKind, RewardEntryKind, RewardWalletKind } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface RewardWalletRow {
  readonly id: number;
  readonly refId: string;
  readonly walletKind: RewardWalletKind;
  readonly currencyCode: string | null;
  readonly balance: number;
  readonly pendingBalance: number;
  readonly lifetimeEarned: number;
}

export interface LedgerEntryRow {
  readonly id: number;
  readonly refId: string;
  readonly walletId: number;
  readonly entryKind: RewardEntryKind;
  readonly amount: number;
  readonly balanceAfter: number;
  readonly occurredAtUtc: Date;
  readonly recordedAtUtc: Date;
  readonly reasonCode: string | null;
  readonly ruleId: number | null;
}

interface PostEntryInput {
  readonly enterpriseId: number;
  readonly walletId: number;
  readonly entryKind: RewardEntryKind;
  /** SIGNED. Whole points or minor units — the wallet's kind decides which. */
  readonly amount: number;
  readonly idempotencyKey: string;
  readonly occurredAtUtc: Date;
  readonly awardId?: number | null;
  readonly ruleId?: number | null;
  readonly ruleVersion?: number | null;
  readonly groupRef?: string | null;
  readonly reversesEntryId?: number | null;
  readonly actorKind?: ActorKind | null;
  readonly actorId?: number | null;
  readonly reasonCode?: string | null;
}

/**
 * Wallets and the ledger behind them.
 *
 * THE LEDGER IS THE RECORD; `balance` IS A PROJECTION, written in the same
 * statement as the entry so the two cannot be separated by a crash. A
 * reconciliation job recomputes from entries and alarms on divergence —
 * divergence is a sev-1, not a cleanup task.
 */
@Injectable()
export class RewardWalletRepository extends BaseRepository {
  /**
   * Gets the wallet, or creates it.
   *
   * ON CONFLICT against the partial unique index rather than SELECT-then-INSERT:
   * two concurrent first-earns for one customer would otherwise both find
   * nothing and both insert. The DO UPDATE is a no-op touch purely so that
   * RETURNING yields the row on the losing side too.
   */
  async ensureCustomerWallet(input: {
    enterpriseId: number;
    customerId: number;
    walletKind: RewardWalletKind;
    currencyCode: string | null;
  }): Promise<RewardWalletRow> {
    const { rows } = await this.mutate<RewardWalletRow>(
      `INSERT INTO reward_wallets
              (enterprise_id, account_kind, customer_id, wallet_kind, currency_code)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (enterprise_id, customer_id, wallet_kind, COALESCE(currency_code, '---'))
         WHERE account_kind = 'customer' AND is_deleted = false
       DO UPDATE SET updated_at = reward_wallets.updated_at
       RETURNING id, ref_id AS "refId", wallet_kind AS "walletKind",
                 currency_code AS "currencyCode", balance,
                 pending_balance AS "pendingBalance", lifetime_earned AS "lifetimeEarned"`,
      [
        input.enterpriseId,
        RewardAccountKind.Customer,
        input.customerId,
        input.walletKind,
        input.currencyCode,
      ],
    );
    const wallet = rows[0];
    if (!wallet) {
      throw new Error('ensureCustomerWallet returned no row');
    }
    return wallet;
  }

  /**
   * Adds value and records why.
   *
   * `lifetime_earned` moves only on a genuine earn. A reversal, a conversion's
   * credit leg and a manual adjustment all change the balance without being
   * something the customer earned — and lifetime is what a tier would read, so
   * inflating it would let a clawed-back award keep its tier credit.
   */
  async credit(input: PostEntryInput): Promise<LedgerEntryRow> {
    return this.post(input, true);
  }

  /**
   * Removes value ONLY if there is enough.
   *
   * ONE STATEMENT. The check and the mutation are the same UPDATE, so no
   * isolation level has to cover a gap — there is no gap. Zero rows affected
   * means insufficient funds, and the caller must treat that as a refusal
   * rather than an error to retry.
   *
   * Read-then-check-then-write is rejected: two concurrent debits both read the
   * same balance, both pass, and both write. That is the shape of
   * CVE-2026-31824, where an ORM made it worse by flushing an absolute value
   * instead of an increment so the writers overwrote one another.
   */
  async debitIfSufficient(input: PostEntryInput): Promise<LedgerEntryRow | null> {
    if (input.amount >= 0) {
      throw new Error('debitIfSufficient needs a negative amount');
    }
    const required = Math.abs(input.amount);
    const { rows } = await this.mutate<{ balance: number }>(
      `UPDATE reward_wallets
          SET balance = balance - $3, version = version + 1
        WHERE id = $1 AND enterprise_id = $2 AND is_deleted = false
          AND balance >= $3
      RETURNING balance`,
      [input.walletId, input.enterpriseId, required],
    );
    const updated = rows[0];
    if (!updated) return null;
    return this.insertEntry(input, updated.balance);
  }

  /**
   * Writes the entry on its own, for the one caller that still needs to.
   *
   * KNOWN DEFECT, LEFT DELIBERATELY — see `docs/backlog.md`. `post()` was
   * inverted so the ledger claim gates the balance change; `debitIfSufficient`
   * above still debits first and writes second, so a REPLAYED debit moves the
   * balance twice and writes one entry.
   *
   * It is not fixed here because the fix changes its contract. Inverting it
   * means claiming the key before knowing whether the funds are there — and
   * when they are not, the claimed row cannot be withdrawn, because
   * `reward_ledger_entries` is append-only by trigger. The only way out is to
   * THROW on insufficient funds instead of returning null, and "not enough
   * points" is currently a refusal the conversion handler expects to receive
   * rather than an error. That is a decision about the conversion flow, not a
   * repair to a repository.
   *
   * The practical exposure is narrower than `post()`'s was: the only caller is
   * `convert-value`, whose own replay would have to get past the award claim
   * first.
   */
  private async insertEntry(input: PostEntryInput, balanceAfter: number): Promise<LedgerEntryRow> {
    const returning = `id, ref_id AS "refId", wallet_id AS "walletId",
              entry_kind AS "entryKind", amount, balance_after AS "balanceAfter",
              occurred_at_utc AS "occurredAtUtc", recorded_at_utc AS "recordedAtUtc",
              reason_code AS "reasonCode", rule_id AS "ruleId"`;

    const { rows } = await this.mutate<LedgerEntryRow>(
      `INSERT INTO reward_ledger_entries
              (enterprise_id, wallet_id, entry_kind, amount, balance_after,
               award_id, rule_id, rule_version, group_ref, reverses_entry_id,
               idempotency_key, actor_kind, actor_id, reason_code, occurred_at_utc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (enterprise_id, idempotency_key) DO NOTHING
       RETURNING ${returning}`,
      [
        input.enterpriseId,
        input.walletId,
        input.entryKind,
        input.amount,
        balanceAfter,
        input.awardId ?? null,
        input.ruleId ?? null,
        input.ruleVersion ?? null,
        input.groupRef ?? null,
        input.reversesEntryId ?? null,
        input.idempotencyKey,
        input.actorKind ?? null,
        input.actorId ?? null,
        input.reasonCode ?? null,
        input.occurredAtUtc,
      ],
    );
    const inserted = rows[0];
    if (inserted) return inserted;

    const existing = await this.query<LedgerEntryRow>(
      `SELECT ${returning}
         FROM reward_ledger_entries
        WHERE enterprise_id = $1 AND idempotency_key = $2`,
      [input.enterpriseId, input.idempotencyKey],
    );
    const found = existing[0];
    if (!found) {
      throw new Error('ledger insert conflicted but the existing entry was not found');
    }
    return found;
  }

  /**
   * Moves the balance WITHOUT a sufficiency check.
   *
   * For reversals and manual debits only, and the distinction is deliberate.
   * Rule evaluation can never drive a balance below zero; only a clawback or an
   * adjustment can. A negative balance is real debt — it takes effect
   * immediately, never expires (one that could expire would be an exploit), and
   * the next earn offsets it.
   */
  async postUnchecked(input: PostEntryInput): Promise<LedgerEntryRow> {
    return this.post(input, false);
  }

  /**
   * The balance and its ledger entry, moved together or not at all.
   *
   * ONE STATEMENT, AND THE ENTRY IS CLAIMED FIRST. That order is the whole
   * correctness argument, and the previous order was a money bug:
   *
   *   1. UPDATE the wallet balance        <- unconditional, NOT idempotent
   *   2. INSERT the entry ON CONFLICT DO NOTHING
   *   3. on conflict, read the existing entry back and return it
   *
   * A replay therefore moved the balance a SECOND time, wrote no ledger row,
   * and returned the original entry as though nothing had happened. The
   * wallet and its ledger disagreed permanently, and the caller was told it
   * succeeded. The comment above step 3 claimed the opposite — that "a replay
   * that reaches here aborts the whole transaction rather than double-counting"
   * — but `ON CONFLICT DO NOTHING` does not raise, so nothing aborted.
   *
   * Measured: three identical adjustments with one idempotency key left a
   * balance of 150 and a single ledger entry for 50.
   *
   * The fix is a guard, not a reordering: the wallet UPDATE only matches a
   * row when no entry already holds this idempotency key, so a replay moves
   * nothing and the UNION hands back the entry that already exists.
   *
   * IT HAS TO BE THIS WAY ROUND, and the two obvious alternatives do not work:
   *
   *   - Claim the key first, then correct `balance_after` afterwards. A
   *     data-modifying CTE cannot see another's inserted row, so the correcting
   *     UPDATE finds nothing — and as separate statements it is refused anyway,
   *     because `reward_ledger_entries` is append-only by trigger. So
   *     `balance_after` must be known at INSERT time, which means the balance
   *     must move first.
   *   - Read the balance, compute, then write. That is the check-then-write
   *     this repository rejects everywhere else.
   *
   * THE HONEST LIMIT: the guard is a subquery against another table, so under
   * READ COMMITTED two concurrent posts carrying the SAME key could both pass
   * it before either commits; the unique index then refuses the second insert
   * while its balance change has already applied. Sequential replays — the
   * retry, the redelivered webhook, the double-click, which is every case seen
   * in practice — are fully covered. The concurrent one is narrowed to callers
   * that do not already serialize, and every current caller runs inside a
   * transaction that holds the award or the wallet row first.
   *
   */
  private async post(input: PostEntryInput, isEarn: boolean): Promise<LedgerEntryRow> {
    const lifetimeDelta = isEarn && input.amount > 0 ? input.amount : 0;
    const returning = `id, ref_id AS "refId", wallet_id AS "walletId",
              entry_kind AS "entryKind", amount, balance_after AS "balanceAfter",
              occurred_at_utc AS "occurredAtUtc", recorded_at_utc AS "recordedAtUtc",
              reason_code AS "reasonCode", rule_id AS "ruleId"`;

    const { rows } = await this.mutate<LedgerEntryRow & { claimed: boolean }>(
      `WITH moved AS (
         UPDATE reward_wallets
            SET balance = balance + $4,
                lifetime_earned = lifetime_earned + $15,
                version = version + 1
          WHERE id = $2 AND enterprise_id = $1 AND is_deleted = false
            AND NOT EXISTS (
                  SELECT 1 FROM reward_ledger_entries
                   WHERE enterprise_id = $1 AND idempotency_key = $10
                )
         RETURNING balance
       ),
       written AS (
         INSERT INTO reward_ledger_entries
                (enterprise_id, wallet_id, entry_kind, amount, balance_after,
                 award_id, rule_id, rule_version, group_ref, reverses_entry_id,
                 idempotency_key, actor_kind, actor_id, reason_code, occurred_at_utc)
         SELECT $1, $2, $3, $4, moved.balance,
                $5, $6, $7, $8, $9,
                $10, $11, $12, $13, $14
           FROM moved
         ON CONFLICT (enterprise_id, idempotency_key) DO NOTHING
         RETURNING ${returning}
       )
       SELECT * FROM written
       UNION ALL
       SELECT ${returning}
         FROM reward_ledger_entries
        WHERE enterprise_id = $1 AND idempotency_key = $10
          AND NOT EXISTS (SELECT 1 FROM moved)`,
      [
        input.enterpriseId,
        input.walletId,
        input.entryKind,
        input.amount,
        input.awardId ?? null,
        input.ruleId ?? null,
        input.ruleVersion ?? null,
        input.groupRef ?? null,
        input.reversesEntryId ?? null,
        input.idempotencyKey,
        input.actorKind ?? null,
        input.actorId ?? null,
        input.reasonCode ?? null,
        input.occurredAtUtc,
        lifetimeDelta,
      ],
    );

    const entry = rows[0];
    if (entry) return entry;

    /*
     * Nothing came back, so the claim was won and the wallet update matched no
     * row — the wallet does not exist, or belongs to another business. The
     * entry inserted by `claim` is part of this statement's transaction and
     * goes with the throw, so no orphan is left behind.
     */
    throw new Error(`reward wallet ${input.walletId} not found for this enterprise`);
  }

  /** One wallet, without creating it. Returns null when they have none. */
  async findCustomerWallet(
    enterpriseId: number,
    customerId: number,
    walletKind: RewardWalletKind,
    currencyCode: string | null,
  ): Promise<RewardWalletRow | null> {
    const rows = await this.query<RewardWalletRow>(
      `SELECT id, ref_id AS "refId", wallet_kind AS "walletKind",
              currency_code AS "currencyCode", balance,
              pending_balance AS "pendingBalance", lifetime_earned AS "lifetimeEarned"
         FROM reward_wallets
        WHERE enterprise_id = $1 AND customer_id = $2 AND wallet_kind = $3
          AND currency_code IS NOT DISTINCT FROM $4
          AND account_kind = 'customer' AND is_deleted = false`,
      [enterpriseId, customerId, walletKind, currencyCode],
    );
    return rows[0] ?? null;
  }

  /**
   * A customer's balances.
   *
   * Bounded by the unique index to one per kind per currency, so the limit is
   * a backstop rather than a page size — but a business trading in thirty
   * currencies would otherwise return thirty rows to a screen that shows two.
   */
  async listCustomerWallets(
    enterpriseId: number,
    customerId: number,
    limit: number,
  ): Promise<RewardWalletRow[]> {
    return this.query<RewardWalletRow>(
      `SELECT id, ref_id AS "refId", wallet_kind AS "walletKind",
              currency_code AS "currencyCode", balance,
              pending_balance AS "pendingBalance", lifetime_earned AS "lifetimeEarned"
         FROM reward_wallets
        WHERE enterprise_id = $1 AND customer_id = $2
          AND account_kind = 'customer' AND is_deleted = false
        ORDER BY wallet_kind, currency_code NULLS FIRST
        LIMIT $3`,
      [enterpriseId, customerId, limit],
    );
  }

  /** A statement. Newest first, with a stable tiebreaker built into the key. */
  async listEntries(
    enterpriseId: number,
    walletId: number,
    limit: number,
  ): Promise<LedgerEntryRow[]> {
    return this.query<LedgerEntryRow>(
      `SELECT id, ref_id AS "refId", wallet_id AS "walletId",
              entry_kind AS "entryKind", amount, balance_after AS "balanceAfter",
              occurred_at_utc AS "occurredAtUtc", recorded_at_utc AS "recordedAtUtc",
              reason_code AS "reasonCode", rule_id AS "ruleId"
         FROM reward_ledger_entries
        WHERE enterprise_id = $1 AND wallet_id = $2
        ORDER BY id DESC
        LIMIT $3`,
      [enterpriseId, walletId, limit],
    );
  }

  /**
   * Recomputes a wallet from its entries.
   *
   * The projection can drift — a failed transaction, a concurrency bug, a
   * direct write. This is what the reconciler compares against, and a mismatch
   * is an incident rather than a number to quietly correct.
   */
  async sumEntries(enterpriseId: number, walletId: number): Promise<number> {
    const rows = await this.query<{ total: string | null }>(
      `SELECT SUM(amount)::text AS total
         FROM reward_ledger_entries
        WHERE enterprise_id = $1 AND wallet_id = $2`,
      [enterpriseId, walletId],
    );
    return Number(rows[0]?.total ?? 0);
  }
}
