import { describe, expect, it, vi } from 'vitest';
import { AutoReplyService } from '@/modules/inbox/auto-reply.service';
import type { ChatService } from '@/modules/ai/chat.service';
import type { ChatbotService } from '@/modules/inbox/chatbot.service';
import type { InboxService } from '@/modules/inbox/inbox.service';
import type { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import type { CustomerRepository } from '@/database/repositories/customer.repository';
import type { MessageRepository } from '@/database/repositories/message.repository';
import type { AuditService } from '@/modules/audit/audit.service';
import type { MediaAnalysisService } from '@/modules/ai/media-analysis.service';
import type { AssistantReplyRepository } from '@/database/repositories/assistant-reply.repository';
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
  previousNotes?: { summary: string } | null;
  platformAutoReply?: boolean;
  businessOptedIn?: boolean;
  providerEnabled?: boolean;
  context?: Record<string, unknown> | null;
  fallbackMessage?: string;
  mediaHoldMessage?: string;
  draftFails?: boolean;
  draft?: Record<string, unknown>;
  attemptCount?: number;
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
          customerId: 3,
          automationPaused: false,
          needsHuman: false,
          ...over.context,
        },
  );
  /* The notes last stored, which the reply's new ones are reconciled against. */
  const latestAssistantSummary = vi.fn().mockResolvedValue(over.previousNotes ?? null);
  const messages = {
    messagesCarrying,
    assistantContextFor,
    latestAssistantSummary,
  } as unknown as MessageRepository;

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
        summary: 'They asked about opening hours; told them 9 to 9.',
        structured: true,
        ...over.draft,
      });
  const replyAsAssistant = vi
    .fn()
    .mockResolvedValue({ messageRefId: 'msg-ref', status: 'pending' });
  const record = vi.fn().mockResolvedValue(undefined);

  /*
   * The ledger row this attempt is settling. Every path through the service
   * must settle it exactly once — a row left leased is a reply nobody sends
   * until the reaper notices.
   */
  const ledger = {
    markSent: vi.fn().mockResolvedValue(true),
    markSkipped: vi.fn().mockResolvedValue(true),
    markFailed: vi.fn().mockResolvedValue(true),
    defer: vi.fn().mockResolvedValue(true),
    wake: vi.fn().mockResolvedValue(1),
  };

  const queueMissingFor = vi.fn().mockResolvedValue(0);
  /* The flag that makes a handoff something a person can finish. */
  const setNeedsHuman = vi.fn().mockResolvedValue(true);

  const service = new AutoReplyService(
    chat,
    { draftReplyForAutomation } as unknown as ChatbotService,
    { replyAsAssistant } as unknown as InboxService,
    enterprises,
    messages,
    { queueMissingFor } as unknown as MediaAnalysisService,
    ledger as unknown as AssistantReplyRepository,
    { record } as unknown as AuditService,
    { setNeedsHuman } as unknown as CustomerRepository,
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as PinoLogger,
  );
  return {
    service,
    setNeedsHuman,
    draftReply: draftReplyForAutomation,
    replyAsAssistant,
    record,
    assistantContextFor,
    queueMissingFor,
    ledger,
    /** One claimed obligation, as the worker hands it over. */
    claim: {
      id: 55,
      enterpriseId: 1,
      conversationId: 7,
      messageId: 100,
      attemptCount: over.attemptCount ?? 1,
      maxAttempts: 3,
    },
  };
}

