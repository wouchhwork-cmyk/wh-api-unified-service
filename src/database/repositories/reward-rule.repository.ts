import { Injectable } from '@nestjs/common';
import {
  RewardAwardMode,
  RewardBenefitKind,
  RewardCapScope,
  RewardConditionKind,
  RewardReversalPolicy,
  RewardTriggerKind,
} from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface RewardRuleBenefitRow {
  readonly benefitIndex: number;
  readonly benefitKind: RewardBenefitKind;
  readonly benefitSchemaVersion: number;
  readonly awardMode: RewardAwardMode;
  readonly awardCap: number | null;
  readonly config: Record<string, unknown>;
}

export interface RewardRuleConditionRow {
  readonly conditionIndex: number;
  readonly conditionKind: RewardConditionKind;
  readonly conditionSchemaVersion: number;
  readonly config: Record<string, unknown>;
}

export interface RewardRuleRow {
  readonly id: number;
  readonly refId: string;
  readonly enterpriseId: number;
  readonly programId: number;
  readonly version: number;
  readonly triggerKind: RewardTriggerKind;
  readonly triggerConfig: Record<string, unknown>;
  readonly factorProviderCode: string;
  readonly capScope: RewardCapScope;
  readonly capCount: number;
  readonly holdHours: number;
  readonly reversalPolicy: RewardReversalPolicy;
  readonly priority: number;
  readonly isActive: boolean;
}

/** A rule plus the two child sets it owns. One aggregate, one repository. */
export interface LoadedRewardRule extends RewardRuleRow {
  readonly benefits: RewardRuleBenefitRow[];
  readonly conditions: RewardRuleConditionRow[];
}

const RULE_COLUMNS = `r.id, r.ref_id AS "refId", r.enterprise_id AS "enterpriseId",
       r.program_id AS "programId", r.version, r.trigger_kind AS "triggerKind",
       r.trigger_config AS "triggerConfig", r.factor_provider_code AS "factorProviderCode",
       r.cap_scope AS "capScope", r.cap_count AS "capCount", r.hold_hours AS "holdHours",
       r.reversal_policy AS "reversalPolicy", r.priority, r.is_active AS "isActive"`;

@Injectable()
export class RewardRuleRepository extends BaseRepository {
  /**
   * Which rules could possibly apply to this event.
   *
   * Gates 1 to 3 only — the program switch, the campaign dates, and the rule's
   * own active flag. Conditions are gate 4 and run in TypeScript against the
   * loaded rule, because a condition is a pure function over an already-loaded
   * event and does not belong in a claim query.
   *
   * THE DATES ARE JUDGED AGAINST `occurredAt`, never now(). A webhook four
   * minutes late, a backfill replayed the next morning, a queue that backed up:
   * all of them would push a legitimate action outside the campaign if we
   * judged by arrival. They commented at 20:58 on Tuesday; that is the fact.
   */
  async findMatchingRules(input: {
    enterpriseId: number;
    triggerKind: RewardTriggerKind;
    occurredAt: Date;
  }): Promise<RewardRuleRow[]> {
    return this.query<RewardRuleRow>(
      `SELECT ${RULE_COLUMNS}
         FROM reward_rules r
         JOIN reward_programs p
           ON p.id = r.program_id AND p.enterprise_id = r.enterprise_id
        WHERE r.enterprise_id = $1
          AND r.trigger_kind = $2
          AND r.is_active = true AND r.is_deleted = false
          AND p.status = 'active' AND p.is_deleted = false
          AND (p.starts_at IS NULL OR $3::timestamptz >= p.starts_at)
          AND (p.ends_at IS NULL OR $3::timestamptz < p.ends_at)
        ORDER BY r.priority, r.id`,
      [input.enterpriseId, input.triggerKind, input.occurredAt],
    );
  }

  async loadBenefits(
    enterpriseId: number,
    ruleId: number,
    ruleVersion: number,
  ): Promise<RewardRuleBenefitRow[]> {
    return this.query<RewardRuleBenefitRow>(
      `SELECT benefit_index AS "benefitIndex", benefit_kind AS "benefitKind",
              benefit_schema_version AS "benefitSchemaVersion",
              award_mode AS "awardMode", award_cap AS "awardCap", config
         FROM reward_rule_benefits
        WHERE enterprise_id = $1 AND rule_id = $2 AND rule_version = $3
          AND is_deleted = false
        ORDER BY benefit_index`,
      [enterpriseId, ruleId, ruleVersion],
    );
  }

