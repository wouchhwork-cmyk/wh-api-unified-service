import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PinoLogger } from 'nestjs-pino';
import type { ChannelRepository } from '@/database/repositories/channel.repository';
import type { MessageRepository } from '@/database/repositories/message.repository';
import type { OutboundEventRepository } from '@/database/repositories/outbound-event.repository';
import type { GraphApiClient } from '@/modules/connections/graph/graph-api.client';
import type { TokenCipherService } from '@/shared/crypto';
import { SendReconciliationService } from '@/modules/inbox/send-reconciliation.service';
import { MessageStatus, OutboundEventType, Platform } from '@/shared/enums';
import { SEND_READ_BACK_MATCH_WINDOW_MS, SEND_READ_BACK_WINDOW_MS } from '@/shared/constants';

/**
 * Reading back a send whose outcome Meta never confirmed.
 *
 * The bug this exists for was observed live (todo E20): a mention reply was
 * accepted by Instagram, the HTTP response was lost, and the inbox said
 * `failed` about a comment the customer could read. An agent trusting that
 * sends it again and the same words appear twice.
 *
 * So the assertions that matter most are the ones about NOT concluding too
 * much: a send that cannot be seen is `unknown`, never `lost`, because only
 * `lost` invites a resend.
 *
 * Everything external is stubbed: no Postgres, no Graph, no clock.
 */

const ENTERPRISE_ID = 7;
const CHANNEL_ID = 42;
const EVENT_ID = 1234;
const IG_USER_ID = '17841400000000000';
const ENCRYPTED = 'v1:k1:nonce:ciphertext';
const TOKEN = 'ig-token';
const BODY = 'Thanks for the mention!';

const sendRow = (overrides: Record<string, unknown> = {}) => ({
  id: EVENT_ID,
  enterpriseId: ENTERPRISE_ID,
  channelId: CHANNEL_ID,
  eventType: OutboundEventType.MentionReply,
  destinationId: String(CHANNEL_ID),
  payload: { mediaId: 'media-1', commentId: 'comment-1', message: BODY },
  lastErrorAt: new Date(Date.now() - 5 * 60 * 1000),
  ...overrides,
});

const comment = (overrides: Record<string, unknown> = {}) => ({
  platformId: '18115614217814583',
  text: BODY,
  timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  likeCount: 0,
  ...overrides,
});

