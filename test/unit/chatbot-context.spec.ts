import { describe, expect, it, vi } from 'vitest';
import { ChatbotService } from '@/modules/inbox/chatbot.service';
import type { InboxService } from '@/modules/inbox/inbox.service';
import type { ChatService } from '@/modules/ai/chat.service';
import type { ConversationBriefService } from '@/modules/inbox/conversation-brief.service';
import type { MessageRepository } from '@/database/repositories/message.repository';
import { ConversationKind, MediaAnalysisStatus, MessageDirection } from '@/shared/enums';

/**
 * What the model is shown, which is the whole of this feature.
 *
 * Two of these are leaks rather than bugs. An internal note handed to the
 * model is a colleague's private remark about a customer, which the model
 * will happily quote back TO that customer. And a description of media whose
 * link has since expired is the only record of what was sent — leaving it out
 * is not a smaller answer, it is an assistant that cannot see the photo the
 * entire conversation is about.
 */
const CONVERSATION = {
  id: 42,
  customerId: 7,
  conversationKind: ConversationKind.DirectMessage,
  messageCount: 3,
};

function serviceWith(
  thread: Partial<{
    conversation: unknown;
    messages: unknown[];
    attachmentsByMessageId: Map<number, unknown[]>;
    analysisByKey: Map<string, unknown>;
  }>,
  answer: Record<string, unknown> = {},
) {
  const inbox = {
    readThread: vi.fn().mockResolvedValue({
      conversation: CONVERSATION,
      messages: [],
      attachmentsByMessageId: new Map(),
      analysisByKey: new Map(),
      ...thread,
    }),
  } as unknown as InboxService;

  const build = vi.fn().mockResolvedValue({
    xml: '<business><name>Acme</name></business>',
    counts: { hasBusinessProfile: true, hasPerson: true, hasPost: false, hasSummary: false },
  });
  const brief = { build } as unknown as ConversationBriefService;

  const latestAssistantSummary = vi.fn().mockResolvedValue(null);
  const messages = { latestAssistantSummary } as unknown as MessageRepository;

  const reply = vi.fn().mockResolvedValue({
    text: 'drafted',
    usage: {},
    truncated: false,
    model: 'gpt-6-luna',
    provider: 'openai',
    promptVersion: 1,
    language: 'English',
    intent: null,
    handoff: null,
    silent: false,
    structured: true,
    ...answer,
  });
  const chat = { reply } as unknown as ChatService;
  return {
    service: new ChatbotService(inbox, brief, messages, chat),
    reply,
    build,
    latestAssistantSummary,
  };
}

function message(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    refId: `ref-${id}`,
    messageKind: 'text',
    parentRefId: null,
    direction: MessageDirection.Inbound,
    body: `message ${id}`,
    isInternalNote: false,
    ...over,
  };
}

/** The turn text with its id marker taken off, for the assertions that predate it. */
const said = (turn: { text: string }) => turn.text.replace(/^\[id:[^\]]+\]\s*/, '');

