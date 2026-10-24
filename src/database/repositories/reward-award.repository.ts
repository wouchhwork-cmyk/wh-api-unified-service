import { Injectable } from '@nestjs/common';
import {
  RewardAwardStatus,
  RewardBenefitKind,
  RewardBenefitStatus,
  RewardEntryKind,
  type RewardWalletKind,
} from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface RewardAwardRow {
  readonly id: number;
  readonly refId: string;
  readonly programId: number;
  readonly ruleId: number;
  readonly ruleVersion: number;
  readonly customerId: number;
  readonly status: RewardAwardStatus;
  readonly periodKey: string | null;
  readonly heldUntil: Date | null;
  readonly occurredAtUtc: Date;
  readonly reasonCode: string | null;
  readonly factorBasisPoints: number | null;
}

/**
 * A row from the cross-tenant grant sweep.
 *
 * The sweep is the ONE query here with no tenant predicate, because a worker
 * serves every business at once. That makes `enterpriseId` the most important
 * column it returns — every call made with this row scopes by it — so it is
 * declared rather than cast in at the call site.
 */
export interface DueRewardAwardRow extends RewardAwardRow {
  readonly enterpriseId: number;
}

export interface CreateAwardInput {
  readonly enterpriseId: number;
  readonly programId: number;
  readonly ruleId: number;
  readonly ruleVersion: number;
  readonly customerId: number;
  readonly channelId: number | null;
  readonly sourceRefKind: string;
  readonly sourceRefId: number;
  readonly status: RewardAwardStatus;
  readonly heldUntil: Date | null;
  readonly occurredAtUtc: Date;
}

@Injectable()
export class RewardAwardRepository extends BaseRepository {
  /**
   * Creates the award, or returns nothing because it already exists.
   *
   * EXACTLY-ONCE PER SOURCE EVENT. A redelivered webhook, a replayed backfill
   * and a retried job all conflict on reward_awards_source_uniq. Returning null
   * rather than throwing is the point: a duplicate is the NORMAL case under
   * at-least-once delivery, not an error.
   *
   * This sits BELOW inbound_events dedup rather than replacing it. That guards
   * the transport; this guards the grant — and one comment can reach the engine
   * through a webhook AND a sync backfill, which are two transport events
   * describing one fact.
   */
  async createIfAbsent(input: CreateAwardInput): Promise<RewardAwardRow | null> {
    const { rows } = await this.mutate<RewardAwardRow>(
      `INSERT INTO reward_awards
              (enterprise_id, program_id, rule_id, rule_version, customer_id,
               channel_id, source_ref_kind, source_ref_id, status, held_until,
               occurred_at_utc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (enterprise_id, rule_id, customer_id, source_ref_kind, source_ref_id)
         WHERE is_deleted = false
       DO NOTHING
       RETURNING id, ref_id AS "refId", program_id AS "programId", rule_id AS "ruleId",
                 rule_version AS "ruleVersion", customer_id AS "customerId", status,
                 period_key AS "periodKey", held_until AS "heldUntil",
                 occurred_at_utc AS "occurredAtUtc", reason_code AS "reasonCode",
                 factor_basis_points AS "factorBasisPoints"`,
      [
        input.enterpriseId,
        input.programId,
        input.ruleId,
        input.ruleVersion,
        input.customerId,
        input.channelId,
        input.sourceRefKind,
        input.sourceRefId,
        input.status,
        input.heldUntil,
        input.occurredAtUtc,
      ],
    );
    return rows[0] ?? null;
  }

