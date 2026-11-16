import { describe, expect, it, vi } from 'vitest';
import { ChatbotService } from '@/modules/inbox/chatbot.service';
import type { InboxService } from '@/modules/inbox/inbox.service';
import type { ChatService } from '@/modules/ai/chat.service';
import type { ConversationBriefService } from '@/modules/inbox/conversation-brief.service';
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
    counts: { hasBusinessProfile: true, hasPerson: true, hasPost: false },
  });
  const brief = { build } as unknown as ConversationBriefService;

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
  return { service: new ChatbotService(inbox, brief, chat), reply, build };
}

function message(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    direction: MessageDirection.Inbound,
    body: `message ${id}`,
    isInternalNote: false,
    ...over,
  };
}

describe('chatbot context', () => {
  it('reads the conversation in the order it happened, not newest first', async () => {
    const { service, reply } = serviceWith({
      // The repository returns newest first, because that is how a reader pages.
      messages: [message(3), message(2), message(1)],
    });
    await service.draftReply(1, 'conv-ref');

    const turns = reply.mock.calls[0]?.[0] as { text: string }[];
    expect(turns.map((turn) => turn.text)).toEqual(['message 1', 'message 2', 'message 3']);
  });

  it('maps who said what, so the model knows which half is its own', async () => {
    const { service, reply } = serviceWith({
      messages: [
        message(2, { direction: MessageDirection.Outbound, body: 'we said this' }),
        message(1, { direction: MessageDirection.Inbound, body: 'they said this' }),
      ],
    });
    await service.draftReply(1, 'conv-ref');

    expect(reply.mock.calls[0]?.[0]).toEqual([
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
    expect((reply.mock.calls[0]?.[0] as { text: string }[])[0]?.text).toBe('look');
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

    expect(reply.mock.calls[0]?.[1]).toContain('<business>');
    expect(draft.context.hasBusinessProfile).toBe(true);
  });
});
