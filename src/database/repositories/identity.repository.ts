import { Injectable } from '@nestjs/common';
import { Identity } from '../entities/identity.entity';
import { BaseRepository } from './base.repository';

export interface CreateIdentityInput {
  readonly email: string | null;
  readonly mobile: string | null;
  readonly mobileCountryCode: string | null;
  readonly mobileCallingCode: string | null;
  readonly mobileNationalNumber: string | null;
  readonly passwordHash: string;
  readonly firstName: string;
  readonly lastName: string | null;
}

@Injectable()
export class IdentityRepository extends BaseRepository {
  /**
   * The hottest auth query. The predicate MUST be `lower(email) = $1` to use
   * identities_email_uniq — a plain `email = $1` would not match the functional
   * index and would sequential-scan the auth path.
   */
  async findByEmail(normalizedEmail: string): Promise<Identity | null> {
    const rows = await this.repo(Identity)
      .createQueryBuilder('i')
      .where('lower(i.email) = :email', { email: normalizedEmail })
      .andWhere('i.isDeleted = false')
      .limit(1)
      .getMany();
    return rows[0] ?? null;
  }

  /** Mobile needs no lower(): E.164 has no case. */
  async findByMobile(canonicalMobile: string): Promise<Identity | null> {
    return this.repo(Identity).findOne({
      where: { mobile: canonicalMobile, isDeleted: false },
    });
  }

  async findById(id: number): Promise<Identity | null> {
    return this.repo(Identity).findOne({ where: { id, isDeleted: false } });
  }

  async findByRefId(refId: string): Promise<Identity | null> {
    return this.repo(Identity).findOne({ where: { refId, isDeleted: false } });
  }

  async create(input: CreateIdentityInput): Promise<Identity> {
    return this.guard(async () => {
      const identity = this.repo(Identity).create({ ...input });
      return this.repo(Identity).save(identity);
    });
  }

  /**
   * Throttling state. Written on every failed attempt, so it is a single
   * statement rather than a read-modify-write that two concurrent attempts
   * could interleave.
   */
  async recordFailedLogin(id: number, lockAfter: number, lockDurationMs: number): Promise<void> {
    await this.query(
      `UPDATE identities
          SET failed_login_count = failed_login_count + 1,
              locked_until = CASE
                WHEN failed_login_count + 1 >= $2
                THEN now() + ($3::bigint * interval '1 millisecond')
                ELSE locked_until
              END
        WHERE id = $1`,
      [id, lockAfter, lockDurationMs],
    );
  }

  async recordSuccessfulLogin(id: number): Promise<void> {
    await this.query(
      `UPDATE identities
          SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
        WHERE id = $1`,
      [id],
    );
  }

  /** Stamps the credential that was just proven. Never overwrites the other one. */
  async markCredentialVerified(id: number, credential: 'email' | 'mobile'): Promise<void> {
    const column = credential === 'email' ? 'email_verified_at' : 'mobile_verified_at';
    await this.query(
      `UPDATE identities SET ${column} = now() WHERE id = $1 AND ${column} IS NULL`,
      [id],
    );
  }

  async updatePasswordHash(id: number, passwordHash: string): Promise<void> {
    await this.query(
      `UPDATE identities SET password_hash = $2, failed_login_count = 0, locked_until = NULL
        WHERE id = $1`,
      [id, passwordHash],
    );
  }
}
