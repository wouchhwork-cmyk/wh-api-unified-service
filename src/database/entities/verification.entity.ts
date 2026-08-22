import { Column, Entity } from 'typeorm';
import {
  DeliveryChannel,
  DeliveryStatus,
  VerificationKind,
  VerificationSubjectKind,
} from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * schema.md §12 — EVERY verification challenge in the product, of any type:
 * first login, email/mobile checks, password reset, employee invites, and end
 * customers when that flow arrives.
 *
 * "One table, one verifier." Hashing, expiry, attempt limiting, resend
 * throttling, single use and destination binding are all security-critical;
 * splitting the table per flow means several implementations, "and the second
 * one is where someone forgets attempt limiting". So both axes are columns:
 * `verificationKind` for what is being verified, and a polymorphic subject.
 *
 * `refId` (from PublicEntity) is what the client posts back on verify — the
 * destination never travels in a second request, so a code can never be checked
 * against an address it was not sent to.
 */
@Entity('verifications')
export class Verification extends PublicEntity {
  /**
   * The polymorphic discriminator. A CHECK constraint enforces exactly one
   * subject, never both and never neither: `identity` requires `identityId` with
   * `customerId` NULL; `customer` requires `customerId` AND `enterpriseId` with
   * `identityId` NULL.
   */
  @Column({ type: 'varchar', length: 20 })
  subjectKind!: VerificationSubjectKind;

  /** Set iff `subjectKind = 'identity'`. */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  identityId!: number | null;

  /**
   * REQUIRED for a customer subject — its FKs route through this column so they
   * cannot cross enterprises. For an identity subject it is context only (which
   * enterprise's login triggered it), because identities are not tenant-scoped.
   */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  enterpriseId!: number | null;

  /** Set iff `subjectKind = 'customer'`; composite FK → customers(id, enterprise_id). */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  customerId!: number | null;

  /**
   * The identifier under test; composite FK → customer_identifiers(id,
   * enterprise_id). Success stamps that row's `verificationStatus` — verification
   * is per-enterprise, so the same email verified for one enterprise and not for
   * another is two rows here and two rows there (§17).
   */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  customerIdentifierId!: number | null;

  /**
   * The discriminator for what is being verified. Each kind carries its own
   * secret shape, expiry and attempt budget in config — "adding a kind is a
   * config entry and an enum value, never a migration".
   */
  @Column({ type: 'varchar', length: 40 })
  verificationKind!: VerificationKind;

  @Column({ type: 'varchar', length: 20 })
  deliveryChannel!: DeliveryChannel;

  /**
   * The NORMALIZED address actually sent to — lower-cased email or E.164. Part
   * of the verify binding (refId + kind + destination), so "a code sent to one
   * mobile must never verify another".
   */
  @Column({ type: 'varchar', length: 320 })
  destination!: string;

  /**
   * HMAC-SHA256 of the secret under a server-side pepper held in the secret
   * manager, NEVER the code itself. Named `secretHash` rather than `codeHash`
   * because it is not always a code: an OTP is six digits, an invite or reset
   * link is a long random token. Plain SHA-256 would be useless — a leaked table
   * would let an attacker exhaust a million six-digit codes instantly; the
   * pepper is what makes the leaked table worthless. Compare digests with a
   * timing-safe function, never `=` on strings.
   */
  @Column({ type: 'varchar', length: 128 })
  secretHash!: string;

  /*
   * There is deliberately NO `status` column. Every state is a function of the
   * timestamps and counters below:
   *   usable = consumedAt IS NULL AND supersededAt IS NULL
   *            AND expiresAt > now() AND attemptCount < maxAttempts
   * A stored status would need a sweep to maintain, and would therefore be wrong
   * for every code that expired since the sweep last ran — "a lying column on
   * the authentication path".
   */

  /** Typically now() + 10 minutes, from config — per kind, never hardcoded. */
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  /** Single use: set on successful verification. */
  @Column({ type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  /**
   * Set when a newer code replaces this one, in the same transaction that issues
   * the new one. Stops two live codes existing where a user requesting a resend
   * could unknowingly validate the older one.
   */
  @Column({ type: 'timestamptz', nullable: true })
  supersededAt!: Date | null;

  /** Wrong guesses so far. */
  @Column({ type: 'int', default: 0 })
  attemptCount!: number;

  /**
   * Exhausted = dead; the user must request a new code. "Attempt limiting is the
   * real security control, not code entropy." Seeded from config per kind.
   */
  @Column({ type: 'int', default: 5 })
  maxAttempts!: number;

  /** How many times the *same* code was re-sent. */
  @Column({ type: 'int', default: 0 })
  resendCount!: number;

  /**
   * Drives the resend cooldown; the `(destination, created_at DESC)` index
   * answers the hourly cap. Both are configuration — "without them this endpoint
   * is a free SMS pump billed to us".
   */
  @Column({ type: 'timestamptz' })
  lastSentAt!: Date;

  /** The send itself, via the transactional outbox — "did it leave our system". */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  outboundEventId!: number | null;

  /**
   * The one exception to the no-status rule: this is provider truth and cannot
   * be derived from anything we hold.
   */
  @Column({ type: 'varchar', length: 30, default: DeliveryStatus.Pending })
  deliveryStatus!: DeliveryStatus;

  /** Who asked, kept for abuse investigation. */
  @Column({ type: 'inet', nullable: true })
  requestedIp!: string | null;

  @Column({ type: 'text', nullable: true })
  requestedUserAgent!: string | null;
}
