import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScopedActor, RequireAnyPermission } from '@/shared/decorators';
import { anyPermissionFor } from '@/shared/rbac';
import type { ScopedActorContext } from '@/shared/context';
import { RefIdParamSchema } from '@/shared/contracts/params.contract';
import { PromptReplayService, type ModelCallSummary } from './prompt-replay.service';

/**
 * What this business has asked a model, and what it asked with.
 *
 * SEPARATE FROM THE CONVERSATION CONTROLLER so that `ai-calls` can never be
 * mistaken for a conversation ref id. A static segment declared alongside
 * `:refId` routes resolves by declaration order, which is a footgun waiting
 * for somebody to reorder a file.
 *
 * BEHIND THE SAME PERMISSION AS READING A THREAD. A replayed prompt contains
 * the customer's own messages and the business profile — everything someone
 * could read by opening the conversation, and nothing more. Anybody who may
 * not open the thread may not read what was asked about it either.
 */
@ApiTags('inbox')
@Controller({ path: 'ai-calls', version: '1' })
export class AiCallsController {
  constructor(private readonly replay: PromptReplayService) {}

  @Get()
  @RequireAnyPermission(...anyPermissionFor('view'))
  @ApiOperation({
    summary: 'Recent model calls made for this business',
    description:
      'Every call that left this service for a model — replies the assistant sent by itself, ' +
      'drafts a colleague asked for, and media descriptions. Metadata only: what it cost, how ' +
      'long it took, and whether it failed. Never the prompt and never the answer.',
  })
  async list(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Query('limit') limit?: string,
  ): Promise<{ calls: ModelCallSummary[] }> {
    return { calls: await this.replay.recentCalls(actor.enterpriseId, Number(limit) || 25) };
  }

  @Get(':callRefId/prompt')
  @RequireAnyPermission(...anyPermissionFor('view'))
  @ApiOperation({
    summary: 'Rebuild the prompt a model was sent',
    description:
      'NOTHING IS STORED: the prompt is built again on demand from the code, the saved ' +
      'instruction, the rows it was assembled from and the ids of the messages it was shown. ' +
      'It is compared against a fingerprint taken at the time, so the answer says whether this ' +
      'is byte-for-byte what ran or a reconstruction that has drifted since.',
  })
  async prompt(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Param('callRefId') callRefId: string,
  ): Promise<unknown> {
    const replayed = await this.replay.replay(
      actor.enterpriseId,
      RefIdParamSchema.parse(callRefId),
    );
    /* The same answer for "no such call" and "another business's call": a
     * 404 that distinguishes them is a way to enumerate the other. */
    if (!replayed) throw new NotFoundException();
    return replayed;
  }
}
