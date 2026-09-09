import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AppConfigService } from '@/config';
import { CREDENTIAL_ATTEMPTS_PER_MINUTE } from '@/shared/constants';
import { CurrentActor, Public } from '@/shared/decorators';
import { DeliveryChannel, VerificationKind } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import type { ActorContext } from '@/shared/context';
import {
  LoginRequestSchema,
  SelectEnterpriseRequestSchema,
  RefreshQuerySchema,
  SwitchEnterpriseRequestSchema,
  VerifyRequestSchema,
  AcceptInviteRequestSchema,
  ResendRequestSchema,
  type LoginRequest,
  type LoginResponse,
  type SelectEnterpriseRequest,
  type SwitchEnterpriseRequest,
  type VerifyRequest,
  type AcceptInviteRequest,
  type ResendRequest,
  type SignOutEverywhereResponse,
} from '@/shared/contracts/auth/login.contract';
import { EnterpriseEmployeeRepository } from '@/database/repositories/enterprise-employee.repository';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { normalizeEmail, normalizeMobile } from '@/shared/utils/normalize';
import { AuthService, type SessionIssue } from './auth.service';
import { VerificationService } from './verification.service';
import { VerificationDeliveryService } from './verification-delivery.service';

const REFRESH_COOKIE = 'refreshToken';

const LOGIN_EXAMPLES = {
  byEmail: {
    summary: 'By email address',
    value: { email: 'owner@acmecoffee.com', password: 'a-long-enough-password' },
  },
  byMobile: {
    summary: 'By mobile number, with an explicit country',
    value: {
      mobile: { number: '9876543210', countryCode: 'IN' },
      password: 'a-long-enough-password',
    },
  },
  byE164: {
    summary: 'By mobile number already in E.164 form',
    value: { mobile: { number: '+919876543210' }, password: 'a-long-enough-password' },
  },
};

/**
 * Controllers parse, call, map, and nothing else. The response envelope is added
 * by an interceptor, so nothing here constructs one.
 */
