import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import { VersioningType } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { seedCatalogue } from '@/database/seed/catalogue.seed';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Reflector } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { PlatformAdminBootstrapService } from '@/modules/platform/platform-admin-bootstrap.service';
import { AppConfigService } from '@/config';
import { MAX_JSON_BODY_BYTES } from '@/shared/constants';
import { AllExceptionsFilter } from '@/shared/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from '@/shared/interceptors/response-envelope.interceptor';
import { TimeoutInterceptor } from '@/shared/interceptors/timeout.interceptor';

export interface TestApp {
  readonly app: NestExpressApplication;
  readonly db: DataSource;
  close(): Promise<void>;
}

/**
 * Boots the REAL application graph — the same guards, interceptors, filter and
 * body parsers as production.
 *
 * The wiring is duplicated from main.ts deliberately rather than exported from
 * it: main.ts calls listen(), and a test that has to start a server to make a
 * request is slower and flakier than one that goes through the HTTP adapter
 * directly. The cost is that this must be kept in step with main.ts, which the
 * envelope and error-shape assertions below will catch.
 */
export async function createTestApp(): Promise<TestApp> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: false,
  });

  const config = app.get(AppConfigService);
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(config.app.apiPrefix);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.use(cookieParser());
  app.useBodyParser('json', { limit: MAX_JSON_BODY_BYTES });

  const reflector = app.get(Reflector);
  app.useGlobalInterceptors(
    new TimeoutInterceptor(config),
    new ResponseEnvelopeInterceptor(reflector),
  );
  app.useGlobalFilters(app.get(AllExceptionsFilter));

  await app.init();

  const db = app.get<DataSource>(getDataSourceToken());
  return {
    app,
    db,
    close: async () => {
      await app.close();
    },
  };
}

/** Clears tenant data, keeping the seeded catalogue signup depends on. */
export async function resetTenantData(db: DataSource): Promise<void> {
  await db.query(`
    TRUNCATE audit_logs, message_attachments, messages, conversations, posts,
             customer_engagements, customer_identifiers, customers,
             verifications, outbound_events, inbound_events, sync_jobs,
             channels, provider_connections, sessions, enterprise_features,
             member_roles, enterprise_members, identities, enterprises
    RESTART IDENTITY CASCADE
  `);
  await db.query(`DELETE FROM roles WHERE enterprise_id IS NOT NULL`);

  /*
   * Re-seed the catalogue. TRUNCATE on enterprises CASCADEs into roles — which
   * carries a nullable enterprise_id — so the NULL-enterprise role TEMPLATES go
   * with it. Signup then fails with "the owner template is missing", which is
   * correct behaviour rather than a test artefact, so the fix is to restore the
   * catalogue instead of weakening the check.
   */
  await db.transaction((manager) => seedCatalogue(manager));
}

/** Reads back the verification secret, which no API ever returns. */
export async function readLatestVerificationSecret(db: DataSource): Promise<string> {
  // The plaintext is never stored, so a test cannot read it. Instead the code is
  // brute-forced against the stored HMAC — trivial for six digits, and it proves
  // the hash is what the service actually compares.
  const rows = (await db.query(
    `SELECT secret_hash FROM verifications ORDER BY id DESC LIMIT 1`,
  )) as { secret_hash: string }[];
  const hash = rows[0]?.secret_hash;
  if (!hash) throw new Error('no verification row to read');

  const { createHmac } = await import('node:crypto');
  const pepper = process.env.VERIFICATION_HMAC_PEPPER ?? '';
  for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
    const code = String(candidate).padStart(6, '0');
    if (createHmac('sha256', pepper).update(code).digest('hex') === hash) return code;
  }
  throw new Error('could not recover the verification code');
}

/**
 * Re-runs the platform admin provisioning.
 *
 * resetTenantData TRUNCATEs identities, and staff_members references it, so the
 * admin created at boot goes with it. Rather than inserting a fixture by hand,
 * this calls the real bootstrap — so every test that needs an admin is also a
 * test of how admins come to exist.
 */
export async function provisionPlatformAdmin(app: NestExpressApplication): Promise<void> {
  await app.get(PlatformAdminBootstrapService).onApplicationBootstrap();
}

/** The credential the bootstrap provisions, read from the same env it reads. */
export function platformAdminLogin(): {
  mobile: { number: string; countryCode: string };
  password: string;
} {
  const mobile = process.env.PLATFORM_ADMIN_MOBILE;
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!mobile || !password)
    throw new Error('PLATFORM_ADMIN_MOBILE and _PASSWORD must be set for tests');
  return { mobile: { number: mobile, countryCode: 'IN' }, password };
}
