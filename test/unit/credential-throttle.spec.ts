import { describe, expect, it } from 'vitest';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { AuthController } from '@/modules/auth/auth.controller';
import { CREDENTIAL_ATTEMPTS_PER_MINUTE } from '@/shared/constants';

/**
 * That the credential routes carry a TIGHTER budget than the rest of the API.
 *
 * Asserted on the metadata rather than over HTTP, because the e2e suite runs
 * with the limiter switched off — it signs in dozens of times a minute from one
 * address, which is exactly the shape the limiter exists to refuse. Without this
 * file, turning that switch off would have silently removed all coverage of the
 * thing it was switched off for.
 *
 * The global budget is 120/min, which is right for a client rendering an inbox
 * and far too generous for a password guess: the account lock is only consulted
 * once a password is already PROVEN, so a wrong guess never meets it.
 */
describe('credential route throttling', () => {
  const CREDENTIAL_ROUTES = ['login', 'verify', 'acceptInvite', 'selectEnterprise'] as const;

  it.each(CREDENTIAL_ROUTES)('gives %s its own attempt budget', (route) => {
    const handler = AuthController.prototype[route] as unknown as object;

    const limits = Reflect.getMetadata(`${THROTTLER_LIMIT}default`, handler) as unknown;
    const ttls = Reflect.getMetadata(`${THROTTLER_TTL}default`, handler) as unknown;

    expect(limits).toBe(CREDENTIAL_ATTEMPTS_PER_MINUTE);
    expect(ttls).toBe(60_000);
  });

  it('is meaningfully tighter than the global budget', () => {
    // A guard against someone "fixing" a noisy test by raising this to 120.
    expect(CREDENTIAL_ATTEMPTS_PER_MINUTE).toBeLessThan(120);
  });

  it('leaves an ordinary authenticated route on the global budget', () => {
    // /me is not a credential attempt, so it must NOT carry the tighter budget —
    // otherwise a client polling it would be throttled out of the product.
    const handler = Reflect.get(AuthController.prototype, 'me') as object;
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, handler)).toBeUndefined();
  });
});
