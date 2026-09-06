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
import { ConversationKind, ConversationStatus, MessageDirection, Permission } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import { paginated, type Paginated } from '@/shared/contracts/envelope';
import { evaluateReplyWindow } from './reply-window';
import type { ActorContext } from '@/shared/context';
import {
  AssignRequestSchema,
  InboxQuerySchema,
  MarkReadRequestSchema,
  ReplyRequestSchema,
  StatusRequestSchema,
  ThreadQuerySchema,
  type ReplyResponse,
} from '@/shared/contracts/inbox/inbox.contract';
import { InboxService } from './inbox.service';

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
      limit: size,
      cursor: parsed.cursor ?? null,
    });

    return paginated(result.items.map(toConversationSummary), {
      limit: size,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
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
      conversation: toConversationSummary(result.conversation),
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
    })),
    // Null for anything the customer sent, and for a message projected from a
    // webhook rather than typed by somebody here.
    sentBy: row.sentByRefId ? { refId: row.sentByRefId, name: row.sentByName } : null,
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
    replyTo:
      row.parentRefId !== null || typeof row.metadata.replyToPlatformMessageId === 'string'
        ? {
            refId: row.parentRefId,
            excerpt: row.parentExcerpt,
            direction: row.parentDirection,
            isSelfReply:
              typeof row.metadata.replyIsSelfReply === 'boolean'
                ? row.metadata.replyIsSelfReply
                : row.parentDirection === null
                  ? null
                  : row.parentDirection === MessageDirection.Inbound,
          }
        : null,
  };
}

function toConversationSummary(row: {
  refId: string;
  conversationKind: string;
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
  assignedToRefId: string | null;
  assignedToName: string | null;
}): Record<string, unknown> {
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
    replyBlockedReason: window.reason,
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
