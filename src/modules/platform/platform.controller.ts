import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DEFAULT_PAGE_SIZE } from '@/shared/constants';
import { RequirePlatformAdmin } from '@/shared/decorators';
import { paginated, type Paginated } from '@/shared/contracts/envelope';
import {
  PlatformEnterpriseQuerySchema,
  PlatformEnterpriseStatusSchema,
  PlatformFeatureDecisionSchema,
  PlatformFeatureKeyParamSchema,
} from '@/shared/contracts/platform/platform.contract';
import { RefIdParamSchema } from '@/shared/contracts/params.contract';
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
  constructor(private readonly platform: PlatformService) {}

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
