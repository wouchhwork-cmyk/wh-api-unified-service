import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { MediaAnalysisRepository } from '@/database/repositories/media-analysis.repository';
import { MessageAttachmentRepository } from '@/database/repositories/message-attachment.repository';
import { AssistantToolCallRepository } from '@/database/repositories/assistant-tool-call.repository';
import { CallbackRequestRepository } from '@/database/repositories/callback-request.repository';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { ConversationRepository } from '@/database/repositories/conversation.repository';
import { RewardWalletRepository } from '@/database/repositories/reward-wallet.repository';
import { RewardEntitlementRepository } from '@/database/repositories/reward-entitlement.repository';
import { cleanContact } from '@/shared/utils/normalize';
import { notesOn } from '@/modules/inbox/turn-text';
import {
  IdentifierKind,
  IdentifierSource,
  IdentifierVerificationStatus,
  MediaAnalysisStatus,
  MessageDirection,
} from '@/shared/enums';
import {
  TOOL_HISTORY_DEFAULT,
  TOOL_HISTORY_MAX,
  TOOL_MESSAGE_WINDOW_MAX,
  TOOL_OTHER_CONVERSATIONS_DEFAULT,
  TOOL_OTHER_CONVERSATIONS_MAX,
  TOOL_REWARD_ENTITLEMENTS_MAX,
  TOOL_REWARD_HISTORY_MAX,
} from '@/shared/constants';
import { checkToolArgs, type RequestedTool } from './tool.contract';
import { TOOL_SPEC_BY_NAME, ToolName } from './tool.specs';
import { ToolOutcome, type ToolRun } from './tool-result';

/** Everything a tool is allowed to know about where it is being run. */
export interface ToolContext {
  readonly enterpriseId: number;
  readonly conversationId: number;
  readonly customerId: number | null;
  readonly customerIdentifierId: number | null;
  /** The inbound message being answered, when there is one. */
  readonly messageId: number | null;
  /** Which model call asked, for the ledger. */
  readonly modelCallId: number | null;
  readonly round: number;
}

/**
 * Runs one tool the assistant asked for, and writes down that it did.
 *
 * THE SERVICE LAYER, and deliberately not the chatbot's own code. A tool
 * does real work against real data: it has to be tenant-scoped, validated,
 * bounded and recorded, and none of that belongs inline in the loop that
 * happens to call it. Keeping it here also means the rules that make a tool
 * safe are in ONE place rather than repeated per tool — a tool's own code is
 * then only the part that is actually about that tool.
 *
 * IT NEVER THROWS INTO THE LOOP. Every failure is a `ToolRun` with an
 * outcome the model can read and act on: "that message is not in this
 * conversation", "you did not give me a phone number". An exception would
 * take down a reply somebody is waiting for, over a lookup that was an
 * optimisation — and the model is perfectly capable of answering without
 * what it asked for, as long as it is told it did not get it.
 */
