import { Column, Entity } from 'typeorm';
import { EnterpriseStatus } from '@/shared/enums';
import { PublicEntity } from './base.entity';

/**
 * schema.md §1 — the tenant. One row per business that signs up.
 *
 * Named `enterprises`, not `businesses`: Meta's API already has a `business_id`
 * (Business Manager / Portfolio) and we handle those in the same code, so two
 * different `business_id`s in one integration is a bug waiting to happen.
 */
@Entity('enterprises')
export class Enterprise extends PublicEntity {
  /** Business / brand name. Free text: trimmed and NFC-normalized, case preserved. */
  @Column({ type: 'varchar', length: 255 })
  name!: string;

  /**
   * URL-safe identifier. Unique only among live rows (partial unique index
   * `WHERE is_deleted = false`), because a slug is a reusable business
   * identifier — deleting an enterprise frees its slug.
   */
  @Column({ type: 'varchar', length: 100 })
  slug!: string;

  /** Primary enterprise contact email. Stored trimmed and fully lower-cased. */
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  /**
   * Canonical E.164 — the one comparable string every lookup and uniqueness
   * check uses. The three columns below hold the same number decomposed
   * because splitting E.164 is genuinely ambiguous (calling codes are one to
   * three digits, national lengths vary by country), and deriving the parts
   * would push a country lookup into every read path. One normalization
   * function is the only writer of all four columns, always together.
   */
  @Column({ type: 'varchar', length: 16, nullable: true })
  mobile!: string | null;

  /** ISO 3166-1 alpha-2. Not recoverable from the number — `+1` covers 20 countries. */
  @Column({ type: 'varchar', length: 2, nullable: true })
  mobileCountryCode!: string | null;

  /** Dialling prefix, digits only, no `+`, so splitting the number needs no parsing. */
  @Column({ type: 'varchar', length: 4, nullable: true })
  mobileCallingCode!: string | null;

  /** Subscriber digits — independently searchable, the way locals write a number. */
  @Column({ type: 'varchar', length: 15, nullable: true })
  mobileNationalNumber!: string | null;

  @Column({ type: 'text', nullable: true })
  websiteUrl!: string | null;

  @Column({ type: 'text', nullable: true })
  logoUrl!: string | null;

  /** Free-form. */
  @Column({ type: 'text', nullable: true })
  address!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  state!: string | null;

  /** ISO 3166-1 alpha-2. */
  @Column({ type: 'varchar', length: 2, default: 'IN' })
  country!: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  pincode!: string | null;

  /**
   * THE BUSINESS'S OWN TIMEZONE, and the only one the product reads.
   *
   * Every summary, every "today" boundary, every reward cap period and every
   * happy-hour window resolves through this. Reward programmes used to carry
   * a copy taken at creation; it drifted, so the copy was removed rather than
   * synchronised.
   *
   * NULL IS A REAL STATE: this business has not chosen one. It defaulted to
   * Asia/Kolkata, which meant a business in London had a timezone it never
   * picked and no way to notice — a cap of "once a day" resetting at
   * half past six in the evening, correctly, for the wrong reason. Anything
   * that needs a calendar day now asks for one to be set
   * (`ErrorCode.EnterpriseTimezoneNotSet`) rather than assuming.
   */
  @Column({ type: 'varchar', length: 50, nullable: true })
  timezone!: string | null;

  /**
   * The currency the business works in, ISO 4217.
   *
   * What a benefit means when it grants money without naming one. A benefit
   * may still name a different currency for a promotion; unstated means this.
   *
   * NULL IS A REAL STATE: this business has not chosen one. A rule that would
   * grant money is refused until it does, rather than being handed a default
   * nobody picked — see `ErrorCode.EnterpriseCurrencyNotSet`. A points-only
   * programme never needs it and is unaffected.
   */
  @Column({ type: 'char', length: 3, nullable: true })
  currencyCode!: string | null;

  @Column({ type: 'varchar', length: 30, default: EnterpriseStatus.Active })
  status!: EnterpriseStatus;
}
