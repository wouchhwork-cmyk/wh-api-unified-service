import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScopedActor, RequirePermission } from '@/shared/decorators';
import type { ActorContext } from '@/shared/context';
import { RefIdParamSchema } from '@/shared/contracts/params.contract';
import {
  CreateRoleSchema,
  SetEmployeeRolesSchema,
  UpdateRoleSchema,
} from '@/shared/contracts/roles/role.contract';
import { Permission } from '@/shared/enums';

/** An actor the scope guard has already proven belongs to a business. */
type ScopedActor = ActorContext & { enterpriseId: number };
import { AppException, ErrorCode } from '@/shared/errors';
import {
  RolesService,
  type PermissionGroupView,
  type RoleView,
} from './roles.service';

/**
 * A business defining what its own people may do.
 *
 * `roles.manage` guards every write here, and it is NOT the whole check —
 * it says who may open the role editor, never what they may put in a role.
 * The service applies the level and subset rules on top, because those depend
 * on the actor and on the row, and a decorator can express neither.
 */
@ApiTags('roles')
@Controller({ path: 'roles', version: '1' })
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @RequirePermission(Permission.RolesView)
  @ApiOperation({
    summary: 'Everything a role can grant, grouped for a person',
    description:
      'Grouped by area — direct messages, comments, mentions, team, and so on — in reading ' +
      'order rather than alphabetically. Each entry says whether the business has the feature ' +
      'behind it (available) and whether the person looking holds it themselves (grantable). ' +
      'Both are reported rather than filtered out: hiding an unavailable permission makes a role ' +
      'that already grants it look corrupt, and hides what buying the feature back would restore.',
  })
  async permissions(@CurrentScopedActor() actor: ScopedActor): Promise<readonly PermissionGroupView[]> {
    return this.roles.permissionCatalogue(actor.enterpriseId, actor.employeeId);
  }

  @Get()
  @RequirePermission(Permission.RolesView)
  @ApiOperation({
    summary: 'The roles this business has',
    description:
      'Most senior first. Each carries its level, its permissions, how many people hold it, and ' +
      'whether THIS caller may edit or assign it — so a client does not offer a button the ' +
      'server will refuse.',
  })
  async list(@CurrentScopedActor() actor: ScopedActor): Promise<readonly RoleView[]> {
    return this.roles.list(actor.enterpriseId, actor.employeeId);
  }

  @Post()
  @RequirePermission(Permission.RolesManage)
  @ApiOperation({
    summary: 'Create a role',
    description:
      'The level must be strictly below your own, and the permissions must be ones you hold ' +
      'yourself. The owner level is reserved and cannot be created.',
  })
  async create(
    @CurrentScopedActor() actor: ScopedActor,
    @Body() body: unknown,
  ): Promise<RoleView> {
    return this.roles.create(actor.enterpriseId, this.actingEmployee(actor), CreateRoleSchema.parse(body));
  }

  @Patch(':refId')
  @RequirePermission(Permission.RolesManage)
  @ApiOperation({
    summary: 'Replace a role',
    description:
      'Wholesale, not a patch: a partial update of a permission SET is ambiguous — an absent ' +
      'list could mean "leave it alone" or "grant nothing", and the difference between those is ' +
      'a silent total revocation. Built-in roles cannot be edited.',
  })
  async update(
    @CurrentScopedActor() actor: ScopedActor,
    @Param('refId') refId: string,
    @Body() body: unknown,
  ): Promise<RoleView> {
    return this.roles.update(
      actor.enterpriseId,
      this.actingEmployee(actor),
      RefIdParamSchema.parse(refId),
      UpdateRoleSchema.parse(body),
    );
  }

  @Post(':refId/archive')
  @RequirePermission(Permission.RolesManage)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Retire a role',
    description:
      'Stops it being assigned; it is not deleted and the people who hold it keep it, so the ' +
      'record of who had what survives. A role somebody still holds is refused — archiving it ' +
      'would quietly leave them holding something the business believes it has retired.',
  })
  async archive(
    @CurrentScopedActor() actor: ScopedActor,
    @Param('refId') refId: string,
  ): Promise<void> {
    await this.roles.archive(
      actor.enterpriseId,
      this.actingEmployee(actor),
      RefIdParamSchema.parse(refId),
    );
  }

  @Post('employees/:refId')
  @RequirePermission(Permission.EmployeesManage)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Replace somebody's roles",
    description:
      'The gap this fills: a role was set once, at invitation, and could never be changed — a ' +
      'promotion meant deleting the person and inviting them again, which loses their history. ' +
      'You may only re-role somebody below your own level, and only into roles below it.',
  })
  async setEmployeeRoles(
    @CurrentScopedActor() actor: ScopedActor,
    @Param('refId') refId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.roles.setEmployeeRoles(
      actor.enterpriseId,
      this.actingEmployee(actor),
      RefIdParamSchema.parse(refId),
      SetEmployeeRolesSchema.parse(body),
    );
  }

  /**
   * Every write here has to be attributable to a person in this business.
   *
   * A Wouchh staff actor has no employment, so `granted_by_employee_id` would be
   * null and the audit trail would record that "somebody" changed who can do
   * what. Reads are open to staff; writes are not, for the same reason the
   * invite endpoint refuses them.
   */
  private actingEmployee(actor: ScopedActor): number {
    if (actor.employeeId === null) throw new AppException(ErrorCode.AuthNoActiveEmployment);
    return actor.employeeId;
  }
}
