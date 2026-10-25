import { Column, Entity } from 'typeorm';
import { RewardProgramStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';
import { TIMESTAMP_PRECISION } from '../timestamp-precision';

/**
 * reward-programs-design.md §8.1 — one campaign.
 *
 * `status` is the SWITCH, not the schedule. A program scheduled for next month
 * sits `active` with a future `starts_at`; there is no `scheduled` status
 * because the date already says it, and no `ended` because `ends_at` does.
 * Two columns answering one question is the duplication schema.md rejects when
 * it forbids `deleted` inside any status enum.
 */
@Entity('reward_programs')
export class RewardProgram extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  /**
   * What customers will see, as opposed to `name`, which is what the business
   * calls it internally.
   *
   * NOT unique and format-free on purpose: it is marketing copy, two
   * programmes may both greet people as "Rewards", and which one awarded is a
   * question for the ledger rather than the label. NULL until somebody
   * chooses one — nothing renders it to an end user yet, so requiring one
   * would demand a decision for a surface that does not exist.
   */
  @Column({ type: 'varchar', length: 160, nullable: true })
  displayName!: string | null;

  @Column({ type: 'varchar', length: 16, default: RewardProgramStatus.Draft })
  status!: RewardProgramStatus;

  /**
   * WHICH VERSION THIS PROGRAM IS ON, mirrored from `entity_versions`.
   *
   * The history in `entity_versions` is the authority — this is the same
   * number on the row so the award path can read it without a MAX() against
   * the history for every award. Written in the same transaction as the
   * version row it mirrors, never on its own.
   */
  @Column({ type: 'int', default: 1 })
  version!: number;

  /*
   * `default_currency_code` IS GONE, and the entity had kept declaring it.
   *
   * `BusinessOwnsTheTimezone1759100000000` dropped the column: a programme
   * does not own a currency, the BUSINESS does, and a per-programme copy was
   * taken at creation and never reconciled. The migration dropped it; this
   * field was left behind.
   *
   * That is not cosmetic. A database built by `db:sync` builds its tables from
   * these entities, so sync kept creating a column migration had removed —
   * two ways of provisioning the same schema producing two different schemas,
   * with the difference being a money column. `pnpm test:schema` is what
   * caught it.
   */

  /** NULL = already running. May be in the FUTURE — that is a scheduled program. */
  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  startsAt!: Date | null;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  endsAt!: Date | null;

  /**
   * NULL = value stays in Wouchh. `'noop'` records intent and moves nothing.
   *
   * The destination must belong to THIS enterprise. Forwarding to a third
   * party is third-party settlement, which is the line out of the closed-loop
   * carve-out (§15).
   */
  @Column({ type: 'varchar', length: 40, nullable: true })
  forwardProviderCode!: string | null;

  /** Endpoint and mapping. A SECRET REFERENCE, never a secret. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  forwardConfig!: Record<string, unknown>;
}
