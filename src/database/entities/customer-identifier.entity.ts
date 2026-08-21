import { Column, Entity } from 'typeorm';
import {
  IdentifierStatus,
  IdentifierVerificationStatus,
  type IdentifierKind,
  type IdentifierSource,
  type IdentifierVerificationMethod,
} from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * schema.md §17 — every way a customer can be recognized or reached, within one
 * enterprise. THE LARGEST TABLE IN THE SCHEMA.
 *
 * Per-enterprise by decision, not by convention: there is no global identifier
 * registry, because Meta issues app-/page-scoped ids (the same human has a
 * different Instagram id per business), and a shared row would be a permanent
 * cross-tenant inference channel.
 *
 * Never `customer_identities` — `identities` (§2) means "a human who logs in".
 */
@Entity('customer_identifiers')
export class CustomerIdentifier extends BaseEntity {
  /** Tenant key — leads every index here. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  customerId!: number;

  @Column({ type: 'varchar', length: 40 })
  identifierKind!: IdentifierKind;

  /**
   * The NORMALIZED canonical form — what the unique index is built on, and the
   * only column exact resolution ever probes. Normalization happens once at the
   * service boundary, never at read time. Phones are canonical E.164.
   */
  @Column({ type: 'varchar', length: 320 })
  identifierValue!: string;

  /**
   * Exactly as received. "The raw form exists for display and support, not for
   * lookup" — it is deliberately never indexed.
   */
  @Column({ type: 'varchar', length: 320, nullable: true })
  identifierValueRaw!: string | null;

  /**
   * Phone kinds only — ISO 3166-1 alpha-2. Real information, not derivable:
   * `+1` covers the US, Canada and 18 more territories. Also records which
   * country a form assumed when the customer typed a bare national number.
   */
  @Column({ type: 'varchar', length: 2, nullable: true })
  countryCode!: string | null;

  /** Phone kinds only — dialling prefix, digits, no `+`, so splitting needs no parsing. */
  @Column({ type: 'varchar', length: 4, nullable: true })
  callingCode!: string | null;

  /**
   * Phone kinds only — subscriber digits, independently indexed because "agents
   * search a phone the way it is written locally". A suffix match on the E.164
   * string would be unindexable.
   */
  @Column({ type: 'varchar', length: 15, nullable: true })
  nationalNumber!: string | null;

  /** The preferred one of its kind for this customer — one ACTIVE primary per kind. */
  @Column({ type: 'boolean', default: false })
  isPrimary!: boolean;

  @Column({ type: 'varchar', length: 30, default: IdentifierVerificationStatus.Unverified })
  verificationStatus!: IdentifierVerificationStatus;

  /** Verification is PER ENTERPRISE — verified for one is not verified for another. */
  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  verificationMethod!: IdentifierVerificationMethod | null;

  /** How we got it. */
  @Column({ type: 'varchar', length: 30 })
  source!: IdentifierSource;

  @Column({ type: 'timestamptz', nullable: true })
  firstSeenAt!: Date | null;

  /** Last time this identifier was actually used. */
  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  /**
   * `active` · `released`. Identifiers get RECYCLED — a carrier reassigns a
   * number, a username is abandoned and claimed — so the old row moves to
   * `released` and the value becomes claimable again, which is why the unique
   * index is partial on `status = 'active'`. `invalid` belongs to
   * verificationStatus alone, so one fact cannot live in two columns.
   */
  @Column({ type: 'varchar', length: 30, default: IdentifierStatus.Active })
  status!: IdentifierStatus;

  /** When it stopped belonging to this customer. */
  @Column({ type: 'timestamptz', nullable: true })
  releasedAt!: Date | null;
}
