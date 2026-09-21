import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_RATE_LIMIT_POINTS,
  DEFAULT_RATE_LIMIT_WINDOW_MINUTES,
} from '@/shared/constants';
import { RequirePlatformAdmin } from '@/shared/decorators';
import { paginated, type Paginated } from '@/shared/contracts/envelope';
import {
  PlatformEnterpriseQuerySchema,
  PlatformEnterpriseStatusSchema,
  PlatformFeatureDecisionSchema,
  PlatformFeatureKeyParamSchema,
  PlatformRateLimitHistoryQuerySchema,
  PlatformStaffRolesSchema,
} from '@/shared/contracts/platform/platform.contract';
import { RefIdParamSchema } from '@/shared/contracts/params.contract';
import { RequestContext } from '@/shared/context';
import { AppException, ErrorCode } from '@/shared/errors';
import {
  MetaRateLimitService,
  type MetaRateLimitOverview,
  type MetaUsagePoint,
} from './meta-rate-limit.service';
import {
  PlatformService,
  type EnterpriseDetail,
  type EnterpriseListItem,
} from './platform.service';

/**
 * Wouchh's own console: every business on the platform, in one place.
 *
 * The whole controller is behind @RequirePlatformAdmin. It declares NO
 * @RequirePermission, and that is deliberate — permissions are granted by roles
 * that live inside an enterprise and are gated by what that enterprise has
 * bought, which is the wrong shape entirely for "this person works for us".
 */
