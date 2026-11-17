import { describe, expect, it, vi } from 'vitest';
import { InboxController } from '@/modules/inbox/inbox.controller';
import { InboxService } from '@/modules/inbox/inbox.service';
import { RequestContext } from '@/shared/context';
import { ErrorCode } from '@/shared/errors';
import { MessageDirection, MessageKind, MessageStatus, Permission } from '@/shared/enums';
import type { ActorContext } from '@/shared/context';

/**
 * "What had it understood when this went out?" — asked at one of our
 * messages, answered from the notes that stood at that moment.
 *
 * TWO THINGS CAN GO SILENTLY WRONG HERE and neither throws:
 *
 *   1. The boundary. The replay path takes the notes written BEFORE a reply,
 *      because that is what the model was shown. A reader wants the opposite
 *      — the notes that reply itself wrote — and the two differ by exactly
 *      one message, which is the one being asked about. Off by one and the
 *      panel answers a question nobody asked, convincingly.
 *
 *   2. The button. It is drawn from a single number for the whole page, so a
 *      wrong rule either hides the control on messages that have an answer or
 *      offers it on ones that cannot have one.
 */
const CONVERSATION = { id: 7, refId: 'conv-ref', conversationKind: 'direct_message' };

const WRITTEN_AT = new Date('2026-11-17T09:00:00.000Z');

function serviceWith(overrides: Record<string, unknown> = {}): {
  service: InboxService;
  messages: Record<string, ReturnType<typeof vi.fn>>;
} {
  const messages = {
    findMessageIdByRef: vi.fn().mockResolvedValue(42),
    notesAsOf: vi.fn().mockResolvedValue({
      summary: 'They asked about delivery to Pune; we quoted two days.',
      refId: 'msg-ref',
      writtenAt: WRITTEN_AT,
      isSameMessage: true,
    }),
    ...overrides,
  };
  const service = Object.create(InboxService.prototype) as InboxService;
  Object.assign(service, {
    conversations: { findByRefId: vi.fn().mockResolvedValue(CONVERSATION) },
    messages,
  });
  return { service, messages };
}

/** An actor who may read this inbox, since the read is permission-checked. */
function asViewer<T>(work: () => Promise<T>): Promise<T> {
  const actor = {
    enterpriseId: 2,
    permissions: new Set([Permission.ConversationsView]),
  } as unknown as ActorContext;
  return RequestContext.run({ correlationId: 'test', actor }, work);
}

describe('the notes as of one message', () => {
  it('returns the notes that message wrote, and says it wrote them', async () => {
    const { service, messages } = serviceWith();

    const result = await asViewer(() => service.readNotesAsOf(2, 'conv-ref', 'msg-ref'));

    expect(result.notes).toContain('delivery to Pune');
    expect(result.summarisedHere).toBe(true);
    expect(result.writtenByRefId).toBe('msg-ref');
    expect(result.writtenAt).toEqual(WRITTEN_AT);
    /*
     * AT, not before. The replay path deliberately asks for the notes that
     * existed BEFORE a reply; this one must not, or every reply would show
     * the notes of the one before it.
     */
    expect(messages.notesAsOf).toHaveBeenCalledWith(2, 7, 42);
  });

  it('says so when the notes have not caught up with the message', async () => {
    /*
     * A colleague answering from the Instagram app. Nothing summarised what
     * they said, and the last notes written still stand — shown, but not
     * presented as if they had read this message.
     */
    const { service } = serviceWith({
      notesAsOf: vi.fn().mockResolvedValue({
        summary: 'They asked about delivery.',
        refId: 'earlier-ref',
        writtenAt: WRITTEN_AT,
        isSameMessage: false,
      }),
    });

    const result = await asViewer(() => service.readNotesAsOf(2, 'conv-ref', 'manual-ref'));

    expect(result.summarisedHere).toBe(false);
    expect(result.writtenByRefId).toBe('earlier-ref');
  });

  it('refuses a message that is not in this conversation', async () => {
    const { service } = serviceWith({ findMessageIdByRef: vi.fn().mockResolvedValue(null) });

    await expect(
      asViewer(() => service.readNotesAsOf(2, 'conv-ref', 'someone-elses-ref')),
    ).rejects.toMatchObject({ code: ErrorCode.MessageNotFound });
  });

  it('refuses rather than returning an empty summary when nothing was summarised', async () => {
    const { service } = serviceWith({ notesAsOf: vi.fn().mockResolvedValue(null) });

    await expect(
      asViewer(() => service.readNotesAsOf(2, 'conv-ref', 'msg-ref')),
    ).rejects.toMatchObject({ code: ErrorCode.MessageNotFound });
  });

  it('stays inside the tenant and the conversation that was opened', async () => {
    const { service, messages } = serviceWith();
    await asViewer(() => service.readNotesAsOf(2, 'conv-ref', 'msg-ref'));
    expect(messages.findMessageIdByRef).toHaveBeenCalledWith(2, 7, 'msg-ref');
  });
});

