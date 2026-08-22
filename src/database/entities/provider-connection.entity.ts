import { Column, Entity } from 'typeorm';
import { ConnectionStatus, Provider, ProviderCategory, TokenStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * schema.md §13 — one OAuth grant per provider per business. Connecting Meta
 * creates ONE row here and MANY `channels` rows.
 */
@Entity('provider_connections')
export class ProviderConnection extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  /** The OAuth authority we authenticate against — NOT the channel's surface (§ provider/platform split). */
  @Column({ type: 'varchar', length: 30 })
  provider!: Provider;

  @Column({ type: 'varchar', length: 30 })
  providerCategory!: ProviderCategory;

  /** The authorizing person's id at the provider — part of the connection uniqueness key. */
  @Column({ type: 'varchar', length: 255 })
  providerUserId!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  providerUserName!: string | null;

  /**
   * A self-describing encrypted envelope, NOT raw ciphertext:
   * `v1:k3:<base64url(nonce)>:<base64url(ciphertext||tag)>` (§14) — the format
   * version and key version travel with the value so rotation stays lazy.
   * Never logged, never returned by an API, never in a `SELECT *`; the
   * repository exposes it only to the send path that needs it.
   */
  @Column({ type: 'text' })
  accessToken!: string;

  /** NULL = the provider issues non-expiring tokens. */
  @Column({ type: 'timestamptz', nullable: true })
  tokenExpiresAt!: Date | null;

  /** Derived state, so the API and the UI do not each re-implement the date maths. */
  @Column({ type: 'varchar', length: 30, default: TokenStatus.Valid })
  tokenStatus!: TokenStatus;

  /** What the UI reads to show a Reconnect prompt. Set on expiry or revocation, cleared on reconnect. */
  @Column({ type: 'boolean', default: false })
  reauthRequired!: boolean;

  /** Stops the notifier re-emailing the same business every run. */
  @Column({ type: 'timestamptz', nullable: true })
  reauthNotifiedAt!: Date | null;

  /**
   * Scopes the provider actually GRANTED — often less than what we requested,
   * comma-separated. Storing the request would be useless; storing the grant
   * lets us detect a missing permission before an API call fails.
   */
  @Column({ type: 'text', nullable: true })
  grantedScopes!: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  connectedByEmployeeId!: number | null;

  @Column({ type: 'varchar', length: 30, default: ConnectionStatus.Active })
  status!: ConnectionStatus;
}
