import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  RoleRepository,
  type RoleDetailRow,
} from '@/database/repositories/role.repository';
import { EnterpriseEmployeeRepository } from '@/database/repositories/enterprise-employee.repository';
import { TransactionManager } from '@/database/transaction';
import { AuditService } from '@/modules/audit';
import {
  AuditAction,
  AuditEntityType,
  PermissionResource,
  ROLE_LEVEL,
  SystemRole,
} from '@/shared/enums';
import { RequestContext } from '@/shared/context';
import { AppException, ErrorCode } from '@/shared/errors';
import {
  explainDenial,
  mayAssignRole,
  mayDefineRole,
  mayModifyEmployee,
  PERMISSION_GROUPS,
  resourceOf,
  type ActorAuthority,
} from '@/shared/rbac';
import type {
  CreateRoleRequest,
  SetEmployeeRolesRequest,
  UpdateRoleRequest,
} from '@/shared/contracts/roles/role.contract';

/** One permission, as a role editor shows it. */
export interface PermissionOption {
  readonly code: string;
  readonly description: string | null;
  /** False when the business's feature for it is not active. */
  readonly available: boolean;
  readonly featureKey: string | null;
  /** False when the person building the role does not hold it themselves. */
  readonly grantable: boolean;
}

/** A section of the role editor. */
export interface PermissionGroupView {
  readonly resource: string;
  readonly label: string;
  readonly description: string;
  readonly permissions: readonly PermissionOption[];
}

export interface RoleView {
  readonly refId: string;
  readonly name: string;
  readonly description: string | null;
  readonly level: number;
  readonly isSystem: boolean;
  readonly permissions: readonly string[];
  readonly holderCount: number;
  /** Whether THIS actor may edit it. Saves a client offering a refused button. */
  readonly editable: boolean;
  readonly assignable: boolean;
}