describe('chatbot context', () => {
  it('reads the conversation in the order it happened, not newest first', async () => {
    const { service, reply } = serviceWith({
      // The repository returns newest first, because that is how a reader pages.
      messages: [message(3), message(2), message(1)],
    });
    await service.draftReply(1, 'conv-ref');

    const turns = reply.mock.calls[0]?.[0] as { text: string }[];
    expect(turns.map(said)).toEqual(['message 1', 'message 2', 'message 3']);
  });

  it('maps who said what, so the model knows which half is its own', async () => {
    const { service, reply } = serviceWith({
      messages: [
        message(2, { direction: MessageDirection.Outbound, body: 'we said this' }),
        message(1, { direction: MessageDirection.Inbound, body: 'they said this' }),
      ],
    });
    await service.draftReply(1, 'conv-ref');

    const turns = reply.mock.calls[0]?.[0] as { role: string; text: string }[];
    expect(turns.map((turn) => ({ role: turn.role, text: said(turn) }))).toEqual([
      { role: 'user', text: 'they said this' },
      { role: 'assistant', text: 'we said this' },
    ]);
  });

  it('never shows the model an internal note', async () => {
    const { service, reply } = serviceWith({
      messages: [
        message(2, { isInternalNote: true, body: 'this one is a known time waster' }),
        message(1, { body: 'is this still available?' }),
      ],
    });
    await service.draftReply(1, 'conv-ref');

    const turns = reply.mock.calls[0]?.[0] as { text: string }[];
    expect(turns).toHaveLength(1);
    expect(JSON.stringify(turns)).not.toContain('time waster');
  });

  it('folds in what a photo showed, long after its link stopped working', async () => {
    const { service, reply } = serviceWith({
      messages: [message(1, { body: 'can you fix this?' })],
      attachmentsByMessageId: new Map([[1, [{ mediaKey: 'asset:9' }]]]),
      analysisByKey: new Map([
        [
          'asset:9',
          {
            status: MediaAnalysisStatus.Done,
            summary: 'A cracked blue ceramic mug',
            transcript: null,
          },
        ],
      ]),
    });
    const draft = await service.draftReply(1, 'conv-ref');

    const turns = reply.mock.calls[0]?.[0] as { text: string }[];
    expect(turns[0]?.text).toContain('can you fix this?');
    expect(turns[0]?.text).toContain('A cracked blue ceramic mug');
    expect(draft.context.mediaDescriptions).toBe(1);
  });

  it('says nothing about media that has not been described yet', async () => {
    const { service, reply } = serviceWith({
      messages: [message(1, { body: 'look' })],
      attachmentsByMessageId: new Map([[1, [{ mediaKey: 'asset:9' }]]]),
      analysisByKey: new Map([
        ['asset:9', { status: MediaAnalysisStatus.Pending, summary: null, transcript: null }],
      ]),
    });
    const draft = await service.draftReply(1, 'conv-ref');
    expect(said((reply.mock.calls[0]?.[0] as { text: string }[])[0]!)).toBe('look');
    expect(draft.context.mediaDescriptions).toBe(0);
  });

  it('tells the brief a voice note was in Hindi, so the reply can be', async () => {
    const { service, build } = serviceWith({
      messages: [message(1, { body: '' })],
      attachmentsByMessageId: new Map([[1, [{ mediaKey: 'asset:9' }]]]),
      analysisByKey: new Map([
        [
          'asset:9',
          {
            status: MediaAnalysisStatus.Done,
            summary: 'Asking whether the shop is open on Sunday',
            transcript: 'Kya Sunday ko khula rahega?',
            language: 'Hindi',
          },
        ],
      ]),
    });
    await service.draftReply(1, 'conv-ref');

    expect(build.mock.calls[0]?.[0]).toMatchObject({ mediaLanguages: ['Hindi'], hasMedia: true });
  });

  it('ignores the language of media WE sent', async () => {
    /*
     * A business posting an English clip into a Hindi conversation would
     * otherwise quietly flip the language of every reply after it.
     */
    const { service, build } = serviceWith({
      messages: [message(1, { direction: MessageDirection.Outbound, body: 'here you go' })],
      attachmentsByMessageId: new Map([[1, [{ mediaKey: 'asset:9' }]]]),
      analysisByKey: new Map([
        [
          'asset:9',
          { status: MediaAnalysisStatus.Done, summary: 'A product clip', language: 'English' },
        ],
      ]),
    });
    await service.draftReply(1, 'conv-ref');

    expect(build.mock.calls[0]?.[0]).toMatchObject({ mediaLanguages: [] });
  });

  it('strips the markdown a model reaches for, because a DM shows it raw', async () => {
    const { service } = serviceWith(
      { messages: [message(1)] },
      { text: 'We have **three** left:\n- blue\n- red' },
    );
    const draft = await service.draftReply(1, 'conv-ref');

    expect(draft.text).toBe('We have three left:\nblue\nred');
  });

  it('keeps an empty reply empty rather than shaping nothing into something', async () => {
    const { service } = serviceWith({ messages: [message(1)] }, { text: '', silent: true });
    const draft = await service.draftReply(1, 'conv-ref');

    expect(draft.text).toBe('');
    expect(draft.silent).toBe(true);
  });

  it('passes the brief on as context, not as another instruction', async () => {
    const { service, reply } = serviceWith({ messages: [message(1)] });
    const draft = await service.draftReply(1, 'conv-ref');

    const options = reply.mock.calls[0]?.[1] as { context: string; purpose: string };
    expect(options.context).toContain('<business>');
    /* And it says whose spend it is: a colleague pressed the button. */
    expect(options.purpose).toBe('draft');
    expect(draft.context.hasBusinessProfile).toBe(true);
  });
});

