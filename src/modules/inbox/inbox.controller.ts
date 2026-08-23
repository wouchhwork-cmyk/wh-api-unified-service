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
import { RawResponse } from '@/shared/decorators/raw-response.decorator';
import { SkipTimeout } from '@/shared/decorators/skip-timeout.decorator';
import { DEFAULT_PAGE_SIZE, SSE_HEARTBEAT_MS, SSE_MAX_STREAM_MS } from '@/shared/constants';
import { InboxEventsService } from './inbox-events.service';
import { ConversationKind, ConversationStatus, Permission } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import { paginated, type Paginated } from '@/shared/contracts/envelope';
import { evaluateReplyWindow } from './reply-window';
import type { ActorContext } from '@/shared/context';
import {
  AssignRequestSchema,
  InboxQuerySchema,
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
    const result = await this.inbox.listInbox(actor.enterpriseId, {
      status: parsed.status ?? null,
      assignedToEmployeeId: parsed.assignedToMe === 'true' ? actor.employeeId : null,
      limit: parsed.limit ?? 50,
      cursor: parsed.cursor ?? null,
    });

    return paginated(result.items.map(toConversationSummary), {
      limit: parsed.limit ?? 50,
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
    const result = await this.inbox.readThread(
      actor.enterpriseId,
      refId,
      parsed.limit ?? DEFAULT_PAGE_SIZE,
      parsed.cursor ?? null,
      parsed.beforeId ?? null,
    );
    return {
      conversation: toConversationSummary(result.conversation),
      messages: result.messages,
      // The thread had no pagination surface at all: a conversation with more
      // than one page of history simply ended, with nothing to say so.
      pagination: { nextCursor: result.nextCursor, hasMore: result.hasMore },
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
      conversationRefId: refId,
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

    await this.inbox.assign(actor.enterpriseId, refId, employeeId);
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
    await this.inbox.setStatus(actor.enterpriseId, refId, parsed.status as ConversationStatus);
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
  ): Promise<void> {
    await this.inbox.markRead(actor.enterpriseId, refId);
  }
}

/** Entities are never returned directly; this is what keeps ids and internals in. */
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
