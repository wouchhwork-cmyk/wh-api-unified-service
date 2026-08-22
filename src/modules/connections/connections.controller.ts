import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { ProviderConnectionRepository } from '@/database/repositories/provider-connection.repository';
import { CurrentScopedActor, Public, RequirePermission } from '@/shared/decorators';
import { Permission } from '@/shared/enums';
import { AppException } from '@/shared/errors';
import type { ActorContext } from '@/shared/context';
import { MetaConnectionService } from './meta-connection.service';

type ScopedActor = ActorContext & { enterpriseId: number };

@ApiTags('connections')
@Controller({ path: 'connections', version: '1' })
export class ConnectionsController {
  constructor(
    private readonly meta: MetaConnectionService,
    private readonly connections: ProviderConnectionRepository,
    private readonly channels: ChannelRepository,
    private readonly config: AppConfigService,
    @InjectPinoLogger(ConnectionsController.name) private readonly logger: PinoLogger,
  ) {}

  @Get('meta/connect')
  @RequirePermission(Permission.ChannelsConnect)
  @ApiOperation({
    summary: 'Begin connecting a Meta account',
    description:
      'Returns the Facebook Login for Business dialog URL. The state parameter is a signed, ' +
      'single-use token bound to this enterprise and employee, and expires in ten minutes.',
  })
  startMetaConnect(@CurrentScopedActor() actor: ScopedActor): { authorizationUrl: string } {
    return {
      authorizationUrl: this.meta.buildAuthorizationUrl(actor.enterpriseId, actor.employeeId),
    };
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
  @ApiExcludeEndpoint()
  async metaCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const target = new URL(this.config.meta.frontendDashboardUrl);

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

  @Get()
  @RequirePermission(Permission.ChannelsView)
  @ApiOperation({ summary: 'The provider connections this business holds' })
  async list(@CurrentScopedActor() actor: ScopedActor): Promise<unknown> {
    return this.connections.listForEnterprise(actor.enterpriseId);
  }

  @Get('channels')
  @RequirePermission(Permission.ChannelsView)
  @ApiOperation({
    summary: 'The channels under those connections',
    description:
      'Facebook Pages and the Instagram profiles linked to them. An Instagram channel names its ' +
      'parent Page, because the Page token is what authorises Instagram calls.',
  })
  async listChannels(@CurrentScopedActor() actor: ScopedActor): Promise<unknown> {
    const channels = await this.channels.listForEnterprise(actor.enterpriseId);
    // Mapped, never returned raw: the row carries internal numeric ids, and the
    // numeric id is never sent to a client. parentChannelId becomes the parent's
    // refId so the Page/Instagram relationship is still expressible.
    const refById = new Map(channels.map((channel) => [channel.id, channel.refId]));
    return channels.map((channel) => ({
      refId: channel.refId,
      platform: channel.platform,
      channelKind: channel.channelKind,
      name: channel.name,
      username: channel.username,
      status: channel.status,
      reauthRequired: channel.reauthRequired,
      isManaged: channel.isManaged,
      parentChannelRefId:
        channel.parentChannelId === null ? null : (refById.get(channel.parentChannelId) ?? null),
    }));
  }
}
