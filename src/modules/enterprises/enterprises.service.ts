import { Injectable } from '@nestjs/common';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { AppException, ErrorCode } from '@/shared/errors';

/** What a client sees of its own business. No internal ids. */
export interface EnterpriseSummary {
  readonly refId: string;
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  readonly status: string;
}

/**
 * Reads of the business a session is scoped to.
 *
 * Separate from EnterpriseOnboardingService, which owns signup and is about
 * CREATING a business. This is about reading the one you are already in, and
 * the two have no steps in common.
 *
 * It exists because the controller was reading the repository itself — the one
 * place the layering was skipped for what looked like a single lookup.
 */
@Injectable()
export class EnterprisesService {
  constructor(private readonly enterprises: EnterpriseRepository) {}

  /**
   * READ, not taken from the token. The business may have been activated or
   * suspended since the token was issued, and a client rendering a stale status
   * looks broken in a way nobody can explain.
   */
  async current(enterpriseId: number): Promise<EnterpriseSummary> {
    const enterprise = await this.enterprises.findById(enterpriseId);
    if (!enterprise) throw new AppException(ErrorCode.EnterpriseNotFound);

    return {
      refId: enterprise.refId,
      name: enterprise.name,
      slug: enterprise.slug,
      timezone: enterprise.timezone,
      status: enterprise.status,
    };
  }
}
