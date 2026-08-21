import { Column, Entity } from 'typeorm';
import { CustomerStatus, type CustomerFirstSource } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * schema.md §16 — one row per human per enterprise: the enterprise's record of
 * a customer. Customers never log in; `identities` (§2) is the login concept.
 *
 * Tenant-scoped by construction — nothing here is ever shared between
 * enterprises, and identity resolution happens strictly within one enterprise.
 */
@Entity('customers')
export class Customer extends PublicEntity {
  /** Tenant key — leads every index here. Always taken from the access token. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  /** Best name we know — from the platform or self-declared. Trigram-searched. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  displayName!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  firstName!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lastName!: string | null;

  /** Platform-hosted, and it expires — never treat it as durable storage. */
  @Column({ type: 'text', nullable: true })
  avatarUrl!: string | null;

  /** As reported by the platform. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  locale!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  timezone!: string | null;

  /** Chosen or inferred; drives reply templates. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  preferredLanguage!: string | null;

  /**
   * How we FIRST met them. "Immutable — attribution, not current state": it
   * answers a historical question and never changes. Where a customer engages
   * now is plural and moves over time — that is customer_engagements (§18).
   */
  @Column({ type: 'varchar', length: 30 })
  firstSource!: CustomerFirstSource;

  /** Channel that first touch arrived on — NULL for `import` / `manual`. */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  firstChannelId!: number | null;

  /**
   * Most recent channel they engaged on, and the default reply target.
   * Denormalized onto the customer "so the inbox list can render a badge and
   * pick a default reply target without joining §18 on every row" — a pointer,
   * not a count, written by the same projector that maintains §18.
   */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  lastChannelId!: number | null;

  /** Internal notes the team writes. */
  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  /** Labels for filtering and automation. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  tags!: string[];

  /** Platform extras. */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: Record<string, unknown>;

  /**
   * blockedAt / blockedByMemberId / blockReason are "audit trail, not state".
   * Blocking sets `status = 'blocked'` and stamps them; unblocking returns
   * `status` to `'active'` and LEAVES them as the record of the last block.
   * There is deliberately no `is_blocked` boolean.
   */
  @Column({ type: 'timestamptz', nullable: true })
  blockedAt!: Date | null;

  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  blockedByMemberId!: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  blockReason!: string | null;

  /** Denormalized for the directory — maintained by the projector, not derived. */
  @Column({ type: 'int', default: 0 })
  conversationCount!: number;

  /**
   * The forward seam for identity resolution: a merge points the losing row at
   * the survivor, moves its identifiers across, and sets `status = 'merged'`.
   * Nothing sets it in V1.
   */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  mergedIntoCustomerId!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  firstSeenAt!: Date | null;

  /** Most recent interaction — the directory's sort key. */
  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  /**
   * Single source of truth for the customer lifecycle. "The blocked check is
   * `status = 'blocked'`, nothing else."
   */
  @Column({ type: 'varchar', length: 30, default: CustomerStatus.Active })
  status!: CustomerStatus;
}
