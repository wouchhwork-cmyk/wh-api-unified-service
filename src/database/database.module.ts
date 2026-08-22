import { Global, Module } from '@nestjs/common';
import { AuditLogRepository } from './repositories/audit-log.repository';
import { EnterpriseEmployeeRepository } from './repositories/enterprise-employee.repository';
import { EnterpriseRepository } from './repositories/enterprise.repository';
import { IdentityRepository } from './repositories/identity.repository';
import { OauthStateRepository } from './repositories/oauth-state.repository';
import { PermissionRepository } from './repositories/permission.repository';
import { PlatformAdminRepository } from './repositories/platform-admin.repository';
import { RoleRepository } from './repositories/role.repository';
import { SessionRepository } from './repositories/session.repository';
import { StaffMemberRepository } from './repositories/staff-member.repository';
import { VerificationRepository } from './repositories/verification.repository';
import { TransactionManager } from './transaction';

const PROVIDERS = [
  TransactionManager,
  AuditLogRepository,
  EnterpriseRepository,
  EnterpriseEmployeeRepository,
  IdentityRepository,
  OauthStateRepository,
  PermissionRepository,
  PlatformAdminRepository,
  RoleRepository,
  SessionRepository,
  StaffMemberRepository,
  VerificationRepository,
];

/**
 * Global so a service can compose several repositories without a circular module
 * import — which is why repositories live here rather than inside each feature
 * module (backend-design.md §3).
 */
@Global()
@Module({ providers: PROVIDERS, exports: PROVIDERS })
export class DatabaseModule {}
