import { describe, expect, it, vi } from 'vitest';
import { InboxService } from '@/modules/inbox/inbox.service';
import type { CustomerRepository } from '@/database/repositories/customer.repository';
import { ChatbotService } from '@/modules/inbox/chatbot.service';
import { RequestContext } from '@/shared/context';
import { ErrorCode } from '@/shared/errors';
import type { ChatService } from '@/modules/ai/chat.service';
import type { ConversationBriefService } from '@/modules/inbox/conversation-brief.service';
import type { MessageRepository } from '@/database/repositories/message.repository';

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
 * The regression that stopped the first automatic reply ever sent.
 *
 * `readThread` ends in a permission check against the CURRENT ACTOR, which a
 * worker does not have — so the assistant was told "conversation not found"
 * about a conversation that plainly existed, and the first real customer
 * message went unanswered with a 404 in the log.
 *
 * The fix is a second door rather than a flag, and both halves need holding:
 * the actorless read must work without an actor, and the ordinary read must
 * still refuse one who lacks the permission. A fix that quietly weakened the
 * second would pass any test written only about the first.
 */
const CONVERSATION = { id: 7, refId: 'conv-ref', conversationKind: 'direct_message' };

function inboxWith(messages: unknown[] = []) {
  const conversations = { findByRefId: vi.fn().mockResolvedValue(CONVERSATION) };
  const messageRepo = {
    listThread: vi.fn().mockResolvedValue(messages),
  };
  const attachments = { listForMessages: vi.fn().mockResolvedValue([]) };
  const mediaAnalysis = { resultsFor: vi.fn().mockResolvedValue([]) };

  const service = Object.create(InboxService.prototype) as InboxService;
  Object.assign(service, {
    conversations,
    messages: messageRepo,
    attachments,
    mediaAnalysis,
  });
  return { service, conversations, messageRepo };
}

describe('reading a thread for the assistant', () => {
  it('works with no actor at all, which is every worker', async () => {
    const { service, messageRepo } = inboxWith([
      { id: 1, direction: 'inbound', body: 'hello', hasAttachments: false },
    ]);

    // No RequestContext.run: this is exactly how the worker calls it.
    const thread = await service.readThreadForAssistant(2, 'conv-ref', 20);

    expect(thread.conversation).toEqual(CONVERSATION);
    expect(thread.messages).toHaveLength(1);
    // Still scoped to the tenant on every read — that boundary is not the
    // one the actorless path steps around.
    expect(messageRepo.listThread).toHaveBeenCalledWith(2, 7, expect.any(Number), null);
  });

  it('still refuses a conversation that is not there', async () => {
    const { service, conversations } = inboxWith();
    conversations.findByRefId.mockResolvedValue(null);
    await expect(service.readThreadForAssistant(2, 'missing', 20)).rejects.toMatchObject({
      code: ErrorCode.ConversationNotFound,
    });
  });

  it('leaves the human path’s permission check exactly where it was', async () => {
    const { service } = inboxWith();
    /*
     * An actor holding no permissions must still be refused — and refused as
     * NOT FOUND rather than forbidden, so a ref id cannot be used to probe
     * for conversations somebody may not see.
     */
    await RequestContext.run({ correlationId: 'test' }, async () => {
      await expect(service.readThread(2, 'conv-ref', 20, null, null)).rejects.toMatchObject({
        code: ErrorCode.ConversationNotFound,
      });
    });
  });
});

/**
 * The SECOND site of the same bug, found the same way: the first fix let the
 * assistant read the thread, and it then failed identically on the send.
 *
 * Asserted by what it fails with. A send that gets past the actor gate goes
 * on to the channel check and complains about THAT — so "it no longer
 * answers CONVERSATION_NOT_FOUND" is the precise claim, with no mock deep
 * enough to pretend a message was delivered.
 */
