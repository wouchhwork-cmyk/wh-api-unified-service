import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PinoLogger } from 'nestjs-pino';
import type { ChannelRepository } from '@/database/repositories/channel.repository';
import type { ProviderConnectionRepository } from '@/database/repositories/provider-connection.repository';
import { GraphApiError } from '@/modules/connections/graph/graph-api.error';
import {
  SUBSCRIBED_FIELDS,
  type GraphApiClient,
} from '@/modules/connections/graph/graph-api.client';
import { WebhookSubscriptionService } from '@/modules/connections/webhook-subscription.service';
import { WebhookSubscriptionReconcilerWorker } from '@/workers/webhook-subscription-reconciler.worker';
import { WEBHOOK_RECONCILE_CHANNELS_PER_RUN } from '@/shared/constants';
import type { TokenCipherService } from '@/shared/crypto';
import { ConnectionStatus, Platform } from '@/shared/enums';

/**
 * Reconciliation of a Page's webhook subscription.
 *
 * This is the one guard against the failure that makes no noise: a subscription
 * removed on the Facebook side, or disabled by Meta after a run of non-2xx
 * deliveries, stops the inbox filling and reports nothing. The assertions that
 * matter here are therefore about what is NOT done as much as what is —
 * a correct subscription must not be rewritten, and a dead token must not be
 * asked again on every run.
 *
 * Everything external is stubbed: no Postgres, no Graph, no clock.
 */

const ENTERPRISE_ID = 7;
const CHANNEL_ID = 42;
const CONNECTION_ID = 9;
const PAGE_ID = '1010101010';
const ENCRYPTED_TOKEN = 'v1:k1:nonce:ciphertext';
const PAGE_TOKEN = 'page-token';

/** A Facebook Page channel with a usable token: the reconcilable case. */
const pageContext = (overrides: Record<string, unknown> = {}) => ({
  channelId: CHANNEL_ID,
  providerConnectionId: CONNECTION_ID,
  platform: Platform.Facebook,
  platformChannelId: PAGE_ID,
  parentPlatformChannelId: null,
  effectiveAccessToken: ENCRYPTED_TOKEN,
  reauthRequired: false,
  isManaged: true,
  ...overrides,
});

const deadTokenError = () =>
  new GraphApiError(400, 190, 463, 'OAuthException', null, 'Error validating access token');

