import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { ProviderConnectionRepository } from '@/database/repositories/provider-connection.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { TransactionManager } from '@/database/transaction';
import { TokenCipherService } from '@/shared/crypto';
import {
  ChannelKind,
  ChannelStatus,
  Platform,
  Provider,
  ProviderCategory,
  SyncJobKind,
  SyncTriggerKind,
  TokenStatus,
} from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import { GraphApiClient } from './graph/graph-api.client';
import { GraphApiError } from './graph/graph-api.error';
import { mapGraphError } from './graph/graph-error.mapper';
import { OauthStateService } from './oauth-state.service';
import { PageDiscoveryService } from './page-discovery.service';
import type { DiscoveredPage } from './graph/graph.types';

export interface ConnectionResult {
  readonly connectionRefId: string;
  readonly pageCount: number;
  readonly instagramCount: number;
  readonly errorCount: number;
}

/** Which backfills a newly connected channel starts. */
const INITIAL_SYNCS: readonly SyncJobKind[] = [
  SyncJobKind.BackfillPosts,
  SyncJobKind.BackfillComments,
  SyncJobKind.BackfillConversations,
] as const;

@Injectable()
export class MetaConnectionService {
  constructor(
    private readonly graph: GraphApiClient,
    private readonly discovery: PageDiscoveryService,
    private readonly state: OauthStateService,
    private readonly connections: ProviderConnectionRepository,
    private readonly channels: ChannelRepository,
    private readonly syncJobs: SyncJobRepository,
    private readonly cipher: TokenCipherService,
    private readonly config: AppConfigService,
    private readonly tx: TransactionManager,
    @InjectPinoLogger(MetaConnectionService.name) private readonly logger: PinoLogger,
  ) {}

  /** Step 0: the URL the browser is redirected to. */
  buildAuthorizationUrl(enterpriseId: number, employeeId: number | null): string {
    this.assertConfigured();
    return this.graph.buildLoginDialogUrl(this.state.mint(enterpriseId, employeeId));
  }

  /**
   * The OAuth callback, in the order backend-design.md §18.1 specifies.
   *
   * Everything that talks to Meta happens BEFORE the transaction opens. A
   * transaction held open across a Graph call would hold locks while waiting on
   * a third party, which is how a slow provider becomes a database incident.
   */
  async handleCallback(code: string, rawState: string): Promise<ConnectionResult> {
    this.assertConfigured();

    // Verified first: an unsigned or expired state is rejected before we spend a
    // single Graph call on it.
    const { enterpriseId, employeeId } = this.state.verify(rawState);

    const shortLived = await this.exchange(() => this.graph.exchangeCodeForToken(code));
    const longLived = await this.exchange(() =>
      this.graph.exchangeForLongLivedToken(shortLived.access_token),
    );

    const me = await this.exchange(() => this.graph.getMe(longLived.access_token));
    if (!me.id) throw new AppException(ErrorCode.OauthExchangeFailed);

    const discovered = await this.exchange(() => this.discovery.discover(longLived.access_token));

    // No pages means nothing to manage. Surfaced as a clear 422 rather than a
    // "successful" connection with an empty channel list.
    const usablePages = discovered.pages.filter((page) => page.error === null);

    // Judged on the USABLE pages, not the raw list: if every discovered page
    // failed its detail lookup there is nothing to manage, and committing a
    // connection with zero channels while reporting success is exactly the
    // behaviour §18.3 says not to port.
    if (usablePages.length === 0) throw new AppException(ErrorCode.NoPagesFound);

    const persisted = await this.tx.runInTransaction(async () => {
      const connection = await this.connections.upsert({
        enterpriseId,
        provider: Provider.Meta,
        providerCategory: ProviderCategory.Social,
        providerUserId: me.id,
        providerUserName: me.name ?? null,
        // Encrypted before it reaches Postgres; the column never holds plaintext.
        accessToken: this.cipher.encrypt(longLived.access_token),
        tokenExpiresAt: expiryFrom(longLived.expires_in),
        grantedScopes: null,
        connectedByEmployeeId: employeeId,
      });

      const channelIds: number[] = [];
      // Page id -> our channel id, so the post-commit subscribe step does not
      // have to look the channel up again with an untenanted query.
      const channelIdByPageId = new Map<string, number>();
      let instagramCount = 0;

      for (const page of usablePages) {
        const pageChannel = await this.channels.upsert({
          enterpriseId,
          providerConnectionId: connection.id,
          parentChannelId: null,
          platform: Platform.Facebook,
          channelKind: ChannelKind.Page,
          platformChannelId: page.pageId,
          name: page.pageName,
          username: null,
          accessToken: page.pageAccessToken ? this.cipher.encrypt(page.pageAccessToken) : null,
          tokenStatus: page.pageAccessToken ? TokenStatus.Valid : TokenStatus.NotApplicable,
          metadata: page.category ? { category: page.category } : {},
          status: ChannelStatus.Active,
        });
        channelIds.push(pageChannel.id);
        channelIdByPageId.set(page.pageId, pageChannel.id);

        // The Instagram account hangs off its Page: parentChannelId is what lets
        // the send path find the Page token that authorises Instagram calls, and
        // its own token_status is not_applicable because it has no token.
        if (page.instagramAccountId) {
          const igChannel = await this.channels.upsert({
            enterpriseId,
            providerConnectionId: connection.id,
            parentChannelId: pageChannel.id,
            platform: Platform.Instagram,
            channelKind: ChannelKind.Profile,
            platformChannelId: page.instagramAccountId,
            name: page.instagramUsername,
            username: page.instagramUsername,
            accessToken: null,
            tokenStatus: TokenStatus.NotApplicable,
            metadata: { linkedPageId: page.pageId },
            status: ChannelStatus.Active,
          });
          channelIds.push(igChannel.id);
          instagramCount += 1;
        }
      }

      for (const channelId of channelIds) {
        for (const jobKind of INITIAL_SYNCS) {
          await this.syncJobs.enqueueIfAbsent({
            enterpriseId,
            channelId,
            jobKind,
            triggerKind: SyncTriggerKind.InitialConnect,
          });
        }
      }

      return { connection, instagramCount, channelIdByPageId };
    });

    // AFTER commit: subscribing is a network call, so it must not sit inside the
    // transaction. A failure here is recorded on the channel, not swallowed —
    // socialLift reported success with an empty page list when this went wrong.
    const subscribeFailures = await this.subscribePages(
      enterpriseId,
      usablePages,
      persisted.channelIdByPageId,
    );

    this.logger.info(
      {
        enterpriseId,
        discoveryPath: discovered.path,
        pages: usablePages.length,
        instagram: persisted.instagramCount,
        partialFailures: discovered.partialFailures,
        subscribeFailures,
      },
      'meta connection established',
    );

    return {
      connectionRefId: persisted.connection.refId,
      pageCount: usablePages.length,
      instagramCount: persisted.instagramCount,
      errorCount: discovered.partialFailures + subscribeFailures,
    };
  }

