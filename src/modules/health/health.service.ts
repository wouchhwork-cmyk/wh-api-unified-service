import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppConfigService } from '@/config';

export interface LivenessReport {
  readonly status: 'ok';
}

export interface HealthReport {
  readonly status: 'ok' | 'degraded';
  readonly checks: Readonly<Record<string, 'ok' | 'failed'>>;
}

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();
  private migrationsVerified = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Deliberately trivial and deliberately synchronous. If the event loop can run
   * this handler, the process is alive; anything more turns a dependency outage
   * into a restart storm.
   */
  liveness(): LivenessReport {
    return { status: 'ok' };
  }

  async readiness(): Promise<HealthReport> {
    const checks: Record<string, 'ok' | 'failed'> = {};

    checks.database = await this.canQuery();
    checks.migrations = (await this.migrationsUpToDate()) ? 'ok' : 'failed';

    const failed = Object.values(checks).includes('failed');
    // No version, hostname, or dependency URL: this endpoint is unauthenticated.
    return { status: failed ? 'degraded' : 'ok', checks };
  }

  async startup(): Promise<HealthReport> {
    const checks: Record<string, 'ok' | 'failed'> = {
      configuration: 'ok', // validated at boot, or the process would not be here
      database: await this.canQuery(),
      migrations: (await this.migrationsUpToDate()) ? 'ok' : 'failed',
    };
    const failed = Object.values(checks).includes('failed');
    return { status: failed ? 'degraded' : 'ok', checks };
  }

  /** Authenticated: this may name versions and pool state. */
  async detail(): Promise<Record<string, unknown>> {
    const readiness = await this.readiness();
    return {
      ...readiness,
      version: this.config.app.version,
      environment: this.config.app.env,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      database: {
        name: this.config.database.name,
        poolMax: this.config.database.poolMax,
        statementTimeoutMs: this.config.database.statementTimeoutMs,
      },
      meta: {
        enabled: this.config.meta.enabled,
        graphApiVersion: this.config.meta.graphApiVersion,
      },
    };
  }

  private async canQuery(): Promise<'ok' | 'failed'> {
    try {
      await this.dataSource.query('SELECT 1');
      return 'ok';
    } catch {
      // The reason goes to the log via the caller's error path, never to an
      // unauthenticated response body.
      return 'failed';
    }
  }

  /**
   * An instance running against a database that is missing a migration will fail
   * in confusing ways, so it should not take traffic. Cached once true, because
   * migrations only ever move forward within a process lifetime.
   */
  private async migrationsUpToDate(): Promise<boolean> {
    if (this.migrationsVerified) return true;
    try {
      const pending = await this.dataSource.showMigrations();
      this.migrationsVerified = !pending;
      return !pending;
    } catch {
      return false;
    }
  }
}
