import type { MigrationInterface, QueryRunner } from 'typeorm';
import { applyRewardObjects } from '../schema/reward-objects';

/**
 * Reward programs — ten tables. Design: docs/reward-programs-design.md.
 *
 * A social event matches a rule; the rule declares N benefits; a dispatcher
 * applies them all-or-nothing; value lands in an append-only ledger.
 *
 * THIS IS A PURE ADD. No existing table is altered, so there is nothing to
 * deploy in two steps and nothing to dual-write. The rollback is a DROP of
 * tables nothing else references.
 *
 * Three tables that are deliberately ABSENT, because the machinery already
 * exists:
 *
 *   - no forward outbox. `outbound_events` already carries destination_kind
 *     'webhook', the pending→leased→sent→dead_letter status machine, lease
 *     columns, jittered backoff and dead-lettering, and OutboundEventType
 *     already has VerificationSend as precedent for a non-Meta sender. A second
 *     outbox would have meant a second poller, a second lease reaper entry and
 *     a second copy of the backoff curve to keep in sync with the first.
 *   - no conversion-rules table. "When points reach 30, burn 30 and grant ₹50"
 *     is a trigger plus a benefit, so it is a RULE — which also makes "convert
 *     at most once a day" an ordinary cap_scope.
 *   - no schedule-windows table. "Is this inside the window?" is a predicate on
 *     the event, exactly like "does this comment contain a keyword", so it is a
 *     condition. As a table it could not express a per-rule happy hour without
 *     a whole second program.
 *
 * The indexes, foreign keys, CHECK constraints and triggers live in
 * schema/reward-objects.ts so that this migration and `pnpm db:sync` apply ONE
 * definition. schema-parity.spec.ts proves they agree.
 */
export class RewardPrograms1758600000000 implements MigrationInterface {
  name = 'RewardPrograms1758600000000';

