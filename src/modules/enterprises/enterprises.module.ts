import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EnterprisesService } from './enterprises.service';
import { EnterpriseOnboardingService } from './enterprise-onboarding.service';
import { EnterprisesController } from './enterprises.controller';
import { FeaturesController } from './features.controller';
import { FeaturesService } from './features.service';
import { AuditModule } from '@/modules/audit';

@Module({
  // AuthModule provides VerificationService; the delivery seam comes with it.
  imports: [AuthModule, AuditModule],
  controllers: [EnterprisesController, FeaturesController],
  providers: [EnterprisesService, EnterpriseOnboardingService, FeaturesService],
  exports: [EnterpriseOnboardingService],
})
export class EnterprisesModule {}
