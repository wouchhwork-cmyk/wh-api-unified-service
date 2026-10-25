import { Injectable } from '@nestjs/common';
import { EnterpriseStatus } from '@/shared/enums';
import { Enterprise } from '../entities/enterprise.entity';
import type { BusinessContact, BusinessLink } from '../entities/enterprise.entity';
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
  /** Omitted at signup. A business chooses one in settings; until then NULL. */
  readonly timezone?: string | null;
  readonly websiteUrl: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly status: EnterpriseStatus;
}

@Injectable()
export class EnterpriseRepository extends BaseRepository {
  async create(input: CreateEnterpriseInput): Promise<Enterprise> {
    return this.guard(async () => {
      const enterprise = this.repo(Enterprise).create({ ...input });
      return this.repo(Enterprise).save(enterprise);
    });
  }

  /**
   * Just the status, for the per-request gate. A primary-key lookup returning a
   * single small column, deliberately not `findById`: that would hydrate the
   * whole row on every tenant request to read one field.
   */
  /**
   * Updates what a business may change about itself.
   *
   * The entity API, like `create` and the finders above — this is a single-row
   * write by primary key, which is exactly the case the repository API is for.
   * The tenant predicate is the primary key here: a business IS the tenant, so
   * there is no wider row this could reach by accident.
   *
   * Returns the row as it now stands so the caller can record a version from
   * it, and `null` when nothing matched — a missing or deleted business rather
   * than a write that changed nothing.
   */
  async updateSettings(
    id: number,
    input: {
      timezone: string | null;
      currencyCode: string | null;
      /** Absent = leave it alone. `null` = clear it. The two differ. */
      displayName?: string | null | undefined;
      about?: string | null | undefined;
      /** A list is replaced WHOLE; absent leaves the stored list untouched. */
      links?: readonly BusinessLink[] | undefined;
      contacts?: readonly BusinessContact[] | undefined;
    },
  ): Promise<Enterprise | null> {
    const { affected } = await this.repo(Enterprise).update(
      { id, isDeleted: false },
      {
        timezone: input.timezone,
        currencyCode: input.currencyCode,
        /*
         * OMITTED RATHER THAN SET TO UNDEFINED. TypeORM treats a key holding
         * `undefined` as "do not touch", which happens to be the behaviour
         * wanted here — but relying on that would make a correct outcome
         * depend on a library detail nobody stated. Spreading the key in only
         * when there is a value says it outright.
         *
         * Tested against `undefined` rather than `'displayName' in input`:
         * a key present but undefined is a caller saying nothing, not a caller
         * asking for null, and the two must not be conflated. `null` is
         * distinct from both and clears the name.
         */
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.about !== undefined ? { about: input.about } : {}),
        /*
         * WHOLE-LIST REPLACEMENT, which is what the form sends: the editor
         * holds every row, so a save states the list rather than patching it.
         * An empty array is therefore a real instruction — "I removed them
         * all" — and only ABSENCE means "I am not talking about links".
         */
        ...(input.links !== undefined ? { links: [...input.links] } : {}),
        ...(input.contacts !== undefined ? { contacts: [...input.contacts] } : {}),
      },
    );
    if (!affected) return null;
    return this.findById(id);
  }

  async statusById(id: number): Promise<EnterpriseStatus | null> {
    const rows = await this.query<{ status: EnterpriseStatus }>(
      `SELECT status FROM enterprises WHERE id = $1 AND is_deleted = false LIMIT 1`,
      [id],
    );
    return rows[0]?.status ?? null;
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