@ApiTags('platform')
@Controller({ path: 'platform', version: '1' })
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly rateLimits: MetaRateLimitService,
  ) {}

  @Get('rate-limits')
  @RequirePlatformAdmin()
  @ApiOperation({
    summary: 'How much of the Meta API allowance is spent, and by whom',
    description:
      'Two meters, because Meta runs two. The app pool is one allowance for the whole developer ' +
      'app, drained by the connect and token paths; the business pools are per business per ' +
      'product and carry the inbox. Every figure Meta gives is a PERCENTAGE of an allowance it ' +
      'never states, so usedPercent is authoritative for how close a pool is to refusal and ' +
      'callsInWindow is ours, for volume. A null percentage means Meta sent no header, which is ' +
      'unknown rather than zero.',
  })
  async rateLimitOverview(): Promise<MetaRateLimitOverview> {
    return this.rateLimits.overview();
  }

  @Get('rate-limits/history')
  @RequirePlatformAdmin()
  @ApiOperation({
    summary: 'Minute-by-minute rate-limit history',
    description:
      'Oldest first, so it can be charted directly. Bounded by both a window and a row cap — an ' +
      'unbounded series is how a monitoring endpoint becomes the thing that needs monitoring.',
  })
  async rateLimitHistory(@Query() query: unknown): Promise<readonly MetaUsagePoint[]> {
    const parsed = PlatformRateLimitHistoryQuerySchema.parse(query);
    return this.rateLimits.history({
      windowMinutes: parsed.windowMinutes ?? DEFAULT_RATE_LIMIT_WINDOW_MINUTES,
      limit: parsed.limit ?? DEFAULT_RATE_LIMIT_POINTS,
      scopeKey: parsed.scopeKey ?? null,
    });
  }

  @Get('staff')
  @RequirePlatformAdmin()
  @ApiOperation({
    summary: "Wouchh's own people, and what each of them may do",
    description:
      'Until staff roles existed there was nothing to show here: every platform admin had ' +
      'identical authority over every business, and the support and ops roles were two seeded ' +
      'rows nothing could point at. A person marked hasAllEnterpriseAccess is a full admin and ' +
      'their roles are ignored.',
  })
  async listStaff(): Promise<Awaited<ReturnType<PlatformService['listStaff']>>> {
    return this.platform.listStaff();
  }

  @Get('staff/roles')
  @RequirePlatformAdmin()
  @ApiOperation({ summary: 'The staff roles that can be granted' })
  async staffRoleOptions(): Promise<Awaited<ReturnType<PlatformService['listStaffRoleOptions']>>> {
    return this.platform.listStaffRoleOptions();
  }

  @Post('staff/:refId/roles')
  @RequirePlatformAdmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Replace a staff member's roles",
    description:
      'Only for scoped staff. A full platform admin is refused, because their permissions come ' +
      'from the flag and roles would be recorded while doing nothing. Nobody may change their ' +
      'own — staff have no signup route, so an admin who narrowed themselves out of the console ' +
      'would have no way back.',
  })
  async setStaffRoles(
    @Param('refId') refId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const actor = RequestContext.actor();
    if (!actor?.staffId) throw new AppException(ErrorCode.PermissionDenied);

    const parsed = PlatformStaffRolesSchema.parse(body);
    await this.platform.setStaffRoles(actor.staffId, RefIdParamSchema.parse(refId), parsed.roleRefIds);
  }

  @Get('overview')
  @RequirePlatformAdmin()
  @ApiOperation({
    summary: 'Platform-wide totals',
    description: 'The numbers behind the admin dashboard: businesses by status, and totals.',
  })
  async overview(): Promise<Awaited<ReturnType<PlatformService['overview']>>> {
    return this.platform.overview();
  }

  @Get('enterprises')
  @RequirePlatformAdmin()
  @ApiOperation({
    summary: 'Every business on the platform',
    description:
      'Newest first, keyset-paginated on (createdAt, id). Optional free-text search over name, ' +
      'slug and email, and an optional status filter.',
  })
  async listEnterprises(@Query() query: unknown): Promise<Paginated<EnterpriseListItem>> {
    const parsed = PlatformEnterpriseQuerySchema.parse(query);

    const result = await this.platform.listEnterprises({
      search: parsed.search ?? null,
      status: parsed.status ?? null,
      limit: parsed.limit ?? null,
      cursor: parsed.cursor ?? null,
    });

    return paginated(result.items, {
      limit: parsed.limit ?? DEFAULT_PAGE_SIZE,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  }

  @Get('enterprises/:refId')
  @RequirePlatformAdmin()
  @ApiOperation({
    summary: 'One business in full',
    description:
      'Profile, owner (contact details masked), every feature and its state, and every channel ' +
      'the business has connected. No conversation, message or customer content is returned.',
  })
  async getEnterprise(@Param('refId') refId: string): Promise<EnterpriseDetail> {
    return this.platform.getEnterprise(RefIdParamSchema.parse(refId));
  }

  @Post('enterprises/:refId/status')
  @RequirePlatformAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Activate or suspend a business',
    description:
      'Activation is what lets a business actually use the portal: a signup lands in ' +
      'pending_activation and every tenant-scoped route refuses it until this is called. ' +
      'Suspending requires a reason, and both are written to the audit trail.',
  })
  async setStatus(
    @Param('refId') refId: string,
    @Body() body: unknown,
  ): Promise<{ refId: string; from: string; to: string }> {
    const parsed = PlatformEnterpriseStatusSchema.parse(body);
    return this.platform.setEnterpriseStatus(
      RefIdParamSchema.parse(refId),
      parsed.status,
      parsed.reason ?? null,
    );
  }

  @Post('enterprises/:refId/features/:featureKey')
  @RequirePlatformAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Grant, disable, decline or revoke a feature',
    description:
      'Follows the documented feature state machine. A feature the business never requested can ' +
      'be granted outright, which is how a plan gets provisioned. Declining or revoking requires ' +
      'a reason.',
  })
  async decideFeature(
    @Param('refId') refId: string,
    @Param('featureKey') featureKey: string,
    @Body() body: unknown,
  ): Promise<{ featureKey: string; from: string | null; to: string }> {
    const parsed = PlatformFeatureDecisionSchema.parse(body);
    return this.platform.decideFeature(
      RefIdParamSchema.parse(refId),
      PlatformFeatureKeyParamSchema.parse(featureKey),
      parsed.status,
      parsed.reason ?? null,
    );
  }
}
