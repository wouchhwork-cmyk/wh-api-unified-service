import { Column, Entity } from 'typeorm';
import { IdentityStatus } from '@/shared/enums';
import { PublicEntity } from './base.entity';

/**
 * schema.md §2 — the login credential. One row per human, never tenant-scoped.
 *
 * The credential is separated from the membership because login by a single
 * credential cannot work if the same credential can appear on two rows. One
 * person in three businesses is one `identities` row and three
 * `enterprise_members` rows.
 */
@Entity('identities')
export class Identity extends PublicEntity {
  /**
   * Nullable — mobile-only signup is allowed. Stored trimmed and fully
   * lower-cased so the value agrees with the `lower(email)` unique index; the
   * login query must therefore read `WHERE lower(email) = $1` or it will
   * sequential-scan the auth path.
   *
   * A CHECK constraint guarantees at least one of email / mobile is present:
   * a row with both NULL is an identity no login or reset can ever find.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  /**
   * Nullable — email-only signup is allowed. Canonical E.164, and the only
   * mobile login lookup key: a client sending a national number plus a country
   * has them composed into E.164 first, so there is exactly one lookup path.
   */
  @Column({ type: 'varchar', length: 16, nullable: true })
  mobile!: string | null;

  /** ISO 3166-1 alpha-2 the user selected. Not recoverable from the number. */
  @Column({ type: 'varchar', length: 2, nullable: true })
  mobileCountryCode!: string | null;

  /** Dialling prefix, digits only. */
  @Column({ type: 'varchar', length: 4, nullable: true })
  mobileCallingCode!: string | null;

  /** Subscriber digits — what the user types when logging in. */
  @Column({ type: 'varchar', length: 15, nullable: true })
  mobileNationalNumber!: string | null;

  /** argon2id — never plain text, never logged. */
  @Column({ type: 'text' })
  passwordHash!: string;

  /** NULL = unverified. */
  @Column({ type: 'timestamptz', nullable: true })
  emailVerifiedAt!: Date | null;

  /** NULL = unverified. */
  @Column({ type: 'timestamptz', nullable: true })
  mobileVerifiedAt!: Date | null;

  /** A person has one name, not one per business. */
  @Column({ type: 'varchar', length: 100 })
  firstName!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lastName!: string | null;

  @Column({ type: 'text', nullable: true })
  avatarUrl!: string | null;

  /**
   * Account-wide state, and only `active` / `disabled`. A throttle lock is
   * deliberately NOT a status: `lockedUntil` alone carries it, since it expires
   * on its own and a stored `locked` would need a sweep to unset.
   */
  @Column({ type: 'varchar', length: 30, default: IdentityStatus.Active })
  status!: IdentityStatus;

  /** Reset on success. Backs login throttling together with `lockedUntil`. */
  @Column({ type: 'int', default: 0 })
  failedLoginCount!: number;

  /** Set by throttling; NULL = not locked. */
  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;
}
