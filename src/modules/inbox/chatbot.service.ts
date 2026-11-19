import { Injectable } from '@nestjs/common';
import type { AnalysisResultRow } from '@/database/repositories/media-analysis.repository';
import type { AttachmentRow } from '@/database/repositories/message-attachment.repository';
import { MessageRepository, type MessageRow } from '@/database/repositories/message.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import type { ConversationRow } from '@/database/repositories/conversation.repository';
import { ChatService, type ChatAnswer } from '@/modules/ai/chat.service';
import type { ChatTurn } from '@/modules/ai/ai.provider';
import {
  CHATBOT_CONTEXT_MESSAGES,
  CHAT_MAX_TOOL_CALLS,
  CHAT_MAX_TOOL_ROUNDS,
  CHAT_MAX_TURNS,
} from '@/shared/constants';
import { MediaAnalysisStatus, MessageDirection, ModelCallPurpose } from '@/shared/enums';
import { tagTurn } from '@/modules/ai/prompts';
import {
  renderHandoffSecondThought,
  renderToolResults,
  ToolName,
  renderToolsSection,
  readRequestedTool,
  ToolOutcome,
  ToolRunnerService,
  TOOL_SPECS,
  type ToolRun,
} from '@/modules/ai/tools';
import { ConversationBriefService } from './conversation-brief.service';
import { replyCapFor, shapeReply } from './reply-format';
import { renderTurnText } from './turn-text';
import { InboxService } from './inbox.service';

export interface DraftedReply extends ChatAnswer {
  /**
   * Notes read out of older replies during this turn, via get_one_message.
   *
   * The service merges these into the notes it stores. See `reconcileNotes`:
   * a recovery the model forgets to carry forward is a question answered
   * once and lost again.
   */
  readonly recoveredNotes?: readonly string[];
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
    private readonly tools: ToolRunnerService,
    /* For the one fact a colleague's button leaves behind. */
    private readonly customers: CustomerRepository,
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
    /* When each turn happened, so an event can be placed among them. */
    const turnTimes: Date[] = [];
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

      /* Kept beside the turn so an event can be placed among them by when
       * it happened rather than simply appended. */
      turnTimes.push(message.platformSentAt ?? message.createdAt);
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

