import { describe, expect, it, vi } from 'vitest';
import { AutoReplyService } from '@/modules/inbox/auto-reply.service';
import type { ChatService } from '@/modules/ai/chat.service';
import type { ChatbotService } from '@/modules/inbox/chatbot.service';
import type { InboxService } from '@/modules/inbox/inbox.service';
import type { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import type { MessageRepository } from '@/database/repositories/message.repository';
import type { AuditService } from '@/modules/audit/audit.service';
import type { PinoLogger } from 'nestjs-pino';
import { AuditStatus, ConversationStatus } from '@/shared/enums';

/**
 * The guards in front of a message to a real person.
 *
 * Every one of these tests is about something that CANNOT BE UNDONE. A reply
 * arrives on somebody's phone in the business's name; there is no retraction,
 * no edit and no apology that reaches them as reliably as the mistake did. So
 * the thing worth proving is not that the assistant answers — it is that it
 * stays quiet in every case where it should.
 */
function serviceWith(over: {
  platformAutoReply?: boolean;
  businessOptedIn?: boolean;
  providerEnabled?: boolean;
  context?: Record<string, unknown> | null;
  fallbackMessage?: string;
  mediaHoldMessage?: string;
  draftFails?: boolean;
  draft?: Record<string, unknown>;
}) {
  const chat = {
    currentSettings: vi.fn().mockResolvedValue({
      provider: 'openai',
      model: 'gpt-6-luna',
      prompt: 'be brief',
      version: 1,
      autoReply: over.platformAutoReply ?? true,
      fallbackMessage: over.fallbackMessage ?? 'Stepping away, back shortly.',
      mediaHoldMessage: over.mediaHoldMessage ?? 'Let me take a look at that…',
    }),
    enabledFor: vi.fn().mockReturnValue(over.providerEnabled ?? true),
  } as unknown as ChatService;

  const enterprises = {
    findById: vi.fn().mockResolvedValue({ autoReplyEnabled: over.businessOptedIn ?? true }),
  } as unknown as EnterpriseRepository;

  const messagesCarrying = vi.fn().mockResolvedValue([100]);
  const assistantContextFor = vi.fn().mockResolvedValue(
    over.context === null
      ? null
      : {
          conversationId: 7,
          conversationRefId: 'conv-ref',
          status: ConversationStatus.Open,
          messagesSince: 0,
          pendingMedia: 0,
          ...over.context,
        },
  );
  const messages = { messagesCarrying, assistantContextFor } as unknown as MessageRepository;

  const draftReplyForAutomation = over.draftFails
    ? vi.fn().mockRejectedValue(new Error('the model call failed'))
    : vi.fn().mockResolvedValue({
        text: 'we open at nine',
        usage: { inputTokens: 10, outputTokens: 4 },
        truncated: false,
        model: 'gpt-6-luna',
        provider: 'openai',
        promptVersion: 1,
        context: { messages: 3, mediaDescriptions: 1, hasBusinessProfile: true },
        language: 'English',
        intent: 'asking opening hours',
        handoff: null,
        silent: false,
        structured: true,
        ...over.draft,
      });
  const replyAsAssistant = vi
    .fn()
    .mockResolvedValue({ messageRefId: 'msg-ref', status: 'pending' });
  const record = vi.fn().mockResolvedValue(undefined);

  const service = new AutoReplyService(
    chat,
    { draftReplyForAutomation } as unknown as ChatbotService,
    { replyAsAssistant } as unknown as InboxService,
    enterprises,
    messages,
    { record } as unknown as AuditService,
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as PinoLogger,
  );
  return {
    service,
    draftReply: draftReplyForAutomation,
    replyAsAssistant,
    record,
    assistantContextFor,
  };
}

describe('automatic reply: when it stays quiet', () => {
  it('says nothing while the platform switch is off', async () => {
    const { service, draftReply, replyAsAssistant } = serviceWith({ platformAutoReply: false });
    await service.considerReplying(1, 100);
    expect(draftReply).not.toHaveBeenCalled();
    expect(replyAsAssistant).not.toHaveBeenCalled();
  });

  it('says nothing until the business has opted in', async () => {
    const { service, draftReply } = serviceWith({ businessOptedIn: false });
    await service.considerReplying(1, 100);
    expect(draftReply).not.toHaveBeenCalled();
  });

  it('costs nothing when it is going to stay quiet', async () => {
    // The order of the checks is the point: the switches are read before any
    // paid call, not after one.
    const { service, draftReply } = serviceWith({ platformAutoReply: false });
    await service.considerReplying(1, 100);
    expect(draftReply).not.toHaveBeenCalled();
  });

  it('will not answer into a closed conversation', async () => {
    const { service, replyAsAssistant, record } = serviceWith({
      context: { status: ConversationStatus.Closed },
    });
    await service.considerReplying(1, 100);
    expect(replyAsAssistant).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ status: AuditStatus.Failure }));
  });

  it('stands down when somebody has already answered', async () => {
    const { service, replyAsAssistant, record } = serviceWith({ context: { messagesSince: 1 } });
    await service.considerReplying(1, 100);
    expect(replyAsAssistant).not.toHaveBeenCalled();
    expect(JSON.stringify(record.mock.calls[0])).toContain('conversation_moved_on');
  });

  it('never throws into ingest, and still leaves a trail when it breaks', async () => {
    const { service, record } = serviceWith({});
    const chat = Reflect.get(service, 'chat') as { currentSettings: () => Promise<unknown> };
    chat.currentSettings = () => Promise.reject(new Error('settings exploded'));
    // The customer's message is already stored; losing it to a failed draft
    // would be trading the thing that matters for the thing that does not.
    await expect(service.considerReplying(1, 100)).resolves.toBeUndefined();
    /*
     * The first automatic reply ever attempted died in this catch and left
     * only a log line, so a customer went unanswered by a feature that was
     * switched on and nothing durable recorded it.
     */
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ status: AuditStatus.Error }));
    expect(JSON.stringify(record.mock.calls[0])).toContain('settings exploded');
  });
});

