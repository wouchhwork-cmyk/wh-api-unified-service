import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '@/config';
import { OauthStateRepository } from '@/database/repositories/oauth-state.repository';
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
 * tripped through Meta and accepted back without validation. That is the hole
 * this closes: `state` is the only CSRF defence in an OAuth redirect, so without
 * it anyone who can guess an identifier can start a flow that attaches THEIR
 * Facebook account to SOMEONE ELSE's business.
 *
 * SIGNED AND SINGLE-USE. A signature alone leaves the token replayable for as
 * long as it is valid, so each mint also writes a row and each callback spends
 * it with one conditional UPDATE.
 */
@Injectable()
export class OauthStateService {
  constructor(
    private readonly config: AppConfigService,
    private readonly states: OauthStateRepository,
  ) {}

  /**
   * Mints a state AND records it, so it can be spent exactly once.
   *
   * The row is written before the URL is handed out. If that insert fails the
   * caller gets an error instead of a URL, which is the right way round: a
   * state that cannot be consumed later would send the user through Facebook
   * only to fail on the way back.
   */
  async mint(enterpriseId: number, employeeId: number | null): Promise<string> {
    const nonce = randomBytes(16).toString('base64url');
    const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);

    await this.states.create({ nonce, enterpriseId, employeeId, expiresAt });

    const payload: StatePayload = {
      enterpriseId,
      employeeId,
      nonce,
      exp: expiresAt.getTime(),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  /**
   * Verifies the signature, then SPENDS the state.
   *
   * Signature first, so a forged nonce never reaches the database — the check is
   * free and it keeps garbage out of the table. Then the conditional UPDATE,
   * which is what makes this single-use: a replay of a valid, unexpired,
   * already-consumed state matches no row and fails exactly like a forgery.
   *
   * The identity returned is the ROW's, not the token's. Both agree today, but
   * the row is the one that was written by an authenticated request and could
   * not have been shaped by anything that came back through the browser.
   *
   * Every failure returns the same error, so the response cannot distinguish a
   * forged state from a stale, spent, or unknown one.
   */
  async consume(state: string): Promise<{ enterpriseId: number; employeeId: number | null }> {
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
    if (typeof payload.nonce !== 'string' || payload.nonce.length === 0) {
      throw new AppException(ErrorCode.OauthStateInvalid);
    }

    const spent = await this.states.consume(payload.nonce);
    if (!spent) throw new AppException(ErrorCode.OauthStateInvalid);

    return { enterpriseId: spent.enterpriseId, employeeId: spent.employeeId };
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
