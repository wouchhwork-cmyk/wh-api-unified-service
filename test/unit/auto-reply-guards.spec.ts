import { describe, expect, it, vi } from 'vitest';
import { AutoReplyService } from '@/modules/inbox/auto-reply.service';
import type { ChatService } from '@/modules/ai/chat.service';
import type { ChatbotService } from '@/modules/inbox/chatbot.service';
import type { InboxService } from '@/modules/inbox/inbox.service';
import type { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import type { MessageRepository } from '@/database/repositories/message.repository';
import type { AuditService } from '@/modules/audit/audit.service';
import type { PinoLogger } from 'nestjs-pino';
import { AUTO_REPLY_MAX_PER_WINDOW } from '@/shared/constants';
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
}) {
  const chat = {
    currentSettings: vi.fn().mockResolvedValue({
      provider: 'openai',
      model: 'gpt-6-luna',
      prompt: 'be brief',
      version: 1,
      autoReply: over.platformAutoReply ?? true,
    }),
    enabledFor: vi.fn().mockReturnValue(over.providerEnabled ?? true),
  } as unknown as ChatService;

  const enterprises = {
    findById: vi.fn().mockResolvedValue({ autoReplyEnabled: over.businessOptedIn ?? true }),
  } as unknown as EnterpriseRepository;

  const messages = {
    assistantContextFor: vi.fn().mockResolvedValue(
      over.context === null
        ? null
        : {
            conversationId: 7,
            conversationRefId: 'conv-ref',
            status: ConversationStatus.Open,
            messagesSince: 0,
            recentAssistantReplies: 0,
            ...over.context,
          },
    ),
  } as unknown as MessageRepository;

  const draftReply = vi.fn().mockResolvedValue({
    text: 'we open at nine',
    usage: { inputTokens: 10, outputTokens: 4 },
    truncated: false,
    model: 'gpt-6-luna',
    provider: 'openai',
    promptVersion: 1,
    context: { messages: 3, mediaDescriptions: 1, hasBusinessProfile: true },
  });
  const replyAsAssistant = vi
    .fn()
    .mockResolvedValue({ messageRefId: 'msg-ref', status: 'pending' });
  const record = vi.fn().mockResolvedValue(undefined);

  const service = new AutoReplyService(
    chat,
    { draftReply } as unknown as ChatbotService,
    { replyAsAssistant } as unknown as InboxService,
    enterprises,
    messages,
    { record } as unknown as AuditService,
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as PinoLogger,
  );
  return { service, draftReply, replyAsAssistant, record };
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

  it('stops at the loop guard, so two bots cannot talk until the bill arrives', async () => {
    const { service, replyAsAssistant, record } = serviceWith({
      context: { recentAssistantReplies: AUTO_REPLY_MAX_PER_WINDOW },
    });
    await service.considerReplying(1, 100);
    expect(replyAsAssistant).not.toHaveBeenCalled();
    expect(JSON.stringify(record.mock.calls[0])).toContain('loop_guard');
  });

  it('never throws into ingest, whatever goes wrong', async () => {
    const { service } = serviceWith({});
    const chat = Reflect.get(service, 'chat') as { currentSettings: () => Promise<unknown> };
    chat.currentSettings = () => Promise.reject(new Error('settings exploded'));
    // The customer's message is already stored; losing it to a failed draft
    // would be trading the thing that matters for the thing that does not.
    await expect(service.considerReplying(1, 100)).resolves.toBeUndefined();
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
