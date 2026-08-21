import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, type EntityTarget, type Repository } from 'typeorm';
import { RequestContext } from '@/shared/context';
import { AppException, ErrorCode, mapConstraintViolation } from '@/shared/errors';

/**
 * Every repository extends this.
 *
 * The point is ONE access path: tenant scoping, timeouts, soft-delete filtering,
 * and constraint translation are enforced here once. With two paths, every
 * cross-cutting concern is implemented twice and the second implementation is
 * where `enterpriseId` gets forgotten — which in this product is a cross-tenant
 * data leak (backend-design.md §5).
 *
 * Repositories NEVER take an EntityManager parameter. The ambient transaction is
 * resolved per call, so the same method works inside and outside a transaction
 * and nested services join automatically.
 */
export abstract class BaseRepository {
  constructor(@InjectDataSource() protected readonly dataSource: DataSource) {}

  /**
   * The manager for the current call: the ambient transaction if one is open,
   * otherwise the pool. This is the whole transaction-participation mechanism.
   */
  protected get manager(): EntityManager {
    return RequestContext.transactionManager() ?? this.dataSource.manager;
  }

  protected repo<T extends object>(target: EntityTarget<T>): Repository<T> {
    return this.manager.getRepository(target);
  }

  /**
   * Raw SQL, ALWAYS parameterised. Permitted only inside a repository, and only
   * where the query builder genuinely cannot express the query — claiming ledger
   * work with FOR UPDATE SKIP LOCKED, upserts onto partial unique indexes, the
   * COALESCE dedup conflict target, trigram search, recursive CTEs.
   */
  protected async query<T = unknown>(sql: string, parameters: readonly unknown[] = []): Promise<T[]> {
    try {
      return (await this.manager.query(sql, parameters as unknown[])) as T[];
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Turns a unique violation on a NAMED index into a typed domain error, once,
   * here — so callers never string-match driver output.
   */
  protected translate(error: unknown): unknown {
    const code = mapConstraintViolation(error);
    return code ? new AppException(code, { cause: error }) : error;
  }

  /** Wraps a write so constraint violations surface as domain errors. */
  protected async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Asserts a tenant key is present before it reaches a query. Defence in depth:
   * the composite foreign keys make a cross-tenant WRITE unrepresentable, but a
   * missing scope on a READ would return another tenant's rows.
   */
  protected requireEnterprise(enterpriseId: number | null | undefined): number {
    if (typeof enterpriseId !== 'number' || !Number.isInteger(enterpriseId) || enterpriseId <= 0) {
      throw new AppException(ErrorCode.AuthEnterpriseNotSelected, {
        message: 'A tenant-scoped query was attempted without an enterprise.',
      });
    }
    return enterpriseId;
  }
}
