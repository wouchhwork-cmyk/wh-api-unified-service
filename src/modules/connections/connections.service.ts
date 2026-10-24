import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Platform, Provider } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import { PROVIDER_CONNECTORS, type ProviderConnector } from './provider-connector';
import { ChannelRepository, type ChannelRow } from '@/database/repositories/channel.repository';
import { ProviderConnectionRepository } from '@/database/repositories/provider-connection.repository';
import { GraphApiClient } from './graph/graph-api.client';
import { TransactionManager } from '@/database/transaction/transaction.manager';
import { TokenCipherService } from '@/shared/crypto';
import { AuditService } from '@/modules/audit';
import { AuditAction, AuditEntityType, ConnectionStatus } from '@/shared/enums';

export interface StartedConnection {
  readonly provider: Provider;
  readonly authorizationUrl: string;
}

/**
 * Starting a connection, for whichever platform was asked for.
 *
 * The provider arrives from the client, so the ONLY thing that decides what runs
 * is this registry — never a string interpolated into a path or a class name.
 * An unimplemented provider gets a distinct answer from an unknown one: the
 * first is our gap, the second is the caller's mistake, and telling them apart
 * is the difference between "coming soon" and "you sent nonsense".
 */
/** What a client sees of a provider connection. No internal ids, no tokens. */
export interface ConnectionDto {
  readonly refId: string;
  readonly provider: string;
  readonly providerUserName: string | null;
  readonly status: string;
  readonly reauthRequired: boolean;
  readonly tokenExpiresAt: Date | null;
}

/** Likewise for a channel. `parentChannelRefId`, never the numeric parent id. */
export interface ChannelDto {
  readonly refId: string;
  readonly platform: string;
  readonly channelKind: string;
  readonly name: string | null;
  readonly username: string | null;
  readonly status: string;
  readonly reauthRequired: boolean;
  readonly isManaged: boolean;
  readonly webhookSubscribedAt: Date | null;
  readonly parentChannelRefId: string | null;
  /**
   * What Meta says this account IS, as opposed to how we have it configured.
   *
   * Collected by the daily profile refresh since the capability sweep widened
   * it (platform-limitations 0.6: the Page node refused none of 26 fields while
   * we were asking for four) and never once read back, so none of it reached
   * anybody. The shape differs by platform because the platforms differ — a
   * Page has a rating and a category, an Instagram account has neither.
   */
  readonly profile: ChannelProfileDto;
}

export interface DisconnectResult {
  readonly connectionRefId: string;
  readonly channelsDisconnected: number;
}

export interface ChannelProfileDto {
  readonly description: string | null;
  readonly pictureUrl: string | null;
  readonly followerCount: number | null;
  readonly postCount: number | null;
  /** null = never refreshed, which is different from "has no followers". */
  readonly syncedAt: Date | null;
  /** Page-only, and null on Instagram rather than absent. */
  readonly category: string | null;
  readonly link: string | null;
  readonly verificationStatus: string | null;
  readonly ratingCount: number | null;
  readonly starRating: number | null;
}

/**
 * Reads one typed value out of the metadata bag.
 *
 * NARROWED RATHER THAN CAST, because this bag is written from whatever Meta
 * returned: a field can be absent, null, or a type we did not expect, and a
 * cast would hand all three to a client as though they were the real thing.
 */
function metaValue<T extends string | number>(
  metadata: Record<string, unknown>,
  key: string,
  kind: 'string' | 'number',
): T | null {
  const value = metadata[key];
  return typeof value === kind ? (value as T) : null;
}

function toProfile(channel: ChannelRow): ChannelProfileDto {
  const metadata = channel.metadata ?? {};
  return {
    description: channel.description,
    pictureUrl: channel.profilePictureUrl,
    followerCount: channel.followerCount,
    postCount: channel.postCount,
    syncedAt: channel.profileSyncedAt,
    category: metaValue<string>(metadata, 'category', 'string'),
    link: metaValue<string>(metadata, 'pageLink', 'string'),
    verificationStatus: metaValue<string>(metadata, 'verificationStatus', 'string'),
    ratingCount: metaValue<number>(metadata, 'ratingCount', 'number'),
    starRating: metaValue<number>(metadata, 'starRating', 'number'),
  };
}

