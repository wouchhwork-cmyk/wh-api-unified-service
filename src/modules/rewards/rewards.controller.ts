import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScopedActor, RequirePermission } from '@/shared/decorators';
import type { ScopedActorContext } from '@/shared/context';
import {
  AdjustRewardBalanceSchema,
  CreateRewardProgramSchema,
  CreateRewardRuleSchema,
  RewardProgramQuerySchema,
  UpdateRewardProgramStatusSchema,
} from '@/shared/contracts/rewards/reward.contract';
import { RefIdParamSchema } from '@/shared/contracts/params.contract';
import { Permission } from '@/shared/enums';
import { RewardsService } from './rewards.service';

/**
 * Reward programs, for the business that owns them.
 *
 * The controller parses, calls the service, and maps the response. No business
 * logic lives here, and every route is authenticated and permission-gated —
 * three permissions, because reading a balance, rewriting a rule and moving one
 * customer's money are three different powers.
 */
@ApiTags('rewards')
@Controller({ path: 'rewards', version: '1' })
export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  /* ---------------------------------------------------------------- */
  /* Programs                                                          */
  /* ---------------------------------------------------------------- */

  @Get('programs')
  @RequirePermission(Permission.RewardsView)
  @ApiOperation({
    summary: 'Reward programs for this business',
    description:
      'Archived programs are EXCLUDED unless asked for by status. They are kept for the record ' +
      'and never deleted, but a retired program in the working list is how somebody edits the ' +
      'wrong one.',
  })
  async listPrograms(@CurrentScopedActor() actor: ScopedActorContext, @Query() query: unknown) {
    const { status } = RewardProgramQuerySchema.parse(query ?? {});
    const programs = await this.rewards.listPrograms(actor.enterpriseId, undefined, status ?? null);
    return { items: programs.map(toProgramSummary) };
  }

  @Get('dashboard')
  @RequirePermission(Permission.RewardsView)
  @ApiOperation({
    summary: 'What every program has actually done',
    description:
      'Awards granted, held and reversed, customers rewarded, and net value per wallet. Value ' +
      'is NET of reversals and is never summed across currencies. Refusals are included: a ' +
      'program granting 12 and refusing 400 is working as configured, and that is worth seeing.',
  })
  async dashboard(@CurrentScopedActor() actor: ScopedActorContext) {
    const items = await this.rewards.programDashboard(actor.enterpriseId);
    return { items };
  }

  @Post('programs')
  @RequirePermission(Permission.RewardsManage)
  @ApiOperation({
    summary: 'Create a reward program',
    description:
      'A program starts as a draft. Its timezone resolves every cap period and every time ' +
      'window, so it cannot be changed casually later.',
  })
  async createProgram(@CurrentScopedActor() actor: ScopedActorContext, @Body() body: unknown) {
    const input = CreateRewardProgramSchema.parse(body);
    const program = await this.rewards.createProgram(actor.enterpriseId, input);
    return toProgramSummary(program);
  }

  @Patch('programs/:refId/status')
  @RequirePermission(Permission.RewardsManage)
  @ApiOperation({
    summary: 'Switch a program on, pause it, or archive it',
    description:
      'Status is the SWITCH, not the schedule. A program scheduled for next month is active ' +
      'with a future start date; there is no "scheduled" status because the date says it. ' +
      'ARCHIVING IS ONE-WAY: the program is kept and readable for ever, its rules stop ' +
      'matching, and it can never be switched back on. 409 if it already is.',
  })
  async setProgramStatus(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Param('refId') refIdParam: string,
    @Body() body: unknown,
  ) {
    const refId = RefIdParamSchema.parse(refIdParam);
    const { status } = UpdateRewardProgramStatusSchema.parse(body);
    const program = await this.rewards.setProgramStatus(actor.enterpriseId, refId, status);
    return program ? toProgramSummary(program) : null;
  }

  /* ---------------------------------------------------------------- */
  /* Rules                                                             */
  /* ---------------------------------------------------------------- */

  @Get('rules')
  @RequirePermission(Permission.RewardsView)
  @ApiOperation({ summary: 'Rules in a program' })
  async listRules(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Query('programRefId') programRefId: string,
  ) {
    const rules = await this.rewards.listRules(actor.enterpriseId, programRefId);
    return { items: rules.map(toRuleSummary) };
  }

  @Post('rules')
  @RequirePermission(Permission.RewardsManage)
  @ApiOperation({
    summary: 'Create a rule',
    description:
      'A rule is one trigger, a flat AND list of conditions, and one or more benefits applied ' +
      'all-or-nothing. An empty condition list means ALWAYS, never never.',
  })
  async createRule(@CurrentScopedActor() actor: ScopedActorContext, @Body() body: unknown) {
    const input = CreateRewardRuleSchema.parse(body);
    const rule = await this.rewards.createRule(actor.enterpriseId, input);
    return toRuleSummary(rule);
  }

  @Patch('rules/:refId/active')
  @RequirePermission(Permission.RewardsManage)
  @ApiOperation({ summary: 'Switch a rule on or off' })
  async setRuleActive(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Param('refId') refIdParam: string,
    @Body() body: { isActive?: unknown },
  ) {
    const refId = RefIdParamSchema.parse(refIdParam);
    const isActive = body?.isActive === true;
    const rule = await this.rewards.setRuleActive(actor.enterpriseId, refId, isActive);
    return rule ? toRuleSummary(rule) : null;
  }

  /* ---------------------------------------------------------------- */
  /* Balances                                                          */
  /* ---------------------------------------------------------------- */

  @Get('customers/:refId/balances')
  @RequirePermission(Permission.RewardsView)
  @ApiOperation({
    summary: 'What a customer holds',
    description:
      'SEVERAL NUMBERS, never one. Points and each currency are separate wallets and are never ' +
      'netted — a total across them would be meaningless.',
  })
  async balances(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Param('refId') refIdParam: string,
  ) {
    const refId = RefIdParamSchema.parse(refIdParam);
    return this.rewards.getCustomerBalances(actor.enterpriseId, refId);
  }

  @Get('customers/:refId/awards')
  @RequirePermission(Permission.RewardsView)
  @ApiOperation({
    summary: 'A customer’s award history',
    description:
      'Includes awards that granted nothing. "Why didn’t I get my points?" is answered by a ' +
      'row saying skipped_cap with its period key.',
  })
  async awards(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Param('refId') refIdParam: string,
  ) {
    const refId = RefIdParamSchema.parse(refIdParam);
    const items = await this.rewards.listAwards(actor.enterpriseId, refId);
    return { items };
  }

  @Post('adjustments')
  @RequirePermission(Permission.RewardsAdjust)
  @ApiOperation({
    summary: 'Manually credit or debit a balance',
    description:
      'Behind its own permission, not rewards.manage: rewriting a rule changes what everybody ' +
      'earns in future, while this moves value for one named customer now. The reason lands in ' +
      'both the audit log and the ledger entry.',
  })
  async adjust(@CurrentScopedActor() actor: ScopedActorContext, @Body() body: unknown) {
    const input = AdjustRewardBalanceSchema.parse(body);
    const entry = await this.rewards.adjustBalance(actor.enterpriseId, input);
    return {
      entryRefId: entry.refId,
      amount: entry.amount,
      balanceAfter: entry.balanceAfter,
      occurredAt: entry.occurredAtUtc,
    };
  }
}

/** The numeric id never leaves the server. Only refId does. */
function toProgramSummary(program: {
  refId: string;
  name: string;
  status: string;
  timezone: string;
  startsAt: Date | null;
  endsAt: Date | null;
}) {
  return {
    refId: program.refId,
    name: program.name,
    status: program.status,
    timezone: program.timezone,
    startsAt: program.startsAt,
    endsAt: program.endsAt,
  };
}

function toRuleSummary(rule: {
  refId: string;
  version: number;
  triggerKind: string;
  capScope: string;
  capCount: number;
  holdHours: number;
  reversalPolicy: string;
  priority: number;
  isActive: boolean;
}) {
  return {
    refId: rule.refId,
    version: rule.version,
    triggerKind: rule.triggerKind,
    capScope: rule.capScope,
    capCount: rule.capCount,
    holdHours: rule.holdHours,
    reversalPolicy: rule.reversalPolicy,
    priority: rule.priority,
    isActive: rule.isActive,
  };
}
