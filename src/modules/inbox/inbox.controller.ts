import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EnterpriseEmployeeRepository } from '@/database/repositories/enterprise-employee.repository';
import { CurrentScopedActor, RequirePermission } from '@/shared/decorators';
import { RefIdParamSchema } from '@/shared/contracts/params.contract';
import type { AttachmentRow } from '@/database/repositories/message-attachment.repository';
import type { MessageRow } from '@/database/repositories/message.repository';
import { RawResponse } from '@/shared/decorators/raw-response.decorator';
import { SkipTimeout } from '@/shared/decorators/skip-timeout.decorator';
import { DEFAULT_PAGE_SIZE, SSE_HEARTBEAT_MS, SSE_MAX_STREAM_MS } from '@/shared/constants';
import { InboxEventsService } from './inbox-events.service';
import {
  ConversationKind,
  ConversationStatus,
  MediaKind,
  MessageDirection,
  Permission,
} from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import { paginated, type Paginated } from '@/shared/contracts/envelope';
import { evaluateReplyWindow } from './reply-window';
import type { ActorContext } from '@/shared/context';
import {
  AssignRequestSchema,
  InboxQuerySchema,
  MarkReadRequestSchema,
  ModerateCommentRequestSchema,
  ReplyRequestSchema,
  StatusRequestSchema,
  ThreadQuerySchema,
  type ReplyResponse,
} from '@/shared/contracts/inbox/inbox.contract';
import { InboxService } from './inbox.service';
import { isExpiringMediaUrl } from './attachment-normalizer';

type ScopedActor = ActorContext & { enterpriseId: number };