@Injectable()
export class ConnectionsService {
  private readonly connectors: ReadonlyMap<Provider, ProviderConnector>;

  constructor(
    @Inject(PROVIDER_CONNECTORS) connectors: readonly ProviderConnector[],
    private readonly connections: ProviderConnectionRepository,
    private readonly channels: ChannelRepository,
    private readonly graph: GraphApiClient,
    private readonly cipher: TokenCipherService,
    private readonly tx: TransactionManager,
    private readonly audit: AuditService,
    @InjectPinoLogger(ConnectionsService.name) private readonly logger: PinoLogger,
  ) {
    this.connectors = new Map(connectors.map((connector) => [connector.provider, connector]));
  }

  /**
   * Disconnects a connection, and everything under it.
   *
   * WHAT THIS DOES NOT DO IS THE IMPORTANT PART. Not one message,
   * conversation, customer or post is touched. Disconnecting says "stop acting
   * for me", not "forget what happened" — a business that disconnects still
   * owns its history, and is often disconnecting precisely so it can hand the
   * account somewhere else without losing it.
   *
   * It exists because A2 made reconnecting a Page impossible while an old
   * connection held it, and there was no way to release one — so a business
   * that had lost its original Facebook login was locked out of its own Page
   * with no exit. Shipping the refusal before the release was a deliberate
   * decision on 19 Sep; this is the other half.
   *
   * THE ORDER MATTERS. Meta is told first, while we still hold a usable token;
   * the local write clears those tokens, and after it there is nothing left to
   * authenticate an unsubscribe with. A failure out there is logged and does
   * not stop the disconnect: the guards in the repository are what actually
   * make a disconnected channel inert, and a business asking us to let go must
   * not be blocked by Meta being unreachable.
   */
  async disconnect(enterpriseId: number, connectionRefId: string): Promise<DisconnectResult> {
    const connection = await this.connections.findByRefId(enterpriseId, connectionRefId);
    if (!connection) throw new AppException(ErrorCode.ConnectionNotFound);

    const channels = await this.channels.listForConnection(enterpriseId, connection.id);
    for (const channel of channels) {
      await this.unsubscribeQuietly(channel, enterpriseId);
    }

    /*
     * ONE TRANSACTION, because a connection marked revoked whose channels still
     * hold live tokens is the worst of both states: the business is told it has
     * disconnected while the relay can still send for them.
     */
    const disconnected = await this.tx.runInTransaction(async () => {
      const count = await this.channels.disconnectForConnection(enterpriseId, connection.id);
      await this.connections.revoke(enterpriseId, connection.id);

      /*
       * INSIDE the transaction, with the writes it describes.
       *
       * This sat after the commit, arguing that an audit row claiming a
       * disconnect that rolled back is worse than none. The premise was right
       * and the placement did not follow from it: `AuditService` joins the
       * ambient transaction, so a row written here rolls back WITH the
       * disconnect and can never claim anything that did not happen. After the
       * commit was the placement that could lose the row, not the one that
       * could invent it.
       *
       * The record matters: this withdraws a business's authority over its own
       * Instagram, clears live tokens and stops every future delivery, and
       * nothing recorded who did it. The channel count travels with it —
       * "they disconnected" and "they disconnected eleven channels" are
       * different events to whoever reads this later. Names and tokens stay
       * out of `changes`.
       */
      await this.audit.record({
        action: AuditAction.Disconnected,
        entityType: AuditEntityType.ProviderConnection,
        entityId: connection.id,
        enterpriseId,
        changes: { status: { from: connection.status, to: ConnectionStatus.Revoked } },
        metadata: { channelsDisconnected: count },
      });

      return count;
    });

    this.logger.info(
      { enterpriseId, connectionRefId, channelsDisconnected: disconnected },
      'connection disconnected — data retained, authority withdrawn',
    );
    return { connectionRefId, channelsDisconnected: disconnected };
  }

