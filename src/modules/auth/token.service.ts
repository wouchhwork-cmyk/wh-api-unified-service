import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '@/config';
import { ActorKind } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';

/**
 * The access-token claims.
 *
 * ROLES ARE DELIBERATELY ABSENT. Permissions are resolved per REQUEST, not per
 * token, so a role change takes effect on the next request rather than the next
 * login — baking roles into a 15-minute token would defeat exactly that
 * (backend-design.md §7.2).
 */
export interface AccessTokenClaims {
  readonly sub: string;
  readonly identityId: number;
  readonly enterpriseId: number | null;
  readonly memberId: number | null;
  readonly staffId: number | null;
  readonly actorKind: ActorKind;
  readonly isImpersonated: boolean;
}

/** A short-lived token that proves a password check, and nothing else. */
export interface SelectionTokenClaims {
  readonly sub: string;
  readonly identityId: number;
  readonly purpose: 'enterprise_selection';
}

const SELECTION_TOKEN_TTL_SECONDS = 300;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async issueAccessToken(claims: Omit<AccessTokenClaims, 'sub'>): Promise<string> {
    return this.jwt.signAsync(
      { ...claims, sub: String(claims.identityId) },
      // Seconds, not the config's duration string: jsonwebtoken's typed
      // expiresIn only accepts a number or a literal duration template.
      { expiresIn: this.accessTokenLifetimeSeconds() },
    );
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      return await this.jwt.verifyAsync<AccessTokenClaims>(token);
    } catch (error) {
      // Distinguish expiry from invalidity: a client can refresh the first and
      // must re-authenticate for the second.
      const isExpired = error instanceof Error && error.name === 'TokenExpiredError';
      throw new AppException(isExpired ? ErrorCode.AuthTokenExpired : ErrorCode.AuthTokenInvalid, {
        cause: error,
      });
    }
  }

  async issueSelectionToken(identityId: number): Promise<string> {
    return this.jwt.signAsync(
      { sub: String(identityId), identityId, purpose: 'enterprise_selection' },
      { expiresIn: SELECTION_TOKEN_TTL_SECONDS },
    );
  }

  async verifySelectionToken(token: string): Promise<SelectionTokenClaims> {
    let claims: SelectionTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<SelectionTokenClaims>(token);
    } catch (error) {
      throw new AppException(ErrorCode.AuthTokenInvalid, { cause: error });
    }
    // A token minted for one purpose must never satisfy another.
    if (claims.purpose !== 'enterprise_selection') {
      throw new AppException(ErrorCode.AuthTokenInvalid);
    }
    return claims;
  }

  /** Seconds, for the client to schedule its own refresh. */
  accessTokenLifetimeSeconds(): number {
    return parseDuration(this.config.auth.accessTtl);
  }

  refreshTokenExpiry(): Date {
    return new Date(Date.now() + this.config.auth.refreshTtlDays * 24 * 60 * 60 * 1000);
  }
}

/** Supports the `15m` / `2h` / `7d` / `900s` forms jsonwebtoken accepts. */
function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(value.trim());
  if (!match) throw new Error(`cannot parse token TTL "${value}"`);
  const amount = Number(match[1]);
  switch (match[2]) {
    case 'd':
      return amount * 86_400;
    case 'h':
      return amount * 3_600;
    case 'm':
      return amount * 60;
    default:
      return amount;
  }
}
