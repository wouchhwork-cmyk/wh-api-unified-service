import { Injectable } from '@nestjs/common';
import type { AnalysisResultRow } from '@/database/repositories/media-analysis.repository';
import type { AttachmentRow } from '@/database/repositories/message-attachment.repository';
import { MessageRepository, type MessageRow } from '@/database/repositories/message.repository';
import type { ConversationRow } from '@/database/repositories/conversation.repository';
import { ChatService, type ChatAnswer } from '@/modules/ai/chat.service';
import type { ChatTurn } from '@/modules/ai/ai.provider';
import {
  CHATBOT_CONTEXT_MESSAGES,
  CHATBOT_MEDIA_CHARS,
  CHATBOT_MESSAGE_CHARS,
  CHAT_MAX_TURNS,
} from '@/shared/constants';
import { MediaAnalysisStatus, MessageDirection, ModelCallPurpose } from '@/shared/enums';
import { tagTurn } from '@/modules/ai/prompts';
import { ConversationBriefService } from './conversation-brief.service';
import { replyCapFor, shapeReply } from './reply-format';
import { InboxService } from './inbox.service';

export interface DraftedReply extends ChatAnswer {
  /**
   * What the model was actually given, in counts.
   *
   * Returned because a draft that reads oddly is nearly always a context
   * problem rather than a model one — "it answered as though it had not seen
   * the photo", "it answered as though it did not know which post that was"
   * — and both are answerable from here without turning on logging that
   * would record a customer's message.
   */
  readonly context: {
    readonly messages: number;
    readonly mediaDescriptions: number;
    readonly hasBusinessProfile: boolean;
    readonly hasPerson: boolean;
    readonly hasPost: boolean;
    readonly hasSummary: boolean;
  };
}

type ThreadRead = {
  conversation: ConversationRow;
  messages: MessageRow[];
  attachmentsByMessageId: ReadonlyMap<number, AttachmentRow[]>;
  analysisByKey: ReadonlyMap<string, AnalysisResultRow>;
};

/**
 * A reply, drafted from everything we already hold about a conversation.
 *
 * THE CONTEXT IS THE FEATURE. The model's own cleverness is the commodity
 * part; what makes a useful answer is that this service hands it the thread,
 * the descriptions of media whose links have since died, who this person is,
 * where the conversation is happening and what the business says about
 * itself — none of which the model could ever ask for.
 *
 * IT DRAFTS, IT DOES NOT SEND. The reply comes back for a person to read,
 * change and send through the ordinary reply path, which is the one that
 * holds the idempotency key, the ledger row and the permission check. An
 * assistant that answered customers unattended is a different feature with a
 * different risk, and it should be switched on deliberately rather than
 * arrive as the side effect of a draft endpoint.
 */
@Injectable()
export class ChatbotService {
  constructor(
    private readonly inbox: InboxService,
    private readonly brief: ConversationBriefService,
    private readonly messages: MessageRepository,
    private readonly chat: ChatService,
  ) {}

  /**
   * For a person who asked for a draft.
   *
   * Reads the thread THE WAY THAT PERSON WOULD, permission check included:
   * somebody who may not open a conversation may not have a model summarise
   * it for them either.
   */
  async draftReply(enterpriseId: number, conversationRefId: string): Promise<DraftedReply> {
    return this.draftFrom(
      enterpriseId,
      await this.inbox.readThread(
        enterpriseId,
        conversationRefId,
        CHATBOT_CONTEXT_MESSAGES,
        null,
        null,
      ),
      /* A person pressed the button. The spend is theirs, not the
       * platform's, and the record has to be able to say so. */
      { purpose: ModelCallPurpose.Draft, messageId: null },
    );
  }

  /**
   * For the worker, where there is no person at all.
   *
   * A SEPARATE ENTRY RATHER THAN A FLAG. `readThread` ends in a permission
   * check against the current actor, and a background job has none — which is
   * why the first automatic reply failed with "conversation not found" for a
   * conversation that plainly existed. A boolean threaded through the normal
   * path would have fixed it and left a parameter that turns off a permission
   * check sitting on a method a controller calls. Two doors, each honest
   * about who may walk through it.
   *
   * The tenant boundary is untouched: `enterpriseId` scopes every query on
   * both paths. What this one skips is which COLLEAGUE may look, and there
   * is no colleague.
   */
  async draftReplyForAutomation(
    enterpriseId: number,
    conversationRefId: string,
    messageId: number,
  ): Promise<DraftedReply> {
    return this.draftFrom(
      enterpriseId,
      await this.inbox.readThreadForAssistant(
        enterpriseId,
        conversationRefId,
        CHATBOT_CONTEXT_MESSAGES,
      ),
      /* The message it is answering, so a cost can be traced to its cause. */
      { purpose: ModelCallPurpose.AutoReply, messageId },
    );
  }