  /**
   * Claims one slot in a capped period. THE FREQUENCY CAP, in one statement.
   *
   * The INSERT takes the slot when no row exists; the DO UPDATE takes the next
   * one only while `used < cap`. RETURNING yields nothing when the guard fails,
   * so ZERO ROWS MEANS CAPPED — there is no window between a check and a write
   * because there is no separate check.
   *
   * SELECT ... FOR UPDATE then count is rejected: it locks only rows that
   * already match, so it does not stop a concurrent INSERT. That is the flaw in
   * the published remediation for CVE-2026-31824, and in at least one vendor's
   * reference anti-fraud tutorial.
   *
   * `cap` is snapshotted on the row at first claim, so raising a rule's cap
   * cannot retroactively hand out slots inside a period already underway.
   */
  async claimCapSlot(input: {
    enterpriseId: number;
    programId: number;
    ruleId: number;
    customerId: number;
    periodKey: string;
    cap: number;
  }): Promise<boolean> {
    const { rows } = await this.mutate<{ used: number }>(
      `INSERT INTO reward_cap_counters
              (enterprise_id, program_id, rule_id, customer_id, period_key, used, cap)
       VALUES ($1, $2, $3, $4, $5, 1, $6)
       ON CONFLICT (enterprise_id, rule_id, customer_id, period_key)
       DO UPDATE SET used = reward_cap_counters.used + 1
             WHERE reward_cap_counters.used < reward_cap_counters.cap
       RETURNING used`,
      [
        input.enterpriseId,
        input.programId,
        input.ruleId,
        input.customerId,
        input.periodKey,
        input.cap,
      ],
    );
    return rows.length > 0;
  }

  /**
   * Hands a claimed slot back.
   *
   * GREATEST(used - 1, 0) rather than a bare decrement: a double release must
   * not drive the counter negative and hand out a free slot. Used when an award
   * is reversed, and when a zero factor means the customer did not actually
   * earn — they should not lose their once-a-week slot to a benefit worth
   * nothing.
   */
  async releaseCapSlot(input: {
    enterpriseId: number;
    ruleId: number;
    customerId: number;
    periodKey: string;
  }): Promise<void> {
    await this.mutate(
      `UPDATE reward_cap_counters
          SET used = GREATEST(used - 1, 0)
        WHERE enterprise_id = $1 AND rule_id = $2
          AND customer_id = $3 AND period_key = $4`,
      [input.enterpriseId, input.ruleId, input.customerId, input.periodKey],
    );
  }

  /** Records why nothing was granted. A skipped award is still a row. */
  async markSkipped(input: {
    enterpriseId: number;
    awardId: number;
    status: RewardAwardStatus;
    reasonCode: string;
    periodKey: string | null;
  }): Promise<void> {
    await this.mutate(
      `UPDATE reward_awards
          SET status = $3, reason_code = $4, period_key = COALESCE($5, period_key)
        WHERE id = $1 AND enterprise_id = $2`,
      [input.awardId, input.enterpriseId, input.status, input.reasonCode, input.periodKey],
    );
  }

  async markGranted(input: {
    enterpriseId: number;
    awardId: number;
    factorBasisPoints: number | null;
    factorProviderCode: string | null;
    factorInputs: Record<string, unknown>;
    periodKey: string | null;
  }): Promise<void> {
    await this.mutate(
      `UPDATE reward_awards
          SET status = $3, granted_at = now(),
              factor_basis_points = $4, factor_provider_code = $5,
              factor_inputs = $6::jsonb, factor_computed_at = now(),
              period_key = COALESCE($7, period_key)
        WHERE id = $1 AND enterprise_id = $2`,
      [
        input.awardId,
        input.enterpriseId,
        RewardAwardStatus.Granted,
        input.factorBasisPoints,
        input.factorProviderCode,
        JSON.stringify(input.factorInputs),
        input.periodKey,
      ],
    );
  }

  async markReversed(input: {
    enterpriseId: number;
    awardId: number;
    reasonCode: string;
  }): Promise<void> {
    await this.mutate(
      `UPDATE reward_awards
          SET status = $3, reversed_at = now(), reason_code = $4
        WHERE id = $1 AND enterprise_id = $2`,
      [input.awardId, input.enterpriseId, RewardAwardStatus.Reversed, input.reasonCode],
    );
  }

