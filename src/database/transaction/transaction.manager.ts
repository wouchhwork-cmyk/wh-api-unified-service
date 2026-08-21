import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DataSource, type EntityManager } from 'typeorm';
import type { IsolationLevel } from 'typeorm/driver/types/IsolationLevel';
import { RequestContext } from '@/shared/context';
import { isRetryablePostgresError } from '@/shared/errors';

export interface TransactionOptions {
  readonly isolation?: IsolationLevel;
  /**
   * Retries on 40001/40P01 only. Off by default: a retry is only safe when the
   * work is idempotent, and the caller is the one who knows that.
   */
  readonly retries?: number;
}

/**
 * THE ONLY PLACE A TRANSACTION IS OPENED (backend-design.md §6.1).
 *
 * Three properties this guarantees, and the reason nobody hand-rolls it:
 *
 *  1. `release()` is in `finally`, so the connection returns to the pool on
 *     success, on failure, and on a throw from commit itself. A leaked query
 *     runner exhausts the pool and takes the service down under load.
 *  2. Rollback, then RETHROW. The manager never turns an error into a return
 *     value; the service layer decides what a failure means.
 *  3. Nesting JOINS rather than nests. An inner call reuses the ambient manager
 *     from AsyncLocalStorage, so a service composing two other services still
 *     produces exactly one transaction.
 */
@Injectable()
export class TransactionManager {
  constructor(
    private readonly dataSource: DataSource,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TransactionManager.name);
  }

  async runInTransaction<T>(
    work: (manager: EntityManager) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const ambient = RequestContext.transactionManager();
    if (ambient) {
      // Already inside a transaction: join it. Savepoints are available for
      // genuine partial rollback but stay opt-in, because implicit savepoints
      // hide bugs.
      return work(ambient);
    }

    const maxAttempts = (options.retries ?? 0) + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.runOnce(work, options.isolation);
      } catch (error) {
        lastError = error;

        // Only serialisation failures and deadlocks are retryable. A constraint
        // violation is not — retrying it just fails again, more slowly.
        if (attempt >= maxAttempts || !isRetryablePostgresError(error)) throw error;

        const delayMs = jitteredBackoff(attempt);
        this.logger.warn(
          { attempt, maxAttempts, delayMs, err: error },
          'retrying transaction after a retryable database error',
        );
        await sleep(delayMs);
      }
    }

    throw lastError;
  }

  private async runOnce<T>(
    work: (manager: EntityManager) => Promise<T>,
    isolation: IsolationLevel | undefined,
  ): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction(isolation ?? 'READ COMMITTED');

    try {
      const result = await RequestContext.runInTransaction(queryRunner.manager, () =>
        work(queryRunner.manager),
      );
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      // Rollback can itself fail (a dead connection). Swallowing that would
      // mask the original error, which is the one worth reporting.
      try {
        if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      } catch (rollbackError) {
        this.logger.error({ err: rollbackError }, 'rollback failed after a transaction error');
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}

function jitteredBackoff(attempt: number): number {
  const base = Math.min(50 * 2 ** (attempt - 1), 1_000);
  // Full jitter: without it, concurrent losers of the same race retry in
  // lockstep and collide again.
  return Math.floor(base * (0.5 + Math.random() / 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