  /** Everything after the read, which is identical whoever asked. */
  private async draftFrom(
    enterpriseId: number,
    thread: ThreadRead,
    accounting: { purpose: ModelCallPurpose; messageId: number | null },
  ): Promise<DraftedReply> {
    /*
     * Newest first out of the repository, because that is what a reader
     * pages through. A model reads a conversation the way it happened.
     */
    const ordered = [...thread.messages].reverse();
    const turns: ChatTurn[] = [];
    const mediaLanguages: string[] = [];
    let mediaDescriptions = 0;

    for (const message of ordered) {
      /*
       * INTERNAL NOTES ARE NOT PART OF THE CONVERSATION. They are colleagues
       * talking to each other about a customer, and a model given them will
       * quote them back to that customer.
       */
      if (message.isInternalNote) continue;

      const described = this.describedAttachments(message, thread);
      mediaDescriptions += described.length;

      /*
       * ONLY WHAT THEY SENT. The language of our own outbound media says
       * nothing about how to answer them, and a business posting an English
       * clip into a Hindi conversation would quietly flip the reply.
       */
      if (message.direction === MessageDirection.Inbound) {
        for (const analysis of described) {
          const language = analysis.language?.trim();
          if (language) mediaLanguages.unshift(language);
        }
      }

      const text = this.textOf(message, described);
      if (text.length === 0) continue;

      turns.push({
        role: message.direction === MessageDirection.Inbound ? 'user' : 'assistant',
        /*
         * EVERY TURN CARRIES ITS OWN ID, so the notes can point at a message
         * rather than describe it. "id abc123 — they complained about a
         * damaged parcel" survives the message scrolling out of the window
         * and can still be opened by a person.
         *
         * The PUBLIC ref id, not the row id. It costs more characters and it
         * is the one this service is allowed to show: the notes are stored
         * and surfaced, and an internal bigint has no business in either.
         */
        /*
         * HOW IT ARRIVED, AND WHAT IT ANSWERS. On a threaded platform "yes"
         * means agreement or it means an answer to a question four messages
         * back, and nothing in the words tells the two apart.
         */
        text: tagTurn(message.refId, text, {
          kind: message.messageKind,
          replyTo: message.parentRefId,
        }),
      });
    }

    const shown = turns.slice(-CHAT_MAX_TURNS);

    /*
     * ITS OWN QUERY, not something picked out of the thread above. The notes
     * exist so the window can be short, which means the reply that wrote
     * them is routinely outside it — ten messages in a row from one customer
     * pushes the last answer out entirely, and that is exactly when the
     * notes matter most.
     */
    const summary = await this.messages.latestAssistantSummary(
      enterpriseId,
      thread.conversation.id,
    );

    const brief = await this.brief.build({
      enterpriseId,
      conversation: thread.conversation,
      shownMessages: shown.length,
      mediaLanguages,
      hasMedia: mediaDescriptions > 0,
      summary,
    });

    const answer = await this.chat.reply(shown, {
      enterpriseId,
      purpose: accounting.purpose,
      messageId: accounting.messageId,
      context: brief.xml,
    });

    return {
      ...answer,
      /*
       * SHAPED AFTER THE MODEL, NEVER INSTEAD OF IT. The prompt asks for a
       * short plain message and this is what happens when it is not given
       * one — markdown removed, length brought down to what the channel
       * actually suits. A reply the model meant to send silently, or one it
       * left empty, stays empty: there is nothing to shape.
       */
      text:
        answer.text.length > 0
          ? shapeReply(answer.text, replyCapFor(thread.conversation.conversationKind))
          : '',
      context: {
        messages: shown.length,
        mediaDescriptions,
        ...brief.counts,
      },
    };
  }

  /**
   * The message as the model should read it: what was typed, plus what was
   * sent that nobody can open any more.
   *
   * A photo whose CDN link expired is the ordinary case on this platform, and
   * its description is the only record that survives — so it is folded into
   * the text rather than left out, which is what makes "what did they send
   * me?" answerable six months later.
   */
  private textOf(message: MessageRow, described: readonly AnalysisResultRow[]): string {
    const parts: string[] = [];
    const body = message.body?.trim() ?? '';
    if (body.length > 0) parts.push(body.slice(0, CHATBOT_MESSAGE_CHARS));

    for (const analysis of described) {
      const summary = analysis.summary?.trim() ?? '';
      const transcript = analysis.transcript?.trim() ?? '';
      const detail = [summary, transcript].filter((value) => value.length > 0).join(' — ');
      if (detail.length > 0) parts.push(`[media: ${detail.slice(0, CHATBOT_MEDIA_CHARS)}]`);
    }

    return parts.join('\n').trim();
  }

  private describedAttachments(message: MessageRow, thread: ThreadRead): AnalysisResultRow[] {
    const attachments = thread.attachmentsByMessageId.get(message.id) ?? [];
    const found: AnalysisResultRow[] = [];
    for (const attachment of attachments) {
      if (!attachment.mediaKey) continue;
      const analysis = thread.analysisByKey.get(attachment.mediaKey);
      /* Only a finished one. A pending row has nothing to say yet. */
      if (analysis?.status === MediaAnalysisStatus.Done) found.push(analysis);
    }
    return found;
  }
}