  public async up(q: QueryRunner): Promise<void> {
    const run = async (sql: string): Promise<void> => {
      await q.query(sql);
    };

    // --- 1. reward_programs -------------------------------------------------
    // `status` is the switch, not the schedule. A program scheduled for next
    // month is `active` with a future starts_at; there is no 'scheduled' value
    // because the date already says it, and no 'ended' because ends_at does.
    await q.query(`
      CREATE TABLE reward_programs (
        id                     BIGSERIAL     PRIMARY KEY,
        ref_id                 UUID          NOT NULL DEFAULT gen_random_uuid(),
        enterprise_id          BIGINT        NOT NULL,
        name                   VARCHAR(120)  NOT NULL,
        status                 VARCHAR(16)   NOT NULL DEFAULT 'draft',
        timezone               VARCHAR(64)   NOT NULL,
        default_currency_code  CHAR(3),
        budget_minor           BIGINT,
        budget_currency_code   CHAR(3),
        spent_minor            BIGINT        NOT NULL DEFAULT 0,
        starts_at              TIMESTAMPTZ,
        ends_at                TIMESTAMPTZ,
        forward_provider_code  VARCHAR(40),
        forward_config         JSONB         NOT NULL DEFAULT '{}',
        is_deleted             BOOLEAN       NOT NULL DEFAULT false,
        created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 2. reward_rules ----------------------------------------------------
    // Versioned, never edited in place: an award stores the version that
    // decided it, so an edit cannot rewrite the explanation of awards already
    // granted. No reward columns here — see reward_rule_benefits.
    await q.query(`
      CREATE TABLE reward_rules (
        id                     BIGSERIAL     PRIMARY KEY,
        ref_id                 UUID          NOT NULL DEFAULT gen_random_uuid(),
        enterprise_id          BIGINT        NOT NULL,
        program_id             BIGINT        NOT NULL,
        version                INTEGER       NOT NULL DEFAULT 1,
        supersedes_rule_id     BIGINT,
        trigger_kind           VARCHAR(40)   NOT NULL,
        trigger_config         JSONB         NOT NULL DEFAULT '{}',
        factor_provider_code   VARCHAR(40)   NOT NULL DEFAULT 'constant_one',
        cap_scope              VARCHAR(10)   NOT NULL DEFAULT 'none',
        cap_count              INTEGER       NOT NULL DEFAULT 1,
        hold_hours             INTEGER       NOT NULL DEFAULT 0,
        reversal_policy        VARCHAR(20)   NOT NULL DEFAULT 'none',
        priority               INTEGER       NOT NULL DEFAULT 0,
        is_active              BOOLEAN       NOT NULL DEFAULT true,
        is_deleted             BOOLEAN       NOT NULL DEFAULT false,
        created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 3. reward_rule_benefits --------------------------------------------
    // award_mode is PER BENEFIT because scalability is a property of the kind:
    // 0.6 x 20 points means something, 0.6 of a free coffee does not.
    await q.query(`
      CREATE TABLE reward_rule_benefits (
        id                      BIGSERIAL     PRIMARY KEY,
        enterprise_id           BIGINT        NOT NULL,
        rule_id                 BIGINT        NOT NULL,
        rule_version            INTEGER       NOT NULL,
        benefit_index           SMALLINT      NOT NULL,
        benefit_kind            VARCHAR(32)   NOT NULL,
        benefit_schema_version  SMALLINT      NOT NULL DEFAULT 1,
        award_mode              VARCHAR(10)   NOT NULL DEFAULT 'fixed',
        award_cap               INTEGER,
        budget_cost_minor       BIGINT        NOT NULL DEFAULT 0,
        config                  JSONB         NOT NULL DEFAULT '{}',
        is_deleted              BOOLEAN       NOT NULL DEFAULT false,
        created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at              TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 4. reward_rule_conditions ------------------------------------------
    // Flat AND list. An EMPTY list means ALWAYS, never "never" — the opposite
    // would silently disable every rule nobody configured.
    await q.query(`
      CREATE TABLE reward_rule_conditions (
        id                        BIGSERIAL     PRIMARY KEY,
        enterprise_id             BIGINT        NOT NULL,
        rule_id                   BIGINT        NOT NULL,
        rule_version              INTEGER       NOT NULL,
        condition_index           SMALLINT      NOT NULL,
        condition_kind            VARCHAR(32)   NOT NULL,
        condition_schema_version  SMALLINT      NOT NULL DEFAULT 1,
        config                    JSONB         NOT NULL DEFAULT '{}',
        is_deleted                BOOLEAN       NOT NULL DEFAULT false,
        created_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at                TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 5. reward_cap_counters ---------------------------------------------
    // The unique index IS the frequency cap, and it carries NO is_deleted
    // predicate — the same category as an idempotency key, which must collide
    // even against a row somebody tried to retire. `is_deleted` exists only for
    // repository-pattern uniformity, as it does on audit_logs; setting it
    // frees nothing, which is the intended behaviour.
    await q.query(`
      CREATE TABLE reward_cap_counters (
        id              BIGSERIAL     PRIMARY KEY,
        enterprise_id   BIGINT        NOT NULL,
        program_id      BIGINT        NOT NULL,
        rule_id         BIGINT        NOT NULL,
        customer_id     BIGINT        NOT NULL,
        period_key      TEXT          NOT NULL,
        used            INTEGER       NOT NULL DEFAULT 0,
        cap             INTEGER       NOT NULL,
        is_deleted      BOOLEAN       NOT NULL DEFAULT false,
        created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 6. reward_awards ---------------------------------------------------
    // No totals: an award holding a INR benefit and a USD benefit cannot be one
    // amount_minor with one currency_code. Value is never netted across
    // wallets, so the benefit rows are read.
    await q.query(`
      CREATE TABLE reward_awards (
        id                     BIGSERIAL     PRIMARY KEY,
        ref_id                 UUID          NOT NULL DEFAULT gen_random_uuid(),
        enterprise_id          BIGINT        NOT NULL,
        program_id             BIGINT        NOT NULL,
        rule_id                BIGINT        NOT NULL,
        rule_version           INTEGER       NOT NULL,
        customer_id            BIGINT        NOT NULL,
        channel_id             BIGINT,
        source_ref_kind        VARCHAR(20)   NOT NULL,
        source_ref_id          BIGINT        NOT NULL,
        status                 VARCHAR(24)   NOT NULL DEFAULT 'held',
        factor_basis_points    INTEGER,
        factor_provider_code   VARCHAR(40),
        factor_inputs          JSONB         NOT NULL DEFAULT '{}',
        factor_computed_at     TIMESTAMPTZ,
        period_key             TEXT,
        held_until             TIMESTAMPTZ,
        granted_at             TIMESTAMPTZ,
        reversed_at            TIMESTAMPTZ,
        reason_code            VARCHAR(60),
        occurred_at_utc        TIMESTAMPTZ   NOT NULL,
        is_deleted             BOOLEAN       NOT NULL DEFAULT false,
        created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 7. reward_award_benefits -------------------------------------------
    // `compensation` holds what the handler PRODUCED. A compensator that
    // re-derives from the rule produces a wrong reversal the moment the rule is
    // edited between apply and compensate.
    await q.query(`
      CREATE TABLE reward_award_benefits (
        id                      BIGSERIAL     PRIMARY KEY,
        enterprise_id           BIGINT        NOT NULL,
        award_id                BIGINT        NOT NULL,
        benefit_index           SMALLINT      NOT NULL,
        benefit_kind            VARCHAR(32)   NOT NULL,
        payload                 JSONB         NOT NULL DEFAULT '{}',
        status                  VARCHAR(16)   NOT NULL DEFAULT 'applied',
        compensation            JSONB         NOT NULL DEFAULT '{}',
        compensates_benefit_id  BIGINT,
        idempotency_key         TEXT          NOT NULL,
        applied_at_utc          TIMESTAMPTZ,
        compensated_at_utc      TIMESTAMPTZ,
        is_deleted              BOOLEAN       NOT NULL DEFAULT false,
        created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at              TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 8. reward_wallets --------------------------------------------------
    // One balance per kind per currency. A customer holds several at once;
    // `balance` is a projection of the ledger written in the same transaction.
    await q.query(`
      CREATE TABLE reward_wallets (
        id                      BIGSERIAL     PRIMARY KEY,
        ref_id                  UUID          NOT NULL DEFAULT gen_random_uuid(),
        enterprise_id           BIGINT        NOT NULL,
        account_kind            VARCHAR(20)   NOT NULL DEFAULT 'customer',
        customer_id             BIGINT,
        destination_program_id  BIGINT,
        wallet_kind             VARCHAR(16)   NOT NULL,
        currency_code           CHAR(3),
        balance                 BIGINT        NOT NULL DEFAULT 0,
        pending_balance         BIGINT        NOT NULL DEFAULT 0,
        lifetime_earned         BIGINT        NOT NULL DEFAULT 0,
        version                 BIGINT        NOT NULL DEFAULT 0,
        is_deleted              BOOLEAN       NOT NULL DEFAULT false,
        created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at              TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 9. reward_ledger_entries -------------------------------------------
    // Append-only, enforced by a BEFORE UPDATE OR DELETE trigger below.
    //
    // `is_deleted` is present for repository-pattern uniformity, exactly as it
    // is on audit_logs — the shared entity base supplies it. Here it is also
    // UNREACHABLE: setting it would require an UPDATE, and the trigger refuses
    // every UPDATE. The column cannot become a second, quieter way to erase a
    // ledger row.
    await q.query(`
      CREATE TABLE reward_ledger_entries (
        id                 BIGSERIAL     PRIMARY KEY,
        ref_id             UUID          NOT NULL DEFAULT gen_random_uuid(),
        enterprise_id      BIGINT        NOT NULL,
        wallet_id          BIGINT        NOT NULL,
        entry_kind         VARCHAR(20)   NOT NULL,
        amount             BIGINT        NOT NULL,
        balance_after      BIGINT        NOT NULL,
        award_id           BIGINT,
        rule_id            BIGINT,
        rule_version       INTEGER,
        group_ref          UUID,
        reverses_entry_id  BIGINT,
        idempotency_key    TEXT          NOT NULL,
        actor_kind         VARCHAR(30),
        actor_id           BIGINT,
        reason_code        VARCHAR(60),
        occurred_at_utc    TIMESTAMPTZ   NOT NULL,
        recorded_at_utc    TIMESTAMPTZ   NOT NULL DEFAULT now(),
        is_deleted         BOOLEAN       NOT NULL DEFAULT false,
        created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 10. reward_entitlements --------------------------------------------
    // An issued right, not a balance. V1 writes these and nothing redeems them.
    await q.query(`
      CREATE TABLE reward_entitlements (
        id               BIGSERIAL     PRIMARY KEY,
        ref_id           UUID          NOT NULL DEFAULT gen_random_uuid(),
        enterprise_id    BIGINT        NOT NULL,
        customer_id      BIGINT        NOT NULL,
        award_id         BIGINT        NOT NULL,
        item_ref         VARCHAR(64)   NOT NULL,
        status           VARCHAR(16)   NOT NULL DEFAULT 'issued',
        redemption_code  VARCHAR(32)   NOT NULL,
        issued_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
        expires_at       TIMESTAMPTZ,
        reserved_until   TIMESTAMPTZ,
        redeemed_at      TIMESTAMPTZ,
        is_deleted       BOOLEAN       NOT NULL DEFAULT false,
        created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    await applyRewardObjects(run);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Child-first, so no FK blocks a drop. CASCADE is deliberately NOT used:
    // if something outside this set has grown a reference, the drop should
    // fail loudly rather than take that something with it.
    for (const table of [
      'reward_entitlements',
      'reward_ledger_entries',
      'reward_wallets',
      'reward_award_benefits',
      'reward_awards',
      'reward_cap_counters',
      'reward_rule_conditions',
      'reward_rule_benefits',
      'reward_rules',
      'reward_programs',
    ]) {
      await q.query(`DROP TABLE IF EXISTS ${table}`);
    }
    await q.query(`DROP FUNCTION IF EXISTS reward_ledger_is_append_only()`);
  }
}