@ApiTags('inbox')
@Controller({ path: 'conversations', version: '1' })
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly employees: EnterpriseEmployeeRepository,
    private readonly events: InboxEventsService,
  ) {}

  @Get()
  @RequirePermission(Permission.ConversationsView)
  @ApiOperation({
    summary: 'The inbox',
    description:
      'Cursor-paginated, newest activity first. The cursor carries the sort key and the row id, ' +
      'so a page can neither skip nor repeat a conversation.',
  })
  async list(
    @CurrentScopedActor() actor: ScopedActor,
    @Query() query: unknown,
  ): Promise<Paginated<unknown>> {
    const parsed = InboxQuerySchema.parse(query);
    const size = parsed.limit ?? DEFAULT_PAGE_SIZE;

    /*
     * "MINE" NEEDS A ME. A staff actor has no employeeId, so this resolved to
     * null — which the repository reads as "no assignment filter" and answers
     * with the ENTIRE inbox. Asking for your own work and being handed everyone's
     * is the wrong answer in the more dangerous direction.
     */
    const mineOnly = parsed.assignedToMe === 'true';
    if (mineOnly && actor.employeeId === null) {
      return paginated([], { limit: size, nextCursor: null, hasMore: false });
    }

    const result = await this.inbox.listInbox(actor.enterpriseId, {
      status: parsed.status ?? null,
      assignedToEmployeeId: mineOnly ? actor.employeeId : null,
      conversationKind: parsed.kind ?? null,
      limit: size,
      cursor: parsed.cursor ?? null,
    });

    /*
     * Wrapped rather than passed by reference: `.map` hands the INDEX as the
     * second argument, which would arrive where the known-author map belongs.
     */
    return paginated(
      result.items.map((row) => toConversationSummary(row)),
      {
        limit: size,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      },
    );
  }

  /**
   * A live feed of conversation changes for this business.
   *
   * Server-Sent Events, not WebSockets: the inbox needs one direction, SSE
   * reconnects on its own, and it needs no gateway or second protocol.
   *
   * THE EVENT IS A NUDGE, NOT THE DATA. It carries a conversation ref and
   * nothing else, and the client re-reads through the ordinary endpoints. That
   * keeps every tenant and permission check in one place instead of duplicating
   * them on a push path, and means no message text or customer name is ever
   * pushed to a session that has since lost access.
   */
  @Get('stream')
  @RequirePermission(Permission.ConversationsView)
  @SkipThrottle()
  @SkipTimeout()
  @RawResponse()
  @ApiOperation({
    summary: 'Live conversation changes (text/event-stream)',
    description:
      'Emits an `inbox` event carrying a conversation ref whenever one changes. The payload is ' +
      'deliberately id-only: re-read the conversation through GET /conversations/:refId.',
  })
  stream(@CurrentScopedActor() actor: ScopedActor, @Res() response: Response): void {
    let unsubscribe: (() => void) | null = null;

    try {
      unsubscribe = this.events.subscribe(actor.enterpriseId, (change) => {
        write('inbox', change);
      });
    } catch {
      // At the per-tenant cap. 503 rather than 429: the request is fine, this
      // instance simply has no room, and a client should retry elsewhere later.
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        success: false,
        error: { code: 'TOO_MANY_STREAMS', message: 'Too many open streams for this business.' },
      });
      return;
    }

    response.writeHead(HttpStatus.OK, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells nginx and friends not to buffer, which would hold every event
      // until the response ended — i.e. forever.
      'x-accel-buffering': 'no',
    });

    function write(event: string, data: unknown): void {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    // Sent immediately so a client can tell "connected" from "still connecting".
    write('ready', { at: new Date().toISOString() });

    /*
     * A comment line, which SSE ignores. Without it an idle stream is
     * indistinguishable from a dead one and proxies close it.
     */
    const heartbeat = setInterval(() => {
      response.write(`: ping ${Date.now()}\n\n`);
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref();

    /*
     * THE STREAM EXPIRES. It is the one authorisation here with no TTL: checked
     * once at connect, then delivering this tenant's activity for as long as a
     * browser tab stayed open — outliving the 15-minute token that opened it,
     * and outliving the employee's employment. Suspending someone did not stop
     * their open stream, because nothing re-asked.
     *
     * Capping it sends the client back through the guard chain with a current
     * token, which is where that question is already answered properly. The
     * client reconnects; an expiring stream is not an error, so it is announced
     * rather than dropped.
     */
    const expiry = setTimeout(() => {
      write('expired', { reason: 'reconnect to continue' });
      close();
    }, SSE_MAX_STREAM_MS);
    expiry.unref();

    const close = (): void => {
      clearInterval(heartbeat);
      clearTimeout(expiry);
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      response.end();
    };

    // Both events matter: 'close' covers a browser tab closing, 'error' a
    // network drop. Leaking a subscriber per reconnect would grow without bound.
    response.on('close', close);
    response.on('error', close);
  }

  @Get(':refId')
  @RequirePermission(Permission.ConversationsView)
  @ApiOperation({ summary: 'One conversation and its messages' })
  async thread(
    @CurrentScopedActor() actor: ScopedActor,
    @Param('refId') refId: string,
    @Query() query: unknown,
  ): Promise<unknown> {
    const parsed = ThreadQuerySchema.parse(query);
    const size = parsed.limit ?? DEFAULT_PAGE_SIZE;
    const result = await this.inbox.readThread(
      actor.enterpriseId,
      RefIdParamSchema.parse(refId),
      size,
      parsed.cursor ?? null,
      parsed.beforeId ?? null,
    );
    return {
      /*
       * The thread view is the only place that can name a mention's
       * neighbours: the list has no reason to pay for the lookup.
       */
      conversation: toConversationSummary(
        result.conversation,
        result.knownAuthors,
        result.parentMention,
      ),
      messages: result.messages.map((row) =>
        toMessage(row, result.attachmentsByMessageId.get(row.id) ?? []),
      ),
      /*
       * Lifted into meta.pagination by the envelope interceptor, so this reads
       * the same as every other list. The thread had no pagination surface at
       * all before — a conversation with more than one page of history simply
       * ended, with nothing to say so — and its first version put this in
       * `data`, which was a second envelope shape for clients to learn.
       */
      pagination: {
        limit: size,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      },
    };
  }

  @Post(':refId/messages/:messageRefId/moderate')
  @RequirePermission(Permission.ConversationsManage)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Hide, unhide or delete a comment on a post you own',
    description:
      'Instagram allows moderation only to the owner of the media a comment sits on — explicitly ' +
      'even when the caller wrote the comment. So this is refused here for anything but a comment ' +
      'thread on one of your own posts, rather than spending a platform call to be told no. ' +
      'Accepted, not applied: the call goes through the outbox and the relay performs it.',
  })
  async moderateComment(
    @CurrentScopedActor() actor: ScopedActor,
    @Param('refId') refId: string,
    @Param('messageRefId') messageRefId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = ModerateCommentRequestSchema.parse(body ?? {});
    return this.inbox.moderateComment(
      actor.enterpriseId,
      RefIdParamSchema.parse(refId),
      RefIdParamSchema.parse(messageRefId),
      parsed.action,
    );
  }

  @Post(':refId/reply')
  @RequirePermission(Permission.ConversationsReply)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Reply to a conversation',
    description:
      'Returns 202 with status "pending": the message and its outbound ledger row are written in ' +
      'one transaction and the platform call happens afterwards, in the relay. Send the same ' +
      'idempotencyKey to retry safely — a repeat returns the original message rather than a second one.',
  })
  async reply(
    @CurrentScopedActor() actor: ScopedActor,
    @Param('refId') refId: string,
    @Body() body: unknown,
  ): Promise<ReplyResponse> {
    const parsed = ReplyRequestSchema.parse(body);
    return this.inbox.reply(actor, {
      conversationRefId: RefIdParamSchema.parse(refId),
      body: parsed.body,
      idempotencyKey: parsed.idempotencyKey,
      internalNote: parsed.internalNote,
      replyToMessageRefId: parsed.replyToMessageRefId,
    });
  }

  @Post(':refId/assign')
  @RequirePermission(Permission.ConversationsAssign)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Assign a conversation to a team employee, or unassign it' })
  async assign(
    @CurrentScopedActor() actor: ScopedActor,
    @Param('refId') refId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = AssignRequestSchema.parse(body);

    let employeeId: number | null = null;
    if (parsed.employeeRefId !== null) {
      // Resolved within THIS enterprise, so a refId from another tenant cannot
      // be assigned work here.
      const employee = await this.employees.findByRefId(actor.enterpriseId, parsed.employeeRefId);
      if (!employee) throw new AppException(ErrorCode.EmployeeNotFound);
      employeeId = employee.employeeId;
    }

    await this.inbox.assign(actor.enterpriseId, RefIdParamSchema.parse(refId), employeeId);
  }

  @Post(':refId/status')
  @RequirePermission(Permission.ConversationsManage)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Move a conversation through its workflow' })
  async setStatus(
    @CurrentScopedActor() actor: ScopedActor,
    @Param('refId') refId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = StatusRequestSchema.parse(body);
    await this.inbox.setStatus(
      actor.enterpriseId,
      RefIdParamSchema.parse(refId),
      parsed.status as ConversationStatus,
    );
  }

  @Post(':refId/resync')
  @RequirePermission(Permission.ConversationsManage)
  @ApiOperation({
    summary: 'Re-read this thread from the platform',
    description:
      'Repairs a gap left by a webhook that never arrived. Meta serves only the ' +
      '20 most recent messages of a thread, so this recovers a recent gap and ' +
      'cannot reach further back. Safe to call repeatedly: the projector dedups ' +
      'on the platform message id, and a resync already in flight is reported as ' +
      'queued: false rather than started twice.',
  })
  async resync(
    @CurrentScopedActor() actor: ScopedActor,
    @Param('refId') refId: string,
  ): Promise<{ queued: boolean }> {
    return this.inbox.requestResync(actor.enterpriseId, RefIdParamSchema.parse(refId));
  }

  @Post(':refId/read')
  @RequirePermission(Permission.ConversationsView)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Clear the unread badge',
    description: 'An explicit write, rather than a side effect of reading the thread.',
  })
  async markRead(
    @CurrentScopedActor() actor: ScopedActor,
    @Param('refId') refId: string,
    @Body() body: unknown,
  ): Promise<void> {
    // Parsed even though it takes nothing: this was the one mutation with no
    // schema, so any body was accepted and ignored — which is how a client comes
    // to send a field it believes is doing something.
    MarkReadRequestSchema.parse(body ?? {});
    await this.inbox.markRead(actor.enterpriseId, RefIdParamSchema.parse(refId));
  }
}

