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
 * A programme is created whole, in one request.
 *
 * It used to take three: create an empty programme, then add a rule, then
 * add another. Somebody setting one up does not think in rules — they think
 * "reward DMs and story mentions, once a week, Friday evenings" — and every
 * step between those two sentences was a chance to stop halfway and leave a
 * programme that awards nothing.
 *
 * The engine's shape is unchanged: a rule still carries exactly one trigger.
 * The expansion happens server-side, in one transaction.
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

describe('creating a reward programme in one save', () => {
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

  /** A business with rewards on, a timezone and a currency — so nothing else refuses. */
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

    const auth = { Authorization: `Bearer ${verified.body.data.accessToken as string}` };
    await http()
      .patch('/api/v1/enterprises/current')
      .set(auth)
      .send({ timezone: 'Asia/Kolkata', currencyCode: 'INR' })
      .expect(200);
    return { auth };
  }

  const POINTS = [{ benefitKind: 'grant_points', config: { points: 20 } }];

  it('expands several triggers into one rule each, sharing everything else', async () => {
    const { auth } = await business();

    const created = await http()
      .post('/api/v1/rewards/programs')
      .set(auth)
      .send({
        name: 'Monsoon loyalty',
        displayName: 'Chai Club',
        triggers: ['direct_message_inbound', 'story_mention', 'comment_on_own_post'],
        capScope: 'week',
        capCount: 1,
        holdHours: 24,
        benefits: POINTS,
      })
      .expect(201);

    const refId = created.body.data.refId as string;
    const rules = await http()
      .get(`/api/v1/rewards/rules?programRefId=${refId}`)
      .set(auth)
      .expect(200);

    const items = rules.body.data.items as {
      triggerKind: string;
      capScope: string;
      holdHours: number;
    }[];
    expect(items.map((r) => r.triggerKind).sort()).toEqual([
      'comment_on_own_post',
      'direct_message_inbound',
      'story_mention',
    ]);
    /* Everything else is shared — that is the point of asking once. */
    for (const rule of items) {
      expect(rule.capScope).toBe('week');
      expect(rule.holdHours).toBe(24);
    }
  });

  /** No cap is the default, and it has to survive being left alone. */
  it('defaults to no cap', async () => {
    const { auth } = await business();
    const created = await http()
      .post('/api/v1/rewards/programs')
      .set(auth)
      .send({ name: 'Simple', triggers: ['direct_message_inbound'], benefits: POINTS })
      .expect(201);

    const rules = await http()
      .get(`/api/v1/rewards/rules?programRefId=${created.body.data.refId}`)
      .set(auth)
      .expect(200);
    expect(rules.body.data.items[0].capScope).toBe('none');
  });

  describe('the system trigger stands alone', () => {
    it('refuses to mix a balance trigger with a social one', async () => {
      const { auth } = await business();
      const refused = await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({
          name: 'Mixed',
          triggers: ['direct_message_inbound', 'points_balance_reached'],
          minPointsBalance: 100,
          benefits: POINTS,
        })
        .expect(422);
      expect(refused.body.error.code).toBe(ErrorCode.ValidationFailed);
    });

    it('requires a balance when it is chosen', async () => {
      const { auth } = await business();
      await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({ name: 'No threshold', triggers: ['points_balance_reached'], benefits: POINTS })
        .expect(422);
    });

    it('refuses a balance on a social trigger', async () => {
      const { auth } = await business();
      await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({
          name: 'Pointless threshold',
          triggers: ['direct_message_inbound'],
          minPointsBalance: 100,
          benefits: POINTS,
        })
        .expect(422);
    });

    /** A hold is a social idea: nobody un-earns points by deleting something. */
    it('refuses a hold on a balance trigger', async () => {
      const { auth } = await business();
      await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({
          name: 'Held balance',
          triggers: ['points_balance_reached'],
          minPointsBalance: 100,
          holdHours: 24,
          benefits: POINTS,
        })
        .expect(422);
    });

    it('accepts it alone, with its threshold', async () => {
      const { auth } = await business();
      const created = await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({
          name: 'Milestone',
          triggers: ['points_balance_reached'],
          minPointsBalance: 100,
          benefits: POINTS,
        })
        .expect(201);

      const stored: { trigger_config: Record<string, unknown> }[] = await db.query(
        `SELECT trigger_config FROM reward_rules WHERE trigger_kind = 'points_balance_reached'`,
      );
      expect(stored[0]?.trigger_config).toEqual({ minPointsBalance: 100 });
      expect(created.body.data.name).toBe('Milestone');
    });
  });

  describe('the schedule', () => {
    /** Every part optional, and absent means always. */
    it('creates no window when no days are chosen', async () => {
      const { auth } = await business();
      await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({ name: 'Anytime', triggers: ['direct_message_inbound'], benefits: POINTS })
        .expect(201);

      const conditions = await db.query(`SELECT count(*)::int AS n FROM reward_rule_conditions`);
      expect(conditions[0].n).toBe(0);
    });

    it('turns per-day slots into one window condition', async () => {
      const { auth } = await business();
      await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({
          name: 'Happy hours',
          triggers: ['direct_message_inbound'],
          benefits: POINTS,
          schedule: {
            days: [
              { isoDay: 5, slots: [{ start: '18:00', end: '21:00' }] },
              {
                isoDay: 6,
                slots: [
                  { start: '12:00', end: '14:00' },
                  { start: '18:00', end: '22:00' },
                ],
              },
            ],
          },
        })
        .expect(201);

      const rows: { condition_kind: string; config: { slots: unknown[] } }[] = await db.query(
        `SELECT condition_kind, config FROM reward_rule_conditions`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.condition_kind).toBe('time_window');
      expect(rows[0]?.config.slots).toEqual([
        { days: [5], start: '18:00', end: '21:00' },
        { days: [6], start: '12:00', end: '14:00' },
        { days: [6], start: '18:00', end: '22:00' },
      ]);
    });

    /** A ticked day with no hours means all of it, not none of it. */
    it('treats a day with no slots as the whole day', async () => {
      const { auth } = await business();
      await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({
          name: 'Fridays',
          triggers: ['direct_message_inbound'],
          benefits: POINTS,
          schedule: { days: [{ isoDay: 5, slots: [] }] },
        })
        .expect(201);

      const rows: { config: { slots: unknown[] } }[] = await db.query(
        `SELECT config FROM reward_rule_conditions`,
      );
      expect(rows[0]?.config.slots).toEqual([{ days: [5], start: '00:00', end: '00:00' }]);
    });

    it('puts the schedule dates on the programme', async () => {
      const { auth } = await business();
      const created = await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({
          name: 'Seasonal',
          triggers: ['direct_message_inbound'],
          benefits: POINTS,
          schedule: { startsAt: '2026-11-01T00:00:00Z', endsAt: '2027-02-01T00:00:00Z', days: [] },
        })
        .expect(201);

      expect(created.body.data.startsAt).not.toBeNull();
      expect(created.body.data.endsAt).not.toBeNull();
    });

    it('refuses an end before its start', async () => {
      const { auth } = await business();
      await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({
          name: 'Backwards',
          triggers: ['direct_message_inbound'],
          benefits: POINTS,
          schedule: { startsAt: '2027-02-01T00:00:00Z', endsAt: '2026-11-01T00:00:00Z', days: [] },
        })
        .expect(422);
    });
  });

  /** Triggers with nothing to award is a programme that does nothing. */
  it('refuses triggers with no reward', async () => {
    const { auth } = await business();
    await http()
      .post('/api/v1/rewards/programs')
      .set(auth)
      .send({ name: 'Empty', triggers: ['direct_message_inbound'], benefits: [] })
      .expect(422);
  });

  /** A shell with no triggers is still allowed — it awards nothing and says so. */
  it('still allows an empty programme', async () => {
    const { auth } = await business();
    await http().post('/api/v1/rewards/programs').set(auth).send({ name: 'Shell' }).expect(201);

    const rules = await db.query(`SELECT count(*)::int AS n FROM reward_rules`);
    expect(rules[0].n).toBe(0);
  });

  /** All of it, or none of it. */
  it('leaves no programme behind when a rule is refused', async () => {
    const { auth } = await business();
    await http()
      .patch('/api/v1/enterprises/current')
      .set(auth)
      .send({ timezone: null, currencyCode: null })
      .expect(200);

    await http()
      .post('/api/v1/rewards/programs')
      .set(auth)
      .send({
        name: 'Doomed',
        triggers: ['direct_message_inbound'],
        capScope: 'day',
        benefits: POINTS,
      })
      .expect(422);

    const programs = await db.query(`SELECT count(*)::int AS n FROM reward_programs`);
    expect(programs[0].n).toBe(0);
  });
});