describe('WebhookSubscriptionService.reconcileAll', () => {
  let channels: {
    listAllForRefresh: ReturnType<typeof vi.fn>;
    findSendContext: ReturnType<typeof vi.fn>;
    markWebhookSubscribed: ReturnType<typeof vi.fn>;
  };
  let connections: { markReauthRequired: ReturnType<typeof vi.fn> };
  let graph: {
    listSubscribedFields: ReturnType<typeof vi.fn>;
    subscribePageToApp: ReturnType<typeof vi.fn>;
  };
  let cipher: { decrypt: ReturnType<typeof vi.fn> };
  let logger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let service: WebhookSubscriptionService;

  beforeEach(() => {
    /*
     * A fixed clock. Nothing in the service reads it today — the stamp is
     * `now()` inside Postgres — and pinning it here keeps that true rather than
     * leaving a future timing dependency to show up as a flake.
     */
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));

    channels = {
      listAllForRefresh: vi
        .fn()
        .mockResolvedValue([{ id: CHANNEL_ID, enterpriseId: ENTERPRISE_ID }]),
      findSendContext: vi.fn().mockResolvedValue(pageContext()),
      markWebhookSubscribed: vi.fn().mockResolvedValue(undefined),
    };
    connections = { markReauthRequired: vi.fn().mockResolvedValue(undefined) };
    graph = {
      listSubscribedFields: vi.fn().mockResolvedValue([...SUBSCRIBED_FIELDS]),
      subscribePageToApp: vi.fn().mockResolvedValue(undefined),
    };
    cipher = { decrypt: vi.fn().mockReturnValue(PAGE_TOKEN) };
    logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    service = new WebhookSubscriptionService(
      channels as unknown as ChannelRepository,
      connections as unknown as ProviderConnectionRepository,
      graph as unknown as GraphApiClient,
      cipher as unknown as TokenCipherService,
      logger as unknown as PinoLogger,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the subscription back with the page token and nothing else', async () => {
    await service.reconcileAll();

    expect(channels.listAllForRefresh).toHaveBeenCalledWith(WEBHOOK_RECONCILE_CHANNELS_PER_RUN);
    expect(graph.listSubscribedFields).toHaveBeenCalledWith(PAGE_ID, PAGE_TOKEN);
    // One Graph call per channel per run is the entire budget of a clean run.
    expect(graph.listSubscribedFields).toHaveBeenCalledTimes(1);
  });

  it('writes nothing to the platform when every required field is subscribed', async () => {
    const summary = await service.reconcileAll();

    // The point of the read-back: a correct subscription costs one call, never a
    // rewrite of something that is already right.
    expect(graph.subscribePageToApp).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ considered: 1, verified: 1, repaired: 0, unrepairable: 0 });
    // Confirmation is recorded, so webhook_subscribed_at means "verified at".
    expect(channels.markWebhookSubscribed).toHaveBeenCalledWith(ENTERPRISE_ID, CHANNEL_ID);
  });

  it('ignores a field subscribed beyond our policy', async () => {
    graph.listSubscribedFields.mockResolvedValue([...SUBSCRIBED_FIELDS, 'ratings']);

    const summary = await service.reconcileAll();

    // SUBSCRIBED_FIELDS is a minimum, not an exact set: an extra field is not
    // drift and must not trigger a write.
    expect(graph.subscribePageToApp).not.toHaveBeenCalled();
    expect(summary.verified).toBe(1);
  });

  it('re-subscribes when a required field has gone missing', async () => {
    const missing = 'mentions';
    graph.listSubscribedFields.mockResolvedValue(
      SUBSCRIBED_FIELDS.filter((field) => field !== missing),
    );

    const summary = await service.reconcileAll();

    expect(graph.subscribePageToApp).toHaveBeenCalledWith(PAGE_ID, PAGE_TOKEN);
    expect(channels.markWebhookSubscribed).toHaveBeenCalledWith(ENTERPRISE_ID, CHANNEL_ID);
    expect(summary).toMatchObject({ considered: 1, verified: 0, repaired: 1, unrepairable: 0 });

    // Drift is a warning with the field names in it: the repair is the good
    // news, the gap is the thing somebody has to look into.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: PAGE_ID, missing: [missing] }),
      expect.stringContaining('repaired'),
    );
  });

  it('re-subscribes a page that was never subscribed at all', async () => {
    // What Meta returns for a Page with no subscription — and also the state left
    // behind by a subscribe call that failed at connect and was never retried.
    graph.listSubscribedFields.mockResolvedValue([]);

    const summary = await service.reconcileAll();

    expect(graph.subscribePageToApp).toHaveBeenCalledTimes(1);
    expect(summary.repaired).toBe(1);
  });

  it('flags the connection for re-auth when the repair hits a dead token', async () => {
    graph.listSubscribedFields.mockResolvedValue([]);
    graph.subscribePageToApp.mockRejectedValue(deadTokenError());

    const summary = await service.reconcileAll();

    // The existing convention, on the CONNECTION's id rather than the channel's.
    expect(connections.markReauthRequired).toHaveBeenCalledWith(
      ENTERPRISE_ID,
      CONNECTION_ID,
      ConnectionStatus.Revoked,
    );
    // Once, not in a loop: no in-run retry of a credential that cannot recover.
    expect(graph.subscribePageToApp).toHaveBeenCalledTimes(1);
    // And nothing claims the Page is subscribed.
    expect(channels.markWebhookSubscribed).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ verified: 0, repaired: 0, unrepairable: 1 });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ graphCode: 190 }),
      expect.stringContaining('re-auth'),
    );
  });

  it('flags the connection when the READ itself reports a dead token', async () => {
    graph.listSubscribedFields.mockRejectedValue(deadTokenError());

    const summary = await service.reconcileAll();

    expect(connections.markReauthRequired).toHaveBeenCalledWith(
      ENTERPRISE_ID,
      CONNECTION_ID,
      ConnectionStatus.Revoked,
    );
    // A token that cannot read cannot write either: no repair is attempted.
    expect(graph.subscribePageToApp).not.toHaveBeenCalled();
    expect(summary.unrepairable).toBe(1);
  });

  it('leaves a rate limit to the next run without flagging anything', async () => {
    graph.listSubscribedFields.mockRejectedValue(
      new GraphApiError(400, 4, null, 'OAuthException', null, 'Application request limit reached'),
    );

    const summary = await service.reconcileAll();

    // A rate limit says nothing about the credential, so a reconnect prompt here
    // would be a lie told to a business whose connection is fine.
    expect(connections.markReauthRequired).not.toHaveBeenCalled();
    expect(channels.markWebhookSubscribed).not.toHaveBeenCalled();
    expect(summary.unrepairable).toBe(1);
  });

  it('spends no call on a channel already flagged for re-auth', async () => {
    // Its own flag keeps it out of the population query; this is the case that
    // still arrives — the PARENT connection is the flagged one.
    channels.findSendContext.mockResolvedValue(pageContext({ reauthRequired: true }));

    const summary = await service.reconcileAll();

    expect(graph.listSubscribedFields).not.toHaveBeenCalled();
    expect(graph.subscribePageToApp).not.toHaveBeenCalled();
    expect(connections.markReauthRequired).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ considered: 1, skipped: 1, unrepairable: 0 });
  });

  it('spends no call on a page with no token', async () => {
    channels.findSendContext.mockResolvedValue(pageContext({ effectiveAccessToken: null }));

    const summary = await service.reconcileAll();

    expect(cipher.decrypt).not.toHaveBeenCalled();
    expect(graph.listSubscribedFields).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    // Silence would hide a Page that receives nothing, so it is a warning.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: PAGE_ID }),
      expect.stringContaining('no usable token'),
    );
  });

  it('spends no call on an instagram channel, whose page carries the subscription', async () => {
    channels.findSendContext.mockResolvedValue(
      pageContext({
        platform: Platform.Instagram,
        platformChannelId: '17841400000000000',
        parentPlatformChannelId: PAGE_ID,
      }),
    );

    const summary = await service.reconcileAll();

    // `{ig-id}/subscribed_apps` is not an edge that exists: the linked Page's
    // subscription is what covers Instagram, and reconciling the Page repairs it.
    expect(graph.listSubscribedFields).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
  });

  it('reports an unreadable token loudly and repairs nothing', async () => {
    cipher.decrypt.mockImplementation(() => {
      throw new Error('no key for version k9');
    });

    const summary = await service.reconcileAll();

    expect(graph.listSubscribedFields).not.toHaveBeenCalled();
    expect(summary.unrepairable).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: CHANNEL_ID }),
      expect.stringContaining('key loss or tampering'),
    );
  });

  it('carries on to the next channel after one fails', async () => {
    const secondChannelId = 43;
    channels.listAllForRefresh.mockResolvedValue([
      { id: CHANNEL_ID, enterpriseId: ENTERPRISE_ID },
      { id: secondChannelId, enterpriseId: ENTERPRISE_ID },
    ]);
    // In order, because the sweep is sequential by design — one channel's Graph
    // call finishes before the next one starts.
    channels.findSendContext
      .mockResolvedValueOnce(pageContext())
      .mockResolvedValueOnce(pageContext({ channelId: secondChannelId }));
    graph.listSubscribedFields
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce([...SUBSCRIBED_FIELDS]);

    const summary = await service.reconcileAll();

    // One tenant's broken channel must not cost every other tenant its check.
    expect(summary).toMatchObject({ considered: 2, verified: 1, unrepairable: 1 });
  });

  it('never logs a token, encrypted or otherwise', async () => {
    graph.listSubscribedFields.mockResolvedValue([]);

    await service.reconcileAll();

    const logged = JSON.stringify([
      logger.debug.mock.calls,
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    expect(logged).not.toContain(PAGE_TOKEN);
    expect(logged).not.toContain(ENCRYPTED_TOKEN);
  });
});

describe('WebhookSubscriptionReconcilerWorker', () => {
  const loggerFor = () => ({ info: vi.fn(), error: vi.fn() });

  it('logs one line naming what the run found', async () => {
    const logger = loggerFor();
    const summary = {
      runId: 'run-1',
      considered: 3,
      verified: 2,
      repaired: 1,
      unrepairable: 0,
      skipped: 0,
    };
    const worker = new WebhookSubscriptionReconcilerWorker(
      { reconcileAll: vi.fn().mockResolvedValue(summary) } as unknown as WebhookSubscriptionService,
      logger as unknown as PinoLogger,
    );

    await worker.reconcile();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining(summary),
      expect.stringContaining('complete'),
    );
  });

  it('swallows a failure so the schedule survives it', async () => {
    const logger = loggerFor();
    const worker = new WebhookSubscriptionReconcilerWorker(
      {
        reconcileAll: vi.fn().mockRejectedValue(new Error('the database is down')),
      } as unknown as WebhookSubscriptionService,
      logger as unknown as PinoLogger,
    );

    // A cron handler that rejects stops scheduling, which would silently end
    // reconciliation for the lifetime of the process.
    await expect(worker.reconcile()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