/** Entities are never returned directly; this is what keeps ids and internals in. */
/**
 * One message, with NO internal ids.
 *
 * The thread used to return the row as it came out of the database — `id`,
 * `customerId` and `sentByEmployeeId`, all internal bigints. That is the one
 * thing this API's own tests assert elsewhere that it never does, and it is
 * useless besides: a client cannot turn an employee id into a name. It gets the
 * name instead.
 */
/**
 * HOW THE CLIENT SHOULD PRESENT AN ATTACHMENT.
 *
 * The media kind says what the thing IS; this says what can be done with the
 * link we hold, which is a different question. A shared reel and a shared post
 * are both "somebody sent me an Instagram thing", but one gives a permalink
 * that can only be followed and the other gives a real image that can be shown.
 *
 * Decided here rather than in each client: a second client would otherwise have
 * to rediscover that `share` means a permalink and `ig_post` does not, and get
 * it subtly wrong.
 */
function renderAsFor(attachment: AttachmentRow): 'image' | 'video' | 'audio' | 'link' {
  // A share carries an instagram.com permalink, never media — whatever its
  // media kind happens to say.
  if (attachment.metadata.platformType === 'share') return 'link';
  if (!attachment.sourceUrl) return 'link';

  switch (attachment.mediaKind) {
    case MediaKind.Image:
    case MediaKind.Gif:
    case MediaKind.Sticker:
      return 'image';
    case MediaKind.Video:
      return 'video';
    case MediaKind.Audio:
      return 'audio';
    default:
      return 'link';
  }
}

