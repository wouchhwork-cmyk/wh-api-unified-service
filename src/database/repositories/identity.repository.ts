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
      /*
       * Two things this deliberately does NOT do, both of which it used to.
       *
       * It does not extend a lock that is already running. It did, on every
       * wrong guess, which handed anyone who knew an address a way to keep its
       * owner locked out forever simply by guessing at it on a timer.
       *
       * And it does not carry the old count past an expired lock. It did, so an
       * account that had served its fifteen minutes sat permanently at the
       * threshold: the next single typo re-locked it for another fifteen. The
       * window is a rolling one now — an expired lock starts the count again.
       *
       * The count expression appears twice because both columns need the same
       * pre-update value, and Postgres evaluates every SET against the row as it
       * was, which keeps this one atomic statement rather than a
       * read-modify-write two attempts could interleave.
       */
      `UPDATE identities
          SET failed_login_count = CASE
                WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
                ELSE failed_login_count + 1
              END,
              locked_until = CASE
                WHEN locked_until > now() THEN locked_until
                WHEN (CASE
                        WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
                        ELSE failed_login_count + 1
                      END) >= $2
                  THEN now() + ($3::bigint * interval '1 millisecond')
                ELSE NULL
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
