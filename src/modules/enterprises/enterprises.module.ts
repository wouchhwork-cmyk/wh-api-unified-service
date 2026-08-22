import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EnterpriseOnboardingService } from './enterprise-onboarding.service';
import { EnterprisesController } from './enterprises.controller';

@Module({
  // AuthModule provides VerificationService; the delivery seam comes with it.
  imports: [AuthModule],
  controllers: [EnterprisesController],
  providers: [EnterpriseOnboardingService],
  exports: [EnterpriseOnboardingService],
})
export class EnterprisesModule {}
