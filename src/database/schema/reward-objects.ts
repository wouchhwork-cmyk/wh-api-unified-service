/**
 * Everything the reward schema needs that is NOT a CREATE TABLE.
 *
 * Same reason schema-objects.ts exists: TypeORM's synchroniser cannot express
 * partial unique indexes, composite foreign keys routed through enterprise_id,
 * CHECK constraints or triggers. So both paths into a database — the migration
 * (the authority for qa and prod) and `pnpm db:sync` (dev only) — call THIS,
 * and the parity test proves they agree.
 *
 * Order is not cosmetic: the (id, enterprise_id) parent keys must exist before
 * any composite FK can reference them.
 */

// Reuses the canonical runner type, so the migration path and the sync path
// cannot drift on the one thing they both call.
import type { SqlRunner } from './schema-objects';

/** Tables carrying a public handle. The numeric id is never sent to a client. */
export const REWARD_REF_ID_TABLES = [
  'reward_programs',
  'reward_rules',
  'reward_awards',
  'reward_wallets',
  'reward_ledger_entries',
  'reward_entitlements',
] as const;

/**
 * Every reward table, for the updated_at trigger loop.
 *
 * The four without a ref_id are reached through a parent and never addressed
 * alone: a rule is versioned, so editing it replaces its benefits and
 * conditions as a SET; an award benefit is read through its award; a cap
 * counter is read through the award that consumed it.
 */
export const REWARD_TABLES = [
  ...REWARD_REF_ID_TABLES,
  'reward_rule_benefits',
  'reward_rule_conditions',
  'reward_cap_counters',
  'reward_award_benefits',
] as const;

