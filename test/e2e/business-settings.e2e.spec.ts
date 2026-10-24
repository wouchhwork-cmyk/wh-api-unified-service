import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  createTestApp,
  platformAdminLogin,
  provisionPlatformAdmin,
  resetTenantData,
  type TestApp,
} from './app.harness';
import { ErrorCode } from '@/shared/errors/error-codes.enum';

/**
 * The business owns its timezone and its currency, and everything reads them.
 *
 * Both used to live on each reward programme, copied at creation, so two
 * programmes in one business could disagree about when Tuesday starts and
 * what money means. They moved here; the programme form no longer asks.
 *
 * The currency is deliberately NULLABLE, and that is the interesting half: a
 * points programme needs no currency and must not be blocked by one, while a
 * rule that grants money must not silently pay in a default nobody chose.
 */
const OWNER_PASSWORD = 'a-long-enough-password';
const SIGNUP = {
  business: { name: 'Acme Coffee', email: 'hello@acme.test', city: 'Pune' },
  owner: {
    firstName: 'Priya',
    lastName: 'Rao',
    email: 'priya@acme.test',
    password: OWNER_PASSWORD,
  },
};

describe('business settings', () => {
  let testApp: TestApp;
  let app: NestExpressApplication;
  let db: DataSource;

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
    await provisionPlatformAdmin(app);
  });

  const http = () => request(app.getHttpServer());
  const code = (): string => process.env.OTP_STATIC_CODE ?? '666666';

  async function business(): Promise<{ auth: { Authorization: string } }> {
    const signup = await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);
    const verified = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId: signup.body.data.verificationRefId, code: code() })
      .expect(200);

    const admin = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
    const adminAuth = { Authorization: `Bearer ${admin.body.data.accessToken as string}` };
    const refId = signup.body.data.enterpriseRefId as string;

    await http()
      .post(`/api/v1/platform/enterprises/${refId}/status`)
      .set(adminAuth)
      .send({ status: 'active' })
      .expect(200);
    await http()
      .post(`/api/v1/platform/enterprises/${refId}/features/reward_programs`)
      .set(adminAuth)
      .send({ status: 'active' })
      .expect(200);

    return { auth: { Authorization: `Bearer ${verified.body.data.accessToken as string}` } };
  }

  const programFor = async (auth: { Authorization: string }): Promise<string> => {
    const created = await http()
      .post('/api/v1/rewards/programs')
      .set(auth)
      .send({ name: 'Monsoon' })
      .expect(201);
    return created.body.data.refId as string;
  };

  describe('the options a client may offer', () => {
    /** The dropdown and the validator must be the same set, or one will refuse the other. */
    it('serves the same lists the validator accepts', async () => {
      const { auth } = await business();
      const options = await http()
        .get('/api/v1/enterprises/settings/options')
        .set(auth)
        .expect(200);

      const { timezones, currencies } = options.body.data as {
        timezones: string[];
        currencies: string[];
      };
      expect(timezones.length).toBeGreaterThan(100);
      expect(currencies).toContain('INR');
      expect(currencies).toContain('USD');

      /* Every offered value must save. Spot-checked at the edges. */
      for (const timezone of [timezones[0], timezones.at(-1)]) {
        await http()
          .patch('/api/v1/enterprises/current')
          .set(auth)
          .send({ timezone, currencyCode: 'USD' })
          .expect(200);
      }
    });

    /** Abbreviations are absent from the list and refused by the validator. */
    it('offers no abbreviation, and refuses one that is sent anyway', async () => {
      const { auth } = await business();
      const options = await http()
        .get('/api/v1/enterprises/settings/options')
        .set(auth)
        .expect(200);
      expect(options.body.data.timezones).not.toContain('EST');
      expect(options.body.data.timezones).not.toContain('IST');

      const refused = await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ timezone: 'EST', currencyCode: 'USD' })
        .expect(422);
      expect(refused.body.error.code).toBe(ErrorCode.ValidationFailed);
    });

    it('refuses a three-letter code that is not a currency', async () => {
      const { auth } = await business();
      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ timezone: 'Asia/Kolkata', currencyCode: 'XYZ' })
        .expect(422);
    });
  });

  describe('a business with no currency set', () => {
    /** Points need no currency, so nothing may stand in their way. */
    it('can still build a points rule', async () => {
      const { auth } = await business();
      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ timezone: 'Asia/Kolkata', currencyCode: null })
        .expect(200);

      const programRefId = await programFor(auth);
      await http()
        .post('/api/v1/rewards/rules')
        .set(auth)
        .send({
          programRefId,
          triggerKind: 'direct_message_inbound',
          benefits: [{ benefitKind: 'grant_points', config: { points: 10 } }],
          conditions: [],
        })
        .expect(201);
    });

    /**
     * THE PROMPT THE PORTAL ACTS ON. Its own code, not a validation failure,
     * because the remedy is a different screen — the client recognises this
     * and offers to take them there.
     */
    it('is refused a money rule, by a code that names the remedy', async () => {
      const { auth } = await business();
      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ timezone: 'Asia/Kolkata', currencyCode: null })
        .expect(200);

      const programRefId = await programFor(auth);
      const refused = await http()
        .post('/api/v1/rewards/rules')
        .set(auth)
        .send({
          programRefId,
          triggerKind: 'direct_message_inbound',
          benefits: [{ benefitKind: 'grant_currency', config: { minorUnits: 500 } }],
          conditions: [],
        })
        .expect(422);

      expect(refused.body.error.code).toBe(ErrorCode.EnterpriseCurrencyNotSet);
    });

    /** A benefit naming its OWN currency needs nothing from the business. */
    it('accepts a money rule that states its currency explicitly', async () => {
      const { auth } = await business();
      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ timezone: 'Asia/Kolkata', currencyCode: null })
        .expect(200);

      const programRefId = await programFor(auth);
      await http()
        .post('/api/v1/rewards/rules')
        .set(auth)
        .send({
          programRefId,
          triggerKind: 'direct_message_inbound',
          benefits: [
            { benefitKind: 'grant_currency', config: { minorUnits: 500, currencyCode: 'USD' } },
          ],
          conditions: [],
        })
        .expect(201);
    });
  });

  describe('a business with no timezone set', () => {
    /**
     * Signup no longer asks for one and no longer defaults to Asia/Kolkata,
     * so a brand-new business genuinely has none — which is the state these
     * assertions depend on.
     */
    it('starts with no timezone at all', async () => {
      const { auth } = await business();
      const current = await http().get('/api/v1/enterprises/current').set(auth).expect(200);
      expect(current.body.data.timezone).toBeNull();
      expect(current.body.data.currencyCode).toBeNull();
    });

    /** A rule that counts no days needs no calendar. */
    it('can still build an uncapped rule with no time window', async () => {
      const { auth } = await business();
      const programRefId = await programFor(auth);

      await http()
        .post('/api/v1/rewards/rules')
        .set(auth)
        .send({
          programRefId,
          triggerKind: 'direct_message_inbound',
          benefits: [{ benefitKind: 'grant_points', config: { points: 10 } }],
          conditions: [],
        })
        .expect(201);
    });

    /** "Once a day" has to know when the day turns over. */
    it('is refused a capped rule, by a code that names the remedy', async () => {
      const { auth } = await business();
      const programRefId = await programFor(auth);

      const refused = await http()
        .post('/api/v1/rewards/rules')
        .set(auth)
        .send({
          programRefId,
          triggerKind: 'direct_message_inbound',
          capScope: 'day',
          benefits: [{ benefitKind: 'grant_points', config: { points: 10 } }],
          conditions: [],
        })
        .expect(422);

      expect(refused.body.error.code).toBe(ErrorCode.EnterpriseTimezoneNotSet);
    });

    /** "Tuesday 6pm" means nothing without a place. */
    it('is refused a time-window rule', async () => {
      const { auth } = await business();
      const programRefId = await programFor(auth);

      const refused = await http()
        .post('/api/v1/rewards/rules')
        .set(auth)
        .send({
          programRefId,
          triggerKind: 'direct_message_inbound',
          benefits: [{ benefitKind: 'grant_points', config: { points: 10 } }],
          conditions: [
            {
              conditionKind: 'time_window',
              config: { slots: [{ days: [2], start: '18:00', end: '21:00' }] },
            },
          ],
        })
        .expect(422);

      expect(refused.body.error.code).toBe(ErrorCode.EnterpriseTimezoneNotSet);
    });

    it('accepts the capped rule once a timezone is set', async () => {
      const { auth } = await business();
      const programRefId = await programFor(auth);
      const body = {
        programRefId,
        triggerKind: 'direct_message_inbound',
        capScope: 'day',
        benefits: [{ benefitKind: 'grant_points', config: { points: 10 } }],
        conditions: [],
      };

      await http().post('/api/v1/rewards/rules').set(auth).send(body).expect(422);

      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ timezone: 'Europe/London', currencyCode: null })
        .expect(200);

      await http().post('/api/v1/rewards/rules').set(auth).send(body).expect(201);
    });
  });

  /** And the remedy actually works: set it, and the same rule saves. */
  it('accepts the money rule once a currency is set', async () => {
    const { auth } = await business();
    await http()
      .patch('/api/v1/enterprises/current')
      .set(auth)
      .send({ timezone: 'Asia/Kolkata', currencyCode: null })
      .expect(200);

    const programRefId = await programFor(auth);
    const body = {
      programRefId,
      triggerKind: 'direct_message_inbound',
      benefits: [{ benefitKind: 'grant_currency', config: { minorUnits: 500 } }],
      conditions: [],
    };

    await http().post('/api/v1/rewards/rules').set(auth).send(body).expect(422);

    await http()
      .patch('/api/v1/enterprises/current')
      .set(auth)
      .send({ timezone: 'Asia/Kolkata', currencyCode: 'USD' })
      .expect(200);

    await http().post('/api/v1/rewards/rules').set(auth).send(body).expect(201);
  });

  /** A settings change is recorded and versioned like any other configuration. */
  it('records the change in the audit trail and the version history', async () => {
    const { auth } = await business();
    await http()
      .patch('/api/v1/enterprises/current')
      .set(auth)
      .send({ timezone: 'Europe/London', currencyCode: 'GBP' })
      .expect(200);

    const audit: { action: string; changes: Record<string, unknown> }[] = await db.query(
      `SELECT action, changes FROM audit_logs
        WHERE entity_type = 'enterprise' AND action = 'updated' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit[0]?.changes).toMatchObject({ currencyCode: { to: 'GBP' } });

    const versions: { snapshot: Record<string, unknown> }[] = await db.query(
      `SELECT snapshot FROM entity_versions WHERE entity_type = 'enterprise' ORDER BY version DESC`,
    );
    expect(versions[0]?.snapshot).toMatchObject({ currencyCode: 'GBP' });
  });
});
