import { Module } from '@nestjs/common';
import { AppConfigModule } from '@/config';
import { AuditModule } from '@/modules/audit';
import { CryptoModule } from '@/shared/crypto';
import { RateLimitService } from './rate-limit.service';
import { PlatformAdminBootstrapService } from './platform-admin-bootstrap.service';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';

@Module({
  imports: [AppConfigModule, AuditModule, CryptoModule],
  controllers: [PlatformController],
  // Repositories come from the global DatabaseModule; re-providing them here
  // would give this module its own instances.
  providers: [PlatformService, PlatformAdminBootstrapService, RateLimitService],
})
export class PlatformModule {}
