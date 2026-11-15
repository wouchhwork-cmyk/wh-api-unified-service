import { describe, expect, it, vi } from 'vitest';
import { InboxService } from '@/modules/inbox/inbox.service';
import { ChatbotService } from '@/modules/inbox/chatbot.service';
import { RequestContext } from '@/shared/context';
import { ErrorCode } from '@/shared/errors';
import type { ChatService } from '@/modules/ai/chat.service';
import type { EnterpriseRepository } from '@/database/repositories/enterprise.repository';

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
    const enterprises = {
      findById: vi.fn().mockResolvedValue(null),
    } as unknown as EnterpriseRepository;
    return {
      chatbot: new ChatbotService(inbox as never, enterprises, chat),
      inbox,
    };
  }
  function empty() {
    return {
      messages: [{ id: 1, direction: 'inbound', body: 'hi', hasAttachments: false }],
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
    await chatbot.draftReplyForAutomation(2, 'conv-ref');
    expect(inbox.readThreadForAssistant).toHaveBeenCalledWith(2, 'conv-ref', expect.any(Number));
    expect(inbox.readThread).not.toHaveBeenCalled();
  });
});
