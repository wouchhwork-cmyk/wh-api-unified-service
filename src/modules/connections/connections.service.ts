import { Inject, Injectable } from '@nestjs/common';
import { Provider } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import { PROVIDER_CONNECTORS, type ProviderConnector } from './provider-connector';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { ProviderConnectionRepository } from '@/database/repositories/provider-connection.repository';

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
}

@Injectable()
export class ConnectionsService {
  private readonly connectors: ReadonlyMap<Provider, ProviderConnector>;

  constructor(
    @Inject(PROVIDER_CONNECTORS) connectors: readonly ProviderConnector[],
    private readonly connections: ProviderConnectionRepository,
    private readonly channels: ChannelRepository,
  ) {
    this.connectors = new Map(connectors.map((connector) => [connector.provider, connector]));
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
    }));
  }

}
