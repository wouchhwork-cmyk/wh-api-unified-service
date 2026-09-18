import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiBody, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { CurrentScopedActor, Public, RequirePermission, SkipTimeout } from '@/shared/decorators';
import { Permission } from '@/shared/enums';
import { AppException } from '@/shared/errors';
import type { ActorContext } from '@/shared/context';
import {
  StartConnectionRequestSchema,
  type StartConnectionRequest,
} from '@/shared/contracts/connections/connect.contract';
import {
  ConnectionsService,
  type ChannelDto,
  type ConnectionDto,
  type StartedConnection,
} from './connections.service';
import { MetaConnectionService } from './meta-connection.service';

type ScopedActor = ActorContext & { enterpriseId: number };

const START_EXAMPLES = {
  meta: {
    summary: 'Facebook and Instagram',
    value: { provider: 'meta' },
  },
  notYetBuilt: {
    summary: 'A platform we recognise but have not built — returns 501',
    value: { provider: 'google' },
  },
};

@ApiTags('connections')
@Controller({ path: 'connections', version: '1' })
export class ConnectionsController {
  constructor(
    private readonly meta: MetaConnectionService,
    private readonly connectionsService: ConnectionsService,
    private readonly config: AppConfigService,
    @InjectPinoLogger(ConnectionsController.name) private readonly logger: PinoLogger,
  ) {}

  @Get('providers')
  @RequirePermission(Permission.ChannelsView)
  @ApiOperation({
    summary: 'The platforms that can be connected',
    description:
      'So a client renders what is actually available rather than hardcoding a list that goes ' +
      'stale the moment a platform is added or withdrawn. Only implemented providers appear.',
  })
  providers(): { provider: string; label: string }[] {
    return this.connectionsService.available();
  }

  @Post('start')
  @RequirePermission(Permission.ChannelsConnect)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Begin connecting a platform',
    description:
      'One entry point for every platform: send the provider you want. Returns the URL to send ' +
      'the browser to. Today only `meta` is implemented — a provider we recognise but have not ' +
      'built returns 501, which is a different answer from one we do not recognise (422).\n\n' +
      'POST rather than GET because it WRITES: the CSRF state is recorded so the callback can ' +
      'spend it exactly once. A GET that mutates would let a link prefetch or a crawler burn ' +
      'states.',
  })
  @ApiBody({ schema: { type: 'object' }, examples: START_EXAMPLES })
  async start(
    @CurrentScopedActor() actor: ScopedActor,
    @Body() body: unknown,
  ): Promise<StartedConnection> {
    const parsed: StartConnectionRequest = StartConnectionRequestSchema.parse(body);
    return this.connectionsService.start(parsed.provider, actor.enterpriseId, actor.employeeId);
  }

  /**
   * The OAuth redirect target.
   *
   * @Public because the browser arrives here from Facebook with no token of
   * ours; the signed `state` is what authenticates the request. It redirects
   * rather than returning JSON, because a human is looking at this URL — and it
   * carries only refIds and counts, never a token.
   */
  @Get('meta/callback')
  @Public()
  /*
   * Facebook drives this, not a client of ours, so two global policies are wrong
   * for it.
   *
   * The rate limit would answer a burst with a 429 JSON envelope — to a BROWSER
   * mid-OAuth, which expects a redirect and would show raw JSON. The webhook
   * controller is exempt for the same reason.
   *
   * The 15-second request timeout is shorter than the work: four mandatory Graph
   * calls in series, then one subscribe per discovered Page, each with its own
   * 10-second budget. Being aborted halfway is the worst available outcome,
   * because the connection may be half written while the person is told it
   * failed. The Graph client's per-call timeouts are the real bound.
   */
  @SkipThrottle()
  @SkipTimeout()
  @ApiExcludeEndpoint()
  async metaCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    /*
     * Built defensively, because this line used to run OUTSIDE the try below:
     * `new URL('')` throws, so an unset FRONTEND_DASHBOARD_URL turned every
     * callback into a 500 on a public route. Without somewhere to send the
     * browser there is nothing useful to do, so say so plainly instead of
     * leaking a stack trace.
     */
    const target = this.redirectTarget();
    if (!target) {
      this.logger.error(
        'FRONTEND_DASHBOARD_URL is missing or not a URL — cannot complete the OAuth callback',
      );
      response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .send('This service is not configured to complete a connection.');
      return;
    }

    // The user cancelled at the consent screen: not an error of ours.
    if (error) {
      target.searchParams.set('status', 'cancelled');
      target.searchParams.set('reason', errorDescription ?? error);
      response.redirect(target.toString());
      return;
    }

    if (!code || !state) {
      target.searchParams.set('status', 'error');
      target.searchParams.set('reason', 'missing_code_or_state');
      response.redirect(target.toString());
      return;
    }

    try {
      const result = await this.meta.handleCallback(code, state);
      target.searchParams.set('status', 'success');
      target.searchParams.set('connectionRefId', result.connectionRefId);
      target.searchParams.set('pageCount', String(result.pageCount));
      target.searchParams.set('instagramCount', String(result.instagramCount));
      // Partial failures are reported, not hidden behind a green tick.
      if (result.errorCount > 0) target.searchParams.set('errorCount', String(result.errorCount));
    } catch (caught) {
      // The reason is a stable error CODE, never a provider message: this string
      // lands in the browser's address bar and its history.
      const code_ = caught instanceof AppException ? caught.code : 'INTERNAL_ERROR';
      this.logger.warn({ err: caught }, 'meta oauth callback failed');
      target.searchParams.set('status', 'error');
      target.searchParams.set('reason', code_);
    }

    response.redirect(target.toString());
  }

  /** null when the configured value is absent or not an absolute URL. */
  private redirectTarget(): URL | null {
    const configured = this.config.meta.frontendDashboardUrl;
    if (!configured) return null;
    try {
      return new URL(configured);
    } catch {
      return null;
    }
  }

  @Get()
  @RequirePermission(Permission.ChannelsView)
  @ApiOperation({ summary: 'The provider connections this business holds' })
  async list(@CurrentScopedActor() actor: ScopedActor): Promise<ConnectionDto[]> {
    return this.connectionsService.listConnections(actor.enterpriseId);
  }

  @Get('channels')
  @RequirePermission(Permission.ChannelsView)
  @ApiOperation({
    summary: 'The channels under those connections',
    description:
      'Facebook Pages and the Instagram profiles linked to them. An Instagram channel names its ' +
      'parent Page, because the Page token is what authorises Instagram calls.',
  })
  async listChannels(@CurrentScopedActor() actor: ScopedActor): Promise<ChannelDto[]> {
    return this.connectionsService.listChannels(actor.enterpriseId);
  }
}