/**
 * The notes are what let the window be short.
 *
 * Without them, remembering message four on message forty means paying for
 * all forty on every reply, for as long as the thread lives.
 */
describe('what it remembers from before the window', () => {
  it('reads the notes by their own query, not out of the messages it was shown', async () => {
    /*
     * The reply that wrote them is routinely OUTSIDE the window — ten
     * messages in a row from one customer push the last answer out of it
     * entirely, which is exactly when the notes matter most.
     */
    const { service, latestAssistantSummary } = serviceWith({ messages: [message(1)] });
    await service.draftReply(1, 'conv-ref');

    expect(latestAssistantSummary).toHaveBeenCalledWith(1, 42);
  });

  it('hands them to the brief to carry forward', async () => {
    const { service, build, latestAssistantSummary } = serviceWith({ messages: [message(1)] });
    latestAssistantSummary.mockResolvedValueOnce('They are chasing order 4471.');
    await service.draftReply(1, 'conv-ref');

    expect(build.mock.calls[0]?.[0]).toMatchObject({
      summary: 'They are chasing order 4471.',
    });
  });

  it('carries nothing forward on a conversation it has never answered', async () => {
    const { service, build } = serviceWith({ messages: [message(1)] });
    await service.draftReply(1, 'conv-ref');

    expect(build.mock.calls[0]?.[0]).toMatchObject({ summary: null });
  });
});

/**
 * The model cannot point at a message it has no name for.
 *
 * Without ids the notes can only describe ("they complained about a
 * parcel"), which nobody can open and nothing can verify. With them the
 * notes become an index into the thread that outlives the window.
 */
describe('how the messages are named', () => {
  it('tags every turn with the message it came from', async () => {
    const { service, reply } = serviceWith({ messages: [message(2), message(1)] });
    await service.draftReply(1, 'conv-ref');

    const turns = reply.mock.calls[0]?.[0] as { text: string }[];
    expect(turns[0]?.text).toBe('[id:ref-1] message 1');
    expect(turns[1]?.text).toBe('[id:ref-2] message 2');
  });

  it('says how a message arrived and what it answers', async () => {
    const { service, reply } = serviceWith({
      messages: [
        message(2, { messageKind: 'story_reply', parentRefId: 'ref-1', body: 'love this' }),
      ],
    });
    await service.draftReply(1, 'conv-ref');

    const turns = reply.mock.calls[0]?.[0] as { text: string }[];
    expect(turns[0]?.text).toBe('[id:ref-2 kind:story_reply re:ref-1] love this');
  });

  it('names our own messages too, so the notes can cite what we said', async () => {
    const { service, reply } = serviceWith({
      messages: [message(5, { direction: MessageDirection.Outbound, body: 'we said this' })],
    });
    await service.draftReply(1, 'conv-ref');

    const turns = reply.mock.calls[0]?.[0] as { role: string; text: string }[];
    expect(turns[0]).toMatchObject({ role: 'assistant', text: '[id:ref-5] we said this' });
  });

  it('never lets an id reach the customer, whatever the model does', async () => {
    /* The rules tell it not to repeat them. A rule is advice; this is not. */
    const { service } = serviceWith(
      { messages: [message(1)] },
      { text: '[id:ref-1] Yes, we have those in stock.' },
    );
    const draft = await service.draftReply(1, 'conv-ref');

    expect(draft.text).toBe('Yes, we have those in stock.');
  });
});
