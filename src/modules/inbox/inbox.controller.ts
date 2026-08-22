import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EnterpriseEmployeeRepository } from '@/database/repositories/enterprise-employee.repository';
import { CurrentScopedActor, RequirePermission } from '@/shared/decorators';
import { ConversationStatus, Permission } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import { paginated, type Paginated } from '@/shared/contracts/envelope';
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
      parsed.limit ?? 50,
      parsed.beforeId ?? null,
    );
    return {
      conversation: toConversationSummary(result.conversation),
      messages: result.messages,
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
      idempotencyKey: parsed.idempotencyKey ?? null,
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
  platform: string;
}): Record<string, unknown> {
  return {
    refId: row.refId,
    conversationKind: row.conversationKind,
    platform: row.platform,
    status: row.status,
    unreadCount: row.unreadCount,
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt,
  };
}
