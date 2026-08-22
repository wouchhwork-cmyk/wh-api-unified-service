import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/auth/auth.module';
import { AuditModule } from '@/modules/audit';
import { CryptoModule } from '@/shared/crypto';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';

/**
 * Who works at a business, and how they get in.
 *
 * Depends on AuthModule for the verification machinery: an invitation IS a
 * verification, and there is deliberately only one implementation of hashing,
 * expiry, attempt limiting and single use in this codebase.
 */
@Module({
  imports: [AuthModule, AuditModule, CryptoModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
})
export class EmployeesModule {}
