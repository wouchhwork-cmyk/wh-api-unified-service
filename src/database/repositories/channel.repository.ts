import { Injectable } from '@nestjs/common';
import { ChannelKind, ChannelStatus, Platform, TokenStatus } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface UpsertChannelInput {
  readonly enterpriseId: number;
  readonly providerConnectionId: number;
  readonly parentChannelId: number | null;
  readonly platform: Platform;
  readonly channelKind: ChannelKind;
  readonly platformChannelId: string;
  readonly name: string | null;
  readonly username: string | null;
  /** An encrypted envelope, or null where the platform has no channel token. */
  readonly accessToken: string | null;
  readonly tokenStatus: TokenStatus;
  readonly metadata: Record<string, unknown>;
  readonly status: ChannelStatus;
}

export interface ChannelRow {
  readonly id: number;
  readonly refId: string;
  readonly platform: Platform;
  readonly channelKind: ChannelKind;
  readonly platformChannelId: string;
  readonly name: string | null;
  readonly username: string | null;
  readonly status: ChannelStatus;
  readonly reauthRequired: boolean;
  readonly isManaged: boolean;
  readonly parentChannelId: number | null;
  /** null = this Page is not subscribed, so no events will arrive. */
  readonly webhookSubscribedAt: Date | null;
}

/** What the send path needs: the token that actually authorises the call. */
export interface ChannelSendContext {
  readonly channelId: number;
  /**
   * The PARENT connection's id. Carried because flagging a dead credential
   * targets provider_connections, and passing a channels.id there would update
   * an unrelated row — both ids are BIGSERIAL and both are `number`, so nothing
   * else would catch the swap.
   */
  readonly providerConnectionId: number;
  readonly platform: Platform;
  readonly platformChannelId: string;
  /**
   * The linked Page's platform id, when this channel hangs off one.
   *
   * Needed for SENDING, not just reading: an Instagram direct message is
   * addressed to the Page, never to the Instagram account. Posting to the
   * Instagram id returns "(#3) Application does not have the capability to make
   * this API call" — which reads like a missing app permission and sent us
   * looking in the wrong place entirely.
   */
  readonly parentPlatformChannelId: string | null;
  /** The channel's own token, or its parent's — Instagram uses the Page token. */
  readonly effectiveAccessToken: string | null;
  readonly reauthRequired: boolean;
  readonly isManaged: boolean;
}

/**
 * What a backfill needs, which is the send context PLUS the parent's platform
 * id: Instagram threads are read from the linked PAGE's conversations edge
 * (`/{page-id}/conversations?platform=instagram`), so the Instagram channel
 * alone cannot address its own inbox.
 */
export interface ChannelBackfillContext {
  readonly channelId: number;
  readonly platform: Platform;
  readonly platformChannelId: string;
  readonly parentPlatformChannelId: string | null;
  readonly effectiveAccessToken: string | null;
  readonly reauthRequired: boolean;
}