describe('SendReconciliationService.reconcileAll', () => {
  let outbound: { [K in keyof OutboundEventRepository]?: ReturnType<typeof vi.fn> };
  let messages: { [K in keyof MessageRepository]?: ReturnType<typeof vi.fn> };
  let channels: { [K in keyof ChannelRepository]?: ReturnType<typeof vi.fn> };
  let graph: { [K in keyof GraphApiClient]?: ReturnType<typeof vi.fn> };
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let service: SendReconciliationService;

  beforeEach(() => {
    outbound = {
      listAmbiguousAwaitingReadBack: vi.fn().mockResolvedValue([sendRow()]),
      markReadBackResolved: vi.fn().mockResolvedValue(true),
    };
    messages = { recordDelivery: vi.fn().mockResolvedValue(undefined) };
    channels = {
      findSendContext: vi.fn().mockResolvedValue({
        channelId: CHANNEL_ID,
        platform: Platform.Instagram,
        platformChannelId: IG_USER_ID,
        effectiveAccessToken: ENCRYPTED,
        reauthRequired: false,
        isManaged: true,
      }),
    };
    graph = {
      listMentionedPostComments: vi.fn().mockResolvedValue([]),
      listMentionedMediaComments: vi.fn().mockResolvedValue([]),
      listCommentReplies: vi.fn().mockResolvedValue([]),
    };
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    service = new SendReconciliationService(
      outbound as unknown as OutboundEventRepository,
      messages as unknown as MessageRepository,
      channels as unknown as ChannelRepository,
      graph as unknown as GraphApiClient,
      { decrypt: vi.fn().mockReturnValue(TOKEN) } as unknown as TokenCipherService,
      logger as unknown as PinoLogger,
    );
  });

  it('promotes a send that had actually landed, and corrects the message', async () => {
    graph.listMentionedPostComments!.mockResolvedValue([comment()]);

    const summary = await service.reconcileAll();

    expect(summary).toMatchObject({ considered: 1, landed: 1, lost: 0, unknown: 0 });
    expect(outbound.markReadBackResolved).toHaveBeenCalledWith({
      id: EVENT_ID,
      outcome: 'landed',
      platformEventId: '18115614217814583',
    });

    // The whole point: the agent was looking at `failed` for a live comment.
    expect(messages.recordDelivery).toHaveBeenCalledWith(
      ENTERPRISE_ID,
      EVENT_ID,
      '18115614217814583',
      MessageStatus.Sent,
    );
  });

  it('records a send that genuinely never landed as lost', async () => {
    const summary = await service.reconcileAll();

    expect(summary).toMatchObject({ landed: 0, lost: 1 });
    expect(outbound.markReadBackResolved).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'lost', platformEventId: null }),
    );
    // Nothing to correct — the message is already failed, which is now true.
    expect(messages.recordDelivery).not.toHaveBeenCalled();
  });

  /*
   * THE GUARD AGAINST A FALSE POSITIVE. Text alone is not unique: an agent who
   * sends the same words twice in a day would otherwise have the second send
   * matched against the first one's comment and marked delivered while it is
   * genuinely missing.
   */
  it('does not match the same text posted outside the time window', async () => {
    graph.listMentionedPostComments!.mockResolvedValue([
      comment({
        timestamp: new Date(
          Date.now() - 5 * 60 * 1000 - SEND_READ_BACK_MATCH_WINDOW_MS - 60_000,
        ).toISOString(),
      }),
    ]);

    const summary = await service.reconcileAll();

    expect(summary).toMatchObject({ landed: 0, lost: 1 });
    expect(messages.recordDelivery).not.toHaveBeenCalled();
  });

  /*
   * UNKNOWN IS NOT LOST. Past Instagram's comments window "not found" stops
   * being evidence, and calling it lost would invite a duplicate.
   */
  it('settles a send too old to read back as unknown, without calling the platform', async () => {
    outbound.listAmbiguousAwaitingReadBack!.mockResolvedValue([
      sendRow({ lastErrorAt: new Date(Date.now() - SEND_READ_BACK_WINDOW_MS - 60_000) }),
    ]);

    const summary = await service.reconcileAll();

    expect(summary).toMatchObject({ unknown: 1, lost: 0, landed: 0 });
    expect(graph.listMentionedPostComments).not.toHaveBeenCalled();
    expect(messages.recordDelivery).not.toHaveBeenCalled();
  });

  it('treats an unusable channel as unknown rather than lost', async () => {
    channels.findSendContext!.mockResolvedValue({
      platformChannelId: IG_USER_ID,
      effectiveAccessToken: ENCRYPTED,
      reauthRequired: true,
      isManaged: true,
    });

    const summary = await service.reconcileAll();

    expect(summary).toMatchObject({ unknown: 1, lost: 0 });
    expect(graph.listMentionedPostComments).not.toHaveBeenCalled();
  });

  /*
   * A CAPTION MENTION HAS NO COMMENT ID, and our reply to one is a top-level
   * comment on the tagged post — a different edge. Reading the wrong one finds
   * nothing, which would mark a live reply lost.
   */
  it('reads a caption mention back from the media, not the comment thread', async () => {
    outbound.listAmbiguousAwaitingReadBack!.mockResolvedValue([
      sendRow({ payload: { mediaId: 'media-1', commentId: null, message: BODY } }),
    ]);
    graph.listMentionedMediaComments!.mockResolvedValue([comment()]);

    const summary = await service.reconcileAll();

    expect(graph.listMentionedMediaComments).toHaveBeenCalledWith(IG_USER_ID, 'media-1', TOKEN);
    expect(graph.listMentionedPostComments).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ landed: 1 });
  });

  it('reads a comment reply back from the replies edge', async () => {
    outbound.listAmbiguousAwaitingReadBack!.mockResolvedValue([
      sendRow({
        eventType: OutboundEventType.CommentReply,
        payload: { commentId: 'parent-comment', message: BODY },
      }),
    ]);
    graph.listCommentReplies!.mockResolvedValue([comment()]);

    const summary = await service.reconcileAll();

    expect(graph.listCommentReplies).toHaveBeenCalledWith('parent-comment', TOKEN);
    expect(summary).toMatchObject({ landed: 1 });
  });

  /*
   * The ledger is written first and will not apply twice. If it reports that
   * somebody else resolved the row, the message must NOT be written again.
   */
  it('does not touch the message when the ledger row was already resolved', async () => {
    graph.listMentionedPostComments!.mockResolvedValue([comment()]);
    outbound.markReadBackResolved!.mockResolvedValue(false);

    await service.reconcileAll();

    expect(messages.recordDelivery).not.toHaveBeenCalled();
  });

  it('keeps going when one send cannot be read back', async () => {
    outbound.listAmbiguousAwaitingReadBack!.mockResolvedValue([
      sendRow({ id: 1 }),
      sendRow({ id: 2 }),
    ]);
    graph.listMentionedPostComments!
      .mockRejectedValueOnce(new Error('graph is down'))
      .mockResolvedValue([comment()]);

    const summary = await service.reconcileAll();

    expect(summary.considered).toBe(2);
    expect(summary.landed).toBe(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('spends nothing when there is nothing to reconcile', async () => {
    outbound.listAmbiguousAwaitingReadBack!.mockResolvedValue([]);

    const summary = await service.reconcileAll();

    expect(summary).toMatchObject({ considered: 0 });
    expect(logger.info).not.toHaveBeenCalled();
  });
});