  /**
   * Takes this award, or reports that somebody else has it.
   *
   * Called INSIDE the per-award transaction, because a lock taken outside one
   * is released before the work starts. SKIP LOCKED means a second worker gets
   * nothing rather than waiting, and the status re-check closes the window
   * between the sweep listing the award and this lock being taken.
   *
   * Without it the sweep leans on the benefit idempotency index to stop a
   * double grant: the second worker would do the work, fail on the unique
   * index, roll back, and log an error on every tick. Correct by accident is
   * not the same as correct.
   */
  async lockHeldAward(enterpriseId: number, awardId: number): Promise<boolean> {
    const rows = await this.query<{ id: number }>(
      `SELECT id FROM reward_awards
        WHERE id = $1 AND enterprise_id = $2
          AND status = $3 AND is_deleted = false
        FOR UPDATE SKIP LOCKED`,
      [awardId, enterpriseId, RewardAwardStatus.Held],
    );
    return rows.length > 0;
  }

  /** The grant sweep: held awards whose hold has elapsed. */
  async claimDueHeldAwards(limit: number): Promise<DueRewardAwardRow[]> {
    return this.query<DueRewardAwardRow>(
      `SELECT id, ref_id AS "refId", program_id AS "programId", rule_id AS "ruleId",
              rule_version AS "ruleVersion", customer_id AS "customerId", status,
              period_key AS "periodKey", held_until AS "heldUntil",
              occurred_at_utc AS "occurredAtUtc", reason_code AS "reasonCode",
              factor_basis_points AS "factorBasisPoints", enterprise_id AS "enterpriseId"
         FROM reward_awards
        WHERE status = $1 AND is_deleted = false
          AND held_until IS NOT NULL AND held_until <= now()
        ORDER BY held_until
        LIMIT $2`,
      [RewardAwardStatus.Held, limit],
    );
  }

  /** The award for a piece of content, so a deletion can reverse it. */
  async findBySource(input: {
    enterpriseId: number;
    sourceRefKind: string;
    sourceRefId: number;
  }): Promise<RewardAwardRow[]> {
    return this.query<RewardAwardRow>(
      `SELECT id, ref_id AS "refId", program_id AS "programId", rule_id AS "ruleId",
              rule_version AS "ruleVersion", customer_id AS "customerId", status,
              period_key AS "periodKey", held_until AS "heldUntil",
              occurred_at_utc AS "occurredAtUtc", reason_code AS "reasonCode",
              factor_basis_points AS "factorBasisPoints"
         FROM reward_awards
        WHERE enterprise_id = $1 AND source_ref_kind = $2 AND source_ref_id = $3
          AND is_deleted = false`,
      [input.enterpriseId, input.sourceRefKind, input.sourceRefId],
    );
  }