describe('sending without a colleague behind it', () => {
  const CONVERSATION_ROW = {
    id: 7,
    refId: 'conv-ref',
    conversationKind: 'direct_message',
    status: 'open',
    customerId: 3,
    channelId: 11,
    lastInboundAt: new Date(),
    contextMetadata: {},
    platform: 'instagram',
  };

  function sendableInbox() {
    const service = Object.create(InboxService.prototype) as InboxService;
    Object.assign(service, {
      conversations: { findByRefId: vi.fn().mockResolvedValue(CONVERSATION_ROW) },
      messages: { findByIdempotencyKey: vi.fn().mockResolvedValue(null) },
      /* Null send context: the next refusal after the gate we are testing. */
      channels: { findSendContext: vi.fn().mockResolvedValue(null) },
    });
    return service;
  }

  const INPUT = {
    conversationRefId: 'conv-ref',
    body: 'we open at nine',
    idempotencyKey: 'assistant:100',
    internalNote: false,
    assistant: { provider: 'openai', model: 'gpt-6-luna' },
  };

  it('gets past the gate that has no answer for a worker', async () => {
    const service = sendableInbox();
    await expect(service.replyAsAssistant(2, INPUT)).rejects.toMatchObject({
      // Not CONVERSATION_NOT_FOUND: the colleague check is behind it now.
      code: ErrorCode.ChannelNotFound,
    });
  });

  it('still refuses a person who may not answer this thread', async () => {
    const service = sendableInbox();
    await RequestContext.run({ correlationId: 'test' }, async () => {
      await expect(service.reply({ enterpriseId: 2, employeeId: 9 }, INPUT)).rejects.toMatchObject({
        code: ErrorCode.ConversationNotFound,
      });
    });
  });

  it('still refuses a send with no employee and no automation flag', async () => {
    const service = sendableInbox();
    await expect(service.reply({ enterpriseId: 2, employeeId: null }, INPUT)).rejects.toMatchObject(
      { code: ErrorCode.AuthNoActiveEmployment },
    );
  });
});

describe('which door the chatbot uses', () => {
  function chatbotWith() {
    const inbox = {
      readThread: vi.fn().mockResolvedValue(empty()),
      readThreadForAssistant: vi.fn().mockResolvedValue(empty()),
    };
    const chat = {
      reply: vi.fn().mockResolvedValue({
        text: 'drafted',
        usage: {},
        truncated: false,
        model: 'm',
        provider: 'openai',
        promptVersion: 1,
      }),
    } as unknown as ChatService;
    const brief = {
      build: vi.fn().mockResolvedValue({
        xml: '',
        counts: { hasBusinessProfile: false, hasPerson: false, hasPost: false, hasSummary: false },
      }),
    } as unknown as ConversationBriefService;
    const messages = {
      latestAssistantSummary: vi.fn().mockResolvedValue(null),
    } as unknown as MessageRepository;
    return {
      /* No tool is ever asked for in these cases, so a runner that would
       * throw if reached is the right stub: it proves the path is not
       * entered rather than quietly standing in for one. */
      chatbot: new ChatbotService(
        inbox as never,
        brief,
        messages,
        chat,
        noTools(),
        noAssistantState(),
      ),
      inbox,
    };
  }
  function empty() {
    return {
      conversation: { id: 42, customerId: 7, conversationKind: 'direct_message', messageCount: 1 },
      messages: [
        { id: 1, refId: 'ref-1', direction: 'inbound', body: 'hi', hasAttachments: false },
      ],
      attachmentsByMessageId: new Map(),
      analysisByKey: new Map(),
    };
  }

  it('asks as the person, when a person asked', async () => {
    const { chatbot, inbox } = chatbotWith();
    await chatbot.draftReply(2, 'conv-ref');
    expect(inbox.readThread).toHaveBeenCalled();
    expect(inbox.readThreadForAssistant).not.toHaveBeenCalled();
  });

  it('asks without one, when nobody did', async () => {
    const { chatbot, inbox } = chatbotWith();
    await chatbot.draftReplyForAutomation(2, 'conv-ref', 100);
    expect(inbox.readThreadForAssistant).toHaveBeenCalledWith(2, 'conv-ref', expect.any(Number));
    expect(inbox.readThread).not.toHaveBeenCalled();
  });
});

/**
 * A runner that must not be reached.
 *
 * These cases are about the window and the context, and none of their
 * fixtures asks for a tool — so a stub that throws proves the loop was not
 * entered, where a stub returning something would hide a reply that asked
 * for one by accident.
 */
function noTools() {
  return {
    run: () => {
      throw new Error('no tool should have been asked for here');
    },
  } as never;
}
