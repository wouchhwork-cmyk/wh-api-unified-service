import { Injectable } from '@nestjs/common';
import { MemberKind, MemberStatus } from '@/shared/enums';
import { EnterpriseMember } from '../entities/enterprise-member.entity';
import { BaseRepository } from './base.repository';

/** What login needs after the password verifies: which businesses is this person in. */
export interface MembershipSummary {
  readonly memberId: number;
  readonly enterpriseId: number;
  readonly enterpriseRefId: string;
  readonly enterpriseName: string;
  readonly enterpriseSlug: string;
  readonly memberKind: MemberKind;
  readonly status: MemberStatus;
}

@Injectable()
export class EnterpriseMemberRepository extends BaseRepository {
  /**
   * The query right after password verification. Uses
   * enterprise_members_identity_idx, and joins the enterprise so the client can
   * render a picker without a second round trip.
   */
  async listActiveByIdentity(identityId: number): Promise<MembershipSummary[]> {
    return this.query<MembershipSummary>(
      `SELECT m.id            AS "memberId",
              m.enterprise_id AS "enterpriseId",
              e.ref_id        AS "enterpriseRefId",
              e.name          AS "enterpriseName",
              e.slug          AS "enterpriseSlug",
              m.member_kind   AS "memberKind",
              m.status        AS "status"
         FROM enterprise_members m
         JOIN enterprises e ON e.id = m.enterprise_id AND e.is_deleted = false
        WHERE m.identity_id = $1
          AND m.is_deleted = false
          AND m.status = $2
          AND e.status = 'active'
        ORDER BY e.name, m.id`,
      [identityId, MemberStatus.Active],
    );
  }

  /**
   * Re-checked on EVERY refresh, so removing someone takes effect within the
   * access-token lifetime rather than whenever their session happens to end.
   */
  async findActiveMembership(
    identityId: number,
    enterpriseId: number,
  ): Promise<MembershipSummary | null> {
    const rows = await this.query<MembershipSummary>(
      `SELECT m.id            AS "memberId",
              m.enterprise_id AS "enterpriseId",
              e.ref_id        AS "enterpriseRefId",
              e.name          AS "enterpriseName",
              e.slug          AS "enterpriseSlug",
              m.member_kind   AS "memberKind",
              m.status        AS "status"
         FROM enterprise_members m
         JOIN enterprises e ON e.id = m.enterprise_id AND e.is_deleted = false
        WHERE m.identity_id = $1
          AND m.enterprise_id = $2
          AND m.is_deleted = false
          AND m.status = $3
          AND e.status = 'active'
        LIMIT 1`,
      [identityId, enterpriseId, MemberStatus.Active],
    );
    return rows[0] ?? null;
  }

  async create(input: {
    identityId: number;
    enterpriseId: number;
    memberKind: MemberKind;
    status: MemberStatus;
    invitedByMemberId?: number | null;
  }): Promise<EnterpriseMember> {
    return this.guard(async () => {
      const member = this.repo(EnterpriseMember).create({
        identityId: input.identityId,
        enterpriseId: input.enterpriseId,
        memberKind: input.memberKind,
        status: input.status,
        invitedByMemberId: input.invitedByMemberId ?? null,
        joinedAt: input.status === MemberStatus.Active ? new Date() : null,
        invitedAt: input.status === MemberStatus.Invited ? new Date() : null,
      });
      return this.repo(EnterpriseMember).save(member);
    });
  }

  /** invited -> active, on accepting an invite. */
  async activate(memberId: number, enterpriseId: number): Promise<void> {
    await this.query(
      `UPDATE enterprise_members
          SET status = $3, joined_at = COALESCE(joined_at, now())
        WHERE id = $1 AND enterprise_id = $2 AND status = $4 AND is_deleted = false`,
      [memberId, this.requireEnterprise(enterpriseId), MemberStatus.Active, MemberStatus.Invited],
    );
  }

  /**
   * Resolves a member by its public refId WITHIN one enterprise, so a refId from
   * another tenant simply does not resolve — which is what stops a conversation
   * being assigned to someone outside the business.
   */
  async findByRefId(
    enterpriseId: number,
    refId: string,
  ): Promise<{ memberId: number; identityId: number } | null> {
    const rows = await this.query<{ memberId: number; identityId: number }>(
      `SELECT id AS "memberId", identity_id AS "identityId"
         FROM enterprise_members
        WHERE enterprise_id = $1 AND ref_id = $2 AND is_deleted = false AND status = $3
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), refId, MemberStatus.Active],
    );
    return rows[0] ?? null;
  }

  async touchLastActive(memberId: number, enterpriseId: number): Promise<void> {
    await this.query(
      `UPDATE enterprise_members SET last_active_at = now() WHERE id = $1 AND enterprise_id = $2`,
      [memberId, this.requireEnterprise(enterpriseId)],
    );
  }
}
