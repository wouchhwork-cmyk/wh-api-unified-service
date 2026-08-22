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
  protected async query<T = unknown>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<T[]> {
    try {
      // The declared return type supplies T[]; query() returns `any`, so an
      // assertion here would launder rather than check.
      return await this.manager.query(sql, parameters as unknown[]);
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * For INSERT / UPDATE / DELETE with a RETURNING clause.
   *
   * This exists because TypeORM's shapes are not uniform. Verified against
   * Postgres 18:
   *
   *   SELECT                     -> [{...}, {...}]        flat rows
   *   INSERT ... RETURNING       -> [{...}]               flat rows
   *   UPDATE/DELETE ... RETURNING-> [[{...}], 1]          [rows, affectedCount]
   *
   * Reading `rows[0]` on the tuple silently gives the inner ARRAY, and
   * `rows.length` silently gives 2 — so "did this update match?" written as
   * `rows.length === 1` is always wrong. The discriminator below is safe because
   * a row is always an object, never an array.
   *
   * Normalising it once, here, is the concrete payoff of having a single data
   * access path: the trap is disarmed for every repository rather than
   * rediscovered in each one.
   */
  protected async mutate<T = unknown>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<{ rows: T[]; affected: number }> {
    try {
      const result = (await this.manager.query(sql, parameters as unknown[])) as unknown;

      if (Array.isArray(result) && Array.isArray(result[0]) && typeof result[1] === 'number') {
        return { rows: result[0] as T[], affected: result[1] };
      }
      // A statement with no RETURNING clause reports only an affected count.
      if (Array.isArray(result)) {
        return { rows: result as T[], affected: result.length };
      }
      return { rows: [], affected: typeof result === 'number' ? result : 0 };
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
