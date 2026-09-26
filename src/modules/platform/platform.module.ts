import { Module } from '@nestjs/common';
import { AppConfigModule } from '@/config';
import { AuditModule } from '@/modules/audit';
import { AuthModule } from '@/modules/auth/auth.module';
import { CryptoModule } from '@/shared/crypto';
import { RateLimitService } from './rate-limit.service';
import { PlatformAdminBootstrapService } from './platform-admin-bootstrap.service';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';

@Module({
  /*
   * AuthModule for the verification machinery: inviting a colleague of ours IS
   * a verification, and it uses the same one implementation of hashing, expiry,
   * attempt limiting and single use as every other invitation in the codebase.
   */
  imports: [AppConfigModule, AuditModule, AuthModule, CryptoModule],
  controllers: [PlatformController],
  // Repositories come from the global DatabaseModule; re-providing them here
  // would give this module its own instances.
  providers: [PlatformService, PlatformAdminBootstrapService, RateLimitService],
})
export class PlatformModule {}