describe('automatic reply: when it stays quiet', () => {
  it('says nothing while the platform switch is off', async () => {
    const { service, draftReply, replyAsAssistant, claim } = serviceWith({
      platformAutoReply: false,
    });
    await service.attempt(claim, 'worker-a');
    expect(draftReply).not.toHaveBeenCalled();
    expect(replyAsAssistant).not.toHaveBeenCalled();
  });

  it('says nothing until the business has opted in', async () => {
    const { service, draftReply, claim } = serviceWith({ businessOptedIn: false });
    await service.attempt(claim, 'worker-a');
    expect(draftReply).not.toHaveBeenCalled();
  });

  it('costs nothing when it is going to stay quiet', async () => {
    // The order of the checks is the point: the switches are read before any
    // paid call, not after one.
    const { service, draftReply, claim } = serviceWith({ platformAutoReply: false });
    await service.attempt(claim, 'worker-a');
    expect(draftReply).not.toHaveBeenCalled();
  });

  it('will not answer into a closed conversation', async () => {
    const { service, replyAsAssistant, record, claim } = serviceWith({
      context: { status: ConversationStatus.Closed },
    });
    await service.attempt(claim, 'worker-a');
    expect(replyAsAssistant).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ status: AuditStatus.Failure }));
  });

  it('stands down when somebody has already answered', async () => {
    const { service, replyAsAssistant, record, claim } = serviceWith({
      context: { messagesSince: 1 },
    });
    await service.attempt(claim, 'worker-a');
    expect(replyAsAssistant).not.toHaveBeenCalled();
    expect(JSON.stringify(record.mock.calls[0])).toContain('conversation_moved_on');
  });

  it('never throws into ingest, and still leaves a trail when it breaks', async () => {
    const { service, record, claim } = serviceWith({});
    const chat = Reflect.get(service, 'chat') as { currentSettings: () => Promise<unknown> };
    chat.currentSettings = () => Promise.reject(new Error('settings exploded'));
    // The customer's message is already stored; losing it to a failed draft
    // would be trading the thing that matters for the thing that does not.
    await expect(service.attempt(claim, 'worker-a')).resolves.toBeUndefined();
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
    const { service, replyAsAssistant, record, assistantContextFor, claim } = serviceWith({});
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

    await service.attempt(claim, 'worker-a');

    expect(replyAsAssistant).not.toHaveBeenCalled();
    expect(JSON.stringify(record.mock.calls)).toContain('draftDiscarded');
  });

  it('checks again after drafting, not only before', async () => {
    const { service, assistantContextFor, claim } = serviceWith({});
    await service.attempt(claim, 'worker-a');
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
    const { service, draftReply, replyAsAssistant, claim } = serviceWith({
      context: { pendingMedia: 1 },
    });
    await service.attempt(claim, 'worker-a');

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
    const { service, replyAsAssistant, record, claim } = serviceWith({
      context: { pendingMedia: 1 },
      mediaHoldMessage: '',
    });
    await service.attempt(claim, 'worker-a');
    expect(replyAsAssistant).not.toHaveBeenCalled();
    expect(JSON.stringify(record.mock.calls)).toContain('waiting_for_media');
  });

  it('puts the row back without spending an attempt', async () => {
    /*
     * A slow download is not a failed attempt. Charging it against
     * max_attempts would write off a perfectly answerable message because
     * somebody's photo took a while to fetch.
     */
    const { service, ledger, claim } = serviceWith({ context: { pendingMedia: 1 } });
    await service.attempt(claim, 'worker-a');

    expect(ledger.defer).toHaveBeenCalledWith(55, 'worker-a', expect.any(Number));
    expect(ledger.markFailed).not.toHaveBeenCalled();
    expect(ledger.markSkipped).not.toHaveBeenCalled();
  });

  it('brings the owed reply forward the moment the description lands', async () => {
    /*
     * A NUDGE RATHER THAN A SECOND ENTRY POINT. The row already carries its
     * own next attempt, so a description that never arrives still gets
     * looked at again; this is the difference between answering the photo
     * now and answering it at the next tick.
     */
    const { service, ledger } = serviceWith({});
    await service.onMediaDescribed(1, 'asset:9');

    expect(ledger.wake).toHaveBeenCalledWith(1, [100]);
  });

  it('does not let a failed wake escape into the analysis worker', async () => {
    const { service, ledger } = serviceWith({});
    ledger.wake.mockRejectedValueOnce(new Error('database gone'));

    // The description itself is already stored; losing the batch over a
    // nudge would trade the thing that matters for the thing that does not.
    await expect(service.onMediaDescribed(1, 'asset:9')).resolves.toBeUndefined();
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
    const { service, replyAsAssistant, claim } = serviceWith({ draftFails: true });
    await service.attempt(claim, 'worker-a');

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
    const { service, replyAsAssistant, claim } = serviceWith({ draftFails: true });
    await service.attempt(claim, 'worker-a');
    const sent = JSON.stringify(replyAsAssistant.mock.calls[0]);
    expect(sent).not.toContain('the model call failed');
  });

  it('puts the real reason in the trail instead', async () => {
    const { service, record, claim } = serviceWith({ draftFails: true });
    await service.attempt(claim, 'worker-a');
    const recorded = JSON.stringify(record.mock.calls);
    expect(recorded).toContain('the model call failed');
    expect(recorded).toContain('could_not_answer');
  });

  it('apologises for a missing key too, which the customer cannot tell apart', async () => {
    const { service, replyAsAssistant, claim } = serviceWith({ providerEnabled: false });
    await service.attempt(claim, 'worker-a');
    expect(replyAsAssistant).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: 'assistant-fallback:100' }),
    );
  });

  it('says nothing when the business chose to say nothing', async () => {
    const { service, replyAsAssistant, record, claim } = serviceWith({
      draftFails: true,
      fallbackMessage: '',
    });
    await service.attempt(claim, 'worker-a');
    expect(replyAsAssistant).not.toHaveBeenCalled();
    expect(JSON.stringify(record.mock.calls)).toContain('"fallbackSent":false');
  });

  it('does not apologise when a colleague has already answered', async () => {
    // Overtaken is not a failure: somebody got there first, and an apology
    // on top of their reply would be noise in front of the customer.
    const { service, replyAsAssistant, claim } = serviceWith({ context: { messagesSince: 1 } });
    await service.attempt(claim, 'worker-a');
    expect(replyAsAssistant).not.toHaveBeenCalled();
  });
});