  /**
   * Subscribes each Page to our webhook fields. Without this the app receives no
   * events for that Page, however correct the app-level subscription is.
   */
  private async subscribePages(
    enterpriseId: number,
    pages: readonly DiscoveredPage[],
    channelIdByPageId: ReadonlyMap<string, number>,
  ): Promise<number> {
    let failures = 0;

    await Promise.all(
      pages.map(async (page) => {
        if (!page.pageAccessToken) {
          failures += 1;
          return;
        }
        try {
          await this.graph.subscribePageToApp(page.pageId, page.pageAccessToken);
        } catch (error) {
          failures += 1;
          // The id written moments ago in OUR transaction, not a fresh
          // untenanted lookup: that lookup can return another enterprise's row
          // for the same Page, and the tenant-scoped update would then match
          // nothing and discard the failure silently.
          const channelId = channelIdByPageId.get(page.pageId);
          if (channelId !== undefined) {
            // A channel we cannot subscribe receives nothing, so it is marked in
            // error rather than left looking healthy.
            await this.channels.markStatus(enterpriseId, channelId, ChannelStatus.Error);
          }
          this.logger.warn(
            { pageId: page.pageId, err: error instanceof Error ? error.message : 'unknown' },
            'could not subscribe a page to webhooks',
          );
        }
      }),
    );

    return failures;
  }

  /** Translates a Graph failure into a domain error once, at the boundary. */
  private async exchange<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof GraphApiError) {
        const mapped = mapGraphError(error);
        throw new AppException(
          mapped.code === ErrorCode.UpstreamUnavailable
            ? ErrorCode.OauthExchangeFailed
            : mapped.code,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private assertConfigured(): void {
    if (!this.config.meta.enabled) throw new AppException(ErrorCode.MetaNotConfigured);
  }
}

/** Meta reports token lifetime in seconds; a missing value means non-expiring. */
function expiryFrom(expiresInSeconds: number | undefined): Date | null {
  if (typeof expiresInSeconds !== 'number' || expiresInSeconds <= 0) return null;
  return new Date(Date.now() + expiresInSeconds * 1000);
}