function toMessage(
  row: MessageRow,
  attachments: readonly AttachmentRow[],
): Record<string, unknown> {
  return {
    refId: row.refId,
    direction: row.direction,
    body: row.body,
    messageKind: row.messageKind,
    status: row.status,
    isRead: row.isRead,
    isInternalNote: row.isInternalNote,
    /*
     * Whether the client may offer "reply to this one". A note and a send still
     * in the relay both exist here with no id the platform would recognise, and
     * offering a control that can only fail is worse than offering none.
     */
    canBeRepliedTo: row.canBeRepliedTo,
    /*
     * THE PLATFORM SENT NO TEXT, which is not the same as an empty message.
     * Instagram omits `text` when a comment is a GIF, a sticker or a photo, and
     * exposes no field for the media itself — so this absence is the only thing
     * that distinguishes "content we cannot show" from "somebody sent nothing".
     *
     * Observed doing real damage: a blank line with a reply underneath asking
     * about it reads as a non-sequitur.
     */
    platformSentNoText: row.metadata.platformSentNoText === true,
    /** Hidden by us on the platform. Ours to set; Instagram never tells us. */
    hiddenOnPlatform: row.isHiddenOnPlatform === true,
    /*
     * The customer unsent it on Instagram. The body is still here on purpose —
     * the business is accountable for the conversation, and a record that
     * rewrites itself when somebody deletes a message is not a record. The
     * client shows it with a marker rather than hiding it.
     */
    deletedOnPlatform: row.platformDeletedAt !== null,
    deletedOnPlatformAt: row.platformDeletedAt,
    /** The customer's emoji on this message, when they put one there. */
    reaction:
      typeof row.metadata.reaction === 'object' && row.metadata.reaction !== null
        ? row.metadata.reaction
        : null,
    /** When the customer read it. Outbound only; null until they do. */
    seenAt: typeof row.metadata.seenAt === 'string' ? row.metadata.seenAt : null,
    /*
     * The customer sent something the platform will not describe. Recovered
     * after a dropped delivery, and Meta exposes a shared post or story only on
     * the live webhook — so this message has an id and a time and no content,
     * permanently. The client says so instead of showing an empty bubble.
     */
    contentUnavailable: row.metadata.contentUnavailable === true,
    platformSentAt: row.platformSentAt,
    createdAt: row.createdAt,
    /*
     * `url` is the PLATFORM's CDN link, passed through rather than proxied.
     * Meta's terms forbid storing or caching the media itself, so there is
     * nothing of ours to serve; the link dies with the story, about 24 hours,
     * which is why `expires` tells the client to expect that rather than treat
     * a broken image as a bug.
     */
    attachments: attachments.map((attachment) => ({
      mediaKind: attachment.mediaKind,
      url: attachment.sourceUrl,
      /*
       * Whether this link will stop working.
       *
       * `storageKey === null` alone was WRONG, and visibly so: a GIF comes from
       * Giphy, is public and permanent, and was still being reported as
       * expiring — so the UI stood ready to tell somebody their GIF was "no
       * longer available on the platform" when nothing of the sort had
       * happened. What expires is a Meta CDN link, which is exactly what
       * stableUrl records.
       */
      expires: attachment.storageKey === null && attachment.metadata.stableUrl !== true,
      platformType: attachment.metadata.platformType ?? null,
      /*
       * A shared post's caption. Without it the thread shows a picture with no
       * hint of what was sent or why, which for a shared advert is most of the
       * message.
       */
      title: attachment.metadata.title ?? null,
      /** Show it, play it, or link to it — see renderAsFor. */
      renderAs: renderAsFor(attachment),
    })),
    // Null for anything the customer sent, and for a message projected from a
    // webhook rather than typed by somebody here.
    sentBy: row.sentByRefId ? { refId: row.sentByRefId, name: row.sentByName } : null,
    /*
     * WHO WROTE IT, when a customer did. A comment thread carries several
     * different people, and without this the client drew every one of them as
     * an unnamed "inbound" — so an agent could not tell who said what, or that
     * a reply came from somebody else entirely.
     *
     * Null on our own messages: `sentBy` above names the colleague instead.
     */
    author: row.authorName ?? null,
    /*
     * WHAT THIS ANSWERS, and what kind of reply it is.
     *
     * Present whenever the message IS a reply, even when we do not hold the
     * message it answers — a reply to a delivery Meta dropped. `refId` is null
     * in that case, which is the honest way to say "this answered something we
     * cannot show you" rather than presenting it as an ordinary line.
     *
     * The client needs THREE states, not two: an ordinary message, an answer to
     * something we sent, and an answer to something the customer said earlier.
     * `isSelfReply` is the platform's own word for the third; `direction` says
     * the same thing from our side, and falls back to it when the platform did
     * not send the flag — which is every message recovered before the resync
     * started asking for reply_to.
     */
    /*
     * THE STORY THIS ANSWERS — deliberately not folded into `replyTo`.
     *
     * `replyTo` answers a MESSAGE and quotes it. A story reply answers a STORY,
     * which no message id names and no excerpt can quote: the customer tapped
     * a story and typed. Sharing one field would have forced the client to
     * render a quote for something that has no text, so the two stay apart and
     * a client can say "replying to your story" and show the story itself.
     *
     * The projector has been keeping these facts all along; nothing exposed
     * them, so an agent saw a bare line of text with no idea what prompted it —
     * which for a story reply is most of the meaning.
     *
     * `url` is Meta's CDN link, passed through rather than proxied, and it dies
     * with the story it points at — about 24 hours. `expires` says so from the
     * host rather than assuming it, exactly as attachments do.
     */
    repliedToStory:
      typeof row.metadata.replyToStoryId === 'string' ||
      typeof row.metadata.replyToStoryUrl === 'string'
        ? {
            storyId:
              typeof row.metadata.replyToStoryId === 'string'
                ? row.metadata.replyToStoryId
                : null,
            url:
              typeof row.metadata.replyToStoryUrl === 'string'
                ? row.metadata.replyToStoryUrl
                : null,
            expires: isExpiringMediaUrl(
              typeof row.metadata.replyToStoryUrl === 'string'
                ? row.metadata.replyToStoryUrl
                : null,
            ),
          }
        : null,
    replyTo:
      row.parentRefId !== null || typeof row.metadata.replyToPlatformMessageId === 'string'
        ? {
            refId: row.parentRefId,
            excerpt: row.parentExcerpt,
            direction: row.parentDirection,
            /*
             * THE SAME PERSON, not merely the same direction.
             *
             * This was derived from `parentDirection === inbound`, which is
             * right for a DM — one customer, so inbound means them — and WRONG
             * for a comment thread, where several different people comment
             * under one post. It reported "replying to their own message"
             * every time one customer answered another, which was observed
             * live: testrestaurant_sd answering genzrelics.
             *
             * Instagram's own flag wins where it exists; otherwise the authors
             * are compared, which is the actual question. Null when there is no
             * parent to compare against — an answer to a delivery Meta dropped.
             */
            isSelfReply:
              typeof row.metadata.replyIsSelfReply === 'boolean'
                ? row.metadata.replyIsSelfReply
                : row.parentCustomerId === null || row.customerId === null
                  ? null
                  : row.parentCustomerId === row.customerId,
          }
        : null,
  };
}

