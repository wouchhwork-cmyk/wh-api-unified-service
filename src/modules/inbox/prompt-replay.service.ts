import { Injectable } from '@nestjs/common';
import {
  ModelCallRepository,
  type ModelCallRow,
} from '@/database/repositories/model-call.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { ConversationRepository } from '@/database/repositories/conversation.repository';
import { MediaAnalysisRepository } from '@/database/repositories/media-analysis.repository';
import { MessageAttachmentRepository } from '@/database/repositories/message-attachment.repository';
import { WireCaptureService, type CapturedCall } from '@/modules/ai/wire-capture.service';
import { ChatService } from '@/modules/ai/chat.service';
import { MediaAnalysisService } from '@/modules/ai/media-analysis.service';
import {
  buildChatReplyPrompt,
  buildMediaAnalysisPrompt,
  canonicalPrompt,
  fingerprint,
  tagTurn,
} from '@/modules/ai/prompts';
import type { ChatTurn } from '@/modules/ai/ai.provider';
import { renderTurnText } from './turn-text';
import { renderToolsSection, TOOL_SPECS } from '@/modules/ai/tools';
import { MediaAnalysisStatus, MessageDirection, ModelCallPurpose } from '@/shared/enums';
import { ConversationBriefService } from './conversation-brief.service';

/** One recorded call, as a list of them reads. */
export interface ModelCallSummary {
  readonly refId: string;
  readonly provider: string;
  readonly model: string;
  readonly purpose: string;
  readonly status: string;
  readonly totalTokens: number | null;
  readonly durationMs: number | null;
  readonly failureCode: string | null;
  /** Whether a prompt can be rebuilt for it at all. */
  readonly replayable: boolean;
  readonly messages: number;
  readonly mediaKey: string | null;
  readonly createdAt: Date;
}

export interface ReplayedPrompt {
  /** The prompt as it would be built right now, for reading. Never stored. */
  readonly prompt: string;
  /**
   * Whether what was rebuilt is what actually ran.
   *
   * THE ONE FIELD THAT MATTERS. Everything else here is a reconstruction,
   * and a reconstruction nobody can check is a story. Equal fingerprints
   * mean this is exact; different ones mean something underneath moved.
   */
  readonly matchesOriginal: boolean;
  /** Why it may differ, in terms somebody can act on. */
  readonly drift: readonly string[];
  readonly call: {
    readonly refId: string;
    readonly provider: string;
    readonly model: string;
    readonly purpose: string;
    readonly status: string;
    readonly promptVersion: number | null;
    readonly createdAt: Date;
  };
}

/**
 * Rebuilds the prompt a model was sent, without anybody having kept one.
 *
 * WHY NOT JUST STORE IT. A chat prompt holds the customer's own words, their
 * name, the transcript of their voice note and the business's contact
 * details. Keeping it makes a second copy of every conversation, growing for
 * ever, in a table whose purpose is bookkeeping. The prompt is almost
 * entirely deterministic — code, a version number, rows, and a list of
 * message ids — so it can be built again on demand and thrown away after
 * being read.
 *
 * WHAT THIS CANNOT DO, said plainly rather than discovered later. It
 * rebuilds the prompt as it would be built NOW. The console prompt keeps no
 * history, the business profile is not versioned, and a photo may have been
 * described again since. When any of those moved, the reconstruction is a
 * lead rather than evidence — and `matchesOriginal` is what tells the two
 * apart instead of leaving somebody to guess.
 */
@Injectable()
export class PromptReplayService {
  constructor(
    private readonly calls: ModelCallRepository,
    private readonly messages: MessageRepository,
    private readonly conversations: ConversationRepository,
    private readonly attachments: MessageAttachmentRepository,
    private readonly analyses: MediaAnalysisRepository,
    private readonly brief: ConversationBriefService,
    private readonly chat: ChatService,
    private readonly media: MediaAnalysisService,
    private readonly wire: WireCaptureService,
  ) {}

  /** Whether this environment keeps the bodies at all. */
  get wireCaptured(): boolean {
    return this.wire.enabled;
  }