    /*
     * WHAT A PERSON DID, WRITTEN INTO THE CONVERSATION WHERE THEY DID IT.
     *
     * A colleague marking a handoff handled is an event in this thread as
     * surely as a message is — but it left no trace the assistant could
     * read, so the only way to know was to infer it from a flag being
     * absent somewhere else in the frame. It inferred wrong, repeatedly,
     * and went on promising a colleague who had already been.
     *
     * FREE, AND THAT IS THE POINT. The alternative is the model asking a
     * tool what happened, which is a paid call on every conversation that
     * has ever been escalated — to learn a fact this service already holds
     * and can simply state. Nothing here costs a round trip.
     *
     * PLACED IN TIME rather than appended, because WHEN it happened is
     * most of what it means: a resolution before the customer's last three
     * messages says something very different from one after them.
     */
    const resolution = await this.handoffResolutionLine(enterpriseId, thread.conversation);
    if (resolution) {
      /* The first message sent after it; the end of the window if none. */
      const at = turnTimes.findIndex((time) => time.getTime() > resolution.at.getTime());
      const where = at === -1 ? turns.length : at;
      turns.splice(where, 0, { role: 'assistant', text: resolution.text });
      turnTimes.splice(where, 0, resolution.at);
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

    /*
     * THE TOOL LOOP.
     *
     * The model answers, and may instead ask for something to be looked up
     * or done. When it does, nothing is sent: the tool runs, the result goes
     * back in a section of its own, and it is asked again. It may ask twice
     * — look something up, record what it learned, then answer — and then it
     * has to speak.
     *
     * BOUNDED IN TWO DIRECTIONS, because one is not enough. Rounds stop the
     * back-and-forth; a total stops the bill, since a model allowed several
     * tools per round could spend far more than three calls inside three
     * rounds. Both ceilings are reached by answering with what it has, which
     * is always possible: a tool is an improvement on an answer, never a
     * prerequisite for one.
     */
    const toolsOffered = renderToolsSection(TOOL_SPECS);
    const runs: ToolRun[] = [];
    /*
     * WHAT WAS ASKED FOR, tracked beside what came back and kept in step
     * with it by index.
     *
     * Matching on the runner's returned `tool` instead would work today
     * and only because the runner happens to echo the request back — a
     * detail of its return shape that nothing promises and a refactor
     * would quietly break, taking the repeat guard with it. A test written
     * with a plainer stub caught exactly that.
     */
    const asked: string[] = [];
    let answer = await this.chat.reply(shown, {
      enterpriseId,
      purpose: accounting.purpose,
      messageId: accounting.messageId,
      context: brief.xml,
      tools: toolsOffered,
      round: 0,
    });

    /*
     * HANDING OVER WITHOUT HAVING LOOKED COSTS ONE MORE ROUND.
     *
     * WATCHED REPEATEDLY, and it is the cheapest wrong answer available to
     * it. Asked "when is the wedding?", with the date recoverable from the
     * notes an earlier reply carried, it set a handoff — "requires
     * colleague intervention" — and called nothing. Setting a flag and
     * writing one line is less work than a lookup, and the cost lands on a
     * colleague rather than on the model.
     *
     * The frame already told it to look: the tool said THE FIRST PLACE TO
     * LOOK, the notes block said these are only the latest notes, and the
     * rules said a handoff does not answer the question in front of you.
     * All three were in that prompt. Instructions have now lost this
     * argument often enough that the loop makes the point instead.
     *
     * ONCE, AND ONLY WHEN NOTHING WAS LOOKED AT. A handoff after a tool
     * has run is a considered one — it looked and could not finish — and
     * it goes straight through. This only catches the reflex.
     */
    if (
      runs.length === 0 &&
      readRequestedTool(answer.tool) === null &&
      (answer.handoff ?? '').trim().length > 0
    ) {
      answer = await this.chat.reply(shown, {
        enterpriseId,
        purpose: accounting.purpose,
        messageId: accounting.messageId,
        context: brief.xml,
        tools: toolsOffered,
        toolResults: renderHandoffSecondThought(),
        round: 0,
      });
    }

    for (let round = 1; round <= CHAT_MAX_TOOL_ROUNDS; round += 1) {
      const requested = readRequestedTool(answer.tool);
      if (!requested) break;

      /*
       * THE SAME CALL TWICE IS REFUSED, and this is not a theoretical
       * guard.
       *
       * Observed on the first live use: told "this business already records
       * them as X, so the name was NOT changed", the model asked for the
       * identical write again, read the identical answer, and asked a
       * third time — burning the whole budget and three paid calls to be
       * told the same thing three times. The tools section already says
       * not to; a model that has just been disappointed by a result reads
       * "try again" into it anyway.
       *
       * Refused DETERMINISTICALLY rather than asked, because a rule a
       * model can talk itself out of is not a bound. The note says what
       * actually happened — it already ran, here is what it said — so the
       * next turn has somewhere to go other than repeating itself.
       */
      const signature = `${requested.name}:${JSON.stringify(requested.args)}`;
      const seenAt = asked.indexOf(signature);
      const already = seenAt === -1 ? undefined : runs[seenAt];

      /*
       * REFUSED RATHER THAN RUN once the budget is gone, and the model is
       * told which — "you have used them up" is something it can answer
       * around, where silence looks like a tool that returned nothing.
       */
      const run = already
        ? {
            tool: requested,
            outcome: ToolOutcome.Refused,
            data: already.data,
            note: `you already ran ${requested.name} with exactly these arguments on this answer and it said: ${already.note ?? 'see the result above'}. It will not say anything different. Answer with what you have.`,
            durationMs: 0,
          }
        : runs.length >= CHAT_MAX_TOOL_CALLS
          ? {
              tool: requested,
              outcome: ToolOutcome.Refused,
              data: null,
              note: 'no more tool calls are available on this answer. Answer with what you have.',
              durationMs: 0,
            }
          : await this.tools.run(requested, {
              enterpriseId,
              conversationId: thread.conversation.id,
              customerId: thread.conversation.customerId,
              customerIdentifierId: thread.conversation.customerIdentifierId ?? null,
              messageId: accounting.messageId,
              modelCallId: answer.callId,
              round,
            });

      asked.push(signature);
      runs.push(run);

      answer = await this.chat.reply(shown, {
        enterpriseId,
        purpose: accounting.purpose,
        messageId: accounting.messageId,
        context: brief.xml,
        tools: toolsOffered,
        /*
         * WHETHER IT HANDED OVER ON THE TURN THAT ASKED. The model cannot
         * see that turn any more, and a handoff decided before the lookup
         * is exactly the decision these results should re-open.
         */
        toolResults: renderToolResults(runs, (answer.handoff ?? '').trim().length > 0),
        round,
      });
    }

    /*
     * IT NEVER GOT TO AN ANSWER. Out of rounds with a tool call still on
     * the table means the last reply is empty — it was asking, not
     * speaking — and sending an empty message is sending nothing while
     * recording that we answered. Handed to a colleague instead, which is
     * what the assistant does with everything else it cannot finish.
     */
    const stillAsking = readRequestedTool(answer.tool) !== null;

    return {
      ...answer,
      ...(stillAsking && !answer.handoff
        ? { handoff: 'it kept asking for tools and never answered' }
        : {}),
      /*
       * NOTES READ BACK OUT OF OLDER REPLIES THIS TURN.
       *
       * Handed on so the service can fold them into what gets stored. The
       * tool result already asks the model to carry a recovery forward and
       * it does not: watched live, it used recovered notes to answer and
       * then wrote notes keeping one of the sixty-two anchors it had just
       * been given. We know what came back, so nothing needs asking.
       */
      recoveredNotes: recoveredNotesFrom(runs),
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
   * The message as the model should read it.
   *
   * ONE LINE, because the body of this lived here and a second copy lived in
   * the replay — and the two drifted. See turn-text.ts.
   */
  /**
   * The line that says a person dealt with the escalation, and when.
   *
   * WRITTEN INTO THE CONVERSATION rather than fetched by a tool. The
   * service already knows this — a colleague pressed the button and the
   * resolution is stamped on the row — so making the model spend a paid
   * round discovering it would be charging for a fact we are holding.
   *
   * ONLY WHEN IT IS SETTLED. While a handoff is still open the frame says
   * so in <colleague_requested>, and a line claiming it was dealt with
   * would contradict it.
   */
  private async handoffResolutionLine(
    enterpriseId: number,
    conversation: { customerId: number | null; channelId: number },
  ): Promise<{ at: Date; text: string } | null> {
    if (conversation.customerId === null) return null;

    const state = await this.customers.assistantState(
      enterpriseId,
      conversation.customerId,
      conversation.channelId,
    );
    if (state.needsHuman || !state.resolvedAt) return null;

    return {
      at: state.resolvedAt,
      text:
        '[what happened here: a COLLEAGUE at this business picked this up and marked the ' +
        'handoff as handled. A real person dealt with it at this point in the conversation. ' +
        'Nobody is waiting for a colleague now — do not tell them one is coming, and do not ' +
        'treat the earlier escalation as still open.]',
    };
  }

  private textOf(message: MessageRow, described: readonly AnalysisResultRow[]): string {
    return renderTurnText(message, described);
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

/**
 * The notes an older reply carried, as this turn's lookups returned them.
 *
 * READ OFF THE TOOL RESULTS rather than re-queried: `get_one_message`
 * returns `notes_at_the_time` for our own replies, so the recovery has
 * already happened and this only collects it.
 */
function recoveredNotesFrom(runs: readonly ToolRun[]): string[] {
  const found: string[] = [];
  for (const run of runs) {
    if (run.tool.name !== ToolName.OneMessage) continue;
    const rows = Array.isArray(run.data) ? run.data : [];
    for (const row of rows) {
      const notes = (row as { notes_at_the_time?: unknown }).notes_at_the_time;
      if (typeof notes === 'string' && notes.trim().length > 0) found.push(notes.trim());
    }
  }
  return found;
}
