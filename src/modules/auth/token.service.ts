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
  /**
   * What this token is FOR.
   *
   * Both token kinds are signed with the same secret, so without this a
   * selection token — which proves a password check and nothing else — would
   * verify perfectly as an access token. It carries none of the claims below, so
   * the ActorContext built from it would be full of `undefined`, and
   * `undefined === null` is false: it would slip straight past the guard that
   * exists to reject a token with no enterprise.
   */
  readonly typ: 'access';
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

/** The claim value that marks a token as usable for authenticating a request. */
const ACCESS_TOKEN_TYPE = 'access';

const SELECTION_TOKEN_TTL_SECONDS = 300;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async issueAccessToken(claims: Omit<AccessTokenClaims, 'sub' | 'typ'>): Promise<string> {
    return this.jwt.signAsync(
      { ...claims, typ: ACCESS_TOKEN_TYPE, sub: String(claims.identityId) },
      // Seconds, not the config's duration string: jsonwebtoken's typed
      // expiresIn only accepts a number or a literal duration template.
      { expiresIn: this.accessTokenLifetimeSeconds() },
    );
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    let claims: unknown;
    try {
      claims = await this.jwt.verifyAsync<Record<string, unknown>>(token);
    } catch (error) {
      // Distinguish expiry from invalidity: a client can refresh the first and
      // must re-authenticate for the second.
      const isExpired = error instanceof Error && error.name === 'TokenExpiredError';
      throw new AppException(isExpired ? ErrorCode.AuthTokenExpired : ErrorCode.AuthTokenInvalid, {
        cause: error,
      });
    }

    /*
     * A valid signature is not enough.
     *
     * The shape is checked too, because everything downstream treats these
     * claims as facts: the guards compare `enterpriseId === null` and
     * `staffId === null` to decide what the caller may reach, and a claim that is
     * absent rather than null makes both comparisons false. Rejecting the token
     * here is the only place that cannot be forgotten later.
     */
    if (!isAccessTokenClaims(claims)) throw new AppException(ErrorCode.AuthTokenInvalid);
    return claims;
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

/**
 * Every claim the application relies on, present and of the right type.
 *
 * `null` is accepted where the claim is legitimately nullable — an unscoped staff
 * token has no enterprise — but `undefined` never is.
 */
function isAccessTokenClaims(value: unknown): value is AccessTokenClaims {
  if (typeof value !== 'object' || value === null) return false;
  const claims = value as Record<string, unknown>;

  return (
    claims['typ'] === ACCESS_TOKEN_TYPE &&
    typeof claims['sub'] === 'string' &&
    typeof claims['identityId'] === 'number' &&
    isNumberOrNull(claims['enterpriseId']) &&
    isNumberOrNull(claims['memberId']) &&
    isNumberOrNull(claims['staffId']) &&
    typeof claims['actorKind'] === 'string' &&
    (Object.values(ActorKind) as string[]).includes(claims['actorKind']) &&
    typeof claims['isImpersonated'] === 'boolean'
  );
}

function isNumberOrNull(value: unknown): boolean {
  return value === null || typeof value === 'number';
}
