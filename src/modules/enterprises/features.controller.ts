import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScopedActor, RequirePermission } from '@/shared/decorators';
import type { ActorContext } from '@/shared/context';
import { PlatformFeatureKeyParamSchema } from '@/shared/contracts/platform/platform.contract';
import { Permission } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import { FeaturesService, type EnterpriseFeatureView } from './features.service';

type ScopedActor = ActorContext & { enterpriseId: number };

/**
 * What this business has, and asking for what it does not.
 *
 * THE HALF OF THE FEATURE MODEL THAT WAS NEVER BUILT. `access_requested` is the
 * first state in `ENTERPRISE_FEATURE_TRANSITIONS`, `features.request` has been
 * in the catalogue since the beginning, and neither was reachable: the only
 * path into `enterprise_features` was a platform admin granting a feature
 * outright. A business could not see what it was missing, let alone ask.
 */
@ApiTags('features')
@Controller({ path: 'features', version: '1' })
export class FeaturesController {
  constructor(private readonly features: FeaturesService) {}

  @Get()
  @RequirePermission(Permission.FeaturesView)
  @ApiOperation({
    summary: 'What this business has, and what it could have',
    description:
      'Every feature we sell, with this business’s standing on each. A feature never requested ' +
      'has no row and reports a null status, which reads the same as not enabled — and is the ' +
      'interesting case, because it is the one somebody might want to ask for.',
  })
  async list(@CurrentScopedActor() actor: ScopedActor): Promise<readonly EnterpriseFeatureView[]> {
    return this.features.listForEnterprise(actor.enterpriseId);
  }

  @Post(':featureKey/request')
  @RequirePermission(Permission.FeaturesRequest)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Ask for a feature',
    description:
      'Legal only from "never requested" and from "declined" — a declined business may ask ' +
      'again. It deliberately cannot move a REVOKED feature, which is withdrawn by us and is ' +
      'not self-serve re-enableable, and it cannot move an active one, where the request would ' +
      'mean nothing. Repeating a request that is already pending changes nothing and still ' +
      'succeeds, so a double-click is not an error.',
  })
  async request(
    @CurrentScopedActor() actor: ScopedActor,
    @Param('featureKey') featureKey: string,
  ): Promise<void> {
    /*
     * A request has to record WHO asked, the way an invitation records who
     * sent it — so a staff actor reaching into the business is refused rather
     * than recorded as nobody.
     */
    if (actor.employeeId === null) throw new AppException(ErrorCode.AuthNoActiveEmployment);

    await this.features.request(
      actor.enterpriseId,
      actor.employeeId,
      PlatformFeatureKeyParamSchema.parse(featureKey),
    );
  }
}
