import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentScopedActor, Public, RequirePermission } from '@/shared/decorators';
import { Permission } from '@/shared/enums';
import type { ActorContext } from '@/shared/context';
import {
  SignupRequestSchema,
  type SignupRequest,
  type SignupResponse,
} from '@/shared/contracts/enterprises/signup.contract';
import { UpdateBusinessSettingsSchema } from '@/shared/contracts/enterprises/settings.contract';
import { EnterprisesService, type EnterpriseSummary } from './enterprises.service';
import { VerificationDeliveryService } from '../auth/verification-delivery.service';
import { EnterpriseOnboardingService } from './enterprise-onboarding.service';

const SIGNUP_EXAMPLE = {
  standard: {
    summary: 'A business signing up with an owner who has both credentials',
    value: {
      business: {
        name: 'Acme Coffee',
        email: 'hello@acmecoffee.com',
        mobile: { number: '9876543210', countryCode: 'IN' },
        websiteUrl: 'https://acmecoffee.com',
        country: 'IN',
        timezone: 'Asia/Kolkata',
        city: 'Pune',
      },
      owner: {
        firstName: 'Priya',
        lastName: 'Sharma',
        email: 'priya@acmecoffee.com',
        mobile: { number: '9876543211', countryCode: 'IN' },
        password: 'a-long-enough-password',
      },
    },
  },
  mobileOnly: {
    summary: 'An owner with only a mobile number',
    value: {
      business: { name: 'Zenith Salon', email: 'hello@zenithsalon.com' },
      owner: {
        firstName: 'Rahul',
        mobile: { number: '+919812345678' },
        password: 'a-long-enough-password',
      },
    },
  },
};

@ApiTags('enterprises')
@Controller({ path: 'enterprises', version: '1' })
export class EnterprisesController {
  constructor(
    private readonly onboarding: EnterpriseOnboardingService,
    private readonly delivery: VerificationDeliveryService,
    private readonly enterprisesService: EnterprisesService,
  ) {}

  @Post('signup')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a business and its owner',
    description:
      'One transaction creates the enterprise, the owner identity, the employment, and the ' +
      "enterprise's own copies of the system role templates, then grants the owner role. No " +
      'session is issued: signup always ends in a verification challenge.',
  })
  @ApiBody({ schema: { type: 'object' }, examples: SIGNUP_EXAMPLE })
  async signup(@Body() body: unknown, @Req() request: Request): Promise<SignupResponse> {
    const parsed: SignupRequest = SignupRequestSchema.parse(body);
    const result = await this.onboarding.signup(parsed, {
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
    await this.delivery.deliver(result.pendingDelivery);
    return result.response;
  }

  @Get('current')
  @RequirePermission(Permission.EnterpriseView)
  @ApiOperation({ summary: 'The business the current session is scoped to' })
  async current(
    @CurrentScopedActor() actor: ActorContext & { enterpriseId: number },
  ): Promise<EnterpriseSummary> {
    return this.enterprisesService.current(actor.enterpriseId);
  }

  @Get('settings/options')
  @RequirePermission(Permission.EnterpriseView)
  @ApiOperation({
    summary: 'The values the settings form may offer',
    description:
      'The canonical IANA timezone list and the ISO 4217 currency list as this runtime knows ' +
      'them, which are the SAME sets the settings endpoint validates against — so a client ' +
      'renders its dropdowns from here rather than hardcoding lists that could drift. ' +
      'Timezone abbreviations are deliberately absent: "EST" resolves to America/Panama and ' +
      '"IST" is claimed by three countries, so neither can be stored. Currencies are checked ' +
      'against the list rather than a three-letter shape, which used to accept "XYZ".',
  })
  settingsOptions(): { timezones: readonly string[]; currencies: readonly string[] } {
    return this.enterprisesService.settingsOptions();
  }

  @Patch('current')
  @RequirePermission(Permission.EnterpriseManage)
  @ApiOperation({
    summary: 'Change the business’s own settings',
    description:
      'The timezone set here is the ONE the whole product reads — reward cap periods, ' +
      'happy-hour windows, and anything added later. Nothing keeps its own copy, so changing ' +
      'it moves every one of them at once. Recorded in the audit trail and versioned, because ' +
      'an award granted last month was decided against the timezone in force last month.',
  })
  async updateSettings(
    @CurrentScopedActor() actor: ActorContext & { enterpriseId: number },
    @Body() body: unknown,
  ): Promise<EnterpriseSummary> {
    const input = UpdateBusinessSettingsSchema.parse(body);
    return this.enterprisesService.updateSettings(actor.enterpriseId, input);
  }
}
