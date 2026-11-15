import { Injectable } from '@nestjs/common';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import type { AnalysisResultRow } from '@/database/repositories/media-analysis.repository';
import type { AttachmentRow } from '@/database/repositories/message-attachment.repository';
import type { MessageRow } from '@/database/repositories/message.repository';
import { ChatService, type ChatAnswer } from '@/modules/ai/chat.service';
import type { ChatTurn } from '@/modules/ai/ai.provider';
import {
  CHATBOT_CONTEXT_MESSAGES,
  CHATBOT_MEDIA_CHARS,
  CHATBOT_MESSAGE_CHARS,
  CHATBOT_PROFILE_ENTRIES,
  CHAT_MAX_TURNS,
} from '@/shared/constants';
import { MediaAnalysisStatus, MessageDirection } from '@/shared/enums';
import { InboxService } from './inbox.service';

export interface DraftedReply extends ChatAnswer {
  /**
   * What the model was actually given, in counts.
   *
   * Returned because a draft that reads oddly is nearly always a context
   * problem rather than a model one — "it answered as though it had not seen
   * the photo" is answerable from here without turning on logging that would
   * record a customer's message.
   */
  readonly context: {
    readonly messages: number;
    readonly mediaDescriptions: number;
    readonly hasBusinessProfile: boolean;
  };
}

/**
 * A reply, drafted from everything we already hold about a conversation.
 *
 * THE CONTEXT IS THE FEATURE. The model's own cleverness is the commodity
 * part; what makes a useful answer is that this service hands it the thread,
 * the descriptions of media whose links have since died, and what the
 * business says about itself — none of which the model could ever ask for.
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
    private readonly enterprises: EnterpriseRepository,
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
  ): Promise<DraftedReply> {
    return this.draftFrom(
      enterpriseId,
      await this.inbox.readThreadForAssistant(
        enterpriseId,
        conversationRefId,
        CHATBOT_CONTEXT_MESSAGES,
      ),
    );
  }

  /** Everything after the read, which is identical whoever asked. */
  private async draftFrom(
    enterpriseId: number,
    thread: {
      messages: MessageRow[];
      attachmentsByMessageId: ReadonlyMap<number, AttachmentRow[]>;
      analysisByKey: ReadonlyMap<string, AnalysisResultRow>;
    },
  ): Promise<DraftedReply> {
    /*
     * Newest first out of the repository, because that is what a reader
     * pages through. A model reads a conversation the way it happened.
     */
    const ordered = [...thread.messages].reverse();
    const turns: ChatTurn[] = [];
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

      const text = this.textOf(message, described);
      if (text.length === 0) continue;

      turns.push({
        role: message.direction === MessageDirection.Inbound ? 'user' : 'assistant',
        text,
      });
    }

    if (turns.length === 0) {
      /*
       * Nothing to answer. Reported through the ordinary chat failure shape
       * rather than invented around, because "there is no question here" and
       * "the model had nothing to say" are different facts.
       */
      return this.chat
        .reply(turns)
        .then((answer) => ({ ...answer, context: this.counts(0, 0, false) }));
    }

    const profile = await this.businessContext(enterpriseId);
    const answer = await this.chat.reply(turns.slice(-CHAT_MAX_TURNS), profile ?? undefined);

    return {
      ...answer,
      context: this.counts(turns.length, mediaDescriptions, profile !== null),
    };
  }

  private counts(
    messages: number,
    mediaDescriptions: number,
    hasBusinessProfile: boolean,
  ): DraftedReply['context'] {
    return { messages, mediaDescriptions, hasBusinessProfile };
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

  private describedAttachments(
    message: MessageRow,
    thread: { attachmentsByMessageId: ReadonlyMap<number, AttachmentRow[]> } & {
      analysisByKey: ReadonlyMap<string, AnalysisResultRow>;
    },
  ): AnalysisResultRow[] {
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

  /**
   * What the business says about itself, as the model should know it.
   *
   * FROM THE PROFILE STAFF ALREADY MAINTAIN, which is the point: the name
   * customers see, the description, the links and the contact details are
   * already kept current for the people who read them, so an assistant that
   * reads the same row cannot drift from what the business publishes.
   *
   * Null when there is nothing worth saying, so the prompt does not carry an
   * empty heading pretending to be context.
   */
  private async businessContext(enterpriseId: number): Promise<string | null> {
    const enterprise = await this.enterprises.findById(enterpriseId);
    if (!enterprise) return null;

    const lines: string[] = [];
    const name = enterprise.displayName?.trim() || enterprise.name.trim();
    if (name.length > 0) lines.push(`You are replying on behalf of ${name}.`);

    const about = enterprise.about?.trim() ?? '';
    if (about.length > 0) lines.push('', 'About the business:', about);

    const links = (enterprise.links ?? []).slice(0, CHATBOT_PROFILE_ENTRIES);
    if (links.length > 0) {
      lines.push('', 'Links you may share:');
      for (const link of links) lines.push(`- ${link.label}: ${link.url}`);
    }

    const contacts = (enterprise.contacts ?? []).slice(0, CHATBOT_PROFILE_ENTRIES);
    if (contacts.length > 0) {
      lines.push('', 'Contact details you may share:');
      for (const contact of contacts) {
        const detail = [contact.phone, contact.email]
          .map((value) => value?.trim() ?? '')
          .filter((value) => value.length > 0)
          .join(', ');
        if (detail.length > 0) lines.push(`- ${contact.label?.trim() || 'Contact'}: ${detail}`);
      }
    }

    if (lines.length === 0) return null;
    /*
     * The closing rule matters as much as the facts: a model given a profile
     * will otherwise fill the gaps in it, and an invented opening hour or
     * phone number is worse than an admission that we do not know.
     */
    lines.push(
      '',
      'Use only these details when answering about the business. If something is not here, say you will check rather than inventing it.',
    );
    return lines.join('\n');
  }
}
