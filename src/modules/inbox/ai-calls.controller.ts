import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScopedActor, RequireAnyPermission } from '@/shared/decorators';
import { anyPermissionFor } from '@/shared/rbac';
import type { ScopedActorContext } from '@/shared/context';
import { RefIdParamSchema } from '@/shared/contracts/params.contract';
import { WireCaptureService, type CapturedCall } from '@/modules/ai/wire-capture.service';
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
  constructor(
    private readonly replay: PromptReplayService,
    private readonly wire: WireCaptureService,
  ) {}

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

  /**
   * The exchange itself, when this environment was told to keep it.
   *
   * DIFFERENT FROM `/prompt` IN THE ONE WAY THAT MATTERS. That endpoint
   * rebuilds what we would send today and tells you whether it still
   * matches; this one is what actually went out and what actually came
   * back, including the model's own unparsed answer. Neither replaces the
   * other — a reconstruction survives a capture being off, and a capture
   * survives the code changing underneath it.
   *
   * EMPTY WHEN CAPTURE IS OFF, which is every ordinary environment. A 404
   * would say "no such call", which is a different and wrong statement.
   */
  @Get(':callRefId/wire')
  @RequireAnyPermission(...anyPermissionFor('view'))
  @ApiOperation({
    summary: 'The exact bodies of one model call',
    description:
      'What was sent to the provider and what it returned, verbatim, for environments with ' +
      'AI_WIRE_CAPTURE_ENABLED on. Off everywhere else, and refused outright in production: ' +
      'these are whole customer conversations. Returns captured: false rather than a 404 when ' +
      'capture is off, so a reader can tell "not kept" from "no such call".',
  })
  async wireFor(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Param('callRefId') callRefId: string,
  ): Promise<{ captured: boolean; call: CapturedCall | null }> {
    const call = await this.wire.read(actor.enterpriseId, RefIdParamSchema.parse(callRefId));
    return { captured: this.wire.enabled, call };
  }

  /**
   * Every exchange behind one reply, in the order they happened.
   *
   * THE ONE A PERSON ACTUALLY WANTS. A reply that used tools is several
   * calls, and the message row keeps only the last one's ref — so asking
   * by message is the only way to see the whole flow rather than its final
   * step.
   */
  @Get(':callRefId/exchange')
  @RequireAnyPermission(...anyPermissionFor('view'))
  @ApiOperation({
    summary: 'Every model exchange behind one reply',
    description:
      'The full round trip that produced one reply: the opening ask, each tool round, and the ' +
      'answer — request and response bodies verbatim for each. Given the ref of any call in the ' +
      'chain, returns them all, because a reply that used a tool is several calls and a message ' +
      'records only the last. Same switch and same caveats as the per-call endpoint.',
  })
  async exchange(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Param('callRefId') callRefId: string,
  ): Promise<{ captured: boolean; rounds: CapturedCall[] }> {
    const rounds = await this.replay.wireForCall(
      actor.enterpriseId,
      RefIdParamSchema.parse(callRefId),
    );
    return { captured: this.replay.wireCaptured, rounds };
  }
}
