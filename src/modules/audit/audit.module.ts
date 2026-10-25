import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { EntityVersionService } from './entity-version.service';

@Module({
  // AuditLogRepository comes from the global DatabaseModule.
  providers: [AuditService, EntityVersionService],
  exports: [AuditService, EntityVersionService],
})
export class AuditModule {}
