import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';

export interface ConsumedState {
  readonly enterpriseId: number;
  readonly employeeId: number | null;
}

/**
 * The outstanding OAuth attempts.
 *
 * NOT tenant-scoped, and it cannot be: the callback arrives from Facebook with
 * no session of ours, so there is no actor to scope by — resolving WHICH tenant
 * this belongs to is the whole job. That is why the nonce is the only lookup
 * key, why it is unguessable, and why consuming it is conditional.
 */
@Injectable()
export class OauthStateRepository extends BaseRepository {
  async create(input: {
    nonce: string;
    enterpriseId: number;
    employeeId: number | null;
    expiresAt: Date;
  }): Promise<void> {
    await this.query(
      `INSERT INTO oauth_states (nonce, enterprise_id, employee_id, expires_at)
            VALUES ($1, $2, $3, $4::timestamptz)`,
      [input.nonce, input.enterpriseId, input.employeeId, input.expiresAt],
    );
  }

  /**
   * Spends the state and returns who started the flow, or null.
   *
   * ONE conditional UPDATE, deliberately. A read-then-write would let two
   * simultaneous callbacks carrying the same state both pass the check before
   * either wrote — which is precisely the replay this exists to stop. Here the
   * second one matches no row.
   *
   * Expiry is part of the same predicate rather than a separate check, so a
   * stale state and a replayed one are indistinguishable to the caller.
   */
  async consume(nonce: string): Promise<ConsumedState | null> {
    const { rows } = await this.mutate<ConsumedState>(
      `UPDATE oauth_states
          SET consumed_at = now(), updated_at = now()
        WHERE nonce = $1
          AND consumed_at IS NULL
          AND expires_at > now()
          AND is_deleted = false
       RETURNING enterprise_id AS "enterpriseId", employee_id AS "employeeId"`,
      [nonce],
    );
    return rows[0] ?? null;
  }

  /**
   * Retention. These are worthless once spent or expired, and nothing reads
   * them again — so they are hard-deleted rather than soft, in bounded batches
   * like the other sweeps.
   */
  async deleteSettledBefore(cutoff: Date, limit: number): Promise<number> {
    const { affected } = await this.mutate(
      `DELETE FROM oauth_states
        WHERE id IN (
          SELECT id FROM oauth_states
           WHERE (consumed_at IS NOT NULL OR expires_at < $1::timestamptz)
             AND created_at < $1::timestamptz
           LIMIT $2
        )`,
      [cutoff, limit],
    );
    return affected;
  }
}
