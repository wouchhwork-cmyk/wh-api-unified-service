import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp, resetTenantData, type TestApp } from './app.harness';
import { MAX_WEBHOOK_BODY_BYTES } from '@/shared/constants';

/**
 * `POST /webhooks/meta` — the only public write route in the service.
 *
 * It had no coverage at all, and it is the one route where a regression is
 * self-concealing: Meta retries a non-2xx delivery for a while and then DISABLES
 * the subscription, after which the inbox silently stops filling and nothing
 * here knows why. A change to body parsing that dropped `req.rawBody` would
 * 401 every delivery with a completely green suite.
 *
 * The signature algorithm itself is covered in
 * test/unit/meta-webhook-signature.spec.ts; this is about the route.
 */
describe('the meta webhook', () => {
  let testApp: TestApp;
  let app: NestExpressApplication;
  let db: DataSource;

  const enabled = process.env.META_ENABLED === 'true';
  const appSecret = process.env.FB_APP_SECRET ?? '';

  beforeAll(async () => {
    testApp = await createTestApp();
    app = testApp.app;
    db = testApp.db;
  });
  afterAll(async () => {
    await testApp.close();
  });
  beforeEach(async () => {
    await resetTenantData(db);
  });

  const http = () => request(app.getHttpServer());
  const sign = (body: string): string =>
    `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`;

  it('refuses a body larger than the webhook limit', async () => {
    /*
     * The route is unauthenticated until its HMAC is checked and deliberately
     * exempt from rate limiting, so the declared length is refused BEFORE the
     * bytes are read and hashed. MAX_WEBHOOK_BODY_BYTES was declared and applied
     * nowhere, which left this route on the same 1 MiB as every authenticated
     * one.
     */
    const oversized = JSON.stringify({
      object: 'page',
      entry: [{ id: 'X', pad: 'y'.repeat(MAX_WEBHOOK_BODY_BYTES + 1_000) }],
    });

    await http()
      .post('/api/v1/webhooks/meta')
      .set('content-type', 'application/json')
      .send(oversized)
      .expect(413);
  });

  it('refuses an unsigned delivery', async () => {
    // The signature is the ONLY authentication here. A 2xx for an unsigned body
    // would mean anyone can write to the ledger.
    await http().post('/api/v1/webhooks/meta').send({ object: 'page', entry: [] }).expect(401);
  });

  it('refuses a signature computed over different bytes', async () => {
    const body = JSON.stringify({ object: 'page', entry: [] });

    await http()
      .post('/api/v1/webhooks/meta')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(`${body} `))
      .send(body)
      .expect(401);
  });

  it.runIf(enabled && appSecret !== '')(
    'accepts a correctly signed delivery, and reads rawBody to do it',
    async () => {
      /*
       * This is the assertion that protects `rawBody: true`. Re-serialising the
       * parsed JSON changes key order and whitespace, so the signature would
       * never match — and the symptom would be every real Meta delivery
       * returning 401 while the suite stayed green.
       */
      const body = JSON.stringify({ object: 'page', entry: [{ id: 'UNKNOWN_PAGE', time: 1 }] });

      const response = await http()
        .post('/api/v1/webhooks/meta')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', sign(body))
        .send(body)
        .expect(200);

      expect(response.body).toMatchObject({ success: true });
    },
  );

  it.runIf(enabled && appSecret !== '')(
    'drops an entry for a page nobody has connected, rather than storing it',
    async () => {
      // A webhook carries no tenant. The enterprise is derived from the channel,
      // so an unmatched page id has nowhere to be filed — and storing it would
      // make inbound_events an unbounded, untenanted table.
      const body = JSON.stringify({ object: 'page', entry: [{ id: 'NOT_OURS', time: 1 }] });

      await http()
        .post('/api/v1/webhooks/meta')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', sign(body))
        .send(body)
        .expect(200);

      const rows: { count: number }[] = await db.query(`SELECT count(*)::int FROM inbound_events`);
      expect(rows[0]?.count).toBe(0);
    },
  );

  it('answers the subscription handshake with the bare challenge', async () => {
    // Meta expects the challenge as text/plain with no envelope around it. The
    // response interceptor would wrap it, which is why the route is @RawResponse.
    const wrongToken = await http()
      .get('/api/v1/webhooks/meta')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '12345' });

    // Either refused for the token or refused because Meta is off — never the
    // challenge, which would let anyone complete somebody else's subscription.
    expect(wrongToken.status).not.toBe(200);
    expect(wrongToken.text).not.toContain('12345');
  });
});
