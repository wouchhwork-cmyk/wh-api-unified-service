import { Injectable } from '@nestjs/common';
import type { AnalysisResultRow } from '@/database/repositories/media-analysis.repository';
import type { AttachmentRow } from '@/database/repositories/message-attachment.repository';
import { MessageRepository, type MessageRow } from '@/database/repositories/message.repository';
import type { ConversationRow } from '@/database/repositories/conversation.repository';
import { ChatService, type ChatAnswer } from '@/modules/ai/chat.service';
import type { ChatTurn } from '@/modules/ai/ai.provider';
import {
  CHATBOT_CONTEXT_MESSAGES,
  CHATBOT_MESSAGE_CHARS,
  CHATBOT_SUMMARY_CHARS,
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
 * A hex run short enough to be a truncated id, and not a piece of a whole
 * one.
 *
 * The hyphen guards on both sides are the load-bearing part: the final
 * segment of a UUID is twelve hex characters with a word boundary either
 * side, so a pattern anchored only on boundaries offers a complete id its
 * own tail to "expand".
 */
const SHORT_ID = /(?<![0-9a-f-])([0-9a-f]{6,12})(?![0-9a-f-])/gi;

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
      (limit) => this.inbox.readThread(enterpriseId, conversationRefId, limit, null, null),
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
      (limit) => this.inbox.readThreadForAssistant(enterpriseId, conversationRefId, limit),
      /* The message it is answering, so a cost can be traced to its cause. */
      { purpose: ModelCallPurpose.AutoReply, messageId },
    );
  }

  /** Everything after the read, which is identical whoever asked. */
  private async draftFrom(
    enterpriseId: number,
    read: (limit: number) => Promise<ThreadRead>,
    accounting: { purpose: ModelCallPurpose; messageId: number | null },
  ): Promise<DraftedReply> {
    let thread = await read(CHATBOT_CONTEXT_MESSAGES);

    /*
     * ITS OWN QUERY, not something picked out of the thread above. The notes
     * exist so the window can be short, which means the reply that wrote
     * them is routinely outside it — ten messages in a row from one customer
     * pushes the last answer out entirely, and that is exactly when the
     * notes matter most.
     */
    const notes = await this.messages.latestAssistantSummary(enterpriseId, thread.conversation.id);

    /*
     * THE WINDOW MEETS THE NOTES, or there is a hole between them.
     *
     * Notes only advance when the assistant writes a reply. A business
     * answering from the Instagram app writes messages nothing here
     * summarises — harmless while they are still in the window, and a
     * permanent gap the moment they scroll out of it: the assistant would
     * answer knowing neither what was said nor that anything was.
     *
     * So the window is widened once, to cover everything the notes do not,
     * and the reply it produces writes notes over the whole of it. Paid
     * once, at the moment it matters, rather than a summarising call after
     * every message a colleague sends by hand.
     *
     * CAPPED, because a conversation answered manually for a month would
     * otherwise send a month of it. Past the cap the oldest are lost either
     * way; this at least keeps the bill finite and the newest in view.
     */
    const uncovered = notes?.uncovered ?? 0;
    if (uncovered > CHATBOT_CONTEXT_MESSAGES) {
      thread = await read(Math.min(uncovered + 1, CHAT_MAX_TURNS));
    }

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
     * THE NOTES ARE REPAIRED BEFORE THEY GO BACK IN.
     *
     * A note is rewritten from the note before it, so a shortened id copies
     * itself forward every reply — and a rule added to the prompt today
     * cannot reach text stored yesterday. Expanding them here fixes the
     * history as well as the next one, and does it by looking the id up
     * rather than by asking the model to behave.
     */
    const summary = await this.withFullIds(
      enterpriseId,
      thread.conversation.id,
      notes?.summary ?? null,
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
   * The same notes, with every shortened id written out in full.
   *
   * WHY THE IDS ARE SHORT AT ALL: the examples in an older prompt showed
   * them that way, and a model follows the shape it is shown over the rule
   * it is told. Those notes are stored text now, and every reply copies
   * them forward.
   *
   * A short id is a PREFIX of a real one, so this is a lookup. Anything
   * that does not resolve, or resolves to more than one message, is left
   * exactly as it was: a citation that points at the wrong message is worse
   * than one that points at nothing, because it looks checkable.
   */
  private async withFullIds(
    enterpriseId: number,
    conversationId: number,
    summary: string | null,
  ): Promise<string | null> {
    if (!summary) return null;

    /*
     * Hex runs that are too short to be an id AND are not a piece of one.
     *
     * A word boundary is not enough: `0d7e0f8c-0898-4441-9588-d37cf0a1e774`
     * ends in a twelve-character run with a boundary on both sides, so a
     * full id offered up its own tail as something to expand. The guard has
     * to exclude a neighbouring hyphen on either side, not just after.
     */
    const shortened = [...summary.matchAll(SHORT_ID)].map((match) => match[1]!.toLowerCase());
    const unique = [...new Set(shortened)];
    if (unique.length === 0) return summary;

    const full = await this.messages.expandMessageRefs(enterpriseId, conversationId, unique);
    if (full.size === 0) return summary;

    return summary.replace(SHORT_ID, (match) => full.get(match.toLowerCase()) ?? match);
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
      /*
       * WHOLE, NOT TRIMMED. The link died days ago, so these words are the
       * only record of what somebody sent — and they are in front of the
       * model precisely when it is being asked about them. A cut at four
       * hundred characters lost a wedding invitation's date and venue,
       * which were the two things anybody would have asked about.
       */
      if (detail.length > 0) parts.push(`[media: ${detail}]`);
    }

    /*
     * A REACTION IS A REPLY WITHOUT WORDS, and it was being thrown away.
     *
     * Somebody who answers a message with a heart has responded — often
     * instead of typing — and a thread that drops it reads as though they
     * went quiet. It also changes what to say next: thanking somebody who
     * already said thanks with an emoji is the assistant talking past them.
     */
    const reaction = this.reactionOn(message);
    if (reaction) parts.push(`[reaction: ${reaction}]`);

    /*
     * THE NOTES WE WROTE AT THE TIME, on the message they were written with.
     *
     * The latest set is carried in <context> for everything before the
     * window; these are what each reply understood as it was sent, which is
     * how the model sees its own understanding change rather than only where
     * it ended up.
     */
    const notes = this.notesOn(message);
    if (notes) parts.push(`[notes: ${notes.slice(0, CHATBOT_SUMMARY_CHARS)}]`);

    return parts.join('\n').trim();
  }

  /** What somebody reacted with, when they reacted rather than wrote. */
  private reactionOn(message: MessageRow): string | null {
    const reaction = (message.metadata as { reaction?: unknown } | undefined)?.reaction;
    if (!reaction || typeof reaction !== 'object') return null;

    const { emoji, name } = reaction as { emoji?: unknown; name?: unknown };
    const mark = typeof emoji === 'string' && emoji.length > 0 ? emoji : null;
    const word = typeof name === 'string' && name.length > 0 && name !== 'other' ? name : null;
    if (!mark && !word) return null;
    return [mark, word].filter((value) => value !== null).join(' ');
  }

  /** The summary this reply was sent with, when it carried one. */
  private notesOn(message: MessageRow): string | null {
    const assistant = (message.metadata as { assistant?: unknown } | undefined)?.assistant;
    if (!assistant || typeof assistant !== 'object') return null;

    const summary = (assistant as { summary?: unknown }).summary;
    return typeof summary === 'string' && summary.trim().length > 0 ? summary.trim() : null;
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
