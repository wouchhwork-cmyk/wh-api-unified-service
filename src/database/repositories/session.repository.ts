import { Injectable } from '@nestjs/common';
import { Session } from '../entities/session.entity';
import { BaseRepository } from './base.repository';

export interface CreateSessionInput {
  readonly identityId: number;
  readonly refreshTokenHash: string;
  readonly deviceInfo: string | null;
  readonly ipAddress: string | null;
  readonly expiresAt: Date;
}

@Injectable()
export class SessionRepository extends BaseRepository {
  async create(input: CreateSessionInput): Promise<Session> {
    return this.guard(async () => {
      const session = this.repo(Session).create({ ...input });
      return this.repo(Session).save(session);
    });
  }

  /**
   * A session is live when it is neither revoked nor expired. There is no status
   * column to consult, deliberately: a stored status would lie for every session
   * that expired since the last sweep — on the auth path (schema.md §11).
   */
  async findLiveByTokenHash(refreshTokenHash: string): Promise<Session | null> {
    const rows = await this.repo(Session)
      .createQueryBuilder('s')
      .where('s.refreshTokenHash = :hash', { hash: refreshTokenHash })
      .andWhere('s.revokedAt IS NULL')
      .andWhere('s.expiresAt > now()')
      .andWhere('s.isDeleted = false')
      .limit(1)
      .getMany();
    return rows[0] ?? null;
  }

  async revoke(id: number): Promise<void> {
    await this.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [
      id,
    ]);
  }

  /** Used on password change and on account lock — every device signs out. */
  async revokeAllForIdentity(identityId: number): Promise<number> {
    const { affected } = await this.mutate(
      `UPDATE sessions SET revoked_at = now()
        WHERE identity_id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [identityId],
    );
    return affected;
  }

  /** The cleanup sweep. Hard-deletes rows no one can present any more. */
  /**
   * Two statements rather than one OR.
   *
   * `(expires_at < $1) OR (revoked_at < $1)` cannot use
   * sessions_expiry_idx — the OR defeats the partial predicate — so it was a
   * sequential scan of the whole table on every run. Split, each half uses an
   * index.
   */
  async deleteExpiredBefore(cutoff: Date, limit: number): Promise<number> {
    const expired = await this.mutate(
      `DELETE FROM sessions
        WHERE id IN (
          SELECT id FROM sessions WHERE expires_at < $1 LIMIT $2
        )
        RETURNING id`,
      [cutoff, limit],
    );
    const revoked = await this.mutate(
      `DELETE FROM sessions
        WHERE id IN (
          SELECT id FROM sessions
           WHERE revoked_at IS NOT NULL AND revoked_at < $1
           LIMIT $2
        )
        RETURNING id`,
      [cutoff, limit],
    );
    return expired.affected + revoked.affected;
  }
}
