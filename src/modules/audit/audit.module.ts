import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';

@Module({
  // AuditLogRepository comes from the global DatabaseModule.
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