@Injectable()
export class ToolRunnerService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly messages: MessageRepository,
    private readonly analyses: MediaAnalysisRepository,
    private readonly attachments: MessageAttachmentRepository,
    private readonly ledger: AssistantToolCallRepository,
    private readonly callbacks: CallbackRequestRepository,
    private readonly enterprises: EnterpriseRepository,
    private readonly conversations: ConversationRepository,
    private readonly wallets: RewardWalletRepository,
    private readonly entitlements: RewardEntitlementRepository,
    @InjectPinoLogger(ToolRunnerService.name) private readonly logger: PinoLogger,
  ) {}

  async run(requested: RequestedTool, ctx: ToolContext): Promise<ToolRun> {
    const started = Date.now();
    const spec = TOOL_SPEC_BY_NAME.get(requested.name);

    if (!spec) {
      /*
       * A NAME WE DO NOT HAVE. Said plainly rather than silently ignored:
       * a model that invented a tool needs to know it invented one, or it
       * will answer as though the call succeeded.
       */
      return this.settle(requested, ctx, {
        outcome: ToolOutcome.Unknown,
        data: null,
        note: `there is no tool called "${requested.name}". Answer with what you have.`,
        effect: 'read',
        startedAt: started,
      });
    }

    const checked = checkToolArgs(spec.args, requested.args);
    if (!checked.ok) {
      return this.settle(requested, ctx, {
        outcome: ToolOutcome.Incomplete,
        data: null,
        note: `missing: ${checked.missing.join(', ')}. Ask the customer for it rather than guessing.`,
        effect: spec.effect,
        startedAt: started,
      });
    }

    try {
      const { data, note, empty } = await this.dispatch(spec.name, checked.values, ctx);
      return this.settle(requested, ctx, {
        outcome: empty ? ToolOutcome.Empty : ToolOutcome.Ok,
        data,
        note,
        effect: spec.effect,
        startedAt: started,
        args: checked.values,
      });
    } catch (error) {
      /*
       * LOGGED HERE, because this is the only place that still knows which
       * tool it was. What goes back to the model is deliberately plain: an
       * error message from a repository is machinery, and machinery in a
       * prompt is machinery a customer eventually reads.
       */
      this.logger.error(
        { enterpriseId: ctx.enterpriseId, tool: spec.name, err: error },
        'a tool the assistant asked for failed',
      );
      return this.settle(requested, ctx, {
        outcome: ToolOutcome.Failed,
        data: null,
        note: 'that lookup did not work. Say you could not find out rather than guessing.',
        effect: spec.effect,
        startedAt: started,
        args: checked.values,
      });
    }
  }

  /** The tool itself. One branch per name, each as small as it can be. */
  private async dispatch(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<{ data: unknown; note: string | null; empty: boolean }> {
    switch (name) {
      case ToolName.CustomerDetails:
        return this.customerDetails(ctx);
      case ToolName.OneMessage:
        return this.message(args, ctx);
      case ToolName.EarlierMessages:
        return this.history(args, ctx);
      case ToolName.Callback:
        return this.callback(args, ctx);
      case ToolName.RecordCustomer:
        return this.recordCustomer(args, ctx);
      case ToolName.RewardBalance:
        return this.rewardBalance(args, ctx);
      case ToolName.OtherChats:
        return this.otherConversations(args, ctx);
      default:
        /* Unreachable: the spec was found by name above. Kept so adding a
         * spec without an implementation fails loudly here rather than
         * silently answering nothing. */
        return {
          data: null,
          note: `"${name}" is declared but not implemented`,
          empty: true,
        };
    }
  }

  private async customerDetails(
    ctx: ToolContext,
  ): Promise<{ data: unknown; note: string | null; empty: boolean }> {
    if (ctx.customerId === null) {
      return { data: null, note: 'this conversation has no customer on it', empty: true };
    }

    const profile = await this.customers.assistantProfile(
      ctx.enterpriseId,
      ctx.customerId,
      ctx.customerIdentifierId,
    );
    if (!profile) return { data: null, note: 'we hold no record for them', empty: true };

    const contacts = await this.customers.contactIdentifiers(ctx.enterpriseId, ctx.customerId);

    return {
      /*
       * NAMED BY WHERE IT CAME FROM, the same split <person> makes. A model
       * handed one "name" cannot tell a colleague's record from a handle,
       * and states the second as a fact about somebody.
       */
      data: {
        name_we_recorded: profile.ownDisplayName ?? profile.ownFirstName ?? null,
        name_on_their_profile: profile.platformDisplayName ?? profile.platformFirstName ?? null,
        handle: profile.handle ? `@${profile.handle}` : null,
        /*
         * READ DEFENSIVELY out of the platform's bag: a missing key means
         * "we have not been told", which is not the same as no — and
         * reporting a false where we simply do not know is the model
         * telling a customer something about their own account.
         */
        follows_this_business: flagIn(profile.platformMetadata, 'followsUs'),
        this_business_follows_them: flagIn(profile.platformMetadata, 'weFollowThem'),
        verified_account: flagIn(profile.platformMetadata, 'isVerified'),
        followers: countIn(profile.platformMetadata, 'followerCount'),
        conversations_with_us: profile.conversationCount,
        contacts: contacts.map((row) => ({
          kind: row.identifierKind,
          value: row.identifierValue,
          /* Said out loud: a number somebody typed in a chat is not a number
           * anybody checked, and the difference decides what may be done
           * with it. */
          verified: row.verificationStatus === String(IdentifierVerificationStatus.Verified),
        })),
      },
      note: null,
      empty: false,
    };
  }

  private async message(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<{ data: unknown; note: string | null; empty: boolean }> {
    const refId = textOf(args.message_id) ?? '';
    if (!UUID.test(refId)) {
      return {
        data: null,
        note: 'that is not a full message id. Copy it exactly from your notes or from the "re:" marker on a turn, including the hyphens.',
        empty: true,
      };
    }

    const clamp = (value: unknown): number =>
      Math.min(Math.max(typeof value === 'number' ? value : 0, 0), TOOL_MESSAGE_WINDOW_MAX);

    const rows = await this.messages.readAround(ctx.enterpriseId, ctx.conversationId, refId, {
      before: clamp(args.before),
      after: clamp(args.after),
    });

    if (rows.length === 0) {
      /*
       * SCOPED TO THIS CONVERSATION, so "not found" also covers an id from
       * somebody else's thread — which is what a laundered id in a customer
       * message would be. The model is told the same thing either way,
       * because the difference is none of its business.
       */
      return {
        data: null,
        note: 'there is no message with that id in this conversation',
        empty: true,
      };
    }

    const described = await this.describe(
      ctx.enterpriseId,
      rows.map((row) => row.id),
    );

    return {
      data: rows.map((row) => ({
        id: row.refId,
        from: row.direction === MessageDirection.Inbound ? 'them' : 'us',
        at: (row.platformSentAt ?? row.createdAt).toISOString(),
        replying_to: row.parentRefId,
        text: row.body,
        media: described.get(row.id) ?? [],
        /*
         * THE NOTES AS THEY STOOD AT THAT MESSAGE — which is how context
         * that has since been lost gets recovered.
         *
         * Every reply carries its own notes, and only the newest set is
         * ever read back. So when a reply rewrites them badly, the older
         * and fuller sets are still sitting on the older messages,
         * untouched: watched live, 5,250 characters of notes carrying the
         * wedding, the recorded name and the phone number were reduced to
         * 504 in one turn — and four minutes later the assistant answered
         * "What wedding are you talking about?" while the full account sat
         * two messages up.
         *
         * Guarding the rewrite stops it happening again. This is what
         * makes the damage already done RECOVERABLE: reach back to any
         * earlier reply and read what was known then.
         */
        ...(notesOn(row) ? { notes_at_the_time: notesOn(row) } : {}),
      })),
      note: 'where a reply carries notes_at_the_time, those are the notes AS THEY STOOD THEN. If they hold something your current notes have lost, use it and carry it forward into the notes you write now.',
      empty: false,
    };
  }

  /** The descriptions for a handful of messages, in one pass. */
  private async describe(
    enterpriseId: number,
    messageIds: readonly number[],
  ): Promise<Map<number, unknown[]>> {
    const byMessage = new Map<number, unknown[]>();
    if (messageIds.length === 0) return byMessage;

    const attachments = await this.attachments.listForMessages(enterpriseId, [...messageIds]);
    if (attachments.length === 0) return byMessage;

    const keys = [
      ...new Set(attachments.map((row) => row.mediaKey).filter((key): key is string => !!key)),
    ];
    const analyses = await this.analyses.findByKeys(enterpriseId, keys);
    const byKey = new Map(analyses.map((row) => [row.mediaKey, row]));

    for (const attachment of attachments) {
      const analysis = attachment.mediaKey ? byKey.get(attachment.mediaKey) : undefined;
      if (!analysis || analysis.status !== MediaAnalysisStatus.Done) continue;

      const existing = byMessage.get(attachment.messageId) ?? [];
      existing.push({
        kind: attachment.mediaKind,
        /* The three kept apart, exactly as the turn renderer keeps them: a
         * date READ off an invitation is not a date somebody SAID. */
        describes: analysis.summary,
        heard: analysis.transcript,
        read: analysis.visibleText,
        scene_by_scene: analysis.scenes,
      });
      byMessage.set(attachment.messageId, existing);
    }
    return byMessage;
  }

  /**
   * More of the conversation, as one line per message.
   *
   * DELIBERATELY THIN. A hundred messages with their media spelled out is a
   * prompt nobody can afford, and it would also be the wrong thing: what
   * this answers is "where is the thing I am looking for", and the answer
   * to that is a list with ids in it. Anything worth reading properly is
   * then fetched by `get_one_message`, which is the detail half of the pair.
   */
  private async history(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<{ data: unknown; note: string | null; empty: boolean }> {
    const asked = typeof args.count === 'number' ? args.count : TOOL_HISTORY_DEFAULT;
    const count = Math.min(Math.max(asked, 1), TOOL_HISTORY_MAX);

    const rows = await this.messages.listThread(ctx.enterpriseId, ctx.conversationId, count, null);
    /*
     * NEWEST FIRST OUT OF THE REPOSITORY, because that is what a reader
     * pages through. A model reads a conversation the way it happened.
     */
    const ordered = [...rows].reverse().filter((row) => !row.isInternalNote);

    if (ordered.length === 0) {
      return { data: null, note: 'this conversation has no messages', empty: true };
    }

    return {
      data: ordered.map((row) => ({
        id: row.refId,
        from: row.direction === MessageDirection.Inbound ? 'them' : 'us',
        at: (row.platformSentAt ?? row.createdAt).toISOString(),
        replying_to: row.parentRefId,
        text: row.body,
        /* A marker, not the description. The id beside it is how to read it. */
        ...(row.hasAttachments ? { has_media: true } : {}),
      })),
      note:
        ordered.length < count
          ? `that is the whole conversation — ${ordered.length} messages, there are no more`
          : 'use get_one_message on any id here to read it in full, with its media',
      empty: false,
    };
  }

  private async callback(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<{ data: unknown; note: string | null; empty: boolean }> {
    if (ctx.customerId === null) {
      return { data: null, note: 'this conversation has no customer to call back', empty: true };
    }

    const result = await this.callbacks.open({
      enterpriseId: ctx.enterpriseId,
      conversationId: ctx.conversationId,
      customerId: ctx.customerId,
      messageId: ctx.messageId,
      /*
       * NARROWED, NOT COERCED. `String(value)` on an unknown that happens
       * to be an object yields the literal text "[object Object]" — which
       * would be stored as somebody's phone number and dialled by a
       * colleague. The arguments are checked before this point, so these
       * are strings; reading them as anything else is how that stops being
       * true the first time a kind changes.
       */
      phone: (textOf(args.phone) ?? '').slice(0, 40),
      reason: textOf(args.reason) ?? '',
      whenReachable: typeof args.when_reachable === 'string' ? args.when_reachable : null,
      requestedBy: 'assistant',
    });

    return {
      data: {
        reference: result.row.refId,
        already_requested: !result.created,
        about: result.row.reason,
      },
      note: result.created
        ? 'recorded. A colleague will ring them — tell them that, not that the call is happening now.'
        : 'a callback was already outstanding on this conversation, so nothing new was booked. Tell them it is already arranged rather than booking a second one.',
      empty: false,
    };
  }

  private async recordCustomer(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<{ data: unknown; note: string | null; empty: boolean }> {
    if (ctx.customerId === null) {
      return { data: null, note: 'this conversation has no customer on it', empty: true };
    }

    /*
     * THE EVIDENCE IS CHECKED, not just required.
     *
     * `said_in_message_id` has to name a message in THIS conversation. That
     * is what stops the obvious attack — a message containing an id from
     * somewhere else, or an invented one — and what makes the record
     * checkable afterwards: a name with a message behind it that a person
     * can open is a claim; a name without one is an assertion.
     */
    const saidIn = textOf(args.said_in_message_id) ?? '';
    if (!UUID.test(saidIn)) {
      return {
        data: null,
        note: 'said_in_message_id must be the full id of the message where they said it',
        empty: true,
      };
    }
    const evidence = await this.messages.findMessageIdByRef(
      ctx.enterpriseId,
      ctx.conversationId,
      saidIn,
    );
    if (evidence === null) {
      return {
        data: null,
        note: 'that message is not in this conversation, so nothing was recorded. Point at the message where they actually said it.',
        empty: true,
      };
    }

    const name = textOf(args.name);
    const firstName = textOf(args.first_name);
    const lastName = textOf(args.last_name);
    const language = textOf(args.preferred_language);
    const phone = textOf(args.phone);
    const whatsapp = textOf(args.whatsapp);
    const email = textOf(args.email);

    if (!name && !firstName && !lastName && !language && !phone && !whatsapp && !email) {
      return { data: null, note: 'nothing was given to record', empty: true };
    }

    const recorded: Record<string, unknown> = {};
    const notes: string[] = [];

    if (name || firstName || lastName || language) {
      /*
       * A COLLEAGUE OUTRANKS THE ASSISTANT. Somebody who typed a correction
       * does not get it undone by a chat — so an existing name is reported
       * back rather than replaced, and the model can mention the difference
       * or hand over instead of silently overwriting it.
       *
       * ONLY THE NAME IS GUARDED THIS WAY. A language they have just asked
       * to be answered in is a request about this conversation, not a
       * record somebody is correcting, and the newest one is the right one.
       */
      const held = await this.customers.assistantProfile(
        ctx.enterpriseId,
        ctx.customerId,
        ctx.customerIdentifierId,
      );
      const existing = held?.ownDisplayName?.trim() ?? '';

      /*
       * A HANDLE SITTING IN THE NAME FIELD IS NOT A COLLEAGUE'S CHOICE.
       *
       * Observed on the first live use. A customer said "it's aditya
       * patil"; the guard refused, reporting that this business already
       * records them as "genzrelics" — which is their Instagram handle,
       * copied into the name column by code that predates the identity
       * split. No colleague ever typed it, so there was nothing to
       * protect, and the result was a record reading first name Aditya,
       * last name Patil, display name genzrelics.
       *
       * The guard exists so a typed correction is not undone by a chat.
       * A value that is simply what the platform calls them has no such
       * claim, so it is treated as absent and may be replaced.
       */
      const inherited = [held?.platformDisplayName, held?.handle]
        .map((value) => value?.trim().toLowerCase() ?? '')
        .filter((value) => value.length > 0);
      const chosenByAColleague = existing.length > 0 && !inherited.includes(existing.toLowerCase());

      const taken =
        name !== null && chosenByAColleague && existing.toLowerCase() !== name.toLowerCase();

      if (taken) {
        notes.push(
          `this business already records them as "${existing}", so the name was NOT changed`,
        );
        recorded.name = existing;
      }

      /*
       * EACH FIELD ON ITS OWN. Absent means "do not touch" all the way
       * down, so recording a language cannot blank a name and a refused
       * name does not take the surname with it.
       */
      const fields = {
        ...(name !== null && !taken ? { displayName: name } : {}),
        ...(firstName !== null ? { firstName } : {}),
        ...(lastName !== null ? { lastName } : {}),
        ...(language !== null ? { preferredLanguage: language } : {}),
      };

      if (Object.keys(fields).length > 0) {
        await this.customers.setDeclaredIdentity(ctx.enterpriseId, ctx.customerId, fields);
        Object.assign(recorded, fields);
      }
    }

    /*
     * A CONTACT IS CLEANED UP BEFORE IT IS STORED, never after.
     *
     * Observed on the first live use. A customer typed "8888 8888 88" and
     * that is exactly what went into `identifier_value` — the canonical
     * column every lookup and every uniqueness check reads. The number
     * matched nothing, the same person typing "+91 88888 88888" tomorrow
     * would become a second identifier, and the three decomposition
     * columns beside it stayed empty.
     *
     * The normalizers for both already existed and are the ones signup
     * uses. Nothing here is new behaviour; this path simply never called
     * them.
     */
    const country = textOf(args.country);
    for (const [value, kind] of [
      [phone, IdentifierKind.Mobile],
      [whatsapp, IdentifierKind.WhatsAppNumber],
      [email, IdentifierKind.Email],
    ] as const) {
      if (!value) continue;

      const clean = cleanContact({
        kind,
        value,
        stated: country,
        /* The country this business stated for itself. It is a declaration,
         * not a guess, which is what lets a bare number through without
         * anybody being asked. A business with none set gets asked. */
        operatesIn:
          kind === IdentifierKind.Email ? [] : await this.businessCountries(ctx.enterpriseId),
      });

      /*
       * REFUSED, NOT STORED BADLY, and the two refusals are different.
       *
       * An unreadable number is a thing to look at again. A number with no
       * country is a thing to ASK about — and the asking is the whole point:
       * guessing produces a number that is wrong, looks right, and gets
       * dialled. The note says which it was and, where the business has
       * said where it trades, which answers are worth offering.
       */
      if (!clean.ok) {
        if (clean.problem === 'needs_country') {
          const choices =
            clean.choices.length > 0
              ? ` This business operates in ${clean.choices.join(', ')} — ask which of those they are in, or for the number with its country code.`
              : ' Ask them for the number with its country code.';
          notes.push(
            `"${value}" has no country on it, so it was NOT recorded — the same digits are a different person in different countries and I will not guess.${choices}`,
          );
        } else {
          notes.push(
            kind === IdentifierKind.Email
              ? `"${value}" is not a usable email address, so it was NOT recorded. Ask them to confirm it.`
              : `"${value}" could not be read as a real phone number, so it was NOT recorded. Ask them to check it.`,
          );
        }
        continue;
      }

      /*
       * WHO ELSE HAS IT, ASKED BEFORE THE WRITE. Caught live, and it is the
       * worst class of bug this service can have.
       *
       * A customer gave their number in a chat. The insert is
       * `ON CONFLICT DO NOTHING` against a unique index on
       * (enterprise_id, kind, value) — which is NOT scoped to a customer —
       * and another customer of the same business already held that number
       * from a colleague typing it in. So the write did nothing, this tool
       * reported the number as recorded anyway, and the assistant told the
       * customer "I have updated that number to your account for you."
       *
       * Nothing was updated. The customer was told it was. That is worse
       * than an error, because everybody involved believes it worked and
       * nobody finds out until somebody cannot be reached.
       *
       * Two records claiming one phone number is also not a thing to
       * resolve from a chat: it is either a typo, a shared handset or two
       * records for one person, and a colleague has to decide which.
       */
      const owner = await this.customers.identifierOwner(
        ctx.enterpriseId,
        kind,
        clean.contact.canonical,
      );
      if (owner !== null && owner !== ctx.customerId) {
        notes.push(
          `that ${kind} is already on a DIFFERENT customer's record with this business, so it was NOT added to theirs. Do NOT tell them it is saved, and do NOT say whose record it is on. Tell them it is already registered to another account and set handoff for that one thing. Everything else they ask for is still yours to do — this refusal covers this ${kind} and nothing else.`,
        );
        continue;
      }

      const linked = await this.customers.linkIdentifier({
        enterpriseId: ctx.enterpriseId,
        customerId: ctx.customerId,
        identifierKind: kind,
        identifierValue: clean.contact.canonical,
        /* What they actually typed, kept beside it for anybody reading the
         * record who wants to see it the way it was given. */
        identifierValueRaw: value,
        ...(clean.contact.mobile ? { mobile: clean.contact.mobile } : {}),
        /* They said it; nobody checked it. Anything that cares can see so. */
        source: IdentifierSource.SelfDeclared,
        verification: IdentifierVerificationStatus.Unverified,
      });
      /* Reported ONLY once it is genuinely on their record. `linked` false
       * here means they already had it, which is still true of the record —
       * the case where it is NOT theirs was refused above. */
      recorded[kind] = clean.contact.canonical;

      if (!linked) notes.push(`we already held that ${kind}`);
    }

    /*
     * READ BACK, NOT REPORTED BACK. The fix for the worst thing this
     * service has done.
     *
     * A customer gave a number; the insert silently did nothing because
     * another customer of the same business already held it; this tool
     * returned the number as `recorded` anyway — it was echoing the
     * REQUEST — and the assistant told them "I have updated that number to
     * your account for you." Then, asked to check the system, it said it
     * had verified it. Nothing had been written and nothing had been read.
     *
     * The ownership check above stops that particular cause. This stops the
     * SHAPE of it: what comes back is now the record as it actually stands,
     * fetched after the writes, so a value that did not land cannot appear
     * here however it failed to land. A write can no longer describe
     * itself — it can only show what is there.
     */
    const [profile, contacts] = await Promise.all([
      this.customers.assistantProfile(ctx.enterpriseId, ctx.customerId, ctx.customerIdentifierId),
      this.customers.contactIdentifiers(ctx.enterpriseId, ctx.customerId),
    ]);

    return {
      data: {
        evidence: saidIn,
        /* What this call set out to change, kept only so the model can see
         * where its intent and the record disagree. */
        attempted: recorded,
        on_record_now: {
          name: profile?.ownDisplayName ?? null,
          first_name: profile?.ownFirstName ?? null,
          preferred_language: profile?.preferredLanguage ?? null,
          contacts: contacts.map((row) => ({
            kind: row.identifierKind,
            value: row.identifierValue,
          })),
        },
      },
      note: [
        ...notes,
        'on_record_now is what the record ACTUALLY holds, read back after writing. If something you passed is missing from it, it was NOT saved — say so plainly rather than saying it was.',
      ].join('; '),
      empty: false,
    };
  }

  /**
   * What this person has earned and what they can spend.
   *
   * TWO READS, ONE ANSWER. A balance without the rewards it can be spent on
   * answers half the question, and a model given half will fill in the rest.
   *
   * NO REDEMPTION CODES, EVER. Each entitlement carries one and it is a
   * bearer value — whoever reads it can spend the reward. What comes back
   * says a reward exists, what it is for and when it lapses. A code is a
   * thing to hand over deliberately, by somebody who knows who is asking.
   */
  private async rewardBalance(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<{ data: unknown; note: string | null; empty: boolean }> {
    if (ctx.customerId === null) {
      return { data: null, note: 'this conversation has no customer on it', empty: true };
    }

    /*
     * FETCHED ONLY WHEN ASKED FOR. Most reward questions are "what have I
     * got"; the history serves the rarer "how did I get it", and paying for
     * it on every balance question is a paragraph nobody reads.
     */
    const askedFor = typeof args.history === 'number' ? args.history : 0;
    const historyCount = Math.min(Math.max(askedFor, 0), TOOL_REWARD_HISTORY_MAX);

    const [wallets, entitlements, history] = await Promise.all([
      this.wallets.listCustomerWallets(ctx.enterpriseId, ctx.customerId, 10),
      this.entitlements.listForCustomer(
        ctx.enterpriseId,
        ctx.customerId,
        TOOL_REWARD_ENTITLEMENTS_MAX,
      ),
      historyCount > 0
        ? this.wallets.listCustomerEntries(ctx.enterpriseId, ctx.customerId, historyCount)
        : Promise.resolve([]),
    ]);

    if (wallets.length === 0 && entitlements.length === 0) {
      /*
       * SAID PLAINLY. "Nothing" is a real answer here and a different one
       * from "this business runs no scheme" — the model may need to say
       * either, and must not turn the first into the second.
       */
      return {
        data: { wallets: [], rewards: [] },
        note: 'this person has no reward balance and no rewards issued to them. That is not the same as the business having no scheme.',
        empty: false,
      };
    }

    /*
     * POINTS ARE NOT MONEY UNLESS A CURRENCY SAYS SO. Asked "of the points,
     * how many dollars", a model holding a bare number will invent a rate —
     * and a made-up exchange rate quoted to a customer is a price this
     * business did not set. A wallet with no currency_code has no cash value
     * here, and that has to be said rather than left to be inferred.
     */
    const anyCashValue = wallets.some((row) => row.currencyCode !== null);

    return {
      data: {
        wallets: wallets.map((row) => ({
          kind: row.walletKind,
          currency: row.currencyCode,
          balance: row.balance,
          /* Earned but not yet usable — the difference somebody disputes. */
          pending: row.pendingBalance,
          earned_all_time: row.lifetimeEarned,
        })),
        rewards: entitlements.map((row) => ({
          what: row.itemRef,
          status: row.status,
          issued: row.issuedAt.toISOString(),
          expires: row.expiresAt?.toISOString() ?? null,
        })),
        ...(history.length > 0
          ? {
              how_it_was_earned: history.map((row) => ({
                /* `earn` or `spend`, said as a direction rather than a word
                 * from the database. */
                direction: row.entryKind,
                amount: row.amount,
                balance_after: row.balanceAfter,
                on: row.occurredAtUtc.toISOString(),
                /* What they DID. The rule's trigger is the only thing that
                 * answers "what for", and without it an amount and a date
                 * are a bank statement with no description. */
                for_doing: triggerInWords(row.triggerKind),
                programme: row.programName,
                wallet: row.walletKind,
              })),
            }
          : {}),
      },
      note: [
        'redemption codes are deliberately not included. If they need one, hand over to a colleague.',
        ...(anyCashValue
          ? []
          : [
              'these balances carry NO cash value — they are a count, not a currency. Do not convert them to money or quote a rate, and if they ask what they are worth, say what they can be redeemed for or hand over.',
            ]),
        ...(historyCount > 0 && history.length === historyCount
          ? [`that is the ${historyCount} most recent entries; there are likely older ones`]
          : []),
      ].join(' '),
      empty: false,
    };
  }

  /**
   * The same person, everywhere else they have spoken to this business.
   *
   * SIDEWAYS RATHER THAN DEEPER, which `get_earlier_messages` is for. Measured
   * live: one customer with 32 threads against this business, 31 of them
   * invisible to an assistant that told them "I don't have access to
   * personal history".
   *
   * NOTES WHERE THEY EXIST, THE LAST MESSAGE WHERE THEY DO NOT. None of
   * that customer's 26 mentions had ever been summarised — they were never
   * auto-replied to — so a list built on notes alone would have been 26
   * blank rows.
   */
  private async otherConversations(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<{ data: unknown; note: string | null; empty: boolean }> {
    if (ctx.customerId === null) {
      return { data: null, note: 'this conversation has no customer on it', empty: true };
    }

    const asked = typeof args.count === 'number' ? args.count : TOOL_OTHER_CONVERSATIONS_DEFAULT;
    const limit = Math.min(Math.max(asked, 1), TOOL_OTHER_CONVERSATIONS_MAX);

    const rows = await this.conversations.otherConversationsFor({
      enterpriseId: ctx.enterpriseId,
      customerId: ctx.customerId,
      excludeConversationId: ctx.conversationId,
      limit,
    });

    if (rows.length === 0) {
      return {
        data: null,
        note: 'this is the only conversation this business has had with them',
        empty: true,
      };
    }

    return {
      data: rows.map((row) => ({
        kind: row.conversationKind,
        status: row.status,
        last_spoke: row.lastMessageAt?.toISOString() ?? null,
        messages: row.messageCount,
        ...(row.subject ? { about: row.subject } : {}),
        /* Which post they commented under, when it was a post at all. */
        ...(row.postCaption ? { on_post: row.postCaption.slice(0, 200) } : {}),
        ...(row.postUrl ? { post_url: row.postUrl } : {}),
        ...(row.notes ? { notes: row.notes } : {}),
        ...(row.lastMessage
          ? {
              last_message: {
                from: row.lastMessageFrom === MessageDirection.Inbound ? 'them' : 'us',
                text: row.lastMessage.slice(0, 300),
                ...(row.lastMessageHadMedia ? { had_media: true } : {}),
              },
            }
          : {}),
      })),
      /*
       * SAID OUT LOUD, because a model handed five of thirty-two will
       * otherwise answer as though five is all there was.
       */
      note:
        rows.length === limit
          ? `that is the ${limit} most recent; there may be older ones — ask again with a larger count if you need them`
          : null,
      empty: false,
    };
  }

  /**
   * The country this business stated for itself, as a one-item list.
   *
   * A LIST BECAUSE `cleanContact` DISTINGUISHES NONE FROM ONE, and those are
   * genuinely different answers: one country settles what a bare number is
   * without asking anybody, and none means the question has to be put. The
   * business has exactly one country today — see the entity for why — so
   * this is always one item or none.
   */
  private async businessCountries(enterpriseId: number): Promise<string[]> {
    const country = await this.enterprises.countryById(enterpriseId);
    return country ? [country] : [];
  }

  /**
   * Writes the row and returns what the loop renders.
   *
   * THE RECORD IS NOT THE WORK. The tool has already run by the time this is
   * called, so a ledger write that fails is logged and swallowed rather than
   * turning a finished effect into a reported failure — which would be a
   * lie, and would invite the model to do it again.
   */
  private async settle(
    requested: RequestedTool,
    ctx: ToolContext,
    outcome: {
      outcome: ToolRun['outcome'];
      data: unknown;
      note: string | null;
      effect: string;
      startedAt: number;
      args?: Record<string, unknown>;
    },
  ): Promise<ToolRun> {
    const durationMs = Date.now() - outcome.startedAt;

    try {
      await this.ledger.record({
        enterpriseId: ctx.enterpriseId,
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        modelCallId: ctx.modelCallId,
        toolName: requested.name,
        effect: outcome.effect,
        round: ctx.round,
        outcome: outcome.outcome,
        because: requested.because,
        arguments: outcome.args ?? requested.args,
        result: outcome.data === null ? null : { data: outcome.data },
        note: outcome.note,
        durationMs,
      });
    } catch (error) {
      this.logger.error(
        { enterpriseId: ctx.enterpriseId, tool: requested.name, err: error },
        'a tool ran but could not be recorded',
      );
    }

    return {
      tool: requested,
      outcome: outcome.outcome,
      data: outcome.data,
      note: outcome.note,
      durationMs,
    };
  }
}

/** A full id, which is the only kind the tools take. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function textOf(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : null;
}

/** A boolean the platform told us, or null for "we were not told". */
function flagIn(bag: Record<string, unknown> | null, key: string): boolean | null {
  const value = bag?.[key];
  return typeof value === 'boolean' ? value : null;
}

/** A count the platform told us, or null. Zero is an answer; absent is not. */
function countIn(bag: Record<string, unknown> | null, key: string): number | null {
  const value = bag?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * What a customer actually DID to earn something.
 *
 * `direct_message_inbound` is a column value, and a model handed one will
 * eventually put it in front of a customer verbatim. These are the same
 * facts in the words somebody would use about themselves.
 *
 * UNKNOWN TRIGGERS FALL THROUGH READABLE rather than being dropped: a rule
 * added after this map was written should still produce an answer, and
 * "comment on own post" is poor but honest where "null" is neither.
 */
const TRIGGER_IN_WORDS: Record<string, string> = {
  direct_message_inbound: 'sending a direct message',
  story_mention: 'mentioning the business in a story',
  story_reply: 'replying to a story',
  comment_on_own_post: 'commenting on one of the business’s posts',
  comment_on_mentioned_post: 'commenting on a post that tagged the business',
  referral_entry: 'referring somebody',
};

function triggerInWords(trigger: string | null): string | null {
  if (trigger === null) return null;
  return TRIGGER_IN_WORDS[trigger] ?? trigger.replace(/_/g, ' ');
}