/**
 * The tagged post, and the thread under our mention.
 *
 * Shaped here rather than passed through raw, because the stored metadata is
 * whatever the Mentions API happened to give us on the day — and a client
 * should not have to know which fields Meta silently omits
 * (docs/platform-limitations.md §1.3-1.4).
 */
/**
 * The two ways Instagram links to one comment. BOTH CONFIRMED against links the
 * Instagram mobile app produced for real comments on this reel:
 *
 *   deep   .../reel/<code>/c/<comment id>/
 *   share  .../reel/<code>?comment_id=<id>&open_comments=true
 *
 * The Graph API offers no comment-permalink field, so these are composed — but
 * they are not guesses: the app's own share sheet gave the second form
 * verbatim, and the first was checked in a browser and opens the comment more
 * reliably, which is why it is the one an agent is offered first.
 *
 * The permalink already carries the right prefix — `/p/` for a post, `/reel/`
 * for a reel — so it is extended rather than rebuilt, which keeps both correct
 * for either kind without a branch. The trailing slash is stripped first
 * because the share form appends a QUERY, and `/?comment_id=` is not the shape
 * the app produces.
 */
function commentLinks(
  permalink: string | null,
  commentId: string | null,
): { deepUrl: string | null; shareUrl: string | null } {
  if (!permalink || !commentId) return { deepUrl: null, shareUrl: null };

  const base = permalink.replace(/\/+$/u, '');
  return {
    deepUrl: `${base}/c/${commentId}/`,
    shareUrl: `${base}?comment_id=${commentId}&open_comments=true`,
  };
}

