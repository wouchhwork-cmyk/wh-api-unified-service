import { Column, Entity } from 'typeorm';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * schema.md §11 — one row per signed-in device, so a session can be revoked
 * server-side. The access token itself is stateless and never stored.
 *
 * No `ref_id`: a client never addresses a session by identifier, it presents
 * the refresh token cookie and the server resolves the row from its hash.
 *
 * Keyed on `identities`, not `enterprise_members`: a session belongs to a
 * person, and the active business is a claim in the short-lived access token,
 * so switching business is a token exchange rather than a re-login.
 *
 * There is deliberately no `status` column — `revoked` is
 * `revokedAt IS NOT NULL` and `expired` is `expiresAt <= now()`, both derivable
 * at read time with no sweep. A stored status would lie for every session that
 * expired since the sweep last ran, on the auth path.
 */
@Entity('sessions')
export class Session extends BaseEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  identityId!: number;

  /**
   * SHA-256 of the refresh token — the proof of this session, and the lookup
   * key on refresh. Plain UNIQUE with no predicate: a hash of a random token is
   * never reused.
   */
  @Column({ type: 'varchar', length: 128 })
  refreshTokenHash!: string;

  /** User-Agent or device label. */
  @Column({ type: 'text', nullable: true })
  deviceInfo!: string | null;

  /** IP at time of issue. */
  @Column({ type: 'inet', nullable: true })
  ipAddress!: string | null;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  /** NULL = valid; set on logout. Revocation is the only defence against a replayed refresh token. */
  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