  async loadConditions(
    enterpriseId: number,
    ruleId: number,
    ruleVersion: number,
  ): Promise<RewardRuleConditionRow[]> {
    return this.query<RewardRuleConditionRow>(
      `SELECT condition_index AS "conditionIndex", condition_kind AS "conditionKind",
              condition_schema_version AS "conditionSchemaVersion", config
         FROM reward_rule_conditions
        WHERE enterprise_id = $1 AND rule_id = $2 AND rule_version = $3
          AND is_deleted = false
        ORDER BY condition_index`,
      [enterpriseId, ruleId, ruleVersion],
    );
  }

  /**
   * Writes a rule and its two child sets.
   *
   * Caller runs this inside a transaction: a rule whose benefits failed to
   * insert would award nothing while appearing configured, which is worse than
   * not existing.
   */
  async insertRule(input: {
    enterpriseId: number;
    programId: number;
    version: number;
    supersedesRuleId: number | null;
    triggerKind: RewardTriggerKind;
    triggerConfig: Record<string, unknown>;
    factorProviderCode: string;
    capScope: RewardCapScope;
    capCount: number;
    holdHours: number;
    reversalPolicy: RewardReversalPolicy;
    priority: number;
  }): Promise<RewardRuleRow> {
    const { rows } = await this.mutate<RewardRuleRow>(
      `INSERT INTO reward_rules
              (enterprise_id, program_id, version, supersedes_rule_id, trigger_kind,
               trigger_config, factor_provider_code, cap_scope, cap_count,
               hold_hours, reversal_policy, priority)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
       RETURNING id, ref_id AS "refId", enterprise_id AS "enterpriseId",
                 program_id AS "programId", version, trigger_kind AS "triggerKind",
                 trigger_config AS "triggerConfig",
                 factor_provider_code AS "factorProviderCode",
                 cap_scope AS "capScope", cap_count AS "capCount",
                 hold_hours AS "holdHours", reversal_policy AS "reversalPolicy",
                 priority, is_active AS "isActive"`,
      [
        input.enterpriseId,
        input.programId,
        input.version,
        input.supersedesRuleId,
        input.triggerKind,
        JSON.stringify(input.triggerConfig),
        input.factorProviderCode,
        input.capScope,
        input.capCount,
        input.holdHours,
        input.reversalPolicy,
        input.priority,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('insertRule returned no row');
    return row;
  }

  async insertBenefits(
    enterpriseId: number,
    ruleId: number,
    ruleVersion: number,
    benefits: readonly {
      benefitKind: RewardBenefitKind;
      awardMode: RewardAwardMode;
      awardCap: number | null;
      config: Record<string, unknown>;
    }[],
  ): Promise<void> {
    for (const [index, benefit] of benefits.entries()) {
      await this.mutate(
        `INSERT INTO reward_rule_benefits
                (enterprise_id, rule_id, rule_version, benefit_index, benefit_kind,
                 award_mode, award_cap, config)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          enterpriseId,
          ruleId,
          ruleVersion,
          index,
          benefit.benefitKind,
          benefit.awardMode,
          benefit.awardCap,
          JSON.stringify(benefit.config),
        ],
      );
    }
  }

  async insertConditions(
    enterpriseId: number,
    ruleId: number,
    ruleVersion: number,
    conditions: readonly { conditionKind: RewardConditionKind; config: Record<string, unknown> }[],
  ): Promise<void> {
    for (const [index, condition] of conditions.entries()) {
      await this.mutate(
        `INSERT INTO reward_rule_conditions
                (enterprise_id, rule_id, rule_version, condition_index,
                 condition_kind, config)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          enterpriseId,
          ruleId,
          ruleVersion,
          index,
          condition.conditionKind,
          JSON.stringify(condition.config),
        ],
      );
    }
  }

  /** By numeric id, for the worker paths that already hold one. */
  async findById(enterpriseId: number, id: number): Promise<RewardRuleRow | null> {
    const rows = await this.query<RewardRuleRow>(
      `SELECT ${RULE_COLUMNS} FROM reward_rules r
        WHERE r.enterprise_id = $1 AND r.id = $2 AND r.is_deleted = false`,
      [enterpriseId, id],
    );
    return rows[0] ?? null;
  }

  async findByRefId(enterpriseId: number, refId: string): Promise<RewardRuleRow | null> {
    const rows = await this.query<RewardRuleRow>(
      `SELECT ${RULE_COLUMNS} FROM reward_rules r
        WHERE r.enterprise_id = $1 AND r.ref_id = $2 AND r.is_deleted = false`,
      [enterpriseId, refId],
    );
    return rows[0] ?? null;
  }

  /**
   * Rules in a program, bounded.
   *
   * A program is not expected to carry hundreds of rules — the catalogue
   * evidence is that these stay small — but "not expected to" is not a limit,
   * and an unbounded SELECT on a tenant-controlled table is how one business
   * makes a page slow for everyone.
   */
  async listForProgram(
    enterpriseId: number,
    programId: number,
    limit: number,
  ): Promise<RewardRuleRow[]> {
    return this.query<RewardRuleRow>(
      `SELECT ${RULE_COLUMNS} FROM reward_rules r
        WHERE r.enterprise_id = $1 AND r.program_id = $2 AND r.is_deleted = false
        ORDER BY r.priority, r.id
        LIMIT $3`,
      [enterpriseId, programId, limit],
    );
  }

  /**
   * Conditions for MANY rules, in one statement.
   *
   * The single-rule version exists for the evaluator, which is looking at one
   * rule by definition. Reading a whole programme means reading every active
   * rule's conditions, and calling that one per rule is the N+1 this codebase
   * forbids outright — fourteen triggers would be fourteen round trips to
   * render one screen.
   *
   * The pairs are expanded into two arrays and zipped with `unnest`, because
   * `(rule_id, rule_version) IN ((1,2),(3,4))` cannot be parameterised as a
   * list without building the SQL by hand, and building SQL by hand around
   * caller-supplied values is how injection gets in.
   */
  async loadConditionsForRules(
    enterpriseId: number,
    rules: readonly { id: number; version: number }[],
  ): Promise<(RewardRuleConditionRow & { ruleId: number })[]> {
    if (rules.length === 0) return [];

    return this.query<RewardRuleConditionRow & { ruleId: number }>(
      `SELECT c.rule_id AS "ruleId",
              c.condition_index AS "conditionIndex", c.condition_kind AS "conditionKind",
              c.condition_schema_version AS "conditionSchemaVersion", c.config
         FROM reward_rule_conditions c
         JOIN unnest($2::bigint[], $3::int[]) AS want(rule_id, rule_version)
           ON want.rule_id = c.rule_id AND want.rule_version = c.rule_version
        WHERE c.enterprise_id = $1 AND c.is_deleted = false
        ORDER BY c.rule_id, c.condition_index`,
      [this.requireEnterprise(enterpriseId), rules.map((r) => r.id), rules.map((r) => r.version)],
    );
  }

  /**
   * Switches off EVERY active rule in a programme, and says which they were.
   *
   * THE RULES ARE NOT DELETED and not edited. Awards point at a rule id and a
   * rule version, and `reward_rules` is documented as versioned and never
   * edited in place — so replacing a programme's configuration means retiring
   * what was there and writing the next version beside it. Deleting would
   * orphan every award ever made under it.
   *
   * RETURNING the rows it switched off is what lets the caller chain each new
   * rule to the one it supersedes, so the lineage of a trigger survives an
   * edit.
   */
  async deactivateProgramRules(
    enterpriseId: number,
    programId: number,
  ): Promise<{ id: number; triggerKind: string; version: number }[]> {
    const { rows } = await this.mutate<{ id: number; triggerKind: string; version: number }>(
      `UPDATE reward_rules
          SET is_active = false
        WHERE enterprise_id = $1 AND program_id = $2
          AND is_deleted = false AND is_active = true
      RETURNING id, trigger_kind AS "triggerKind", version`,
      [enterpriseId, programId],
    );
    return rows;
  }

  /** Switching a rule off. The versions stay; awards under them still resolve. */
  async setActive(enterpriseId: number, refId: string, isActive: boolean): Promise<boolean> {
    const { affected } = await this.mutate(
      `UPDATE reward_rules SET is_active = $3
        WHERE enterprise_id = $1 AND ref_id = $2 AND is_deleted = false`,
      [enterpriseId, refId, isActive],
    );
    return affected > 0;
  }
}