type KnownAuthors = ReadonlyMap<string, { authorName: string | null; direction: MessageDirection }>;

const NO_KNOWN_AUTHORS: KnownAuthors = new Map();

type ParentMention = { refId: string; subject: string | null } | null;

function toMentionContext(
  metadata: Record<string, unknown>,
  known: KnownAuthors = NO_KNOWN_AUTHORS,
  parentMention: ParentMention = null,
): Record<string, unknown> | null {
  const mediaId = typeof metadata.mentionedMediaId === 'string' ? metadata.mentionedMediaId : null;
  const thisMentionCommentId =
    typeof metadata.mentionedCommentId === 'string' ? metadata.mentionedCommentId : null;
  const permalink = typeof metadata.postPermalink === 'string' ? metadata.postPermalink : null;
  if (!mediaId && !permalink) return null;

  const details = (
    typeof metadata.postDetails === 'object' && metadata.postDetails !== null
      ? metadata.postDetails
      : {}
  ) as Record<string, unknown>;
  const links = commentLinks(permalink, thisMentionCommentId);
  const asNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  const asText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

  return {
    mediaId,
    permalink,
    /*
     * TWO LINKS TO THE MENTION ITSELF, so an agent lands on the comment rather
     * than the top of a post with two thousand of them.
     *
     * `commentUrl` is the deep link and the one to prefer — it opens the
     * comment most reliably in a browser. `commentShareUrl` is the exact form
     * Instagram's own mobile share sheet produces, kept because it is what
     * somebody pasting a link from the app will recognise.
     *
     * Both null unless we hold post AND comment, rather than half a URL.
     */
    commentUrl: links.deepUrl,
    commentShareUrl: links.shareUrl,
    ownerUsername: asText(metadata.postOwnerUsername) ?? asText(details.ownerUsername),
    caption: asText(details.caption),
    mediaType: asText(details.mediaType),
    /*
     * ONE FIELD FOR "SHOW THIS", because the platform uses two and a client
     * should not have to learn which.
     *
     * THE THUMBNAIL WINS, and the order is the whole point. `media_url` is not
     * always an image: on a reel it can be the .mp4 itself, and preferring it
     * put a video file into an <img> tag — which fails, and then reports "the
     * image is no longer available" about a post that is perfectly fine.
     *
     * A thumbnail is always a still. When there is none, the post is a photo
     * and media_url IS the image. So thumbnail-then-media is displayable in
     * both cases, where media-then-thumbnail is displayable in only one.
     *
     * The raw fields stay exposed below for a client that wants to play the
     * video rather than preview it.
     */
    previewUrl: asText(details.thumbnailUrl) ?? asText(details.mediaUrl),
    mediaUrl: asText(details.mediaUrl),
    thumbnailUrl: asText(details.thumbnailUrl),
    /** `FEED`, `REELS`, `STORY` — lets a client say "Reel" rather than "post". */
    productType: asText(details.productType),
    postedAt: asText(details.timestamp),
    likeCount: asNumber(details.likeCount),
    commentCount: asNumber(details.commentsCount),
    /*
     * Likes on THE MENTION ITSELF, deliberately named apart from `likeCount`
     * above — one is a post with a million likes, the other a comment with two,
     * and a client that mixed them up would be wrong by six orders of
     * magnitude. Null means Meta did not tell us, which is not the same as
     * nobody having liked it.
     */
    mentionLikeCount: asNumber(metadata.mentionLikeCount),
    /*
     * ALWAYS null, and said explicitly rather than omitted. Instagram gives no
     * share or save count for a post we do not own — there is no field for it —
     * so a client that leaves a blank space is showing the truth.
     */
    shareCount: null,
    /*
     * The replies under our mention, as they looked when we read them. Meta
     * sends no webhook for a reply to a mention, so this is a SNAPSHOT and not
     * a live thread — and every entry is anonymous, because the platform omits
     * the author on all of them.
     */
    replies: Array.isArray(metadata.replyThread)
      ? (metadata.replyThread as Record<string, unknown>[]).map((reply) =>
          toThreadReply(reply, known, thisMentionCommentId),
        )
      : [],
    /*
     * WHAT THE MENTION WAS ANSWERING, when the tag was inside a reply.
     *
     * "tell this guy" is not a message an agent can act on; the comment above
     * it is most of the meaning. Null when the mention is top-level, and also
     * when the parent did not mention us — Meta refuses to describe any other
     * comment, so that is a boundary rather than something we failed to fetch.
     *
     * Unlike the replies, the parent DOES carry an author: it mentioned us, and
     * a comment that mentions us is the one comment Meta will name.
     */
    /*
     * THE ROOM, not the conversation. Every entry is anonymous — Instagram omits
     * the author on all of them — and unanswerable, since a comment on someone
     * else's post can only be replied to if it tagged us. Kept behind its own
     * key so a client can put it behind a disclosure rather than mixing it into
     * the thread that actually concerns us.
     */
    postComments: Array.isArray(metadata.postComments)
      ? (metadata.postComments as Record<string, unknown>[]).map((comment) =>
          toThreadReply(comment, known, thisMentionCommentId),
        )
      : [],
    /** When that snapshot was taken. There is no webhook to keep it current. */
    postCommentsReadAt: asText(metadata.postCommentsReadAt),
    parentComment: toParentComment(
      metadata.mentionParent,
      metadata.mentionParentId,
      known,
      thisMentionCommentId,
    ),
    /*
     * THE PARENT AS A CONVERSATION, not just as quoted text.
     *
     * When the comment this mention answered also tagged us, it is a mention of
     * ours in its own right — the same exchange filed twice. Giving the client
     * the ref lets it link the two instead of showing the parent's words with
     * no way to reach the thread they belong to.
     *
     * Null whenever the parent is somebody else's comment, which is the common
     * case and is not a failure.
     */
    parentMention: parentMention
      ? { refId: parentMention.refId, subject: parentMention.subject }
      : null,
  };
}

