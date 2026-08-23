import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { ProviderConnectionRepository } from '@/database/repositories/provider-connection.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { TransactionManager } from '@/database/transaction';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import type { ProviderConnector } from './provider-connector';
import { TokenCipherService } from '@/shared/crypto';
import {
  ChannelKind,
  ChannelStatus,
  EnterpriseStatus,
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
  /*
   * Mentions only have history on Instagram, and the walk reports "finished,
   * nothing added" for a Page rather than failing — so this is enqueued for both
   * platforms rather than branching here on something the walk already knows.
   */
  SyncJobKind.BackfillMentions,
] as const;

@Injectable()
export class MetaConnectionService implements ProviderConnector {
  /** Keyed on this in the connector registry. */
  readonly provider = Provider.Meta;
  /** One connector covers both: Instagram is reached through its parent Page. */
  readonly label = 'Facebook & Instagram';

  constructor(
    private readonly graph: GraphApiClient,
    private readonly discovery: PageDiscoveryService,
    private readonly state: OauthStateService,
    private readonly connections: ProviderConnectionRepository,
    private readonly channels: ChannelRepository,
    private readonly syncJobs: SyncJobRepository,
    private readonly enterprises: EnterpriseRepository,
    private readonly cipher: TokenCipherService,
    private readonly config: AppConfigService,
    private readonly tx: TransactionManager,
    @InjectPinoLogger(MetaConnectionService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Step 0: the URL the browser is redirected to.
   *
   * Async because minting the state now WRITES it — that is what makes it
   * spendable exactly once. If the write fails the caller gets an error rather
   * than a URL, which is the right way round: a state that cannot be consumed
   * would send somebody through Facebook only to fail on the way back.
   */
  async buildAuthorizationUrl(enterpriseId: number, employeeId: number | null): Promise<string> {
    this.assertConfigured();
    return this.graph.buildLoginDialogUrl(await this.state.mint(enterpriseId, employeeId));
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

    // Spent first: an unsigned, expired or already-used state is rejected before
    // a single Graph call is spent on it — and consuming it here means a
    // replayed callback cannot get as far as Facebook a second time.
    const { enterpriseId, employeeId } = await this.state.consume(rawState);

    /*
     * RE-CHECKED HERE, not just when the flow started.
     *
     * This route is @Public and trusts only the signed state, so it bypasses the
     * guard chain entirely — including the one that refuses a suspended or
     * unactivated business. A state minted while a business was active would
     * otherwise complete a connection minutes after it was switched off, and the
     * tokens would be live.
     */
    const status = await this.enterprises.statusById(enterpriseId);
    if (status !== EnterpriseStatus.Active) {
      throw new AppException(
        status === EnterpriseStatus.Suspended
          ? ErrorCode.EnterpriseSuspended
          : ErrorCode.EnterprisePendingActivation,
      );
    }

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

    /*
     * READ BEFORE THE TRANSACTION, not inside it.
     *
     * This is a Graph call — debugToken — and it used to sit in the upsert's
     * argument list, which put a third-party HTTP round trip inside the
     * transaction and contradicted the invariant this method's own comment
     * asserts. It held write locks on provider_connections and channels for as
     * long as Facebook felt like taking, up to the 10 s request timeout.
     */
    const grantedScopes = await this.readGrantedScopes(longLived.access_token);

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
        grantedScopes,
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
          /*
           * A Page that arrived without a token cannot send or be subscribed, so
           * it is NOT active. It used to be stored as active and merely counted
           * in errorCount — which reads, on the connections screen, as a working
           * channel that silently never receives anything.
           */
          status: page.pageAccessToken ? ChannelStatus.Active : ChannelStatus.Error,
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
   * The scopes Meta actually granted, as a comma-separated string.
   *
   * Read from debug_token rather than assumed from what was requested: with
   * Facebook Login for Business the config decides the scopes, and a user can
   * decline individual permissions at the consent screen. Without this there is
   * no record of what was granted, so "why can we not read comments for this
   * Page" has no answer months later.
   *
   * Best-effort on purpose. Failing to READ the scopes must not fail a
   * connection whose tokens are already in hand — the column simply stays null,
   * exactly as it was before.
   */
  private async readGrantedScopes(token: string): Promise<string | null> {
    try {
      const debug = await this.graph.debugToken(token);
      const scopes = debug.data?.scopes;
      return scopes && scopes.length > 0 ? scopes.join(',') : null;
    } catch (error) {
      this.logger.warn({ err: error }, 'could not read granted scopes; storing none');
      return null;
    }
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
        // The id written moments ago in OUR transaction, not a fresh untenanted
        // lookup: that lookup can return another enterprise's row for the same
        // Page, and the tenant-scoped update would then match nothing and
        // discard the outcome silently.
        const channelId = channelIdByPageId.get(page.pageId);

        try {
          await this.graph.subscribePageToApp(page.pageId, page.pageAccessToken);
          if (channelId !== undefined) {
            await this.channels.markWebhookSubscribed(enterpriseId, channelId);
          }
        } catch (error) {
          failures += 1;
          /*
           * The channel is NOT marked in error, which it used to be.
           *
           * A Page we could not subscribe still holds a valid token and can
           * still send — it just receives nothing yet. Marking it `error` made a
           * perfectly good connection look broken, and it did so most often in
           * the ordinary case where the app has no webhook configured. The
           * missing `webhook_subscribed_at` is what says "receives nothing", and
           * it says only that.
           */
          this.logger.warn(
            { pageId: page.pageId, err: error instanceof Error ? error.message : 'unknown' },
            'could not subscribe a page to webhooks — it can send but will receive nothing',
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
