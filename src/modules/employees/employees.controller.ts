import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleRepository } from '@/database/repositories/role.repository';
import { VerificationDeliveryService } from '@/modules/auth/verification-delivery.service';
import { CurrentScopedActor, RequirePermission } from '@/shared/decorators';
import { Permission } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import type { ActorContext } from '@/shared/context';
import { RefIdParamSchema } from '@/shared/contracts/params.contract';
import {
  CreateEmployeeRequestSchema,
  EmployeeQuerySchema,
  EmployeeStatusRequestSchema,
  type EmployeeDto,
} from '@/shared/contracts/employees/employee.contract';
import { EmployeesService } from './employees.service';

type ScopedActor = ActorContext & { enterpriseId: number };

const CREATE_EXAMPLES = {
  byEmail: {
    summary: 'An agent, invited by email',
    value: {
      firstName: 'Rahul',
      lastName: 'Nair',
      email: 'rahul@bluebottle.test',
      roleRefId: '11111111-1111-4111-8111-111111111111',
    },
  },
  byMobile: {
    summary: 'A manager, invited by mobile',
    value: {
      firstName: 'Anita',
      mobile: { number: '9812345678', countryCode: 'IN' },
      roleRefId: '22222222-2222-4222-8222-222222222222',
    },
  },
};

/**
 * The people who work at one business.
 *
 * EVERY ROUTE IS TENANT-SCOPED. A business sees and manages only its own people:
 * the enterprise comes from the token, never from a request body, and an employee
 * refId from another business does not resolve.
 *
 * There is deliberately no route that lets somebody add themselves.
 */
@ApiTags('employees')
@Controller({ path: 'employees', version: '1' })
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly roles: RoleRepository,
    private readonly delivery: VerificationDeliveryService,
  ) {}

  @Get()
  @RequirePermission(Permission.EmployeesView)
  @ApiOperation({
    summary: 'Everybody who works here',
    description:
      "The business's own people, with their roles and whether they have accepted their " +
      'invitation. Contact details are masked. Pass includeSupport=true to also see the Wouchh ' +
      'people assigned to this business — who are not its employees.',
  })
  async list(
    @CurrentScopedActor() actor: ScopedActor,
    @Query() query: unknown,
  ): Promise<EmployeeDto[]> {
    const parsed = EmployeeQuerySchema.parse(query);
    return this.employees.list(actor.enterpriseId, parsed.includeSupport === 'true');
  }

  @Get('roles')
  @RequirePermission(Permission.RolesView)
  @ApiOperation({
    summary: 'The roles this business can assign',
    description:
      'Its OWN copies of the role templates, created at signup. Needed before anybody can be ' +
      'invited, since a role is required.',
  })
  async roleOptions(
    @CurrentScopedActor() actor: ScopedActor,
  ): Promise<{ refId: string; name: string }[]> {
    const roles = await this.roles.listForEnterprise(actor.enterpriseId);
    return roles.map((role) => ({ refId: role.refId, name: role.name }));
  }

  @Post()
  @RequirePermission(Permission.EmployeesInvite)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a colleague',
    description:
      'The only way a second person joins a business — there is no employee signup. No password ' +
      'is accepted: the person sets their own from the code that reaches them, so nobody else ' +
      'ever knows it. They arrive as `invited` and can do nothing until they accept.',
  })
  @ApiBody({ schema: { type: 'object' }, examples: CREATE_EXAMPLES })
  async create(
    @CurrentScopedActor() actor: ScopedActor,
    @Body() body: unknown,
  ): Promise<EmployeeDto> {
    // A staff actor reaching into a business carries no employeeId, and an
    // invitation has to record who sent it.
    if (actor.employeeId === null) throw new AppException(ErrorCode.AuthNoActiveEmployment);

    const parsed = CreateEmployeeRequestSchema.parse(body);
    const created = await this.employees.create(actor.enterpriseId, actor.employeeId, parsed);
    await this.delivery.deliver(created.pendingDelivery);
    return created.employee;
  }

  @Post(':refId/status')
  @RequirePermission(Permission.EmployeesManage)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspend or reinstate somebody',
    description:
      'A status change, never a deletion: what they did has to survive them leaving. Suspending ' +
      'requires a reason, and both are written to the audit trail. You cannot change your own.',
  })
  async setStatus(
    @CurrentScopedActor() actor: ScopedActor,
    @Param('refId') refId: string,
    @Body() body: unknown,
  ): Promise<{ refId: string; from: string; to: string }> {
    if (actor.employeeId === null) throw new AppException(ErrorCode.AuthNoActiveEmployment);

    const parsed = EmployeeStatusRequestSchema.parse(body);
    return this.employees.setStatus(
      actor.enterpriseId,
      actor.employeeId,
      RefIdParamSchema.parse(refId),
      parsed.status,
      parsed.reason ?? null,
    );
  }
}