describe('automatic reply: when the customer keeps typing', () => {
  /*
   * The draft takes seconds, and people type in bursts. The check before
   * drafting proves the question was current when we started; only a second
   * check proves the ANSWER is still current when it goes.
   */
  it('throws the draft away when a newer message arrived while it was written', async () => {
    const { service, replyAsAssistant, record, assistantContextFor } = serviceWith({});
    assistantContextFor
      .mockResolvedValueOnce({
        conversationId: 7,
        conversationRefId: 'conv-ref',
        status: ConversationStatus.Open,
        messagesSince: 0,
        pendingMedia: 0,
      })
      /* They said something else while the model was writing. */
      .mockResolvedValueOnce({
        conversationId: 7,
        conversationRefId: 'conv-ref',
        status: ConversationStatus.Open,
        messagesSince: 1,
        pendingMedia: 0,
      });

    await service.considerReplying(1, 100);

    expect(replyAsAssistant).not.toHaveBeenCalled();
    expect(JSON.stringify(record.mock.calls)).toContain('draftDiscarded');
  });

  it('checks again after drafting, not only before', async () => {
    const { service, assistantContextFor } = serviceWith({});
    await service.considerReplying(1, 100);
    // Twice: once to decide whether to answer, once to decide whether to send.
    expect(assistantContextFor).toHaveBeenCalledTimes(2);
  });
});

describe('automatic reply: while the photo is still being looked at', () => {
  /*
   * Media is described by a worker seconds AFTER the message lands. The reply
   * fired first, found a photo and no text, and apologised — for a message
   * that was about to be perfectly answerable.
   */
  it('holds the moment instead of answering with nothing', async () => {
    const { service, draftReply, replyAsAssistant } = serviceWith({
      context: { pendingMedia: 1 },
    });
    await service.considerReplying(1, 100);

    expect(draftReply).not.toHaveBeenCalled();
    expect(replyAsAssistant).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        body: 'Let me take a look at that…',
        // Its own key, so the hold is said once however many times this
        // message is considered — and the real answer's key stays free.
        idempotencyKey: 'assistant-hold:100',
      }),
    );
  });

  it('waits silently when the business left the line empty', async () => {
    const { service, replyAsAssistant, record } = serviceWith({
      context: { pendingMedia: 1 },
      mediaHoldMessage: '',
    });
    await service.considerReplying(1, 100);
    expect(replyAsAssistant).not.toHaveBeenCalled();
    expect(JSON.stringify(record.mock.calls)).toContain('waiting_for_media');
  });

  it('answers for real once the description lands', async () => {
    const { service, replyAsAssistant } = serviceWith({});
    await service.onMediaDescribed(1, 'asset:9');

    // The guards all ran again, and this time nothing was pending.
    expect(replyAsAssistant).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: 'assistant:100' }),
    );
  });

  it('does not answer twice when a second photo finishes', async () => {
    const { service, replyAsAssistant } = serviceWith({ context: { pendingMedia: 1 } });
    await service.onMediaDescribed(1, 'asset:9');
    // Still waiting on the other one: the hold key repeats, which the
    // idempotency index turns into nothing being sent.
    expect(replyAsAssistant).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: 'assistant-hold:100' }),
    );
  });
});