export async function applyRewardObjects(run: SqlRunner): Promise<void> {
  // =========================================================================
  // 1. Tenant-safety parent keys
  // =========================================================================
  // Every composite FK below routes through enterprise_id, so a child row
  // cannot name another tenant's parent even if a query forgets its predicate.
  // Isolation is structural, not a convention somebody has to remember.
  await run(
    `ALTER TABLE reward_programs ADD CONSTRAINT reward_programs_tenant_key UNIQUE (id, enterprise_id)`,
  );
  await run(
    `ALTER TABLE reward_rules ADD CONSTRAINT reward_rules_tenant_key UNIQUE (id, enterprise_id)`,
  );
  await run(
    `ALTER TABLE reward_awards ADD CONSTRAINT reward_awards_tenant_key UNIQUE (id, enterprise_id)`,
  );
  await run(
    `ALTER TABLE reward_wallets ADD CONSTRAINT reward_wallets_tenant_key UNIQUE (id, enterprise_id)`,
  );
  await run(
    `ALTER TABLE reward_ledger_entries ADD CONSTRAINT reward_ledger_entries_tenant_key UNIQUE (id, enterprise_id)`,
  );
  await run(
    `ALTER TABLE reward_award_benefits ADD CONSTRAINT reward_award_benefits_tenant_key UNIQUE (id, enterprise_id)`,
  );

  // =========================================================================
  // 2. ref_id — random, never reused, so a plain UNIQUE is correct
  // =========================================================================
  for (const table of REWARD_REF_ID_TABLES) {
    await run(`CREATE UNIQUE INDEX ${table}_ref_id_uniq ON ${table} (ref_id)`);
  }

  // =========================================================================
  // 3. The guarantees
  // =========================================================================

  // A program name is a reusable business identifier: deleting one frees it.
  await run(`
    CREATE UNIQUE INDEX reward_programs_name_uniq
      ON reward_programs (enterprise_id, lower(name))
      WHERE is_deleted = false
  `);

  // One row per rule VERSION. Editing a rule writes a new version; the old one
  // stays, because awards granted under it point at it.
  await run(`
    CREATE UNIQUE INDEX reward_rules_version_uniq
      ON reward_rules (enterprise_id, id, version)
  `);

  await run(`
    CREATE UNIQUE INDEX reward_rule_benefits_uniq
      ON reward_rule_benefits (enterprise_id, rule_id, rule_version, benefit_index)
      WHERE is_deleted = false
  `);

  await run(`
    CREATE UNIQUE INDEX reward_rule_conditions_uniq
      ON reward_rule_conditions (enterprise_id, rule_id, rule_version, condition_index)
      WHERE is_deleted = false
  `);

  // THE FREQUENCY CAP. No is_deleted predicate, deliberately: this index is in
  // the same category as an idempotency key, and must collide even against a
  // row somebody tried to retire.
  await run(`
    CREATE UNIQUE INDEX reward_cap_counters_uniq
      ON reward_cap_counters (enterprise_id, rule_id, customer_id, period_key)
  `);

  // EXACTLY-ONCE PER SOURCE EVENT. A redelivered webhook, a replayed backfill
  // and a retried job all conflict here and return the existing award. This
  // sits BELOW inbound_events dedup rather than replacing it: that protects the
  // transport, this protects the grant, and one comment can reach the engine
  // through a webhook AND a sync backfill.
  await run(`
    CREATE UNIQUE INDEX reward_awards_source_uniq
      ON reward_awards (enterprise_id, rule_id, customer_id, source_ref_kind, source_ref_id)
      WHERE is_deleted = false
  `);

  await run(`
    CREATE UNIQUE INDEX reward_award_benefits_idem_uniq
      ON reward_award_benefits (enterprise_id, idempotency_key)
  `);
  await run(`
    CREATE UNIQUE INDEX reward_award_benefits_slot_uniq
      ON reward_award_benefits (enterprise_id, award_id, benefit_index)
      WHERE is_deleted = false AND compensates_benefit_id IS NULL
  `);

  // One wallet per kind per currency. COALESCE because a NULL currency on the
  // points wallet would otherwise defeat uniqueness and let two coexist.
  await run(`
    CREATE UNIQUE INDEX reward_wallets_customer_uniq
      ON reward_wallets (enterprise_id, customer_id, wallet_kind, COALESCE(currency_code, '---'))
      WHERE account_kind = 'customer' AND is_deleted = false
  `);
  await run(`
    CREATE UNIQUE INDEX reward_wallets_system_uniq
      ON reward_wallets (enterprise_id, destination_program_id, account_kind, wallet_kind,
                         COALESCE(currency_code, '---'))
      WHERE account_kind <> 'customer' AND is_deleted = false
  `);

  await run(`
    CREATE UNIQUE INDEX reward_ledger_idem_uniq
      ON reward_ledger_entries (enterprise_id, idempotency_key)
  `);

  // ONE REVERSAL PER ENTRY, EVER. This is the second half of the compensation
  // rule: re-submitting the SAME compensation id is a no-op (the idempotency
  // index above), while a DIFFERENT compensation against an already-reversed
  // entry is an error. Swallowing the second as a duplicate would hide a
  // double reversal.
  await run(`
    CREATE UNIQUE INDEX reward_ledger_reversal_uniq
      ON reward_ledger_entries (enterprise_id, reverses_entry_id)
      WHERE reverses_entry_id IS NOT NULL
  `);

  await run(`
    CREATE UNIQUE INDEX reward_entitlements_code_uniq
      ON reward_entitlements (enterprise_id, redemption_code)
      WHERE is_deleted = false
  `);

  // =========================================================================
  // 4. Composite foreign keys — every one routed through enterprise_id
  // =========================================================================
  await run(`
    ALTER TABLE reward_programs
      ADD CONSTRAINT reward_programs_enterprise_fk
      FOREIGN KEY (enterprise_id) REFERENCES enterprises (id)
  `);
  await run(`
    ALTER TABLE reward_rules
      ADD CONSTRAINT reward_rules_program_fk
      FOREIGN KEY (program_id, enterprise_id) REFERENCES reward_programs (id, enterprise_id)
  `);
  await run(`
    ALTER TABLE reward_rule_benefits
      ADD CONSTRAINT reward_rule_benefits_rule_fk
      FOREIGN KEY (rule_id, enterprise_id) REFERENCES reward_rules (id, enterprise_id)
  `);
  await run(`
    ALTER TABLE reward_rule_conditions
      ADD CONSTRAINT reward_rule_conditions_rule_fk
      FOREIGN KEY (rule_id, enterprise_id) REFERENCES reward_rules (id, enterprise_id)
  `);
  await run(`
    ALTER TABLE reward_cap_counters
      ADD CONSTRAINT reward_cap_counters_rule_fk
      FOREIGN KEY (rule_id, enterprise_id) REFERENCES reward_rules (id, enterprise_id)
  `);
  await run(`
    ALTER TABLE reward_cap_counters
      ADD CONSTRAINT reward_cap_counters_customer_fk
      FOREIGN KEY (customer_id, enterprise_id) REFERENCES customers (id, enterprise_id)
  `);
  await run(`
    ALTER TABLE reward_awards
      ADD CONSTRAINT reward_awards_rule_fk
      FOREIGN KEY (rule_id, enterprise_id) REFERENCES reward_rules (id, enterprise_id)
  `);
  await run(`
    ALTER TABLE reward_awards
      ADD CONSTRAINT reward_awards_customer_fk
      FOREIGN KEY (customer_id, enterprise_id) REFERENCES customers (id, enterprise_id)
  `);
  await run(`
    ALTER TABLE reward_award_benefits
      ADD CONSTRAINT reward_award_benefits_award_fk
      FOREIGN KEY (award_id, enterprise_id) REFERENCES reward_awards (id, enterprise_id)
  `);
  await run(`
    ALTER TABLE reward_wallets
      ADD CONSTRAINT reward_wallets_customer_fk
      FOREIGN KEY (customer_id, enterprise_id) REFERENCES customers (id, enterprise_id)
  `);
  await run(`
    ALTER TABLE reward_ledger_entries
      ADD CONSTRAINT reward_ledger_entries_wallet_fk
      FOREIGN KEY (wallet_id, enterprise_id) REFERENCES reward_wallets (id, enterprise_id)
  `);
  await run(`
    ALTER TABLE reward_entitlements
      ADD CONSTRAINT reward_entitlements_award_fk
      FOREIGN KEY (award_id, enterprise_id) REFERENCES reward_awards (id, enterprise_id)
  `);
  await run(`
    ALTER TABLE reward_entitlements
      ADD CONSTRAINT reward_entitlements_customer_fk
      FOREIGN KEY (customer_id, enterprise_id) REFERENCES customers (id, enterprise_id)
  `);

  // =========================================================================
  // 5. CHECK constraints — structural invariants, NOT value lists
  // =========================================================================
  // schema.md keeps enum VALUES out of CHECK so that adding one is a code
  // change. These do not constrain a value set; they tie columns together, the
  // same category as verifications_subject_chk.

  // A house account has no customer; a customer account has no program.
  await run(`
    ALTER TABLE reward_wallets ADD CONSTRAINT reward_wallets_account_chk CHECK (
      (account_kind = 'customer' AND customer_id IS NOT NULL AND destination_program_id IS NULL)
      OR
      (account_kind <> 'customer' AND customer_id IS NULL AND destination_program_id IS NOT NULL)
    )
  `);

  // Points have no currency; currency must have one. This is what stops a
  // points balance acquiring an ISO code and being read as money.
  await run(`
    ALTER TABLE reward_wallets ADD CONSTRAINT reward_wallets_currency_chk CHECK (
      (wallet_kind = 'points' AND currency_code IS NULL)
      OR
      (wallet_kind = 'currency' AND currency_code IS NOT NULL)
    )
  `);

  // An `up_to` benefit needs a ceiling for the factor to scale; a `fixed` one
  // must not carry a cap that nothing reads.
  await run(`
    ALTER TABLE reward_rule_benefits ADD CONSTRAINT reward_rule_benefits_mode_chk CHECK (
      (award_mode = 'up_to' AND award_cap IS NOT NULL AND award_cap > 0)
      OR
      (award_mode = 'fixed' AND award_cap IS NULL)
    )
  `);

  // 0..10000 basis points. The clamp lives at the provider boundary; this is
  // the backstop that stops a provider returning 1.5 paying 30 against 20.
  await run(`
    ALTER TABLE reward_awards ADD CONSTRAINT reward_awards_factor_chk CHECK (
      factor_basis_points IS NULL
      OR (factor_basis_points >= 0 AND factor_basis_points <= 10000)
    )
  `);

  // A cap counter may never exceed its own cap. The conditional UPDATE already
  // guarantees it; this makes a direct SQL write unable to break it.
  await run(`
    ALTER TABLE reward_cap_counters ADD CONSTRAINT reward_cap_counters_used_chk
      CHECK (used >= 0 AND used <= cap)
  `);

  // =========================================================================
  // 6. Supporting indexes — the hot paths
  // =========================================================================

  // Which active rules match this trigger, in deterministic order. The whole
  // rule-evaluation path starts here.
  await run(`
    CREATE INDEX reward_rules_trigger_idx
      ON reward_rules (enterprise_id, trigger_kind, priority, id)
      WHERE is_active = true AND is_deleted = false
  `);

  await run(`
    CREATE INDEX reward_rules_program_idx
      ON reward_rules (enterprise_id, program_id, version DESC)
      WHERE is_deleted = false
  `);

  // The grant sweep: awards whose hold has elapsed.
  await run(`
    CREATE INDEX reward_awards_due_idx
      ON reward_awards (enterprise_id, held_until)
      WHERE status = 'held' AND is_deleted = false
  `);

  // "What has this customer earned?" — the award history screen.
  await run(`
    CREATE INDEX reward_awards_customer_idx
      ON reward_awards (enterprise_id, customer_id, created_at DESC)
      WHERE is_deleted = false
  `);

  // The programme dashboard: awards grouped by status, per program.
  await run(`
    CREATE INDEX reward_awards_program_idx
      ON reward_awards (enterprise_id, program_id, status)
      WHERE is_deleted = false
  `);

  // The same dashboard's value side, which joins the ledger back to the award
  // that caused the entry. Without it that is a sequential scan of the largest
  // table in the feature.
  await run(`
    CREATE INDEX reward_ledger_award_idx
      ON reward_ledger_entries (enterprise_id, award_id)
      WHERE award_id IS NOT NULL
  `);

  // Reversal lookup: find the award for a deleted comment.
  await run(`
    CREATE INDEX reward_awards_source_lookup_idx
      ON reward_awards (enterprise_id, source_ref_kind, source_ref_id)
      WHERE is_deleted = false
  `);

  await run(`
    CREATE INDEX reward_award_benefits_award_idx
      ON reward_award_benefits (enterprise_id, award_id, benefit_index)
  `);

  // A customer's statement, newest first.
  await run(`
    CREATE INDEX reward_ledger_wallet_idx
      ON reward_ledger_entries (enterprise_id, wallet_id, id DESC)
  `);

  // Both legs of a conversion or a forward, together.
  await run(`
    CREATE INDEX reward_ledger_group_idx
      ON reward_ledger_entries (enterprise_id, group_ref)
      WHERE group_ref IS NOT NULL
  `);

  await run(`
    CREATE INDEX reward_wallets_customer_idx
      ON reward_wallets (enterprise_id, customer_id)
      WHERE account_kind = 'customer' AND is_deleted = false
  `);

  // The transit-drain alarm: a non-zero balance here is a stuck forward.
  await run(`
    CREATE INDEX reward_wallets_transit_idx
      ON reward_wallets (enterprise_id, account_kind)
      WHERE account_kind = 'system_transit' AND is_deleted = false
  `);

  await run(`
    CREATE INDEX reward_entitlements_customer_idx
      ON reward_entitlements (enterprise_id, customer_id, status)
      WHERE is_deleted = false
  `);

  // =========================================================================
  // 7. The ledger is append-only IN THE DATABASE
  // =========================================================================
  // Application discipline is not enforcement. audit_logs is made append-only
  // with a REVOKE; this is a trigger because the application role must keep
  // INSERT while losing UPDATE and DELETE on one table only.
  //
  // THE HONEST LIMIT: a privileged role can drop this trigger. It stops the
  // accidental UPDATE and the well-meaning repair script, which is the realistic
  // threat. It is not a defence against someone with DDL rights.
  await run(`
    CREATE OR REPLACE FUNCTION reward_ledger_is_append_only()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'reward_ledger_entries is append-only: % is not permitted. Write a reversing entry.', TG_OP;
    END;
    $$ LANGUAGE plpgsql
  `);
  await run(`
    CREATE TRIGGER reward_ledger_entries_append_only
      BEFORE UPDATE OR DELETE ON reward_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION reward_ledger_is_append_only()
  `);

  // =========================================================================
  // 8. updated_at triggers
  // =========================================================================
  // reward_ledger_entries is excluded: it has an updated_at column for column
  // uniformity, but the append-only trigger above means nothing can ever change
  // it, so a trigger that fires on UPDATE would be unreachable code.
  for (const table of REWARD_TABLES) {
    if (table === 'reward_ledger_entries') continue;
    await run(`
      CREATE TRIGGER ${table}_set_updated_at
        BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);
  }
}
