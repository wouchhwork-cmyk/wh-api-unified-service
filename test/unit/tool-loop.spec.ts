import { describe, expect, it, vi } from 'vitest';
import { ChatbotService } from '@/modules/inbox/chatbot.service';
import type { ChatService } from '@/modules/ai/chat.service';
import type { ConversationBriefService } from '@/modules/inbox/conversation-brief.service';
import type { InboxService } from '@/modules/inbox/inbox.service';
import type { CustomerRepository } from '@/database/repositories/customer.repository';
import type { MessageRepository } from '@/database/repositories/message.repository';
import type { ToolRunnerService } from '@/modules/ai/tools';
import { CHAT_MAX_TOOL_ROUNDS } from '@/shared/constants';

/** Nobody waiting, nothing resolved — the ordinary state. */
function noAssistantState(): CustomerRepository {
  return {
    assistantState: vi.fn().mockResolvedValue({
      needsHuman: false,
      needsHumanReason: null,
      needsHumanSince: null,
      resolvedAt: null,
      paused: false,
      resumesAt: null,
    }),
  } as unknown as CustomerRepository;
}

/**
 * The loop between asking for a tool and answering.
 *
 * WRITTEN FROM A LIVE FAILURE. On the first real use, a customer said
 * "it's aditya patil"; the model called `record_customer_details`, was told
 * "this business already records them as X, so the name was NOT changed",
 * and asked for the IDENTICAL write again. Then a third time. It burned
 * every round and three paid model calls to be told the same thing three
 * times, and the same shape repeated on the next message with a phone
 * number.
 *
 * The tools section already says not to. A model that has just been
 * disappointed by a result reads "try again" into it anyway, which is why
 * the bound has to be arithmetic rather than a request.
 */
const CONVERSATION = {
  id: 7,
  refId: 'conv-ref',
  customerId: 3,
  customerIdentifierId: 9,
  conversationKind: 'direct_message',
  messageCount: 1,
};

function serviceWith(answers: Record<string, unknown>[]) {
  const inbox = {
    readThread: vi.fn().mockResolvedValue({
      conversation: CONVERSATION,
      messages: [],
      attachmentsByMessageId: new Map(),
      analysisByKey: new Map(),
    }),
  } as unknown as InboxService;

  const brief = {
    build: vi.fn().mockResolvedValue({ xml: '<business/>', counts: {} }),
  } as unknown as ConversationBriefService;

  const messages = {
    latestAssistantSummary: vi.fn().mockResolvedValue(null),
    expandMessageRefs: vi.fn().mockResolvedValue(new Map()),
  } as unknown as MessageRepository;

  /* One answer per call, the last one repeating once they run out. */
  let turn = 0;
  const reply = vi.fn().mockImplementation(() => {
    const answer = answers[Math.min(turn, answers.length - 1)] ?? {};
    turn += 1;
    return Promise.resolve({
      text: '',
      usage: {},
      truncated: false,
      model: 'gemini',
      provider: 'gemini',
      promptVersion: 1,
      language: null,
      intent: null,
      handoff: null,
      silent: false,
      summary: null,
      structured: true,
      tool: null,
      callId: 1,
      callRef: 'call-ref',
      ...answer,
    });
  });

  const run = vi.fn().mockResolvedValue({
    tool: { name: 'record_customer_details', args: {}, because: 'why' },
    outcome: 'ok',
    data: null,
    note: 'the name was NOT changed',
    durationMs: 1,
  });

  const service = new ChatbotService(
    inbox,
    brief,
    messages,
    { reply } as unknown as ChatService,
    { run } as unknown as ToolRunnerService,
    noAssistantState(),
  );

  return { service, reply, run };
}

/** What the model sends when it wants a tool run. */
const asking = (args: Record<string, unknown>) => ({
  tool: { name: 'record_customer_details', arguments: args, because: 'they told me their name' },
  text: '',
});