describe('automatic reply: when it speaks', () => {
  it('sends the draft, keyed to the message it answers', async () => {
    const { service, replyAsAssistant, claim } = serviceWith({});
    await service.attempt(claim, 'worker-a');

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
    const { service, replyAsAssistant, claim } = serviceWith({});
    await service.attempt(claim, 'worker-a');

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
    const { service, record, draftReply, claim } = serviceWith({ providerEnabled: false });
    await service.attempt(claim, 'worker-a');
    expect(draftReply).not.toHaveBeenCalled();
    expect(JSON.stringify(record.mock.calls[0])).toContain('provider_has_no_key');
  });
});

describe('automatic reply: what the model decided', () => {
  it('does not answer "thanks", because a person reading an inbox would not', async () => {
    const { service, replyAsAssistant, record, claim } = serviceWith({
      draft: { silent: true, text: '', intent: 'acknowledging' },
    });
    await service.attempt(claim, 'worker-a');

    expect(replyAsAssistant).not.toHaveBeenCalled();
    expect(JSON.stringify(record.mock.calls[0])).toContain('nothing_to_say');
  });

  it('tries again before apologising for a model that produced nothing', async () => {
    /*
     * THE LEDGER BOUGHT THIS. An empty answer used to mean one apology and
     * nothing more, because there was nothing to come back to. A retry
     * thirty seconds later that actually answers is far better for the
     * customer than an apology that arrived instantly.
     */
    const { service, replyAsAssistant, ledger, claim } = serviceWith({
      draft: { silent: false, text: '   ' },
    });
    await service.attempt(claim, 'worker-a');

    expect(replyAsAssistant).not.toHaveBeenCalled();
    expect(ledger.markFailed).toHaveBeenCalledWith(
      55,
      'worker-a',
      expect.objectContaining({ permanent: false }),
    );
  });

  it('apologises on the last attempt, where there is nothing left to come back for', async () => {
    const { service, replyAsAssistant, record, ledger, claim } = serviceWith({
      draft: { silent: false, text: '   ' },
      attemptCount: 3,
    });
    await service.attempt(claim, 'worker-a');

    const sent = replyAsAssistant.mock.calls[0]?.[1] as { body: string };
    expect(sent.body).toBe('Stepping away, back shortly.');
    expect(JSON.stringify(record.mock.calls[0])).toContain('could_not_answer');
    expect(ledger.markFailed).toHaveBeenCalledWith(
      55,
      'worker-a',
      expect.objectContaining({ permanent: true }),
    );
  });

  it('settles the row as sent when a reply goes out', async () => {
    const { service, ledger, claim } = serviceWith({
      draft: { intent: 'asking opening hours', handoff: 'wants a refund' },
    });
    await service.attempt(claim, 'worker-a');

    expect(ledger.markSent).toHaveBeenCalledWith(
      55,
      'worker-a',
      expect.objectContaining({
        model: 'gpt-6-luna',
        intent: 'asking opening hours',
        handoffReason: 'wants a refund',
      }),
    );
  });

  it('carries a handoff onto the message, where a colleague can see it', async () => {
    const { service, replyAsAssistant, claim } = serviceWith({
      draft: {
        text: 'Let me get a colleague onto this for you.',
        handoff: 'wants a refund',
        intent: 'refund request',
      },
    });
    await service.attempt(claim, 'worker-a');

    const sent = replyAsAssistant.mock.calls[0]?.[1] as { assistant: Record<string, unknown> };
    expect(sent.assistant).toMatchObject({
      handoff: 'wants a refund',
      intent: 'refund request',
      language: 'English',
    });
  });

  it('marks a reply the model did not shape properly, so somebody notices', async () => {
    const { service, replyAsAssistant, claim } = serviceWith({ draft: { structured: false } });
    await service.attempt(claim, 'worker-a');

    const sent = replyAsAssistant.mock.calls[0]?.[1] as { assistant: Record<string, unknown> };
    expect(sent.assistant.unstructured).toBe(true);
  });
});

