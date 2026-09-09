import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  ChannelRepository,
  type ChannelSendContext,
} from '@/database/repositories/channel.repository';
import { ProviderConnectionRepository } from '@/database/repositories/provider-connection.repository';
import { WEBHOOK_RECONCILE_CHANNELS_PER_RUN } from '@/shared/constants';
import { TokenCipherService } from '@/shared/crypto';
import { ConnectionStatus, Platform } from '@/shared/enums';
import { GraphApiClient, SUBSCRIBED_FIELDS } from './graph/graph-api.client';
import { GraphApiError } from './graph/graph-api.error';
import { mapGraphError } from './graph/graph-error.mapper';

/**
 * What one channel's reconciliation concluded. Four outcomes rather than a
 * boolean, because "correct", "repaired" and "could not be repaired" need
 * different reactions from whoever reads the logs, and "skipped" needs none.
 */
export type SubscriptionReconcileOutcome = 'verified' | 'repaired' | 'unrepairable' | 'skipped';

export interface SubscriptionReconcileSummary {
  /** Correlates every per-channel line of one run with the run's own line. */
  readonly runId: string;
  readonly considered: number;
  readonly verified: number;
  readonly repaired: number;
  readonly unrepairable: number;
  readonly skipped: number;
}

/**
 * Keeps a Page's webhook subscription true, rather than assuming it stayed the
 * way we left it.
 *
 * `subscribePageToApp` is attempted ONCE, when a channel is connected, and
 * succeeding then is not evidence of anything later: a subscription can be
 * removed from the Facebook side at any time, and Meta itself disables one after
 * a run of non-2xx deliveries (docs/platform-limitations.md §7.2). Nothing about
 * that is visible here — no error, no event, no status change. The only symptom
 * is that the inbox stops filling, which for this product is the worst failure
 * mode there is, because it looks like a quiet week.
 *
 * So the write side is checked against the read side on a schedule:
 * `listSubscribedFields` reports what Meta believes, `SUBSCRIBED_FIELDS` is what
 * we require, and the difference is repaired. It also closes a second hole for
 * free — a Page whose subscribe call failed at connect (logged as a warning and
 * never retried) is now repaired on the next run instead of never.
 */
