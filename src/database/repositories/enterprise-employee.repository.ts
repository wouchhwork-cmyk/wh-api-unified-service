import { Injectable } from '@nestjs/common';
import { EmployeeKind, EmployeeStatus } from '@/shared/enums';
import { EnterpriseEmployee } from '../entities/enterprise-employee.entity';
import { BaseRepository } from './base.repository';

/** What login needs after the password verifies: which businesses is this person in. */
export interface EmploymentSummary {
  readonly employeeId: number;
  readonly enterpriseId: number;
  readonly enterpriseRefId: string;
  readonly enterpriseName: string;
  readonly enterpriseSlug: string;
  readonly employeeKind: EmployeeKind;
  readonly status: EmployeeStatus;
}

/*
 * These queries answer ONE question: is this person a employee of this business.
 *
 * They deliberately do NOT filter on the enterprise's own status. Doing so used
 * to make a suspended business's employment disappear, which surfaced to its
 * owner as AUTH_NO_ACTIVE_EMPLOYMENT — "this account has no active business" —
 * when the truth was "your business is suspended". Whether a business may be
 * USED is a separate question, answered per request by EnterpriseActiveGuard,
 * which can say which of pending_activation or suspended applies.
 */
export interface EmployeeListRow {
  readonly refId: string;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly mobile: string | null;
  readonly emailVerified: boolean;
  readonly mobileVerified: boolean;
  readonly lastLoginAt: Date | null;
  readonly employeeKind: EmployeeKind;
  readonly status: EmployeeStatus;
  readonly invitedAt: Date | null;
  readonly joinedAt: Date | null;
  readonly lastActiveAt: Date | null;
  readonly roles: string[];
}

export interface EmployeeRecord {
  readonly employeeId: number;
  readonly identityId: number;
  readonly status: EmployeeStatus;
  readonly employeeKind: EmployeeKind;
}

@Injectable()
export class EnterpriseEmployeeRepository extends BaseRepository {
  /**
   * The query right after password verification. Uses
   * enterprise_employees_identity_idx, and joins the enterprise so the client can
   * render a picker without a second round trip.
   */
  async listActiveByIdentity(identityId: number): Promise<EmploymentSummary[]> {
    return this.query<EmploymentSummary>(
      `SELECT m.id            AS "employeeId",
              m.enterprise_id AS "enterpriseId",
              e.ref_id        AS "enterpriseRefId",
              e.name          AS "enterpriseName",
              e.slug          AS "enterpriseSlug",
              m.employee_kind   AS "employeeKind",
              m.status        AS "status"
         FROM enterprise_employees m
         JOIN enterprises e ON e.id = m.enterprise_id AND e.is_deleted = false
        WHERE m.identity_id = $1
          AND m.is_deleted = false
          AND m.status = $2
        ORDER BY e.name, m.id`,
      [identityId, EmployeeStatus.Active],
    );
  }

  /**
   * Re-checked on EVERY refresh, so removing someone takes effect within the
   * access-token lifetime rather than whenever their session happens to end.
   */
  async findActiveEmployment(
    identityId: number,
    enterpriseId: number,
  ): Promise<EmploymentSummary | null> {
    const rows = await this.query<EmploymentSummary>(
      `SELECT m.id            AS "employeeId",
              m.enterprise_id AS "enterpriseId",
              e.ref_id        AS "enterpriseRefId",
              e.name          AS "enterpriseName",
              e.slug          AS "enterpriseSlug",
              m.employee_kind   AS "employeeKind",
              m.status        AS "status"
         FROM enterprise_employees m
         JOIN enterprises e ON e.id = m.enterprise_id AND e.is_deleted = false
        WHERE m.identity_id = $1
          AND m.enterprise_id = $2
          AND m.is_deleted = false
          AND m.status = $3
        LIMIT 1`,
      [identityId, enterpriseId, EmployeeStatus.Active],
    );
    return rows[0] ?? null;
  }

  async create(input: {
    identityId: number;
    enterpriseId: number;
    employeeKind: EmployeeKind;
    status: EmployeeStatus;
    invitedByEmployeeId?: number | null;
  }): Promise<EnterpriseEmployee> {
    return this.guard(async () => {
      const employee = this.repo(EnterpriseEmployee).create({
        identityId: input.identityId,
        enterpriseId: input.enterpriseId,
        employeeKind: input.employeeKind,
        status: input.status,
        invitedByEmployeeId: input.invitedByEmployeeId ?? null,
        joinedAt: input.status === EmployeeStatus.Active ? new Date() : null,
        invitedAt: input.status === EmployeeStatus.Invited ? new Date() : null,
      });
      return this.repo(EnterpriseEmployee).save(employee);
    });
  }

  /** invited -> active, on accepting an invite. */
  async activate(employeeId: number, enterpriseId: number): Promise<void> {
    await this.query(
      `UPDATE enterprise_employees
          SET status = $3, joined_at = COALESCE(joined_at, now())
        WHERE id = $1 AND enterprise_id = $2 AND status = $4 AND is_deleted = false`,
      [
        employeeId,
        this.requireEnterprise(enterpriseId),
        EmployeeStatus.Active,
        EmployeeStatus.Invited,
      ],
    );
  }

