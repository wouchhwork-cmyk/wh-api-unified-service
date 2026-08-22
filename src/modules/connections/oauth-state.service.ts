import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '@/config';
import { OAUTH_STATE_TTL_MS } from '@/shared/constants';
import { AppException, ErrorCode } from '@/shared/errors';

interface StatePayload {
  readonly enterpriseId: number;
  readonly employeeId: number | null;
  readonly nonce: string;
  readonly exp: number;
}

/**
 * The OAuth `state` parameter, as a signed, expiring token.
 *
 * socialLift used `state` as its session key — the caller's own user id, round
 * tripped through Meta and accepted back without validation. Their git history
 * shows a correct signed-nonce implementation that was removed for demo
 * convenience. This restores it, because `state` is the only CSRF defence in an
 * OAuth redirect: without it, anyone who can guess an identifier can start a
 * connection flow that attaches THEIR Facebook account to SOMEONE ELSE's
 * enterprise.
 */
@Injectable()
export class OauthStateService {
  constructor(private readonly config: AppConfigService) {}

  mint(enterpriseId: number, employeeId: number | null): string {
    const payload: StatePayload = {
      enterpriseId,
      employeeId,
      nonce: randomBytes(16).toString('base64url'),
      exp: Date.now() + OAUTH_STATE_TTL_MS,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  /**
   * Verifies signature THEN expiry. Both failures return the same error, so the
   * response cannot be used to distinguish a forged state from a stale one.
   */
  verify(state: string): { enterpriseId: number; employeeId: number | null } {
    const parts = state.split('.');
    if (parts.length !== 2) throw new AppException(ErrorCode.OauthStateInvalid);

    const [body, signature] = parts as [string, string];

    const expected = Buffer.from(this.sign(body), 'utf8');
    const actual = Buffer.from(signature, 'utf8');
    // Length check first: timingSafeEqual throws on a mismatch, and the length
    // itself carries no secret.
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new AppException(ErrorCode.OauthStateInvalid);
    }

    let payload: StatePayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
    } catch {
      throw new AppException(ErrorCode.OauthStateInvalid);
    }

    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) {
      throw new AppException(ErrorCode.OauthStateInvalid);
    }
    if (typeof payload.enterpriseId !== 'number' || payload.enterpriseId <= 0) {
      throw new AppException(ErrorCode.OauthStateInvalid);
    }

    return { enterpriseId: payload.enterpriseId, employeeId: payload.employeeId ?? null };
  }

  /**
   * Signed with the JWT secret. A dedicated secret would be marginally better
   * hygiene; reusing this one keeps the number of secrets to rotate down, and
   * both live in the same secret manager with the same handling.
   */
  private sign(body: string): string {
    return createHmac('sha256', this.config.auth.accessSecret).update(body).digest('base64url');
  }
}
