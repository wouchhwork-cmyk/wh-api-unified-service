import { Inject, Injectable } from '@nestjs/common';
import { Provider } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import { PROVIDER_CONNECTORS, type ProviderConnector } from './provider-connector';

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
@Injectable()
export class ConnectionsService {
  private readonly connectors: ReadonlyMap<Provider, ProviderConnector>;

  constructor(@Inject(PROVIDER_CONNECTORS) connectors: readonly ProviderConnector[]) {
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
}