/** One row as listThread returns it, with only what the mapping reads. */
function row(id: number, direction: MessageDirection, extra: Record<string, unknown> = {}) {
  return {
    id,
    refId: `ref-${id}`,
    direction,
    body: 'text',
    messageKind: MessageKind.Text,
    status: MessageStatus.Sent,
    isRead: true,
    isInternalNote: false,
    hasAttachments: false,
    canBeRepliedTo: true,
    metadata: {},
    ...extra,
  };
}

async function threadOf(rows: unknown[], notesFromMessageId: number | null) {
  const controller = Object.create(InboxController.prototype) as InboxController;
  Object.assign(controller, {
    inbox: {
      readThread: vi.fn().mockResolvedValue({
        conversation: { ...CONVERSATION, contextMetadata: {} },
        messages: rows,
        attachmentsByMessageId: new Map(),
        analysisByKey: new Map(),
        knownAuthors: new Map(),
        failedModerationCommentIds: new Set(),
        parentMention: null,
        notesFromMessageId,
        nextCursor: null,
        hasMore: false,
      }),
    },
  });
  const actor = { enterpriseId: 2 } as never;
  const result = (await controller.thread(actor, '11111111-1111-4111-8111-111111111111', {})) as {
    messages: { refId: string; hasNotes: boolean }[];
  };
  return new Map(result.messages.map((message) => [message.refId, message.hasNotes]));
}

describe('which messages offer the notes', () => {
  it('offers it from the first message that has notes onwards, and not before', async () => {
    const offered = await threadOf(
      [
        row(10, MessageDirection.Outbound),
        row(20, MessageDirection.Outbound),
        row(30, MessageDirection.Outbound),
      ],
      20,
    );

    // Nothing had been summarised yet at message 10.
    expect(offered.get('ref-10')).toBe(false);
    // The one that wrote them, and everything after it.
    expect(offered.get('ref-20')).toBe(true);
    expect(offered.get('ref-30')).toBe(true);
  });

  it('never offers it on a message the customer sent', async () => {
    const offered = await threadOf([row(30, MessageDirection.Inbound)], 20);
    /*
     * The notes are what the assistant knew when WE last spoke. Asking the
     * question at a customer's message has no meaning: they did not say
     * anything on the strength of what it understood.
     */
    expect(offered.get('ref-30')).toBe(false);
  });

  it('never offers it on an internal note, which never left the building', async () => {
    const offered = await threadOf(
      [row(30, MessageDirection.Outbound, { isInternalNote: true })],
      20,
    );
    expect(offered.get('ref-30')).toBe(false);
  });

  it('offers it nowhere in a thread the assistant has never written in', async () => {
    const offered = await threadOf([row(30, MessageDirection.Outbound)], null);
    expect(offered.get('ref-30')).toBe(false);
  });
});