  /**
   * Resolves a employee by its public refId WITHIN one enterprise, so a refId from
   * another tenant simply does not resolve — which is what stops a conversation
   * being assigned to someone outside the business.
   */
  async findByRefId(
    enterpriseId: number,
    refId: string,
  ): Promise<{ employeeId: number; identityId: number } | null> {
    const rows = await this.query<{ employeeId: number; identityId: number }>(
      `SELECT id AS "employeeId", identity_id AS "identityId"
         FROM enterprise_employees
        WHERE enterprise_id = $1 AND ref_id = $2 AND is_deleted = false AND status = $3
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), refId, EmployeeStatus.Active],
    );
    return rows[0] ?? null;
  }

  /**
   * The people who work here, with their roles.
   *
   * One query with an aggregate rather than a query per employee: a business with
   * forty people would otherwise be forty-one round trips to render one screen.
   */
  async listForEnterprise(
    enterpriseId: number,
    options: { includeSupport: boolean },
  ): Promise<EmployeeListRow[]> {
    const params: unknown[] = [this.requireEnterprise(enterpriseId)];
    let kindPredicate = '';
    if (!options.includeSupport) {
      params.push(EmployeeKind.Business);
      kindPredicate = `AND e.employee_kind = $${params.length}::varchar`;
    }

    return this.query<EmployeeListRow>(
      `SELECT e.ref_id        AS "refId",
              i.first_name    AS "firstName",
              i.last_name     AS "lastName",
              i.email         AS "email",
              i.mobile        AS "mobile",
              (i.email_verified_at IS NOT NULL)  AS "emailVerified",
              (i.mobile_verified_at IS NOT NULL) AS "mobileVerified",
              i.last_login_at AS "lastLoginAt",
              e.employee_kind AS "employeeKind",
              e.status        AS "status",
              e.invited_at    AS "invitedAt",
              e.joined_at     AS "joinedAt",
              e.last_active_at AS "lastActiveAt",
              COALESCE(
                array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL),
                '{}'
              )               AS "roles"
         FROM enterprise_employees e
         JOIN identities i ON i.id = e.identity_id AND i.is_deleted = false
         LEFT JOIN employee_roles er
                ON er.employee_id = e.id AND er.enterprise_id = e.enterprise_id
               AND er.is_deleted = false
         LEFT JOIN roles r ON r.id = er.role_id AND r.enterprise_id = er.enterprise_id
        WHERE e.enterprise_id = $1 AND e.is_deleted = false ${kindPredicate}
        GROUP BY e.id, i.id
        ORDER BY e.created_at ASC, e.id ASC`,
      params,
    );
  }

  /**
   * Any employee by refId, whatever their status.
   *
   * Separate from findByRefId, which is active-only because it serves assignment:
   * you cannot hand a conversation to somebody who has been suspended. Managing
   * that person, on the other hand, requires being able to see them.
   */
  async findAnyByRefId(enterpriseId: number, refId: string): Promise<EmployeeRecord | null> {
    const rows = await this.query<EmployeeRecord>(
      `SELECT id AS "employeeId", identity_id AS "identityId",
              status AS "status", employee_kind AS "employeeKind"
         FROM enterprise_employees
        WHERE enterprise_id = $1 AND ref_id = $2 AND is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), refId],
    );
    return rows[0] ?? null;
  }

  /**
   * The public ref for one of our own employee ids.
   *
   * Exists so /auth/me can tell a client WHO it is. Without it the inbox could
   * not offer "assign this to me" — the assign endpoint speaks in refIds, and the
   * client had no way to learn its own.
   */
  async refIdOf(enterpriseId: number, employeeId: number): Promise<string | null> {
    const rows = await this.query<{ refId: string }>(
      `SELECT ref_id AS "refId" FROM enterprise_employees
        WHERE enterprise_id = $1 AND id = $2 AND is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), employeeId],
    );
    return rows[0]?.refId ?? null;
  }

  /** Is this identity already on this business's books, in any state? */
  async findByIdentity(enterpriseId: number, identityId: number): Promise<EmployeeRecord | null> {
    const rows = await this.query<EmployeeRecord>(
      `SELECT id AS "employeeId", identity_id AS "identityId",
              status AS "status", employee_kind AS "employeeKind"
         FROM enterprise_employees
        WHERE enterprise_id = $1 AND identity_id = $2 AND is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), identityId],
    );
    return rows[0] ?? null;
  }

  /**
   * Moves an employee between statuses, conditional on the one they are in.
   *
   * Conditional so two managers acting at once cannot both believe they won: the
   * second update matches nothing and the caller is told, rather than the later
   * write quietly overwriting the earlier.
   */
  async setStatus(
    enterpriseId: number,
    employeeId: number,
    from: EmployeeStatus,
    to: EmployeeStatus,
  ): Promise<boolean> {
    const { affected } = await this.mutate(
      `UPDATE enterprise_employees
          SET status = $4::varchar,
              joined_at = CASE WHEN $4::varchar = $5::varchar THEN COALESCE(joined_at, now())
                               ELSE joined_at END,
              updated_at = now()
        WHERE id = $2 AND enterprise_id = $1 AND status = $3::varchar AND is_deleted = false`,
      [this.requireEnterprise(enterpriseId), employeeId, from, to, EmployeeStatus.Active],
    );
    return affected > 0;
  }

  async touchLastActive(employeeId: number, enterpriseId: number): Promise<void> {
    await this.query(
      `UPDATE enterprise_employees SET last_active_at = now() WHERE id = $1 AND enterprise_id = $2`,
      [employeeId, this.requireEnterprise(enterpriseId)],
    );
  }
}