@Injectable()
export class WebhookSubscriptionService {
  constructor(
    private readonly channels: ChannelRepository,
    private readonly connections: ProviderConnectionRepository,
    private readonly graph: GraphApiClient,
    private readonly cipher: TokenCipherService,
    @InjectPinoLogger(WebhookSubscriptionService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Reconciles every channel that can be reconciled, and reports what happened.
   *
   * Returns the tally rather than logging it, so the caller owns the one line
   * that says a run finished and this owns the lines that say what it found.
   */
  async reconcileAll(): Promise<SubscriptionReconcileSummary> {
    const runId = randomUUID();

    /*
     * Reuses the refresh scheduler's population deliberately: managed, active,
     * not flagged for re-auth, across every tenant — which is exactly the set
     * that can be both checked and repaired. A cron belongs to no business, and
     * the enterprise_id on each row is what re-establishes the tenant before
     * anything is read or written.
     *
     * Its ORDER BY is profile_synced_at, which is the profile refresh's notion
     * of staleness rather than this one's. That only matters past the cap: with
     * more active Pages than WEBHOOK_RECONCILE_CHANNELS_PER_RUN, the set rotates
     * as the daily profile refresh advances that column instead of rotating on
     * webhook_subscribed_at. Ordering on the latter needs a query of its own in
     * the repository, which is the right fix when this deployment is anywhere
     * near the cap.
     */
    const channels = await this.channels.listAllForRefresh(WEBHOOK_RECONCILE_CHANNELS_PER_RUN);

    const tally: Record<SubscriptionReconcileOutcome, number> = {
      verified: 0,
      repaired: 0,
      unrepairable: 0,
      skipped: 0,
    };

    /*
     * SEQUENTIAL, not Promise.all: this is a bounded background sweep whose only
     * deadline is the next run, and firing two hundred Graph reads at once is
     * how a sweep earns an app-level rate limit that then costs the SEND path —
     * which does have a deadline.
     */
    for (const channel of channels) {
      const outcome = await this.reconcileChannel(channel.enterpriseId, channel.id, runId);
      tally[outcome] += 1;
    }

    return { runId, considered: channels.length, ...tally };
  }

  /**
   * One channel: read the subscription back, compare, repair if it has to.
   *
   * Never throws. A run covers every tenant, so one channel's failure must cost
   * that channel and nothing else — the alternative is a sweep that abandons the
   * remaining Pages because one token was unreadable.
   */
  private async reconcileChannel(
    enterpriseId: number,
    channelId: number,
    runId: string,
  ): Promise<SubscriptionReconcileOutcome> {
    let context: ChannelSendContext | null;
    try {
      /*
       * One context lookup per channel — the same shape the backfill worker
       * uses, and the send context specifically because it is the only resolver
       * that carries provider_connection_id, which is what a dead token has to
       * be flagged against. It is a primary-key read whose cost is invisible
       * next to the Graph round trip it precedes; batching it would mean a new
       * repository query, which is worth doing only alongside the ordering fix
       * described in reconcileAll.
       */
      context = await this.channels.findSendContext(enterpriseId, channelId);
    } catch (error) {
      this.logger.error(
        { runId, enterpriseId, channelId, err: error },
        'could not resolve a channel for webhook reconciliation',
      );
      return 'unrepairable';
    }

    // Deleted between the list and this lookup. Nothing to reconcile and nothing
    // worth a log line.
    if (!context) return 'skipped';

    /*
     * THE SUBSCRIPTION LIVES ON THE PAGE. An Instagram professional account is
     * covered by its linked Page's subscription — that is why SUBSCRIBED_FIELDS
     * carries Instagram's own fields — and `{ig-id}/subscribed_apps` is not an
     * edge that exists. Checking an Instagram channel would spend a call to
     * learn nothing, and reconciling its parent Page is what actually repairs it.
     */
    if (context.platform !== Platform.Facebook) return 'skipped';

    /*
     * Already flagged: skipped WITHOUT a call. The population query excludes a
     * channel whose own flag is set, but findSendContext ORs in the parent
     * connection's flag, so a channel under a dead grant still arrives here. It
     * cannot be repaired until the business reconnects — the token is the thing
     * that is broken — and a reconnect re-subscribes as part of connecting, so
     * every call spent here would be wasted twice over.
     */
    if (context.reauthRequired) {
      this.logger.debug(
        { runId, enterpriseId, channelId },
        'webhook reconciliation skipped a channel awaiting re-auth',
      );
      return 'skipped';
    }

    /*
     * No token, no repair. This is a real state — the fallback discovery path can
     * return a Page without one — and it is worth a warning rather than silence,
     * because such a Page receives nothing and nothing else says so.
     */
    if (!context.effectiveAccessToken) {
      this.logger.warn(
        { runId, enterpriseId, channelId, pageId: context.platformChannelId },
        'webhook reconciliation skipped a page with no usable token',
      );
      return 'skipped';
    }

    let token: string;
    try {
      token = this.cipher.decrypt(context.effectiveAccessToken);
    } catch (error) {
      // Same reasoning as the relay and the backfill: a decryption failure is key
      // loss or tampering, not a missing token, and must be loud.
      this.logger.error(
        { runId, enterpriseId, channelId, err: error },
        'could not decrypt a page token for webhook reconciliation — key loss or tampering',
      );
      return 'unrepairable';
    }

    try {
      return await this.compareAndRepair(context, enterpriseId, channelId, token, runId);
    } catch (error) {
      return await this.handleGraphFailure(context, enterpriseId, channelId, runId, error);
    }
  }

  /** The read, the comparison, and the write that only happens if it must. */
  private async compareAndRepair(
    context: ChannelSendContext,
    enterpriseId: number,
    channelId: number,
    token: string,
    runId: string,
  ): Promise<SubscriptionReconcileOutcome> {
    const pageId = context.platformChannelId;
    const subscribed = await this.graph.listSubscribedFields(pageId, token);

    /*
     * MISSING fields only. A field subscribed beyond our policy is left alone:
     * SUBSCRIBED_FIELDS is the minimum this app needs, an extra one costs us
     * nothing, and unsubscribing something somebody added on purpose is not this
     * sweep's decision to make. (The repair itself replaces the set with our
     * policy, which is Meta's semantics for the edge, not a choice here.)
     */
    const missing = SUBSCRIBED_FIELDS.filter((field) => !subscribed.includes(field));

    if (missing.length === 0) {
      /*
       * Stamped even though nothing changed, so webhook_subscribed_at means "we
       * confirmed this Page is subscribed, and this is when" rather than "we
       * once asked". It also fills the column in for a Page that was subscribed
       * before this reconciliation existed. One single-row update per Page per
       * run, on the primary key.
       */
      await this.channels.markWebhookSubscribed(enterpriseId, channelId);
      this.logger.debug(
        { runId, enterpriseId, channelId, pageId, fieldCount: subscribed.length },
        'webhook subscription is complete',
      );
      return 'verified';
    }

    await this.graph.subscribePageToApp(pageId, token);
    await this.channels.markWebhookSubscribed(enterpriseId, channelId);

    /*
     * WARN, not info: a subscription that drifted means this Page received
     * nothing for some of the fields named, for an unknown length of time. The
     * repair is the good news; the drift is the thing to look into, and the
     * field names are what make it diagnosable.
     */
    this.logger.warn(
      { runId, enterpriseId, channelId, pageId, missing },
      'webhook subscription was incomplete and has been repaired',
    );
    return 'repaired';
  }

  /**
   * A failure of either Graph call — the read and the repair fail the same ways
   * and deserve the same answer.
   */
  private async handleGraphFailure(
    context: ChannelSendContext,
    enterpriseId: number,
    channelId: number,
    runId: string,
    error: unknown,
  ): Promise<'unrepairable'> {
    const pageId = context.platformChannelId;

    if (!(error instanceof GraphApiError)) {
      this.logger.error(
        { runId, enterpriseId, channelId, pageId, err: error },
        'webhook subscription could not be reconciled',
      );
      return 'unrepairable';
    }

    const mapped = mapGraphError(error);

    /*
     * A DEAD TOKEN IS FLAGGED, NOT RETRIED. A live auth error beats the calendar
     * (schema.md §14), so the connection is marked the moment a call says the
     * credential is dead rather than waiting for the expiry sweep — the same
     * mechanism the relay and the backfill use, deliberately not a second one.
     *
     * That flag is also what stops this becoming a loop: markReauthRequired
     * cascades reauth_required onto every channel under the connection, and the
     * population query excludes exactly those, so the next run spends no call on
     * this Page at all. It re-enters the sweep when the business reconnects,
     * which clears the flag and re-subscribes on its own.
     */
    if (mapped.requiresReauth) {
      await this.connections.markReauthRequired(
        enterpriseId,
        // The CONNECTION's id, not the channel's: both are BIGSERIAL and both are
        // `number`, so the wrong one would revoke an unrelated row in silence.
        context.providerConnectionId,
        ConnectionStatus.Revoked,
      );
      this.logger.error(
        {
          runId,
          enterpriseId,
          channelId,
          pageId,
          graphCode: error.code,
          graphSubcode: error.subcode,
        },
        'webhook subscription cannot be repaired — the page token is dead and the connection needs re-auth',
      );
      return 'unrepairable';
    }

    /*
     * Everything else — a rate limit, a 5xx, a permission gap — is left to the
     * next run. There is no in-loop retry on purpose: the sweep already repeats
     * on a schedule, a rate limit outlasts any backoff worth holding a run open
     * for, and a permission gap is fixed by changing the app's configuration
     * rather than by asking again.
     */
    this.logger.error(
      {
        runId,
        enterpriseId,
        channelId,
        pageId,
        graphCode: error.code,
        graphSubcode: error.subcode,
        errorCode: mapped.code,
        retryable: mapped.retryable,
        // Meta's own text: safe to keep for diagnosis, and it names no token.
        reason: error.message,
      },
      'webhook subscription could not be reconciled — the next run will try again',
    );
    return 'unrepairable';
  }
}