describe('automatic reply: what it writes down for next time', () => {
  it('pins the notes to the message they were written with', async () => {
    /*
     * This is what makes every message carry the context up to itself: the
     * next reply reads the most recent set of notes rather than however
     * much of the thread happens to fit in the window.
     */
    const { service, replyAsAssistant, claim } = serviceWith({});
    await service.attempt(claim, 'worker-a');

    const sent = replyAsAssistant.mock.calls[0]?.[1] as { assistant: Record<string, unknown> };
    expect(sent.assistant.summary).toBe('They asked about opening hours; told them 9 to 9.');
  });

  it('stores the notes whole, however long they have grown', async () => {
    /*
     * THE ONE TRIM THAT CANNOT BE UNDONE, and it used to happen here.
     *
     * This cut the notes to 600 characters BEFORE writing them, and every
     * later note is written from this one — so a sentence lost at write time
     * is lost from every note that follows it, for ever. The notes are
     * cumulative now and will grow; what they cost is a question for the
     * model_calls ledger, not for a slice through the middle of a sentence.
     */
    const { service, replyAsAssistant, claim } = serviceWith({
      draft: { summary: 'x'.repeat(5_000) },
    });
    await service.attempt(claim, 'worker-a');

    const sent = replyAsAssistant.mock.calls[0]?.[1] as { assistant: { summary: string } };
    expect(sent.assistant.summary.length).toBe(5_000);
  });

  it('writes nothing down when the model offered nothing', async () => {
    const { service, replyAsAssistant, claim } = serviceWith({ draft: { summary: null } });
    await service.attempt(claim, 'worker-a');

    const sent = replyAsAssistant.mock.calls[0]?.[1] as { assistant: Record<string, unknown> };
    expect(sent.assistant).not.toHaveProperty('summary');
  });
});

/**
 * A photo nobody queued used to be answered straight past.
 *
 * The hold counts media that is queued and unfinished; media with no ledger
 * row at all was invisible to it. So anything stored before descriptions
 * existed — or by any path that forgot to queue — looked like a message
 * carrying no media, and the assistant replied as though it had seen
 * nothing.
 */
describe('automatic reply: media nobody ever queued', () => {
  it('queues what is missing before deciding whether to wait', async () => {
    const { service, queueMissingFor, claim } = serviceWith({});
    await service.attempt(claim, 'worker-a');

    expect(queueMissingFor).toHaveBeenCalledWith(1, 100);
  });

  it('queues it before reading the context, not after', async () => {
    /* The order is the whole point: reading first would see no pending
     * media and answer past the photo. */
    const calls: string[] = [];
    const { service, queueMissingFor, assistantContextFor, claim } = serviceWith({});
    queueMissingFor.mockImplementation(() => {
      calls.push('queue');
      return Promise.resolve(1);
    });
    assistantContextFor.mockImplementation(() => {
      calls.push('context');
      return Promise.resolve({
        conversationId: 7,
        conversationRefId: 'conv-ref',
        status: ConversationStatus.Open,
        messagesSince: 0,
        pendingMedia: 0,
      });
    });

    await service.attempt(claim, 'worker-a');
    expect(calls[0]).toBe('queue');
    expect(calls[1]).toBe('context');
  });

  it('answers anyway when the queue attempt fails', async () => {
    /* A description is worth having and never worth losing the reply over. */
    const { service, replyAsAssistant, queueMissingFor, claim } = serviceWith({});
    queueMissingFor.mockResolvedValueOnce(0);

    await service.attempt(claim, 'worker-a');
    expect(replyAsAssistant).toHaveBeenCalled();
  });
});

/**
 * A colleague taking one customer over.
 *
 * WHY THIS GUARD EXISTS. Before it, a colleague answering somebody by hand
 * had two options: let the assistant talk over them mid-conversation, or
 * switch it off for the entire business to deal with one person.
 */
