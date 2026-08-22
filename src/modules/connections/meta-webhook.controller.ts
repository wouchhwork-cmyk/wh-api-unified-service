import { Controller, Get, Header, Headers, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public, RawResponse } from '@/shared/decorators';
import { MetaWebhookService } from './meta-webhook.service';

/**
 * The one deliberately public write surface.
 *
 * Platform webhooks cannot carry our JWT, so these routes are @Public and the
 * HMAC signature is the authentication. Excluded from Swagger: the audience is
 * Meta, not our clients.
 */
@ApiExcludeController()
@Controller('webhooks/meta')
export class MetaWebhookController {
  constructor(private readonly webhooks: MetaWebhookService) {}

  /**
   * The subscription handshake. Meta requires the bare challenge string as
   * text/plain — an enveloped JSON response fails verification, which is why
   * this is the only route that opts out of the envelope.
   */
  @Get()
  @Public()
  @RawResponse()
  @Header('content-type', 'text/plain; charset=utf-8')
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
  ): string {
    return this.webhooks.verifySubscription(mode, token, challenge);
  }

  /**
   * Event delivery.
   *
   * Always answers 200 fast: the work is recorded in the ledger and projected by
   * a worker. Anything slower invites Meta's retry, and any non-2xx guarantees
   * redelivery of something we already hold.
   */
  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature: string | undefined,
  ): Promise<{ received: true }> {
    // Verified against the RAW body, before anything trusts the parsed payload.
    this.webhooks.verifySignature(request.rawBody, signature);
    await this.webhooks.ingest(request.body);
    return { received: true };
  }
}