/**
 * One comment in a mention's surrounding thread.
 *
 * Meta omits the author on every one of these (§1.4) — but that is only Meta's
 * silence, not ours. Several of the comments in a thread are OUR OWN: replies
 * this business sent, and earlier mentions already stored here with a name
 * against them. `known` puts those names back, and the rest stay honestly
 * anonymous.
 */
function toThreadReply(
  reply: Record<string, unknown>,
  known: KnownAuthors,
  thisMentionCommentId: string | null,
): Record<string, unknown> {
  const platformId = typeof reply.platformId === 'string' ? reply.platformId : null;
  const match = platformId ? known.get(platformId) : undefined;

  return {
    text: typeof reply.text === 'string' ? reply.text : null,
    postedAt: typeof reply.timestamp === 'string' ? reply.timestamp : null,
    likeCount: typeof reply.likeCount === 'number' ? reply.likeCount : null,
    /*
     * Null only when we genuinely do not know. Our own sends are marked as ours
     * rather than named, because "you" is what an agent needs to see.
     */
    authorUsername: match?.authorName ?? null,
    isOurs: match?.direction === MessageDirection.Outbound,
    /*
     * THE MENTION ITSELF APPEARS IN ITS OWN THREAD, because it is a sibling
     * reply like any other. Rendering it twice — once anonymously here, once as
     * the message below — read as two different people saying the same thing.
     */
    isThisMention: platformId !== null && platformId === thisMentionCommentId,
  };
}

/**
 * THREE STATES, not two — and the third is the one that was being lost.
 *
 * A mention is either top-level (no parent at all), a reply to a comment we can
 * read, or a reply to a comment Meta will not show us. The last happens
 * whenever somebody tags us under a STRANGER's comment: the mentions edge
 * refuses it with `(#10) User is not mentioned in the comment`, and the post's
 * own comment list does not contain it either.
 *
 * Returning null for that case made a fragment read as a whole thought — "soo
 * funny man 😂" presented as if it opened the conversation. So an unreadable
 * parent is reported AS unreadable, and the client says so.
 */
function toParentComment(
  value: unknown,
  parentCommentId: unknown,
  known: KnownAuthors,
  thisMentionCommentId: string | null,
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return typeof parentCommentId === 'string'
      ? { available: false, text: null, authorUsername: null, postedAt: null, replies: [] }
      : null;
  }
  const parent = value as Record<string, unknown>;

  return {
    available: true,
    text: typeof parent.text === 'string' ? parent.text : null,
    authorUsername: typeof parent.authorUsername === 'string' ? parent.authorUsername : null,
    postedAt: typeof parent.timestamp === 'string' ? parent.timestamp : null,
    likeCount: typeof parent.likeCount === 'number' ? parent.likeCount : null,
    /*
     * The rest of the thread — the sibling replies our mention sits among.
     * Anonymous, exactly like the replies under the mention itself.
     */
    replies: Array.isArray(parent.replies)
      ? (parent.replies as Record<string, unknown>[]).map((reply) =>
          toThreadReply(reply, known, thisMentionCommentId),
        )
      : [],
  };
}