  /**
   * Every exchange that produced one reply, in order.
   *
   * ONE REPLY IS NO LONGER ONE CALL. With tools in the loop it can be four:
   * ask, run a tool, ask again with the result, answer. Each is its own
   * model call with its own ref, and the message row keeps only the LAST
   * one — so following the chain from there leads backwards into nothing.
   *
   * ASKED BY CALL, ANSWERED BY MESSAGE. A caller has the ref of the call
   * that wrote the reply, because that is what the message row carries.
   * What they want is every call that was made ABOUT THE SAME INBOUND
   * MESSAGE, which is the thing all four rounds have in common. The lookup
   * is tenant-scoped at the call, and again inside the capture.
   */
  async wireForCall(enterpriseId: number, callRefId: string): Promise<CapturedCall[]> {
    if (!this.wire.enabled) return [];

    const call = await this.calls.findByRef(enterpriseId, callRefId);
    if (!call) return [];

    /* A call about no message in particular — a media description — is its
     * own whole exchange and there is nothing to group it with. */
    if (call.messageId === null) {
      const one = await this.wire.read(enterpriseId, callRefId);
      return one ? [one] : [];
    }
    return this.wire.readForMessage(enterpriseId, call.messageId);
  }

  /**
   * The recent calls, as a reader of the trail needs them.
   *
   * Shaped here rather than in the controller: which columns are fit to
   * leave this service is a decision about the domain, and a controller that
   * picks them is a controller holding a repository.
   */
  async recentCalls(enterpriseId: number, limit: number): Promise<ModelCallSummary[]> {
    const rows = await this.calls.listRecent(enterpriseId, limit);
    return rows.map((row) => ({
      refId: row.refId,
      provider: row.provider,
      model: row.model,
      purpose: row.purpose,
      status: row.status,
      totalTokens: row.totalTokens,
      durationMs: row.durationMs,
      failureCode: row.failureCode,
      replayable: row.promptHash !== null,
      messages: row.turnRefs?.length ?? 0,
      mediaKey: row.mediaKey,
      createdAt: row.createdAt,
    }));
  }

  async replay(enterpriseId: number, callRefId: string): Promise<ReplayedPrompt | null> {
    const call = await this.calls.findByRef(enterpriseId, callRefId);
    if (!call) return null;

    const prompt =
      call.purpose === ModelCallPurpose.MediaDescription
        ? await this.mediaPrompt()
        : await this.chatPrompt(enterpriseId, call);

    const drift = this.drift(call, prompt);
    return {
      prompt: prompt.text,
      matchesOriginal:
        call.promptHash !== null && fingerprint(prompt.canonical) === call.promptHash,
      drift,
      call: {
        refId: call.refId,
        provider: call.provider,
        model: call.model,
        purpose: call.purpose,
        status: call.status,
        promptVersion: call.promptVersion,
        createdAt: call.createdAt,
      },
    };
  }

  /**
   * A description prompt, which has no conversation in it at all.
   *
   * The only moving part is the console's instruction, so a mismatch here
   * means exactly one thing and the drift note can say so.
   */
  private async mediaPrompt(): Promise<{ text: string; canonical: string }> {
    const instruction = await this.media.currentSettings();
    const text = buildMediaAnalysisPrompt(instruction.prompt);
    return { text, canonical: text };
  }

