import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentScopedActor, Public, RequirePermission } from '@/shared/decorators';
import { Permission } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import type { ActorContext } from '@/shared/context';
import {
  SignupRequestSchema,
  type SignupRequest,
  type SignupResponse,
} from '@/shared/contracts/enterprises/signup.contract';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
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
    private readonly enterprises: EnterpriseRepository,
  ) {}

  @Post('signup')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a business and its owner',
    description:
      'One transaction creates the enterprise, the owner identity, the membership, and the ' +
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
  async current(@CurrentScopedActor() actor: ActorContext & { enterpriseId: number }): Promise<{
    refId: string;
    name: string;
    slug: string;
    timezone: string;
    status: string;
  }> {
    const enterprise = await this.enterprises.findById(actor.enterpriseId);
    if (!enterprise) throw new AppException(ErrorCode.EnterpriseNotFound);
    return {
      refId: enterprise.refId,
      name: enterprise.name,
      slug: enterprise.slug,
      timezone: enterprise.timezone,
      status: enterprise.status,
    };
  }
}
