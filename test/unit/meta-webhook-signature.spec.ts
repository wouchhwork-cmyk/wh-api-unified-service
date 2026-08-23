import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '@/config';
import { MetaWebhookService } from '@/modules/connections/meta-webhook.service';
import type { ChannelRepository } from '@/database/repositories/channel.repository';
import type { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { ErrorCode } from '@/shared/errors';

/**
 * HMAC verification on POST /webhooks/meta.
 *
 * This is the ONLY authentication on a public write endpoint — the route is
 * @Public, and anything that gets past this line becomes a ledger row and then
 * domain state. It had no test coverage at all: the whole boundary rested on a
 * reading of the code.
 *
 * Only the config is real. verifySignature touches nothing else, and stubbing the
 * repositories keeps the boundary under test rather than the wiring around it.
 */
describe('meta webhook signature verification', () => {
  const APP_SECRET = 'test-app-secret';

  function service(meta: { enabled?: boolean; appSecret?: string } = {}): MetaWebhookService {
    const config = {
      meta: {
        enabled: meta.enabled ?? true,
        appSecret: meta.appSecret ?? APP_SECRET,
        webhookVerifyToken: '',
      },
    } as unknown as AppConfigService;

    return new MetaWebhookService(
      config,
      {} as InboundEventRepository,
      {} as ChannelRepository,
      { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    );
  }

  const sign = (body: Buffer, secret = APP_SECRET): string =>
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  const BODY = Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: 'PAGE_1' }] }));

  it('accepts a signature over the raw body', () => {
    expect(() => service().verifySignature(BODY, sign(BODY))).not.toThrow();
  });

  it('refuses a signature computed under a different secret', () => {
    expect(() => service().verifySignature(BODY, sign(BODY, 'not-the-secret'))).toThrow(
      expect.objectContaining({ code: ErrorCode.WebhookSignatureInvalid }),
    );
  });

  it('refuses a body that has been altered by one byte', () => {
    // The signature must be over these exact bytes. Re-serialising the parsed
    // JSON changes key order and whitespace, which is why the app is
    // bootstrapped with rawBody: true.
    const tampered = Buffer.concat([BODY, Buffer.from(' ')]);
    expect(() => service().verifySignature(tampered, sign(BODY))).toThrow(
      expect.objectContaining({ code: ErrorCode.WebhookSignatureInvalid }),
    );
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['unprefixed', 'deadbeef'],
    ['sha1', 'sha1=deadbeef'],
    ['prefix only', 'sha256='],
    ['uppercase algorithm', 'SHA256=deadbeef'],
  ])('refuses a %s signature header', (_label, header) => {
    expect(() => service().verifySignature(BODY, header)).toThrow(
      expect.objectContaining({ code: ErrorCode.WebhookSignatureInvalid }),
    );
  });

  it('refuses a truncated digest of the right prefix', () => {
    // The length guard before timingSafeEqual matters: timingSafeEqual THROWS on
    // unequal lengths rather than returning false, so without it a short digest
    // would surface as a 500 instead of a rejection.
    const full = sign(BODY).slice('sha256='.length);
    expect(() => service().verifySignature(BODY, `sha256=${full.slice(0, 16)}`)).toThrow(
      expect.objectContaining({ code: ErrorCode.WebhookSignatureInvalid }),
    );
  });

  it('refuses an empty body even with a matching signature', () => {
    const empty = Buffer.alloc(0);
    expect(() => service().verifySignature(undefined, sign(empty))).toThrow(
      expect.objectContaining({ code: ErrorCode.WebhookSignatureInvalid }),
    );
  });

  it('refuses everything when meta is not configured', () => {
    /*
     * With META_ENABLED=false the app secret is an empty string, and an HMAC
     * under an empty key is one anybody can compute. The route is registered
     * unconditionally, so a correct signature must still be refused — and with a
     * DIFFERENT error, so an operator sees a configuration problem rather than
     * hunting for a forged request.
     */
    const disabled = service({ enabled: false, appSecret: '' });
    expect(() => disabled.verifySignature(BODY, sign(BODY, ''))).toThrow(
      expect.objectContaining({ code: ErrorCode.MetaNotConfigured }),
    );
  });

  it('refuses when the app secret is missing but the flag is on', () => {
    const misconfigured = service({ enabled: true, appSecret: '' });
    expect(() => misconfigured.verifySignature(BODY, sign(BODY, ''))).toThrow(
      expect.objectContaining({ code: ErrorCode.MetaNotConfigured }),
    );
  });
});
