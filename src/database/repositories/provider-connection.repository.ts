import { Injectable } from '@nestjs/common';
import { ConnectionStatus, Provider, ProviderCategory, TokenStatus } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface UpsertConnectionInput {
  readonly enterpriseId: number;
  readonly provider: Provider;
  readonly providerCategory: ProviderCategory;
  readonly providerUserId: string;
  readonly providerUserName: string | null;
  /** Already an encrypted envelope — this layer never sees a plaintext token. */
  readonly accessToken: string;
  readonly tokenExpiresAt: Date | null;
  readonly grantedScopes: string | null;
  readonly connectedByEmployeeId: number | null;
}

export interface ConnectionRow {
  readonly id: number;
  readonly refId: string;
  readonly accessToken: string;
  readonly tokenExpiresAt: Date | null;
  readonly reauthRequired: boolean;
  readonly status: ConnectionStatus;
}

@Injectable()
export class ProviderConnectionRepository extends BaseRepository {
  /**
   * Reconnecting must UPDATE the existing row, not create a second connection —
   * which is why provider_connections_uniq has NO is_deleted predicate. The
   * conflict target matches that index exactly.
   *
   * A reconnect also clears reauth_required and restores status: that is the
   * whole point of the user going through the dialog again.
   */
  async upsert(input: UpsertConnectionInput): Promise<{ id: number; refId: string }> {
    const { rows } = await this.mutate<{ id: number; ref_id: string }>(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, provider_user_name,
          access_token, token_expires_at, token_status, reauth_required, granted_scopes,
          connected_by_employee_id, status, is_deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10, $11, false)
       ON CONFLICT (enterprise_id, provider, provider_user_id)
       DO UPDATE SET
         provider_user_name     = EXCLUDED.provider_user_name,
         access_token           = EXCLUDED.access_token,
         token_expires_at       = EXCLUDED.token_expires_at,
         token_status           = EXCLUDED.token_status,
         reauth_required        = false,
         reauth_notified_at     = NULL,
         granted_scopes         = EXCLUDED.granted_scopes,
         connected_by_employee_id = EXCLUDED.connected_by_employee_id,
         status                 = EXCLUDED.status,
         is_deleted             = false
       RETURNING id, ref_id`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.provider,
        input.providerCategory,
        input.providerUserId,
        input.providerUserName,
        input.accessToken,
        input.tokenExpiresAt,
        TokenStatus.Valid,
        input.grantedScopes,
        input.connectedByEmployeeId,
        ConnectionStatus.Active,
      ],
    );

    const row = rows[0];
    if (!row) throw new Error('provider_connections upsert returned no row');
    return { id: row.id, refId: row.ref_id };
  }

  async findByRefId(enterpriseId: number, refId: string): Promise<ConnectionRow | null> {
    const rows = await this.query<ConnectionRow>(
      `SELECT id, ref_id AS "refId", access_token AS "accessToken",
              token_expires_at AS "tokenExpiresAt", reauth_required AS "reauthRequired", status
         FROM provider_connections
        WHERE enterprise_id = $1 AND ref_id = $2 AND is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), refId],
    );
    return rows[0] ?? null;
  }

  async listForEnterprise(enterpriseId: number): Promise<
    {
      refId: string;
      provider: string;
      providerUserName: string | null;
      status: string;
      reauthRequired: boolean;
      tokenExpiresAt: Date | null;
    }[]
  > {
    return this.query(
      `SELECT ref_id AS "refId", provider, provider_user_name AS "providerUserName",
              status, reauth_required AS "reauthRequired", token_expires_at AS "tokenExpiresAt"
         FROM provider_connections
        WHERE enterprise_id = $1 AND is_deleted = false
        ORDER BY created_at DESC`,
      [this.requireEnterprise(enterpriseId)],
    );
  }

  /**
   * A live auth error beats the calendar: providers revoke early on a password
   * change or an app removal, so a 401 marks the row immediately instead of
   * waiting for the expiry sweep. Flagging the parent CASCADES to its channels,
   * because channel tokens derive from this grant.
   */
  async markReauthRequired(
    enterpriseId: number,
    connectionId: number,
    status: ConnectionStatus,
  ): Promise<void> {
    // enterprise_id in BOTH statements: this was the one tenant-scoped write in
    // the repository layer without it, which meant a mistyped id could revoke
    // another tenant's connection and the database could not object.
    const enterprise = this.requireEnterprise(enterpriseId);

    await this.mutate(
      `UPDATE provider_connections
          SET reauth_required = true, token_status = $2, status = $3
        WHERE id = $1 AND enterprise_id = $4`,
      [connectionId, TokenStatus.Revoked, status, enterprise],
    );
    await this.mutate(
      `UPDATE channels SET reauth_required = true, token_status = $2
        WHERE provider_connection_id = $1 AND enterprise_id = $3 AND is_deleted = false`,
      [connectionId, TokenStatus.Revoked, enterprise],
    );
  }
}