/**
 * Roles, as a business defines them for itself.
 *
 * EVERY WRITE HERE IS A PRIVILEGE CHANGE, which is why the authority rules are
 * applied at the top of each one rather than left to a guard. `roles.manage`
 * says who may open the role editor; it cannot say what they may put in a role,
 * and the difference between those two is the whole attack surface — a manager
 * with `roles.manage` and no further check could define a role carrying
 * `enterprise.manage`, grant it to a colleague, and have that colleague do what
 * the manager cannot.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly roles: RoleRepository,
    private readonly employees: EnterpriseEmployeeRepository,
    private readonly audit: AuditService,
    private readonly tx: TransactionManager,
    @InjectPinoLogger(RolesService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * The permission list, grouped the way somebody building a role thinks about
   * it, with each entry saying whether it is available and whether the person
   * looking may hand it out.
   *
   * UNAVAILABLE AND UNGRANTABLE ARE SHOWN, NOT HIDDEN, and they are different
   * things. "Available" is commercial — the business does not have that feature.
   * "Grantable" is structural — you do not hold it yourself. Hiding either would
   * make a role that already grants it look corrupt, and would hide from an
   * owner what buying the feature back would restore.
   */
  async permissionCatalogue(
    enterpriseId: number,
    actingEmployeeId: number | null,
  ): Promise<readonly PermissionGroupView[]> {
    const [rows, authority] = await Promise.all([
      this.roles.listAssignablePermissions(enterpriseId),
      this.authorityOf(enterpriseId, actingEmployeeId),
    ]);

    const byResource = new Map<PermissionResource, PermissionOption[]>();
    for (const row of rows) {
      const resource = resourceOf(row.code);
      // A code whose resource is not in the grouping is a catalogue that has
      // outgrown this file. Skipped rather than dropped into a fake group,
      // because an unlabelled toggle is worse than a missing one.
      if (!resource) continue;

      const options = byResource.get(resource) ?? [];
      options.push({
        code: row.code,
        description: row.description,
        available: row.featureKey === null || row.featureActive,
        featureKey: row.featureKey,
        grantable: authority.permissionCodes.has(row.code),
      });
      byResource.set(resource, options);
    }

    return [...byResource.entries()]
      .map(([resource, permissions]) => ({
        resource,
        label: PERMISSION_GROUPS[resource].label,
        description: PERMISSION_GROUPS[resource].description,
        permissions,
      }))
      .sort((a, b) => PERMISSION_GROUPS[a.resource].order - PERMISSION_GROUPS[b.resource].order);
  }

  async list(enterpriseId: number, actingEmployeeId: number | null): Promise<readonly RoleView[]> {
    const [rows, authority] = await Promise.all([
      this.roles.listDetailed(enterpriseId),
      this.authorityOf(enterpriseId, actingEmployeeId),
    ]);

    return rows.map((row) => this.toView(row, authority));
  }

  async create(
    enterpriseId: number,
    actingEmployeeId: number,
    request: CreateRoleRequest,
  ): Promise<RoleView> {
    const authority = await this.authorityOf(enterpriseId, actingEmployeeId);
    this.assertMayDefine(authority, request.level, request.permissions);

    const existing = await this.roles.findByNameInEnterprise(enterpriseId, request.name);
    if (existing) {
      throw new AppException(ErrorCode.ValidationFailed, {
        details: [{ field: 'name', issue: 'a role with this name already exists' }],
      });
    }

    const created = await this.tx.runInTransaction(async () => {
      const role = await this.roles.createRole({
        enterpriseId,
        name: request.name,
        description: request.description ?? null,
        level: request.level,
      });
      await this.roles.replaceRolePermissions(enterpriseId, role.id, request.permissions);
      return role;
    });

    await this.audit.record({
      action: AuditAction.Created,
      entityType: AuditEntityType.Role,
      entityId: created.id,
      enterpriseId,
      metadata: { name: request.name, level: request.level, permissions: request.permissions },
    });
    this.logger.info(
      { enterpriseId, level: request.level, permissionCount: request.permissions.length },
      'role created',
    );

    return this.requireView(enterpriseId, created.refId, authority);
  }

  async update(
    enterpriseId: number,
    actingEmployeeId: number,
    refId: string,
    request: UpdateRoleRequest,
  ): Promise<RoleView> {
    const authority = await this.authorityOf(enterpriseId, actingEmployeeId);
    const role = await this.roles.findAnyByRefId(enterpriseId, refId);
    if (!role) throw new AppException(ErrorCode.RoleNotFound);

    /*
     * BOTH the role as it stands and the role as it would become.
     *
     * Checking only the new state would let somebody edit a role ABOVE them
     * down to a level they outrank and walk away holding the edit — the level
     * being requested is theirs to choose, so it proves nothing about what they
     * were allowed to touch.
     */
    this.assertMayDefine(authority, role.level, role.permissionCodes, role.isSystem);
    this.assertMayDefine(authority, request.level, request.permissions, role.isSystem);

    /*
     * A rename onto an existing name is caught by `roles_enterprise_name_uniq`
     * either way, and comes back as a constraint violation. Checked here so it
     * comes back as the same field-level message `create` gives instead —
     * "a role with this name already exists" is actionable; a translated
     * constraint error is a puzzle.
     *
     * That index is also the only thing stopping a second role called `owner`,
     * which `mayAssignRole` reads by NAME. Nothing in this layer would refuse
     * it, so the guarantee rests on the database — worth knowing if the index
     * is ever touched.
     */
    const clash = await this.roles.findByNameInEnterprise(enterpriseId, request.name);
    if (clash && clash.id !== role.id) {
      throw new AppException(ErrorCode.ValidationFailed, {
        details: [{ field: 'name', issue: 'a role with this name already exists' }],
      });
    }

    await this.tx.runInTransaction(async () => {
      const affected = await this.roles.updateRole({
        enterpriseId,
        roleId: role.id,
        name: request.name,
        description: request.description ?? null,
        level: request.level,
      });
      // Zero means it is a system role; the assertion above should already have
      // refused, so this is the belt to that braces.
      if (affected === 0) throw new AppException(ErrorCode.PermissionDenied);
      await this.roles.replaceRolePermissions(enterpriseId, role.id, request.permissions);
    });

    await this.audit.record({
      action: AuditAction.Updated,
      entityType: AuditEntityType.Role,
      entityId: role.id,
      enterpriseId,
      changes: {
        level: { from: role.level, to: request.level },
        permissions: { from: role.permissionCodes, to: request.permissions },
      },
    });

    return this.requireView(enterpriseId, refId, authority);
  }

  async archive(enterpriseId: number, actingEmployeeId: number, refId: string): Promise<void> {
    const authority = await this.authorityOf(enterpriseId, actingEmployeeId);
    const role = await this.roles.findAnyByRefId(enterpriseId, refId);
    if (!role) throw new AppException(ErrorCode.RoleNotFound);

    this.assertMayDefine(authority, role.level, role.permissionCodes, role.isSystem);

    /*
     * A role somebody still holds is not archivable.
     *
     * Archiving stops it being ASSIGNED; it does not revoke it from the people
     * who have it, because the grants stay and the history with them. So
     * archiving one that is in use would quietly leave those people holding a
     * role the business believes it has retired — the worst of both.
     */
    if (role.holderCount > 0) {
      throw new AppException(ErrorCode.ValidationFailed, {
        details: [
          {
            field: 'refId',
            issue: `${role.holderCount} person(s) still hold this role; move them first`,
          },
        ],
      });
    }

    const affected = await this.roles.archiveRole(enterpriseId, role.id);
    if (affected === 0) throw new AppException(ErrorCode.PermissionDenied);

    await this.audit.record({
      action: AuditAction.Updated,
      entityType: AuditEntityType.Role,
      entityId: role.id,
      enterpriseId,
      changes: { status: { from: 'active', to: 'archived' } },
    });
  }

  /**
   * Replaces exactly which roles one person holds.
   *
   * The gap this fills: a role was set once, at invitation, and there was no
   * way to change it afterwards. A promotion meant deleting somebody and
   * inviting them again, which loses their history.
   */
  async setEmployeeRoles(
    enterpriseId: number,
    actingEmployeeId: number,
    employeeRefId: string,
    request: SetEmployeeRolesRequest,
  ): Promise<void> {
    const authority = await this.authorityOf(enterpriseId, actingEmployeeId);

    const employee = await this.employees.findAnyByRefId(enterpriseId, employeeRefId);
    if (!employee) throw new AppException(ErrorCode.EmployeeNotFound);

    // You may only re-role somebody you outrank, and never yourself — otherwise
    // this endpoint is a self-promotion button.
    const denial = mayModifyEmployee(authority, {
      employeeId: employee.employeeId,
      level: await this.roles.highestLevelForEmployee(enterpriseId, employee.employeeId),
    });
    if (denial) {
      throw new AppException(ErrorCode.PermissionDenied, {
        details: [{ field: 'employeeRefId', issue: explainDenial(denial) }],
      });
    }

    const roles = await this.roles.findManyByRefIds(enterpriseId, request.roleRefIds);
    if (roles.length !== request.roleRefIds.length) throw new AppException(ErrorCode.RoleNotFound);

    // EVERY role, not just the highest: handing somebody a junior role and a
    // senior one in the same call must not slip the senior one through.
    for (const role of roles) {
      const roleDenial = mayAssignRole(authority, role);
      if (roleDenial) {
        throw new AppException(ErrorCode.PermissionDenied, {
          details: [{ field: 'roleRefIds', issue: `${role.name}: ${explainDenial(roleDenial)}` }],
        });
      }
    }

    /*
     * THE LAST OWNER STAYS AN OWNER.
     *
     * The suspension path guards this too, and it has to be guarded here as
     * well: re-roling the final owner down to `manager` empties the business of
     * owners exactly as suspending them would, and is the quieter of the two —
     * it looks like an ordinary change of duties rather than a removal.
     *
     * Only asked when the role is actually being taken away. Somebody keeping
     * it, or never having had it, cannot reduce the count.     *
     * CURRENTLY UNREACHABLE, and kept anyway. To act on an owner you must be an
     * owner, so if there is somebody to do the acting then the target is not
     * the last one — the arithmetic cannot come out at zero today. It is here
     * because that is a property of two rules agreeing, not of this rule, and
     * the day either moves (a platform-admin path into employee management, a
     * change to who may act on whom) this is the check that stops a business
     * being emptied of owners. Cheap to ask, asked only on the two paths that
     * could ever reduce the count.
     */
    const keepsOwner = roles.some((role) => role.name === (SystemRole.Owner as string));
    if (!keepsOwner) {
      const held = await this.roles.listRoleNamesForEmployee(enterpriseId, employee.employeeId);
      if (held.includes(SystemRole.Owner)) {
        const others = await this.roles.countOtherActiveOwners(enterpriseId, employee.employeeId);
        if (others === 0) {
          throw new AppException(ErrorCode.ValidationFailed, {
            details: [
              {
                field: 'roleRefIds',
                issue: 'this is the last owner; make somebody else an owner first',
              },
            ],
          });
        }
      }
    }

    await this.tx.runInTransaction(async () => {
      await this.roles.replaceEmployeeRoles({
        enterpriseId,
        employeeId: employee.employeeId,
        roleIds: roles.map((role) => role.id),
        grantedByEmployeeId: actingEmployeeId,
      });
    });

    await this.audit.record({
      action: AuditAction.RoleGranted,
      entityType: AuditEntityType.EnterpriseEmployee,
      entityId: employee.employeeId,
      enterpriseId,
      metadata: { roles: roles.map((role) => role.name) },
    });
    this.logger.info({ enterpriseId, roleCount: roles.length }, 'employee roles replaced');
  }

  private assertMayDefine(
    authority: ActorAuthority,
    level: number,
    permissions: readonly string[],
    isSystem = false,
  ): void {
    const denial = mayDefineRole(authority, { level, permissionCodes: permissions, isSystem });
    if (denial) {
      throw new AppException(ErrorCode.PermissionDenied, {
        details: [{ field: 'permissions', issue: explainDenial(denial) }],
      });
    }
  }

  private toView(row: RoleDetailRow, authority: ActorAuthority): RoleView {
    return {
      refId: row.refId,
      name: row.name,
      description: row.description,
      level: row.level,
      isSystem: row.isSystem,
      permissions: row.permissionCodes,
      holderCount: row.holderCount,
      editable:
        mayDefineRole(authority, {
          level: row.level,
          permissionCodes: row.permissionCodes,
          isSystem: row.isSystem,
        }) === null,
      assignable: mayAssignRole(authority, row) === null,
    };
  }

  private async requireView(
    enterpriseId: number,
    refId: string,
    authority: ActorAuthority,
  ): Promise<RoleView> {
    const row = await this.roles.findAnyByRefId(enterpriseId, refId);
    if (!row) throw new AppException(ErrorCode.RoleNotFound);
    return this.toView(row, authority);
  }

  /**
   * What the acting employee may hand out.
   *
   * A staff actor has no employment and therefore no level. They are given the
   * owner's, for the same reason the employee listing does: their reach is
   * governed on the platform side, and treating them as outranking nobody would
   * make support unable to look at a role editor they are expected to help with.
   * They still cannot grant the owner role — `mayAssignRole` checks the role
   * NAMES held, and a staff actor holds none.
   */
  private async authorityOf(
    enterpriseId: number,
    employeeId: number | null,
  ): Promise<ActorAuthority> {
    if (employeeId === null) {
      return {
        employeeId: -1,
        level: ROLE_LEVEL.Owner,
        roleNames: [],
        /*
         * Their OWN resolved permissions, not everything that exists. Staff
         * hold no `employee_roles` rows, so the subset rule would be vacuous if
         * this were the full catalogue — a support agent could then write a
         * role granting more than the platform ever gave them.
         */
        permissionCodes: new Set(RequestContext.actor()?.permissions ?? []),
      };
    }
    const authority = await this.roles.authorityOfEmployee(enterpriseId, employeeId);
    return {
      employeeId,
      level: authority.level,
      roleNames: authority.roleNames,
      permissionCodes: new Set(authority.permissionCodes),
    };
  }
}