describe('while the assistant is paused for a customer', () => {
  it('sends nothing', async () => {
    const { service, replyAsAssistant, claim } = serviceWith({
      context: { automationPaused: true },
    });

    await service.attempt(claim, 'worker-a');

    expect(replyAsAssistant).not.toHaveBeenCalled();
  });

  it('does not pay for a draft it would throw away', async () => {
    // The point of a pause is that nothing is sent. A draft that is billed
    // and discarded is an invoice for silence.
    const { service, draftReply, claim } = serviceWith({ context: { automationPaused: true } });

    await service.attempt(claim, 'worker-a');

    expect(draftReply).not.toHaveBeenCalled();
  });

  it('records it as a deliberate pause, not as a failure', async () => {
    /*
     * ITS OWN REASON. "We said nothing because a person is handling it" and
     * "we could not answer" are different facts, and somebody reading the
     * audit a week later has to tell them apart — one is the feature
     * working and the other may be a bug.
     */
    const { service, record, ledger, claim } = serviceWith({ context: { automationPaused: true } });

    await service.attempt(claim, 'worker-a');

    expect(ledger.markSkipped).toHaveBeenCalledWith(
      55,
      'worker-a',
      'automation_paused_for_customer',
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: AuditStatus.Success,
        metadata: expect.objectContaining({ skipped: 'automation_paused_for_customer' }),
      }),
    );
  });

  it('is checked before the conversation looks overtaken', async () => {
    /*
     * A colleague typing replies by hand is exactly what makes a
     * conversation move on, so the two guards would race — and the audit
     * would record whichever won rather than the reason that mattered.
     */
    const { service, ledger, claim } = serviceWith({
      context: { automationPaused: true, messagesSince: 4 },
    });

    await service.attempt(claim, 'worker-a');

    expect(ledger.markSkipped).toHaveBeenCalledWith(
      55,
      'worker-a',
      'automation_paused_for_customer',
    );
  });

  it('answers normally once it is lifted', async () => {
    const { service, replyAsAssistant, claim } = serviceWith({
      context: { automationPaused: false },
    });

    await service.attempt(claim, 'worker-a');

    expect(replyAsAssistant).toHaveBeenCalled();
  });
});

/**
 * Making a handoff something a person can finish.
 *
 * It used to be a log line and nothing else, so the assistant could ask for
 * a colleague and never learn whether one came — and went on promising the
 * same colleague on every later message.
 */
describe('when it hands over', () => {
  it('records that this customer is waiting for a person', async () => {
    const { service, setNeedsHuman, claim } = serviceWith({
      draft: { handoff: 'needs a refund decision' },
    });

    await service.attempt(claim, 'worker-a');

    expect(setNeedsHuman).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 3,
        needsHuman: true,
        reason: 'needs a refund decision',
      }),
    );
  });

  it('raises it when the reply promised a person but the field did not', async () => {
    /*
     * WATCHED LIVE. "Hello! A colleague will be with you shortly to help
     * sort this out." went out with handoff null — the customer told
     * somebody was coming, the system recording that nobody was needed, no
     * flag anywhere, and nobody ever going to arrive.
     *
     * Those words have been sent and the business now owes that person a
     * colleague whatever the model meant, so the flag is raised and
     * somebody can glance at it and clear it.
     */
    const { service, setNeedsHuman, claim } = serviceWith({
      draft: { handoff: null, text: 'Hello! A colleague will be with you shortly.' },
    });

    await service.attempt(claim, 'worker-a');

    expect(setNeedsHuman).toHaveBeenCalledWith(
      expect.objectContaining({
        needsHuman: true,
        reason: expect.stringContaining('without flagging it'),
      }),
    );
  });

  it('keeps the model’s own reason when it did flag one', async () => {
    // The detector is a backstop, never a replacement: what the assistant
    // said it could not do is better than anything inferred from the text.
    const { service, setNeedsHuman, claim } = serviceWith({
      draft: { handoff: 'wants a refund', text: 'A colleague will be with you shortly.' },
    });

    await service.attempt(claim, 'worker-a');

    expect(setNeedsHuman).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'wants a refund' }),
    );
  });

  it('does not raise it when it answered by itself', async () => {
    const { service, setNeedsHuman, claim } = serviceWith({});

    await service.attempt(claim, 'worker-a');

    expect(setNeedsHuman).not.toHaveBeenCalled();
  });

  it('still counts the reply as sent when the flag cannot be written', async () => {
    /*
     * The customer has already been answered. Losing the flag is bad; making
     * a delivered reply look like a failed one is worse, and would have the
     * worker try to send it a second time.
     */
    const { service, setNeedsHuman, ledger, claim } = serviceWith({
      draft: { handoff: 'needs a person' },
    });
    setNeedsHuman.mockRejectedValueOnce(new Error('database went away'));

    await service.attempt(claim, 'worker-a');

    expect(ledger.markSent).toHaveBeenCalled();
  });
});
