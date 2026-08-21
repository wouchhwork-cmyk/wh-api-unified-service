import { Column, Entity } from 'typeorm';
import { ChannelKind, ChannelStatus, Platform, TokenStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * schema.md §14 — the individual surfaces under a connection: a Facebook Page,
 * an Instagram professional account, a Zendesk instance. Each has its own stats
 * and, on some platforms, its own token.
 */
@Entity('channels')
export class Channel extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  providerConnectionId!: number;

  /** Denormalized from the parent connection — every query is tenant-scoped. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  /**
   * For a surface owned by another. Meta requires it: an Instagram professional
   * account is reached THROUGH the Facebook Page it is linked to, and the Page
   * token is what authorizes Instagram calls. Without the link the send path
   * cannot find the right token.
   */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  parentChannelId!: number | null;

  /** The specific surface this channel exists on — one provider yields many platforms. */
  @Column({ type: 'varchar', length: 30 })
  platform!: Platform;

  @Column({ type: 'varchar', length: 30 })
  channelKind!: ChannelKind;

  /** Page / account / instance id at the platform. */
  @Column({ type: 'varchar', length: 255 })
  platformChannelId!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name!: string | null;

  /** Handle. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  username!: string | null;

  /** Bio / about. */
  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  profilePictureUrl!: string | null;

  /** Last synced value, not live. */
  @Column({ type: 'int', default: 0 })
  followerCount!: number;

  /** Last synced value, not live. */
  @Column({ type: 'int', default: 0 })
  postCount!: number;

  /**
   * Channel-level token (e.g. a Page token), NULL if the platform has none.
   * Holds the same self-describing encrypted envelope as the connection's
   * token: `v1:k3:<base64url(nonce)>:<base64url(ciphertext||tag)>` (§14).
   * Never logged, never returned by an API, never in a `SELECT *`; the
   * repository exposes it only to the send path that needs it.
   */
  @Column({ type: 'text', nullable: true })
  accessToken!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  tokenExpiresAt!: Date | null;

  /**
   * Derived state. `not_applicable` covers platforms with no channel-level
   * token — Instagram authorises with the parent Page token.
   */
  @Column({ type: 'varchar', length: 30, default: TokenStatus.Valid })
  tokenStatus!: TokenStatus;

  /** Set when the PARENT connection needs reconnecting — channel tokens cascade. */
  @Column({ type: 'boolean', default: false })
  reauthRequired!: boolean;

  /** Whether we actively sync and serve this channel — `status` answers whether it is alive. */
  @Column({ type: 'boolean', default: true })
  isManaged!: boolean;

  /** Platform extras (category, verified, linked ids). */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 30, default: ChannelStatus.Active })
  status!: ChannelStatus;

  /** Last profile/stats refresh — named for the one thing it covers, since §15 syncs more. */
  @Column({ type: 'timestamptz', nullable: true })
  profileSyncedAt!: Date | null;
}