describe('automatic reply: when it cannot answer', () => {
  /*
   * Silence is the worst outcome here. With automatic replies on, every fast
   * answer has already told the customer that somebody is there — so a model
   * failure that says nothing does not read as "no reply", it reads as being
   * ignored by someone who was plainly around a moment ago.
   */
  it('tells the customer something rather than going quiet', async () => {
    const { service, replyAsAssistant } = serviceWith({ draftFails: true });
    await service.considerReplying(1, 100);

    expect(replyAsAssistant).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        body: 'Stepping away, back shortly.',
        // Its own key: an apology must not consume the reply's, or a later
        // real answer to the same message could never be sent.
        idempotencyKey: 'assistant-fallback:100',
      }),
    );
  });

  it('never tells the customer why', async () => {
    const { service, replyAsAssistant } = serviceWith({ draftFails: true });
    await service.considerReplying(1, 100);
    const sent = JSON.stringify(replyAsAssistant.mock.calls[0]);
    expect(sent).not.toContain('the model call failed');
  });

  it('puts the real reason in the trail instead', async () => {
    const { service, record } = serviceWith({ draftFails: true });
    await service.considerReplying(1, 100);
    const recorded = JSON.stringify(record.mock.calls);
    expect(recorded).toContain('the model call failed');
    expect(recorded).toContain('could_not_answer');
  });

  it('apologises for a missing key too, which the customer cannot tell apart', async () => {
    const { service, replyAsAssistant } = serviceWith({ providerEnabled: false });
    await service.considerReplying(1, 100);
    expect(replyAsAssistant).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: 'assistant-fallback:100' }),
    );
  });

  it('says nothing when the business chose to say nothing', async () => {
    const { service, replyAsAssistant, record } = serviceWith({
      draftFails: true,
      fallbackMessage: '',
    });
    await service.considerReplying(1, 100);
    expect(replyAsAssistant).not.toHaveBeenCalled();
    expect(JSON.stringify(record.mock.calls)).toContain('"fallbackSent":false');
  });

  it('does not apologise when a colleague has already answered', async () => {
    // Overtaken is not a failure: somebody got there first, and an apology
    // on top of their reply would be noise in front of the customer.
    const { service, replyAsAssistant } = serviceWith({ context: { messagesSince: 1 } });
    await service.considerReplying(1, 100);
    expect(replyAsAssistant).not.toHaveBeenCalled();
  });
});

describe('automatic reply: when it speaks', () => {
  it('sends the draft, keyed to the message it answers', async () => {
    const { service, replyAsAssistant } = serviceWith({});
    await service.considerReplying(1, 100);

    expect(replyAsAssistant).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        conversationRefId: 'conv-ref',
        body: 'we open at nine',
        // A redelivered webhook must return the first reply, not send a second.
        idempotencyKey: 'assistant:100',
        internalNote: false,
      }),
    );
  });

  it('stamps what wrote it, so no reply can pass as a colleague’s', async () => {
    const { service, replyAsAssistant } = serviceWith({});
    await service.considerReplying(1, 100);

    const sent = replyAsAssistant.mock.calls[0]?.[1] as { assistant: Record<string, unknown> };
    expect(sent.assistant).toMatchObject({
      provider: 'openai',
      model: 'gpt-6-luna',
      promptVersion: 1,
      inReplyToMessageId: 100,
    });
    // What it cost and what it saw, for the bill and for the post-mortem.
    expect(sent.assistant.usage).toBeDefined();
    expect(sent.assistant.context).toBeDefined();
  });

  it('records a provider with no key as a fault, not a preference', async () => {
    const { service, record, draftReply } = serviceWith({ providerEnabled: false });
    await service.considerReplying(1, 100);
    expect(draftReply).not.toHaveBeenCalled();
    expect(JSON.stringify(record.mock.calls[0])).toContain('provider_has_no_key');
  });
});

describe('automatic reply: what the model decided', () => {
  it('does not answer "thanks", because a person reading an inbox would not', async () => {
    const { service, replyAsAssistant, record } = serviceWith({
      draft: { silent: true, text: '', intent: 'acknowledging' },
    });
    await service.considerReplying(1, 100);

    expect(replyAsAssistant).not.toHaveBeenCalled();
    expect(JSON.stringify(record.mock.calls[0])).toContain('nothing_to_say');
  });

  it('apologises when the model produced no message, rather than going quiet', async () => {
    /*
     * Deliberate silence and a failed answer must not look the same: one of
     * them owes this customer an apology.
     */
    const { service, replyAsAssistant, record } = serviceWith({
      draft: { silent: false, text: '   ' },
    });
    await service.considerReplying(1, 100);

    const sent = replyAsAssistant.mock.calls[0]?.[1] as { body: string };
    expect(sent.body).toBe('Stepping away, back shortly.');
    expect(JSON.stringify(record.mock.calls[0])).toContain('could_not_answer');
  });

  it('carries a handoff onto the message, where a colleague can see it', async () => {
    const { service, replyAsAssistant } = serviceWith({
      draft: {
        text: 'Let me get a colleague onto this for you.',
        handoff: 'wants a refund',
        intent: 'refund request',
      },
    });
    await service.considerReplying(1, 100);

    const sent = replyAsAssistant.mock.calls[0]?.[1] as { assistant: Record<string, unknown> };
    expect(sent.assistant).toMatchObject({
      handoff: 'wants a refund',
      intent: 'refund request',
      language: 'English',
    });
  });

  it('marks a reply the model did not shape properly, so somebody notices', async () => {
    const { service, replyAsAssistant } = serviceWith({ draft: { structured: false } });
    await service.considerReplying(1, 100);

    const sent = replyAsAssistant.mock.calls[0]?.[1] as { assistant: Record<string, unknown> };
    expect(sent.assistant.unstructured).toBe(true);
  });
});
