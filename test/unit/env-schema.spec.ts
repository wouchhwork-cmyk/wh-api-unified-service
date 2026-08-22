import { describe, expect, it } from 'vitest';
import { EnvSchema } from '@/config/env.schema';

/**
 * The boot-time refusals, tested individually.
 *
 * Worth its own file because these checks only ever run on a production deploy,
 * which is the one place nobody gets to iterate. A guard nested one brace too
 * deep looks identical in review and never fires — so each one is asserted to
 * reject on its own, from an otherwise VALID prod environment.
 */
const PROD_BASE = {
  NODE_ENV: 'prod',
  DB_HOST: 'db.internal',
  DB_PORT: '5432',
  DB_NAME: 'wouchh',
  DB_USER: 'wouchh',
  DB_PASSWORD: 'a-real-password',
  DB_SSL: 'true',
  JWT_ACCESS_SECRET: 'x'.repeat(48),
  TOKEN_ENCRYPTION_KEY_ID: 'k1',
  VERIFICATION_HMAC_PEPPER: 'y'.repeat(48),
  OTP_REALTIME_ENABLED: 'true',
} as const;

function issuesFor(overrides: Record<string, string>): string[] {
  const result = EnvSchema.safeParse({ ...PROD_BASE, ...overrides });
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join('.'));
}

describe('production environment refusals', () => {
  it('accepts a valid production environment', () => {
    expect(issuesFor({})).toEqual([]);
  });

  it('refuses a static OTP in production even when everything else is correct', () => {
    // The regression this file exists for: with DB_SSL correctly true, a guard
    // nested inside the DB_SSL branch would never run, and production would boot
    // happily with a code anyone can guess.
    expect(issuesFor({ OTP_REALTIME_ENABLED: 'false' })).toContain('OTP_REALTIME_ENABLED');
  });

  it('refuses a short platform admin password in production', () => {
    expect(
      issuesFor({
        PLATFORM_ADMIN_ENABLED: 'true',
        PLATFORM_ADMIN_EMAIL: 'admin@wouchh.com',
        PLATFORM_ADMIN_MOBILE: '8408994828',
        PLATFORM_ADMIN_PASSWORD: '1234',
      }),
    ).toContain('PLATFORM_ADMIN_PASSWORD');
  });

  it('accepts a long platform admin password in production', () => {
    expect(
      issuesFor({
        PLATFORM_ADMIN_ENABLED: 'true',
        PLATFORM_ADMIN_EMAIL: 'admin@wouchh.com',
        PLATFORM_ADMIN_MOBILE: '8408994828',
        PLATFORM_ADMIN_PASSWORD: 'a'.repeat(20),
      }),
    ).toEqual([]);
  });

  it('still refuses an unencrypted database connection in production', () => {
    expect(issuesFor({ DB_SSL: 'false' })).toContain('DB_SSL');
  });

  it('refuses a placeholder secret in production', () => {
    expect(issuesFor({ JWT_ACCESS_SECRET: 'dev-only-'.repeat(6) })).toContain('JWT_ACCESS_SECRET');
    expect(issuesFor({ VERIFICATION_HMAC_PEPPER: 'changeme-'.repeat(6) })).toContain(
      'VERIFICATION_HMAC_PEPPER',
    );
  });

  it('requires every platform admin field once the bootstrap is enabled', () => {
    const issues = issuesFor({ NODE_ENV: 'dev', PLATFORM_ADMIN_ENABLED: 'true' });
    expect(issues).toContain('PLATFORM_ADMIN_EMAIL');
    expect(issues).toContain('PLATFORM_ADMIN_MOBILE');
    expect(issues).toContain('PLATFORM_ADMIN_PASSWORD');
  });

  it('allows a static OTP outside production, which is the whole point of it', () => {
    expect(issuesFor({ NODE_ENV: 'dev', OTP_REALTIME_ENABLED: 'false', DB_SSL: 'false' })).toEqual(
      [],
    );
  });

  it('rejects a static OTP that is not 4 to 8 digits', () => {
    expect(issuesFor({ NODE_ENV: 'dev', OTP_STATIC_CODE: '66' })).toContain('OTP_STATIC_CODE');
    expect(issuesFor({ NODE_ENV: 'dev', OTP_STATIC_CODE: 'abcdef' })).toContain('OTP_STATIC_CODE');
    expect(issuesFor({ NODE_ENV: 'dev', OTP_STATIC_CODE: '1234' })).toEqual([]);
  });
});
