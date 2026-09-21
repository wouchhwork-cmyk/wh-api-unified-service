import { Module } from '@nestjs/common';
import { EnterpriseEmployeeRepository } from '@/database/repositories/enterprise-employee.repository';
import { RoleRepository } from '@/database/repositories/role.repository';
import { AuditModule } from '@/modules/audit';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

@Module({
  imports: [AuditModule],
  controllers: [RolesController],
  providers: [RolesService, RoleRepository, EnterpriseEmployeeRepository],
  exports: [RolesService],
})
export class RolesModule {}