@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly verifications: VerificationService,
    private readonly delivery: VerificationDeliveryService,
    private readonly enterprises: EnterpriseRepository,
    private readonly employees: EnterpriseEmployeeRepository,
    private readonly config: AppConfigService,
  ) {}

  @Post('login')
  @Public()
  /*
   * Tighter than the global 120/min, because a request here is an attempt at a
   * password rather than a page of data. The account lock alone does not cover
   * this: by design it is only consulted once the password is already proven, so
   * a wrong guess never meets it.
   */
  @Throttle({ default: { limit: CREDENTIAL_ATTEMPTS_PER_MINUTE, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with an email address or a mobile number',
    description:
      'Returns one of three outcomes: authenticated, enterprise_selection_required, or ' +
      'verification_required. Verification is NOT an error — it is a 200 carrying what the ' +
      'client needs next, and never the code itself.',
  })
  @ApiBody({ schema: { type: 'object' }, examples: LOGIN_EXAMPLES })
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const parsed: LoginRequest = LoginRequestSchema.parse(body);
    const outcome = await this.auth.login(parsed, requestMetadata(request));

    if (outcome.session) this.setRefreshCookie(response, outcome.session);
    if (outcome.pendingDelivery !== undefined) {
      await this.delivery.deliver(outcome.pendingDelivery);
    }
    return outcome.response;
  }

  @Post('verify')
  @Public()
  // An OTP is a six-digit secret: the global budget would allow a fifth of the
  // keyspace an hour from a single address.
  @Throttle({ default: { limit: CREDENTIAL_ATTEMPTS_PER_MINUTE, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit a verification code and receive a session',
    description:
      'The client posts back the opaque verificationRefId, never the destination — which keeps ' +
      'the address out of a second request and makes it impossible to verify a code against a ' +
      'different address than it was sent to.',
  })
  async verify(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const parsed: VerifyRequest = VerifyRequestSchema.parse(body);

    const subject = await this.verifications.verify(
      parsed.verificationRefId,
      parsed.code,
      VerificationKind.FirstLogin,
    );
    if (subject.identityId === null) throw new AppException(ErrorCode.VerificationNotFound);

    const outcome = await this.auth.completeVerifiedLogin(
      subject.identityId,
      // The destination the code was actually sent to, so the credential marked
      // verified is the one that was proven.
      subject.destination,
      requestMetadata(request),
    );
    if (outcome.session) this.setRefreshCookie(response, outcome.session);
    return outcome.response;
  }

  @Post('accept-invite')
  @Public()
  // The invite token is a bearer secret; the same reasoning as /verify applies.
  @Throttle({ default: { limit: CREDENTIAL_ATTEMPTS_PER_MINUTE, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept an invitation and set a password',
    description:
      'How everybody except a business owner gets their first session. The owner created the ' +
      'account and never knew a password for it; this proves the address and sets one, in one ' +
      'step, and moves the employment from invited to active. Both happen together, because a ' +
      'spent code with no password set would leave an account nobody can ever enter.',
  })
  async acceptInvite(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const parsed: AcceptInviteRequest = AcceptInviteRequestSchema.parse(body);

    // Normalised here, once, so the lookup sees exactly what was stored: the
    // destination on the verification row is the canonical form.
    const destination =
      parsed.email !== undefined
        ? normalizeEmail(parsed.email)
        : normalizeMobile(parsed.mobile as { number: string; countryCode?: string })?.canonical;
    if (!destination) throw new AppException(ErrorCode.InvalidMobile);

    const subject = await this.verifications.verifyByDestination(
      destination,
      parsed.code,
      VerificationKind.EmployeeInvite,
    );
    if (subject.identityId === null) throw new AppException(ErrorCode.VerificationNotFound);

    const outcome = await this.auth.completeInvite(
      subject.identityId,
      subject.enterpriseId,
      // The destination the code actually went to, so the credential marked
      // proven is the one that was proven.
      subject.destination,
      parsed.password,
      requestMetadata(request),
    );
    if (outcome.session) this.setRefreshCookie(response, outcome.session);
    return outcome.response;
  }

  @Post('resend')
  @Public()
  // A resend sends a message that costs money, so it gets the credential budget
  // rather than the generous one, on top of the per-destination cap and cooldown.
  @Throttle({ default: { limit: CREDENTIAL_ATTEMPTS_PER_MINUTE, ttl: 60_000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Send a fresh code to an address that already had one',
    description:
      'Always 202, whatever the address. An unknown destination, one with no live challenge, and ' +
      'one still inside its cooldown are indistinguishable — otherwise this would tell a caller ' +
      'who has been invited. It exists because accept-invite spends an attempt per submission: ' +
      'without a resend, anyone who knew a colleague’s address could exhaust the invitation and ' +
      'leave that account permanently unenterable.',
  })
  async resend(@Body() body: unknown, @Req() request: Request): Promise<{ accepted: true }> {
    const parsed: ResendRequest = ResendRequestSchema.parse(body);

    const destination =
      parsed.email !== undefined
        ? normalizeEmail(parsed.email)
        : normalizeMobile(parsed.mobile as { number: string; countryCode?: string })?.canonical;

    // A malformed mobile is the one thing worth reporting: it is a client bug,
    // not a fact about who exists.
    if (!destination) throw new AppException(ErrorCode.InvalidMobile);

    const pending = await this.verifications.resend({
      destination,
      verificationKind: parsed.purpose,
      deliveryChannel: parsed.email !== undefined ? DeliveryChannel.Email : DeliveryChannel.Sms,
      requestedIp: requestMetadata(request).ipAddress,
      requestedUserAgent: requestMetadata(request).userAgent,
    });

    // Delivery is best-effort and never throws: the row is already committed, so
    // a failed send is something the person recovers from by asking again.
    if (pending) await this.delivery.deliver(pending);

    return { accepted: true };
  }

  @Post('select-enterprise')
  @Public()
  @Throttle({ default: { limit: CREDENTIAL_ATTEMPTS_PER_MINUTE, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a selection token for a session in one business' })
  async selectEnterprise(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const parsed: SelectEnterpriseRequest = SelectEnterpriseRequestSchema.parse(body);
    const outcome = await this.auth.selectEnterprise(
      parsed.selectionToken,
      parsed.enterpriseRefId,
      requestMetadata(request),
    );
    if (outcome.session) this.setRefreshCookie(response, outcome.session);
    return outcome.response;
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange the refresh cookie for a new access token',
    description:
      'Every refresh re-checks that the employment is still active, so removing someone takes ' +
      'effect within the access-token lifetime rather than whenever their session ends.',
  })
  async refresh(@Req() request: Request): Promise<{
    accessToken: string;
    expiresInSeconds: number;
    enterprise: unknown;
  }> {
    const token = readRefreshCookie(request);
    // Validated like every other input: ref_id is a UUID column, so an
    // arbitrary string reached the driver and surfaced as a 500 instead of a 422.
    const query = RefreshQuerySchema.parse(request.query);
    return this.auth.refresh(token, query.enterpriseRefId ?? null);
  }

  @Post('switch-enterprise')
  @ApiOperation({ summary: 'Move the session to another business the actor belongs to' })
  async switchEnterprise(
    @CurrentActor() actor: ActorContext,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed: SwitchEnterpriseRequest = SwitchEnterpriseRequestSchema.parse(body);
    return this.auth.switchEnterprise(actor.identityId, parsed.enterpriseRefId);
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the session and clear the cookie' })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const token = request.cookies?.[REFRESH_COOKIE];
    if (typeof token === 'string' && token) await this.auth.logout(token);
    response.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign out everywhere — revoke every session this person holds',
    description:
      'Authenticated, and identity-scoped: the identity is read from the access token, so there ' +
      'is no body and no identifier a caller could use to sign somebody else out. It includes ' +
      'the session making the request, because anybody reaching for this believes a device or a ' +
      'token is in the wrong hands. Access tokens already issued are stateless and live out ' +
      'their remaining fifteen minutes; what this ends is the ability to mint new ones.',
  })
  async logoutAll(
    @CurrentActor() actor: ActorContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SignOutEverywhereResponse> {
    const result = await this.auth.signOutEverywhere(actor.identityId);
    // The caller's own session is among the revoked, so the cookie it holds is
    // now dead: clearing it stops the browser presenting a credential that can
    // only fail.
    response.clearCookie(REFRESH_COOKIE, this.cookieOptions());
    return result;
  }

  @Get('me')
  @ApiOperation({
    summary: 'The current actor, its scope, and its resolved permissions',
    description:
      'What a client needs to decide what to render after a page reload, when all it holds is a ' +
      'token: whether this is an internal admin, which business the session is scoped to, that ' +
      "business's status, and the permission codes. No internal ids are returned — a sequential " +
      'id would tell a caller how many businesses exist and let them probe for neighbours.',
  })
  async me(@CurrentActor() actor: ActorContext): Promise<{
    actorKind: string;
    isPlatformAdmin: boolean;
    isImpersonated: boolean;
    enterprise: { refId: string; name: string; slug: string; status: string } | null;
    /**
     * The actor's OWN employee ref, or null for platform staff.
     *
     * The client needs it to offer "assign this to me" and to render "assigned
     * to you": the assign endpoint speaks in refIds, and until now nothing told
     * a client what its own was.
     */
    employeeRefId: string | null;
    permissions: string[];
  }> {
    // Read rather than trusted from the token: the business may have been
    // activated or suspended since this token was issued, and a client that
    // renders "pending activation" forever would look broken.
    const enterprise =
      actor.enterpriseId === null ? null : await this.enterprises.findById(actor.enterpriseId);

    const employeeRefId =
      actor.enterpriseId !== null && actor.employeeId !== null
        ? await this.employees.refIdOf(actor.enterpriseId, actor.employeeId)
        : null;

    return {
      actorKind: actor.actorKind,
      isPlatformAdmin: actor.staffId !== null,
      isImpersonated: actor.isImpersonated,
      enterprise: enterprise
        ? {
            refId: enterprise.refId,
            name: enterprise.name,
            slug: enterprise.slug,
            status: enterprise.status,
          }
        : null,
      employeeRefId,
      permissions: [...actor.permissions].sort(),
    };
  }

  /**
   * The refresh token lives in an httpOnly cookie, never in a response body, so
   * script running on the page cannot read it.
   */
  private setRefreshCookie(response: Response, session: SessionIssue): void {
    response.cookie(REFRESH_COOKIE, session.refreshToken, {
      ...this.cookieOptions(),
      expires: session.expiresAt,
    });
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      // Secure everywhere except plain-HTTP local development.
      secure: this.config.app.env !== 'dev',
      // Strict assumes the web app and the API share a site. If the frontend
      // ever moves to another registrable domain this must become 'none' plus
      // an explicit CSRF token, or refresh silently stops working.
      sameSite: 'strict' as const,
      path: '/',
    };
  }
}

function requestMetadata(request: Request): { ipAddress: string | null; userAgent: string | null } {
  return {
    ipAddress: request.ip ?? null,
    userAgent: request.get('user-agent') ?? null,
  };
}

function readRefreshCookie(request: Request): string {
  const token = request.cookies?.[REFRESH_COOKIE];
  if (typeof token !== 'string' || !token) throw new AppException(ErrorCode.AuthSessionRevoked);
  return token;
}