  /**
   * Best effort, and deliberately silent about failure.
   *
   * A dead token, a Page already removed, Meta being down — none of them are
   * reasons to refuse a business permission to disconnect. Logged at `warn`
   * because it does mean Meta may keep delivering for a while, which the
   * ingest guard then drops.
   */
  private async unsubscribeQuietly(
    channel: {
      id: number;
      platform: Platform;
      platformChannelId: string;
      accessToken: string | null;
    },
    enterpriseId: number,
  ): Promise<void> {
    // Instagram is covered by its linked Page's subscription, so there is
    // nothing of its own to unsubscribe.
    if (channel.platform !== Platform.Facebook || !channel.accessToken) return;
    try {
      await this.graph.unsubscribePageFromApp(
        channel.platformChannelId,
        this.cipher.decrypt(channel.accessToken),
      );
    } catch (error) {
      this.logger.warn(
        { enterpriseId, channelId: channel.id, err: error },
        'could not unsubscribe the Page before disconnecting — events may keep arriving and will be dropped',
      );
    }
  }

  /** The providers that can actually be connected today. */
  supported(): Provider[] {
    return [...this.connectors.keys()];
  }

  /**
   * What a client can offer, with labels.
   *
   * Only what is actually implemented. Listing the unimplemented ones would be a
   * roadmap promise in an API response, and a client that renders "coming soon"
   * for something nobody has committed to is worse than one that shows nothing.
   */
  available(): { provider: Provider; label: string }[] {
    return [...this.connectors.values()].map((connector) => ({
      provider: connector.provider,
      label: connector.label,
    }));
  }

  async start(
    provider: Provider,
    enterpriseId: number,
    employeeId: number | null,
  ): Promise<StartedConnection> {
    const connector = this.connectors.get(provider);
    if (!connector) {
      throw new AppException(ErrorCode.ProviderNotSupported, {
        // Naming what IS available turns a dead end into something a client
        // author can act on, and none of it is secret.
        details: [{ field: 'provider', issue: `supported: ${this.supported().join(', ')}` }],
      });
    }

    return {
      provider,
      authorizationUrl: await connector.buildAuthorizationUrl(enterpriseId, employeeId),
    };
  }
  /**
   * The provider connections this business holds.
   *
   * MAPPED, never returned verbatim. Handing back the repository row made every
   * change to that SELECT a silent change to the API, including one that would
   * leak a column added later.
   */
  async listConnections(enterpriseId: number): Promise<ConnectionDto[]> {
    const connections = await this.connections.listForEnterprise(enterpriseId);
    return connections.map((connection) => ({
      refId: connection.refId,
      provider: connection.provider,
      providerUserName: connection.providerUserName,
      status: connection.status,
      reauthRequired: connection.reauthRequired,
      tokenExpiresAt: connection.tokenExpiresAt,
    }));
  }

  /**
   * The channels under those connections.
   *
   * Mapped for the reason above and one more: the row carries internal numeric
   * ids, and a numeric id is never sent to a client. `parentChannelId` becomes
   * the parent's refId so the Page/Instagram relationship survives that.
   */
  async listChannels(enterpriseId: number): Promise<ChannelDto[]> {
    const channels = await this.channels.listForEnterprise(enterpriseId);
    const refById = new Map(channels.map((channel) => [channel.id, channel.refId]));

    return channels.map((channel) => ({
      refId: channel.refId,
      platform: channel.platform,
      channelKind: channel.channelKind,
      name: channel.name,
      username: channel.username,
      status: channel.status,
      reauthRequired: channel.reauthRequired,
      isManaged: channel.isManaged,
      // null means events will not arrive for this Page yet.
      webhookSubscribedAt: channel.webhookSubscribedAt,
      parentChannelRefId:
        channel.parentChannelId === null ? null : (refById.get(channel.parentChannelId) ?? null),
      profile: toProfile(channel),
    }));
  }
}