function toConversationSummary(row: {
  refId: string;
  conversationKind: string;
  subject: string | null;
  postId: number | null;
  status: string;
  unreadCount: number;
  messageCount: number;
  lastMessageAt: Date | null;
  lastInboundAt: Date | null;
  platform: string;
  customerRefId: string | null;
  customerDisplayName: string | null;
  customerAvatarUrl: string | null;
  customerProfile: Record<string, unknown>;
  contextMetadata?: Record<string, unknown>;
  assignedToRefId: string | null;
  assignedToName: string | null;
  },
  known: KnownAuthors = NO_KNOWN_AUTHORS,
  parentMention: ParentMention = null,
): Record<string, unknown> {
  /*
   * Told to the client, not just enforced on it. A reply box that accepts text
   * and then answers 409 is worse than one that explains up front why it is
   * disabled — and the client cannot work this out alone, because the rule
   * depends on when the CUSTOMER last wrote, not on the last message.
   */
  const window = evaluateReplyWindow({
    conversationKind: row.conversationKind as ConversationKind,
    lastInboundAt: row.lastInboundAt,
    // Included so a resolved thread reads as "reopen it to reply" rather than
    // offering a reply box that answers 409.
    status: row.status as ConversationStatus,
  });

  return {
    refId: row.refId,
    conversationKind: row.conversationKind,
    platform: row.platform,
    status: row.status,
    canReply: window.canReply,
    /*
     * WHETHER HIDE AND DELETE ARE EVEN POSSIBLE HERE, decided once on the
     * server rather than re-derived by each client.
     *
     * Instagram allows moderation only to the owner of the media a comment sits
     * on — explicitly even when the caller wrote the comment — so a mention on
     * somebody else's post can never be moderated. `postId` is the proof: the
     * projector fills it only when the comment's media is one of our own posts.
     *
     * A client that guessed this from the conversation kind alone would offer
     * controls that can only fail, which is worse than offering none.
     */
    canModerateComments:
      // Cast for the same reason the reply-window call above does: the row type
      // carries the kind as a string, while the value is the enum.
      (row.conversationKind as ConversationKind) === ConversationKind.CommentThread &&
      row.postId !== null,
    replyBlockedReason: window.reason,
    /*
     * THE POST A MENTION IS ON, which is the whole context for the thread.
     *
     * Somebody tagged this business in a comment under a stranger's post; an
     * agent's first question is what post, whose, and how big — and none of it
     * is derivable from the comment. Null for every other kind.
     *
     * Counts are null rather than 0 when the platform refused them, so a client
     * can say nothing instead of claiming a post has no likes.
     */
    /*
     * WHAT THE THREAD IS ABOUT, in the customer's words. For a mention this is
     * the comment they tagged us in, which is the one thing a list of mentions
     * has to show — without it every row reads only as a name and a date.
     */
    subject: row.subject,
    mentionContext: toMentionContext(row.contextMetadata ?? {}, known, parentMention),
    /*
     * Nested rather than flattened, so a client can tell "we have no name for
     * this person" from "there is no person" — a comment thread always has an
     * author, an unnamed customer is simply one we have not learned a name for
     * yet.
     */
    customer: row.customerRefId
      ? {
          refId: row.customerRefId,
          displayName: row.customerDisplayName,
          avatarUrl: row.customerAvatarUrl,
          /*
           * Only the three facts an agent acts on, not the whole metadata bag:
           * a customer's stored metadata is ours to grow, and shipping it
           * wholesale would make every future key part of the public contract.
           */
          followsUs: row.customerProfile.followsUs ?? null,
          isVerified: row.customerProfile.isVerified ?? null,
          followerCount: row.customerProfile.followerCount ?? null,
        }
      : null,
    /*
     * Nested like the customer, and for the same reason: null means nobody has
     * picked this up, which a client has to be able to tell from "assigned to
     * somebody we have no name for".
     */
    assignedTo: row.assignedToRefId
      ? { refId: row.assignedToRefId, name: row.assignedToName || null }
      : null,
    unreadCount: row.unreadCount,
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt,
  };
}