  /**
   * A customer's award history, INCLUDING the ones that granted nothing.
   *
   * Skipped awards are the point: "why didn't I get my points?" is answered by
   * a row saying skipped_cap with its period key, rather than by an absence
   * somebody has to investigate.
   */
  async listForCustomer(
    enterpriseId: number,
    customerId: number,
    limit: number,
  ): Promise<RewardAwardRow[]> {
    return this.query<RewardAwardRow>(
      `SELECT id, ref_id AS "refId", program_id AS "programId", rule_id AS "ruleId",
              rule_version AS "ruleVersion", customer_id AS "customerId", status,
              period_key AS "periodKey", held_until AS "heldUntil",
              occurred_at_utc AS "occurredAtUtc", reason_code AS "reasonCode",
              factor_basis_points AS "factorBasisPoints"
         FROM reward_awards
        WHERE enterprise_id = $1 AND customer_id = $2 AND is_deleted = false
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [enterpriseId, customerId, limit],
    );
  }

  /**
   * What every program has done, in ONE query.
   *
   * Grouped by program rather than fetched per program: a page showing fifty
   * programs was issuing a hundred and one queries, which is the N+1 the house
   * rules forbid outright.
   */
  async activityByProgram(
    enterpriseId: number,
  ): Promise<
    { programId: number; status: RewardAwardStatus; awards: number; customers: number }[]
  > {
    return this.query(
      `SELECT program_id AS "programId",
              status,
              COUNT(*)::int AS awards,
              COUNT(DISTINCT customer_id)::int AS customers
         FROM reward_awards
        WHERE enterprise_id = $1 AND is_deleted = false
        GROUP BY program_id, status
        ORDER BY program_id, status`,
      [enterpriseId],
    );
  }

  /**
   * Net value every program put into customers' hands.
   *
   * ALSO ONE QUERY, for the same reason.
   *
   * TWO ENTRY KINDS ARE EXCLUDED, and the exclusions are the point:
   *
   *   - `convert_out` is the customer SPENDING their own points, not the
   *     program taking them away. Including it made a program whose rule
   *     converts points report a negative points figure — points it never
   *     granted — while the program that originally granted them looked
   *     untouched. Two programs, one customer, and a number that reads like a
   *     bug in both.
   *   - `adjust` is a human moving value by hand. It is a real movement and it
   *     belongs in the audit trail and on the ledger, but attributing it to a
   *     program's performance would credit a rule for a support gesture.
   *
   * `reversal` IS included, so the figure is net: a clawed-back award stops
   * counting. A gross number would tell a business it spent money it got back.
   *
   * `net` comes back as a STRING. int8 exceeds what a JS number holds safely,
   * so the driver hands back text and the caller converts deliberately rather
   * than being handed a silently-rounded figure.
   */
  async valueByProgram(enterpriseId: number): Promise<
    {
      programId: number;
      walletKind: RewardWalletKind;
      currencyCode: string | null;
      net: string;
    }[]
  > {
    return this.query(
      `SELECT a.program_id AS "programId",
              w.wallet_kind AS "walletKind",
              w.currency_code AS "currencyCode",
              COALESCE(SUM(l.amount), 0)::text AS net
         FROM reward_ledger_entries l
         JOIN reward_awards a
           ON a.id = l.award_id AND a.enterprise_id = l.enterprise_id
         JOIN reward_wallets w
           ON w.id = l.wallet_id AND w.enterprise_id = l.enterprise_id
        WHERE l.enterprise_id = $1
          AND a.is_deleted = false
          AND l.entry_kind NOT IN ($2, $3)
        GROUP BY a.program_id, w.wallet_kind, w.currency_code
        ORDER BY a.program_id, w.wallet_kind, w.currency_code NULLS FIRST`,
      [enterpriseId, RewardEntryKind.ConvertOut, RewardEntryKind.Adjust],
    );
  }

  /* ---------------------------------------------------------------------
   * Applied benefits — what the award actually did, and how to undo it
   * ------------------------------------------------------------------ */

  async recordBenefit(input: {
    enterpriseId: number;
    awardId: number;
    benefitIndex: number;
    benefitKind: RewardBenefitKind;
    payload: Record<string, unknown>;
    compensation: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<number> {
    const { rows } = await this.mutate<{ id: number }>(
      `INSERT INTO reward_award_benefits
              (enterprise_id, award_id, benefit_index, benefit_kind,
               payload, status, compensation, idempotency_key, applied_at_utc)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, now())
       RETURNING id`,
      [
        input.enterpriseId,
        input.awardId,
        input.benefitIndex,
        input.benefitKind,
        JSON.stringify(input.payload),
        RewardBenefitStatus.Applied,
        JSON.stringify(input.compensation),
        input.idempotencyKey,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('recordBenefit returned no row');
    return row.id;
  }

  async listAppliedBenefits(
    enterpriseId: number,
    awardId: number,
  ): Promise<
    {
      id: number;
      benefitIndex: number;
      benefitKind: RewardBenefitKind;
      payload: Record<string, unknown>;
      compensation: Record<string, unknown>;
      status: RewardBenefitStatus;
    }[]
  > {
    return this.query(
      `SELECT id, benefit_index AS "benefitIndex", benefit_kind AS "benefitKind",
              payload, compensation, status
         FROM reward_award_benefits
        WHERE enterprise_id = $1 AND award_id = $2 AND is_deleted = false
        ORDER BY benefit_index`,
      [enterpriseId, awardId],
    );
  }

  async markBenefitCompensated(enterpriseId: number, benefitId: number): Promise<void> {
    await this.mutate(
      `UPDATE reward_award_benefits
          SET status = $3, compensated_at_utc = now()
        WHERE id = $1 AND enterprise_id = $2`,
      [benefitId, enterpriseId, RewardBenefitStatus.Compensated],
    );
  }
}
