import { describe, expect, it, vi } from 'vitest';
import { ChatbotService } from '@/modules/inbox/chatbot.service';
import type { InboxService } from '@/modules/inbox/inbox.service';
import type { ChatService } from '@/modules/ai/chat.service';
import type { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { MediaAnalysisStatus, MessageDirection } from '@/shared/enums';

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
const ENTERPRISE = {
  name: 'Acme Legal Name Ltd',
  displayName: 'Acme',
  about: 'We sell handmade candles.',
  links: [{ label: 'Shop', url: 'https://acme.test/shop' }],
  contacts: [{ label: 'Support', phone: '+91 90000 00000', email: 'help@acme.test' }],
};

function serviceWith(
  thread: Partial<{
    messages: unknown[];
    attachmentsByMessageId: Map<number, unknown[]>;
    analysisByKey: Map<string, unknown>;
  }>,
  enterprise: unknown = ENTERPRISE,
) {
  const inbox = {
    readThread: vi.fn().mockResolvedValue({
      messages: [],
      attachmentsByMessageId: new Map(),
      analysisByKey: new Map(),
      ...thread,
    }),
  } as unknown as InboxService;
  const enterprises = {
    findById: vi.fn().mockResolvedValue(enterprise),
  } as unknown as EnterpriseRepository;
  const reply = vi.fn().mockResolvedValue({
    text: 'drafted',
    usage: {},
    truncated: false,
    model: 'gpt-6-luna',
    provider: 'openai',
    promptVersion: 1,
  });
  const chat = { reply } as unknown as ChatService;
  return { service: new ChatbotService(inbox, enterprises, chat), reply };
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

  it('tells the model the media line is its own seeing, not a quote', async () => {
    /*
     * Asked "did you watch it?", it answered "I can read the description you
     * shared, but I can't watch the video itself" — true about the plumbing,
     * and useless to a customer who had just sent a video to a business.
     */
    const { service, reply } = serviceWith({
      messages: [message(1, { body: 'did you watch it?' })],
      attachmentsByMessageId: new Map([[1, [{ mediaKey: 'asset:9' }]]]),
      analysisByKey: new Map([
        [
          'asset:9',
          { status: MediaAnalysisStatus.Done, summary: 'A dog on a skateboard', transcript: null },
        ],
      ]),
    });
    await service.draftReply(1, 'conv-ref');

    const instructions = reply.mock.calls[0]?.[1] as string;
    expect(instructions).toContain('your own record');
    expect(instructions).toContain('do not say you are unable to see');
  });

  it('does not explain the media convention when there is no media', async () => {
    const { service, reply } = serviceWith({ messages: [message(1)] });
    await service.draftReply(1, 'conv-ref');
    expect(reply.mock.calls[0]?.[1] as string).not.toContain('[media:');
  });

  it('tells the model who it is replying for, from the business profile', async () => {
    const { service, reply } = serviceWith({ messages: [message(1)] });
    const draft = await service.draftReply(1, 'conv-ref');

    const instructions = reply.mock.calls[0]?.[1] as string;
    expect(instructions).toContain('Acme');
    expect(instructions).toContain('handmade candles');
    expect(instructions).toContain('https://acme.test/shop');
    expect(instructions).toContain('help@acme.test');
    // The guard against filling the gaps in a profile it was handed.
    expect(instructions).toContain('rather than inventing it');
    expect(draft.context.hasBusinessProfile).toBe(true);
  });

  it('prefers the name customers see over the registered one', async () => {
    const { service, reply } = serviceWith({ messages: [message(1)] });
    await service.draftReply(1, 'conv-ref');
    const instructions = reply.mock.calls[0]?.[1] as string;
    expect(instructions).toContain('on behalf of Acme.');
    expect(instructions).not.toContain('Legal Name');
  });

  it('carries no business heading when the profile is empty', async () => {
    const { service, reply } = serviceWith({ messages: [message(1)] }, null);
    const draft = await service.draftReply(1, 'conv-ref');
    expect(reply.mock.calls[0]?.[1]).toBeUndefined();
    expect(draft.context.hasBusinessProfile).toBe(false);
  });
});