describe('the tool loop', () => {
  it('runs a tool it asked for, then answers with the result', async () => {
    const { service, reply, run } = serviceWith([
      asking({ name: 'Aditya' }),
      { text: 'Thanks, noted.', tool: null },
    ]);

    const draft = await service.draftReply(1, 'conv-ref');

    expect(run).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(draft.text).toBe('Thanks, noted.');
  });

  it('refuses the identical call a second time instead of running it again', async () => {
    /*
     * THE LIVE FAILURE. Three identical writes, three identical answers,
     * three paid calls. Refused deterministically now: a rule a model can
     * talk itself out of is not a bound.
     */
    const { service, run } = serviceWith([asking({ name: 'Aditya' })]);

    await service.draftReply(1, 'conv-ref');

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('tells it what the earlier run said, so it has somewhere to go', async () => {
    // Silence here reads as a tool that returned nothing, which invites
    // exactly the retry the refusal is meant to stop.
    const { service, reply } = serviceWith([asking({ name: 'Aditya' })]);

    await service.draftReply(1, 'conv-ref');

    const lastCall = reply.mock.calls[reply.mock.calls.length - 1]?.[1] as { toolResults: string };
    expect(lastCall.toolResults).toContain('you already ran record_customer_details');
    expect(lastCall.toolResults).toContain('the name was NOT changed');
    expect(lastCall.toolResults).toContain('outcome="refused"');
  });

  it('still runs the same tool with DIFFERENT arguments', async () => {
    // Asking twice is only wrong when the question is identical. A second
    // lookup of a different message is a different question.
    const { service, run } = serviceWith([
      asking({ name: 'Aditya' }),
      asking({ phone: '8888' }),
      { text: 'done', tool: null },
    ]);

    await service.draftReply(1, 'conv-ref');

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('stops after the round cap however long it keeps asking', async () => {
    // Every round is a paid call, and the loop is the model's to drive.
    const { service, reply } = serviceWith([
      asking({ a: 1 }),
      asking({ b: 2 }),
      asking({ c: 3 }),
      asking({ d: 4 }),
      asking({ e: 5 }),
    ]);

    await service.draftReply(1, 'conv-ref');

    expect(reply.mock.calls.length).toBeLessThanOrEqual(CHAT_MAX_TOOL_ROUNDS + 1);
  });

  it('hands over rather than sending nothing when it never answered', async () => {
    /*
     * Out of rounds with a tool call still on the table means the last
     * reply is empty — it was asking, not speaking. Sending that is
     * sending nothing while recording that we answered.
     */
    const { service } = serviceWith([asking({ a: 1 }), asking({ b: 2 }), asking({ c: 3 })]);

    const draft = await service.draftReply(1, 'conv-ref');

    expect(draft.handoff).toContain('never answered');
  });

  it('throws away a reply written on the same turn as a tool request', async () => {
    /*
     * OBSERVED, AND NOT RARE. `gemini-3.1-flash-lite`, asked to check the
     * system, returned a tool call AND a filled-in reply in the same
     * object: "I have checked the system again and can see your number is
     * correctly recorded" — written before the lookup it was asking for
     * had run, describing a result it could not have had.
     *
     * The contract says to leave reply empty on a tool turn. A model that
     * ignores that is not a model to argue with, so the loop never reads
     * the text from a turn that asked for a tool: the answer always comes
     * from the call made AFTER the result is in.
     */
    const { service } = serviceWith([
      { ...asking({ name: 'Aditya' }), text: 'I have checked and it is all saved.' },
      { text: 'Checked — it is saved.', tool: null },
    ]);

    const draft = await service.draftReply(1, 'conv-ref');

    expect(draft.text).toBe('Checked — it is saved.');
  });

  /*
   * HANDING OVER WITHOUT LOOKING IS THE CHEAPEST WRONG ANSWER. Set a flag,
   * write one line, and the cost lands on a colleague. Watched repeatedly:
   * asked when a wedding was, with the date recoverable from notes an
   * earlier reply carried, it answered "a colleague will take over" and
   * called nothing — while the tool description, the notes block and the
   * rules all told it to look.
   */
  describe('a handoff with nothing looked at', () => {
    it('asks once more before letting it go', async () => {
      const { service, reply } = serviceWith([
        { text: 'A colleague will take over.', tool: null, handoff: 'needs a person' },
        { text: 'The wedding is on 30 November.', tool: null, handoff: null },
      ]);

      const draft = await service.draftReply(1, 'conv-ref');

      expect(reply).toHaveBeenCalledTimes(2);
      expect(draft.text).toBe('The wedding is on 30 November.');
    });

    it('tells it what it has not done, which it cannot see for itself', async () => {
      const { service, reply } = serviceWith([
        { text: 'A colleague will take over.', tool: null, handoff: 'needs a person' },
        { text: 'done', tool: null, handoff: null },
      ]);

      await service.draftReply(1, 'conv-ref');

      const second = reply.mock.calls[1]?.[1] as { toolResults?: string };
      expect(second.toolResults).toContain('YOU HAVE LOOKED AT NOTHING');
      expect(second.toolResults).toContain('get_earlier_messages');
    });

    it('lets a considered handoff stand', async () => {
      // Asked again and still handing over is an answer, not a reflex.
      const { service } = serviceWith([
        { text: 'A colleague will take over.', tool: null, handoff: 'wants a refund' },
        { text: 'A colleague will take over.', tool: null, handoff: 'wants a refund' },
      ]);

      const draft = await service.draftReply(1, 'conv-ref');

      expect(draft.handoff).toBe('wants a refund');
    });

    it('does not ask again when a tool had already run', async () => {
      /*
       * A handoff AFTER a lookup is considered — it looked and could not
       * finish — and must go straight through. Only the reflex is caught.
       */
      const { service, reply } = serviceWith([
        asking({ name: 'Aditya' }),
        { text: 'A colleague will take over.', tool: null, handoff: 'could not finish' },
      ]);

      await service.draftReply(1, 'conv-ref');

      expect(reply).toHaveBeenCalledTimes(2);
    });

    it('leaves an ordinary answer alone', async () => {
      const { service, reply } = serviceWith([{ text: 'Hello!', tool: null, handoff: null }]);

      await service.draftReply(1, 'conv-ref');

      expect(reply).toHaveBeenCalledTimes(1);
    });
  });

  it('does not touch a tool when the model simply answers', async () => {
    const { service, run, reply } = serviceWith([{ text: 'Hello!', tool: null }]);

    const draft = await service.draftReply(1, 'conv-ref');

    expect(run).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(draft.text).toBe('Hello!');
  });
});