  /**
   * A reply prompt, rebuilt from the messages it was actually shown.
   *
   * FROM THE RECORDED IDS, not from the thread as it stands. Rebuilding from
   * "the last ten messages" would show a different window every time the
   * customer writes again — which is the one thing that makes a replay
   * worthless.
   */
  private async chatPrompt(
    enterpriseId: number,
    call: ModelCallRow,
  ): Promise<{ text: string; canonical: string }> {
    const settings = await this.chat.currentSettings();
    const refs = call.turnRefs ?? [];
    const rows = await this.messages.findByRefIds(enterpriseId, refs);

    /* Back into the order they were sent in, which the ids carry and the
     * query does not promise. */
    const byRef = new Map(rows.map((row) => [row.refId, row]));
    const ordered = refs.map((ref) => byRef.get(ref)).filter((row) => row !== undefined);

    const withMedia = ordered.filter((row) => row.hasAttachments).map((row) => row.id);
    const attachmentRows = await this.attachments.listForMessages(enterpriseId, withMedia);
    const analysisRows = await this.analyses.findByKeys(enterpriseId, [
      ...new Set(attachmentRows.map((row) => row.mediaKey).filter((key): key is string => !!key)),
    ]);
    const byMessage = new Map<number, typeof attachmentRows>();
    for (const row of attachmentRows) {
      const existing = byMessage.get(row.messageId);
      if (existing) existing.push(row);
      else byMessage.set(row.messageId, [row]);
    }
    const byKey = new Map(analysisRows.map((row) => [row.mediaKey, row]));

    const turns: ChatTurn[] = [];
    const mediaLanguages: string[] = [];
    let mediaDescriptions = 0;

    for (const message of ordered) {
      const described = (byMessage.get(message.id) ?? [])
        .map((attachment) => (attachment.mediaKey ? byKey.get(attachment.mediaKey) : undefined))
        .filter((row) => row?.status === MediaAnalysisStatus.Done);
      mediaDescriptions += described.length;

      if (message.direction === MessageDirection.Inbound) {
        for (const row of described) {
          const language = row?.language?.trim();
          if (language) mediaLanguages.unshift(language);
        }
      }

      /*
       * THE SAME RENDERER THE LIVE PATH USES. This was a second copy, and it
       * had already lost the reaction, the notes and — through a query that
       * never selected them — the parent a message answers. See turn-text.ts.
       */
      const text = renderTurnText(
        message,
        described.filter((row): row is NonNullable<typeof row> => row !== undefined),
      );
      if (text.length === 0) continue;

      turns.push({
        role: message.direction === MessageDirection.Inbound ? 'user' : 'assistant',
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
     * THE THREAD COMES FROM THE MESSAGES, not from a column on the call.
     * A draft nobody sent answers no message, so there is no inbound id to
     * follow — but every call was shown messages, and a message knows its
     * own conversation.
     */
    const conversationId = ordered[0]?.conversationId;
    const conversation =
      conversationId === undefined
        ? null
        : await this.conversations.findById(enterpriseId, conversationId);

    const context = conversation
      ? (
          await this.brief.build({
            enterpriseId,
            conversation,
            shownMessages: turns.length,
            mediaLanguages,
            hasMedia: mediaDescriptions > 0,
            summary: await this.summaryBefore(enterpriseId, conversation.id, refs),
          })
        ).xml
      : '';

    /*
     * THE TOOLS GO BACK IN, or every replay of a reply made since they
     * existed reports as drifted.
     *
     * The fingerprint is taken over the whole instruction, and the live
     * path now puts a <tools> section in it. Rebuilding without one
     * produces a different prompt by definition — so the drift warning
     * would fire on every single reply, which is the same as it firing on
     * none: a signal that is always on teaches a reader to ignore it.
     *
     * The section is rendered from the specs as they stand TODAY, which is
     * a real limit and the honest one to have: a tool added or reworded
     * since the call will show as drift, because the prompt genuinely did
     * change. That is what the drift note is for.
     */
    const instructions = buildChatReplyPrompt({
      businessPrompt: settings.prompt,
      context,
      tools: renderToolsSection(TOOL_SPECS),
    });
    /* One rendering, used for both reading and checking: a second one could
     * differ from the first and the hash would be of neither. */
    const rendered = canonicalPrompt({ instructions, turns });
    return { text: rendered, canonical: rendered };
  }

  /**
   * The notes as they stood when this call was made, not as they stand now.
   *
   * The conversation has very likely been answered since, and each answer
   * rewrites them — so reading the latest would show a replay of message
   * four the notes written at message forty.
   */
  private async summaryBefore(
    enterpriseId: number,
    conversationId: number,
    refs: readonly string[],
  ): Promise<string | null> {
    const oldest = refs[0];
    if (!oldest) return null;
    return this.messages.summaryBeforeRef(enterpriseId, conversationId, oldest);
  }

  /** What is known to have moved since, in terms somebody can act on. */
  private drift(call: ModelCallRow, prompt: { canonical: string }): string[] {
    if (call.promptHash === null) {
      return ['This call was made before prompts were fingerprinted, so it cannot be checked.'];
    }
    if (fingerprint(prompt.canonical) === call.promptHash) return [];

    const notes = [
      'This is not byte-for-byte what was sent. Something it was built from has changed since.',
    ];
    if (call.purpose === ModelCallPurpose.MediaDescription) {
      notes.push('The only moving part here is the console instruction, so that is what changed.');
      return notes;
    }
    notes.push(
      'Likely causes: the console prompt, the business profile, a photo described again, or a message edited or deleted.',
    );
    return notes;
  }
}
