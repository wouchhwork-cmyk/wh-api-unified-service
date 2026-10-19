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

  private async post(input: PostEntryInput, isEarn: boolean): Promise<LedgerEntryRow> {
    const lifetimeDelta = isEarn && input.amount > 0 ? input.amount : 0;
    const { rows } = await this.mutate<{ balance: number }>(
      `UPDATE reward_wallets
          SET balance = balance + $3,
              lifetime_earned = lifetime_earned + $4,
              version = version + 1
        WHERE id = $1 AND enterprise_id = $2 AND is_deleted = false
      RETURNING balance`,
      [input.walletId, input.enterpriseId, input.amount, lifetimeDelta],
    );
    const updated = rows[0];
    if (!updated) {
      throw new Error(`reward wallet ${input.walletId} not found for this enterprise`);
    }
    return this.insertEntry(input, updated.balance);
  }

  /**
   * Writes the entry itself.
   *
   * ON CONFLICT DO NOTHING on the idempotency key, then a read-back: a retried
   * job must not write a second entry, and must still see the first. The
   * balance update above is NOT idempotent on its own, which is why every
   * caller runs inside the award transaction — a replay that reaches here
   * aborts the whole transaction rather than double-counting.
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

  /** A customer's balances. Several at once is the normal case, never netted. */
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
