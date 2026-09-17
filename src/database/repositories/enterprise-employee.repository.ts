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
  /** Cursor material, never mapped into a DTO. */
  readonly internalId: number;
  readonly createdAt: Date;
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

/**
 * Whether an identity still stands anywhere — two counts rather than a boolean,
 * because "has no active employment" and "never had one" are different answers
 * and only the first is a revocation. AuthService.refresh() is the caller, and
 * the comment there is the rule.
 */
export interface EmploymentStanding {
  /** Employment rows on this person's record, in any status. */
  readonly employments: number;
  /** Of those, the ones login accepts: active, in a business that still exists. */
  readonly active: number;
}

export interface EmployeeRecord {
  readonly employeeId: number;
  readonly identityId: number;
  readonly status: EmployeeStatus;
  readonly employeeKind: EmployeeKind;
}

/**
 * TRUNCATED TO MILLISECONDS, in the projection, the ordering and the cursor
 * predicate alike — all three, or none.
 *
 * Postgres keeps timestamptz to the microsecond; a JS Date cannot hold one, so
 * a cursor built from a row that was stored at .993456 says .993000. Compared
 * against the untruncated column, `created_at > '.993000'` is still true of the
 * cursor row itself, and the page repeats the row it was supposed to resume
 * after. Descending listings have the mirror image of the same fault and SKIP
 * every row sharing that millisecond, which is worse for being invisible.
 *
 * Truncating the column to the precision the cursor can actually carry makes
 * the comparison exact, and the (truncated timestamp, id) order stays total.
 * The cost is that the expression cannot use a plain index on created_at —
 * affordable here, where the table holds one business's staff and the query
 * already sorts behind an aggregate.
 */
const CURSOR_TIMESTAMP = "date_trunc('milliseconds', e.created_at)";

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

  /**
   * The two counts refresh needs, in one round trip rather than two.
   *
   * `active` matches listActiveByIdentity exactly — status active, in an
   * undeleted enterprise — so refresh and login cannot disagree about what
   * standing is. The LEFT JOIN is deliberate: the foreign key means an employment
   * always has its enterprise, and joining INNER would silently drop the row
   * from `employments` too if that ever stopped being true, turning "removed"
   * into "never existed".
   *
   * Both halves stay on enterprise_employees_identity_idx, which is partial on
   * `is_deleted = false` — so an employment soft-deleted rather than suspended is
   * invisible here and reads as "never had one". Nothing in the service writes
   * is_deleted today; a removal path that starts to MUST revoke that identity's
   * sessions in the same transaction, because this query cannot see it.
   */
  async countStandingForIdentity(identityId: number): Promise<EmploymentStanding> {
    const rows = await this.query<EmploymentStanding>(
      `SELECT count(*)::int AS "employments",
              (count(*) FILTER (
                 WHERE m.status = $2::varchar AND e.is_deleted = false
               ))::int AS "active"
         FROM enterprise_employees m
         LEFT JOIN enterprises e ON e.id = m.enterprise_id
        WHERE m.identity_id = $1
          AND m.is_deleted = false`,
      [identityId, EmployeeStatus.Active],
    );
    // An aggregate always returns a row; the fallback is so a shape that
    // somehow did not cannot read as standing.
    return rows[0] ?? { employments: 0, active: 0 };
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
   *
   * Keyset-paginated on (created_at, id), OLDEST FIRST — the order a business
   * expects of its own people, with the owner at the top.
   *
   * The id is the tiebreaker that makes the order total. Two colleagues invited
   * in the same millisecond could otherwise swap places between pages, and one
   * of them would never be shown at all — which on this listing means somebody
   * who works here being invisible to the person managing access.
   */
  async listForEnterprise(
    enterpriseId: number,
    options: {
      includeSupport: boolean;
      limit: number;
      cursor: { createdAt: Date; id: number } | null;
    },
  ): Promise<EmployeeListRow[]> {
    const params: unknown[] = [this.requireEnterprise(enterpriseId), options.limit];
    let kindPredicate = '';
    if (!options.includeSupport) {
      params.push(EmployeeKind.Business);
      kindPredicate = `AND e.employee_kind = $${params.length}::varchar`;
    }

    let cursorPredicate = '';
    if (options.cursor) {
      params.push(options.cursor.createdAt, options.cursor.id);
      // Ascending order, so the next page resumes AFTER the cursor row.
      cursorPredicate =
        `AND (${CURSOR_TIMESTAMP}, e.id) > ` +
        `($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
    }

    return this.query<EmployeeListRow>(
      `SELECT e.id            AS "internalId",
              ${CURSOR_TIMESTAMP} AS "createdAt",
              e.ref_id        AS "refId",
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
        WHERE e.enterprise_id = $1 AND e.is_deleted = false ${kindPredicate} ${cursorPredicate}
        GROUP BY e.id, i.id
        ORDER BY ${CURSOR_TIMESTAMP} ASC, e.id ASC
        LIMIT $2`,
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