@Injectable()
export class ChannelRepository extends BaseRepository {
  /**
   * Conflict target matches channels_platform_uniq exactly — no is_deleted
   * predicate, because a re-synced Page must reuse its row rather than create a
   * second one.
   */
  async upsert(input: UpsertChannelInput): Promise<{ id: number; refId: string }> {
    const { rows } = await this.mutate<{ id: number; ref_id: string }>(
      `INSERT INTO channels
         (enterprise_id, provider_connection_id, parent_channel_id, platform, channel_kind,
          platform_channel_id, name, username, access_token, token_status, metadata,
          status, reauth_required, is_deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, false)
       ON CONFLICT (platform, platform_channel_id, provider_connection_id)
       DO UPDATE SET
         parent_channel_id = EXCLUDED.parent_channel_id,
         name              = EXCLUDED.name,
         username          = EXCLUDED.username,
         -- Never overwrite a good token with NULL: the fallback discovery path
         -- can legitimately return a page without one.
         access_token      = COALESCE(EXCLUDED.access_token, channels.access_token),
         token_status      = EXCLUDED.token_status,
         metadata          = EXCLUDED.metadata,
         status            = EXCLUDED.status,
         reauth_required   = false,
         is_deleted        = false
       RETURNING id, ref_id`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.providerConnectionId,
        input.parentChannelId,
        input.platform,
        input.channelKind,
        input.platformChannelId,
        input.name,
        input.username,
        input.accessToken,
        input.tokenStatus,
        JSON.stringify(input.metadata),
        input.status,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('channels upsert returned no row');
    return { id: row.id, refId: row.ref_id };
  }

  async listForEnterprise(enterpriseId: number): Promise<ChannelRow[]> {
    return this.query<ChannelRow>(
      `SELECT id, ref_id AS "refId", platform, channel_kind AS "channelKind",
              platform_channel_id AS "platformChannelId", name, username, status,
              reauth_required AS "reauthRequired", is_managed AS "isManaged",
              parent_channel_id AS "parentChannelId",
              webhook_subscribed_at AS "webhookSubscribedAt"
         FROM channels
        WHERE enterprise_id = $1 AND is_deleted = false
        ORDER BY platform, name NULLS LAST`,
      [this.requireEnterprise(enterpriseId)],
    );
  }

  /**
   * Resolves the token a send should use.
   *
   * COALESCE across the parent is the Meta requirement made concrete: an
   * Instagram professional account is reached THROUGH its linked Facebook Page,
   * and the PAGE token is what authorises the call. Without this join the send
   * path cannot find a usable credential for Instagram at all.
   */
  async findSendContext(
    enterpriseId: number,
    channelId: number,
  ): Promise<ChannelSendContext | null> {
    const rows = await this.query<ChannelSendContext>(
      `SELECT c.id                                            AS "channelId",
              c.provider_connection_id                        AS "providerConnectionId",
              c.platform,
              c.platform_channel_id                           AS "platformChannelId",
              parent.platform_channel_id                      AS "parentPlatformChannelId",
              COALESCE(c.access_token, parent.access_token)    AS "effectiveAccessToken",
              (c.reauth_required OR COALESCE(parent.reauth_required, false)) AS "reauthRequired",
              c.is_managed                                    AS "isManaged"
         FROM channels c
         LEFT JOIN channels parent
                ON parent.id = c.parent_channel_id
               AND parent.enterprise_id = c.enterprise_id
        WHERE c.enterprise_id = $1 AND c.id = $2 AND c.is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), channelId],
    );
    return rows[0] ?? null;
  }

  /**
   * Resolves an inbound webhook's Page/IG id to EVERY channel that holds it.
   *
   * Deliberately NOT tenant-scoped: a webhook arrives with no tenant context,
   * and this lookup is how the enterprise is DERIVED. Every subsequent query
   * uses an enterpriseId returned here.
   *
   * It returns a LIST because channels_platform_uniq is
   * (platform, platform_channel_id, provider_connection_id) — no enterprise
   * component — so the same Page legitimately exists once per connecting
   * enterprise. schema.md names the case: an agency and the brand it manages can
   * both connect the same Page, and each must process the event independently.
   * Taking only the first row silently dropped every other tenant's copy.
   */
  async findAllByPlatformId(
    platform: Platform,
    platformChannelId: string,
  ): Promise<{ id: number; enterpriseId: number }[]> {
    return this.query<{ id: number; enterpriseId: number }>(
      `SELECT id, enterprise_id AS "enterpriseId" FROM channels
        WHERE platform = $1 AND platform_channel_id = $2 AND is_deleted = false
        ORDER BY id`,
      [platform, platformChannelId],
    );
  }

  /**
   * Records that a Page is subscribed and will receive events.
   *
   * Stamped only on success, so null keeps meaning "receives nothing yet" rather
   * than "we are not sure".
   */
  async markWebhookSubscribed(enterpriseId: number, channelId: number): Promise<void> {
    await this.mutate(
      `UPDATE channels SET webhook_subscribed_at = now(), updated_at = now()
        WHERE enterprise_id = $1 AND id = $2 AND is_deleted = false`,
      [this.requireEnterprise(enterpriseId), channelId],
    );
  }

  async markStatus(enterpriseId: number, channelId: number, status: ChannelStatus): Promise<void> {
    await this.mutate(`UPDATE channels SET status = $3 WHERE enterprise_id = $1 AND id = $2`, [
      this.requireEnterprise(enterpriseId),
      channelId,
      status,
    ]);
  }

  /**
   * Resolves a channel for backfill: its own platform id, its PARENT's platform
   * id, and the token that authorises calls for it.
   *
   * Separate from findSendContext rather than widening it, because the send path
   * is the hot path and has no use for the parent's platform id.
   */
  async findBackfillContext(
    enterpriseId: number,
    channelId: number,
  ): Promise<ChannelBackfillContext | null> {
    const rows = await this.query<ChannelBackfillContext>(
      `SELECT c.id                                            AS "channelId",
              c.platform,
              c.platform_channel_id                           AS "platformChannelId",
              parent.platform_channel_id                      AS "parentPlatformChannelId",
              COALESCE(c.access_token, parent.access_token)    AS "effectiveAccessToken",
              (c.reauth_required OR COALESCE(parent.reauth_required, false)) AS "reauthRequired"
         FROM channels c
         LEFT JOIN channels parent
                ON parent.id = c.parent_channel_id
               AND parent.enterprise_id = c.enterprise_id
        WHERE c.enterprise_id = $1 AND c.id = $2 AND c.is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), channelId],
    );
    return rows[0] ?? null;
  }

  /**
   * Resolves a channel ref_id WITHIN a tenant.
   *
   * The enterprise predicate is the whole point: a ref_id belonging to another
   * business must resolve to nothing, so a filter parameter can never become a
   * way to read across the boundary.
   */
  async findByRefId(enterpriseId: number, refId: string): Promise<{ id: number } | null> {
    const rows = await this.query<{ id: number }>(
      `SELECT id FROM channels
        WHERE enterprise_id = $1 AND ref_id = $2 AND is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), refId],
    );
    return rows[0] ?? null;
  }

  /**
   * Every channel a scheduler should refresh, across all tenants.
   *
   * NOT tenant-scoped, and it cannot be: a cron belongs to no business. Safe
   * because it returns only the ids a job needs, and every job it enqueues
   * carries the enterprise_id from this row — so the tenant is re-established
   * before anything is read or written.
   */
  async listAllForRefresh(limit: number): Promise<{ id: number; enterpriseId: number }[]> {
    return this.query<{ id: number; enterpriseId: number }>(
      `SELECT id, enterprise_id AS "enterpriseId"
         FROM channels
        WHERE is_deleted = false
          AND is_managed = true
          AND reauth_required = false
          AND status = $1
        ORDER BY COALESCE(profile_synced_at, to_timestamp(0)), id
        LIMIT $2`,
      [ChannelStatus.Active, limit],
    );
  }

  /**
   * Writes back what a profile refresh learned.
   *
   * COALESCE on every field: a refresh that could not read the follower count
   * must not zero the one we hold. profile_synced_at moves regardless, because
   * the attempt happened and the scheduler orders on it — without that a channel
   * whose profile never resolves would be retried ahead of everything else
   * forever.
   */
  async updateProfile(input: {
    enterpriseId: number;
    channelId: number;
    name: string | null;
    username: string | null;
    followerCount: number | null;
    profilePictureUrl: string | null;
  }): Promise<void> {
    await this.mutate(
      `UPDATE channels
          SET name                = COALESCE($3, name),
              username            = COALESCE($4, username),
              follower_count      = COALESCE($5, follower_count),
              profile_picture_url = COALESCE($6, profile_picture_url),
              profile_synced_at   = now(),
              updated_at          = now()
        WHERE enterprise_id = $1 AND id = $2 AND is_deleted = false`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.channelId,
        input.name,
        input.username,
        input.followerCount,
        input.profilePictureUrl,
      ],
    );
  }
}
