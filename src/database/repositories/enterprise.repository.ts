import { Injectable } from '@nestjs/common';
import { EnterpriseStatus } from '@/shared/enums';
import { Enterprise } from '../entities/enterprise.entity';
import { BaseRepository } from './base.repository';

export interface CreateEnterpriseInput {
  readonly name: string;
  readonly slug: string;
  readonly email: string;
  readonly mobile: string | null;
  readonly mobileCountryCode: string | null;
  readonly mobileCallingCode: string | null;
  readonly mobileNationalNumber: string | null;
  readonly country: string;
  readonly timezone: string;
  readonly websiteUrl: string | null;
  readonly city: string | null;
  readonly state: string | null;
}

@Injectable()
export class EnterpriseRepository extends BaseRepository {
  async create(input: CreateEnterpriseInput): Promise<Enterprise> {
    return this.guard(async () => {
      const enterprise = this.repo(Enterprise).create({ ...input });
      return this.repo(Enterprise).save(enterprise);
    });
  }

  async findById(id: number): Promise<Enterprise | null> {
    return this.repo(Enterprise).findOne({ where: { id, isDeleted: false } });
  }

  async findByRefId(refId: string): Promise<Enterprise | null> {
    return this.repo(Enterprise).findOne({ where: { refId, isDeleted: false } });
  }

  /** Uses enterprises_slug_uniq; a soft-deleted enterprise frees its slug. */
  async slugExists(slug: string): Promise<boolean> {
    const rows = await this.query<{ exists: boolean }>(
      `SELECT true AS exists FROM enterprises WHERE slug = $1 AND is_deleted = false LIMIT 1`,
      [slug],
    );
    return rows.length > 0;
  }

  /**
   * Finds a free slug by suffixing. Racy by nature — two signups can pick the
   * same candidate — so the caller must still handle the unique violation; this
   * only avoids the common case.
   */
  async findAvailableSlug(base: string, maxAttempts = 20): Promise<string> {
    if (!(await this.slugExists(base))) return base;
    for (let n = 2; n <= maxAttempts; n += 1) {
      const candidate = `${base}-${n}`;
      if (!(await this.slugExists(candidate))) return candidate;
    }
    // Deterministic fallback rather than an unbounded loop.
    return `${base}-${Date.now().toString(36)}`;
  }

  async isActive(id: number): Promise<boolean> {
    const rows = await this.query<{ status: EnterpriseStatus }>(
      `SELECT status FROM enterprises WHERE id = $1 AND is_deleted = false LIMIT 1`,
      [id],
    );
    return rows[0]?.status === EnterpriseStatus.Active;
  }
}
