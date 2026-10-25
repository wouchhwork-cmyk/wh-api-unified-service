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
  /** The two fields this PUT requires; every profile test restates them. */
  const base = () => ({ timezone: 'Asia/Kolkata', currencyCode: 'INR' });

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

  /**
   * A programme has two names, and they are opposites on purpose.
   *
   * `name` is the internal identifier and is unique per business, case
   * insensitively, because its job is to let somebody say which programme
   * they mean. `displayName` is what customers will see: not unique, no
   * format rules, optional.
   */
  describe('a programme’s two names', () => {
    it('keeps the internal name unique, case insensitively', async () => {
      const { auth } = await business();
      await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({ name: 'Monsoon loyalty' })
        .expect(201);

      await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({ name: 'monsoon LOYALTY' })
        .expect(409);
    });

    /** Two programmes may greet customers identically; the ledger says which paid. */
    it('lets two programmes share a customer-facing name', async () => {
      const { auth } = await business();
      await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({ name: 'Monsoon v1', displayName: 'Rewards' })
        .expect(201);

      const second = await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({ name: 'Monsoon v2', displayName: 'Rewards' })
        .expect(201);

      expect(second.body.data.displayName).toBe('Rewards');
    });

    /** Marketing copy is not ours to police. */
    it('accepts anything in the customer-facing name', async () => {
      const { auth } = await business();
      const wild = '☕ Chai Club — 50% off! (मानसून) 🎉';

      const created = await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({ name: 'Internal only', displayName: wild })
        .expect(201);

      expect(created.body.data.displayName).toBe(wild);
    });

    /** Optional: nothing renders it to an end user yet. */
    it('allows no customer-facing name at all', async () => {
      const { auth } = await business();
      const created = await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({ name: 'Internal only' })
        .expect(201);

      expect(created.body.data.displayName).toBeNull();
    });

    /** An empty string is not a name; it is the absence of one. */
    it('treats an empty customer-facing name as unset', async () => {
      const { auth } = await business();
      const created = await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({ name: 'Internal only', displayName: '   ' })
        .expect(201);

      expect(created.body.data.displayName).toBeNull();
    });

    /** "No checks" cannot mean "no limit". */
    it('still bounds its length', async () => {
      const { auth } = await business();
      await http()
        .post('/api/v1/rewards/programs')
        .set(auth)
        .send({ name: 'Internal only', displayName: 'x'.repeat(161) })
        .expect(422);
    });
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

  /**
   * The name customers are shown, which the business chooses for itself.
   *
   * `name` is what got typed at signup and is usually the registered entity.
   * This is the one that reaches a customer in a message, and the cases worth
   * pinning are about what a SAVE does to it — particularly a save that never
   * mentions it, which is what every client written before the field existed
   * sends.
   */
  describe('the customer-facing name', () => {
    it('is null until the business chooses one', async () => {
      const { auth } = await business();
      const read = await http().get('/api/v1/enterprises/current').set(auth).expect(200);
      expect(read.body.data.displayName).toBeNull();
      /* Not backfilled from the signup name: unset must stay distinguishable
       * from "they chose to show their registered entity". */
      expect(read.body.data.name).toBe(SIGNUP.business.name);
    });

    it('is saved, read back, and survives a save that does not mention it', async () => {
      const { auth } = await business();

      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ timezone: 'Asia/Kolkata', currencyCode: 'INR', displayName: '  Acme ☕  ' })
        .expect(200);

      const saved = await http().get('/api/v1/enterprises/current').set(auth).expect(200);
      expect(saved.body.data.displayName).toBe('Acme ☕');

      /*
       * THE REGRESSION THIS GUARDS. The settings PUT is a full restatement,
       * so an older client sends timezone and currency and nothing else. If
       * the field defaulted instead of being optional, this request would
       * silently clear a name the business had chosen, on every save.
       */
      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ timezone: 'Europe/London', currencyCode: 'GBP' })
        .expect(200);

      const after = await http().get('/api/v1/enterprises/current').set(auth).expect(200);
      expect(after.body.data.displayName).toBe('Acme ☕');
      expect(after.body.data.timezone).toBe('Europe/London');
    });

    it('is cleared by an explicit null, which absence does not do', async () => {
      const { auth } = await business();
      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ timezone: 'Asia/Kolkata', currencyCode: 'INR', displayName: 'Acme' })
        .expect(200);

      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ timezone: 'Asia/Kolkata', currencyCode: 'INR', displayName: null })
        .expect(200);

      const after = await http().get('/api/v1/enterprises/current').set(auth).expect(200);
      expect(after.body.data.displayName).toBeNull();
    });

    it('refuses a name longer than the column holds', async () => {
      const { auth } = await business();
      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ timezone: 'Asia/Kolkata', currencyCode: 'INR', displayName: 'x'.repeat(161) })
        .expect(422);
    });

    it('records the change in the audit trail and the version history', async () => {
      const { auth } = await business();
      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ timezone: 'Asia/Kolkata', currencyCode: 'INR', displayName: 'Acme' })
        .expect(200);

      const audit: { changes: Record<string, unknown> }[] = await db.query(
        `SELECT changes FROM audit_logs
          WHERE entity_type = 'enterprise' AND action = 'updated' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit[0]?.changes).toMatchObject({ displayName: { from: null, to: 'Acme' } });

      const versions: { snapshot: Record<string, unknown> }[] = await db.query(
        `SELECT snapshot FROM entity_versions WHERE entity_type = 'enterprise' ORDER BY version DESC`,
      );
      expect(versions[0]?.snapshot).toMatchObject({ displayName: 'Acme' });
    });
  });

  /**
   * The profile a customer reads: a description, links, and how to reach a
   * person.
   *
   * The interesting cases are the same two as the name — what a save that
   * never mentions them does, and what an explicitly empty one does — plus
   * the refusals, because every value here is rendered to somebody outside
   * the business.
   */
  describe('the public profile', () => {
    const PROFILE = {
      about: 'We are McDonalds — a chain of fast food restaurants. Try the aloo tikki burger.',
      links: [
        { label: 'Order online', url: 'https://mcdonalds.in/order' },
        { label: 'Directions', url: 'https://maps.example.com/mcd-andheri' },
      ],
      contacts: [
        { label: 'India', phone: '+91 98765-43210', email: 'Orders@McDonalds.IN' },
        { label: 'Support', email: 'help@mcdonalds.in' },
      ],
    };

    it('starts empty, with lists rather than nulls', async () => {
      const { auth } = await business();
      const read = await http().get('/api/v1/enterprises/current').set(auth).expect(200);
      expect(read.body.data.about).toBeNull();
      expect(read.body.data.links).toEqual([]);
      expect(read.body.data.contacts).toEqual([]);
    });

    it('saves a whole profile and reads it back normalised', async () => {
      const { auth } = await business();
      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ ...base(), ...PROFILE })
        .expect(200);

      const read = await http().get('/api/v1/enterprises/current').set(auth).expect(200);
      expect(read.body.data.about).toBe(PROFILE.about);
      /* Order is the business's own answer to "what matters most". */
      expect(read.body.data.links.map((l: { label: string }) => l.label)).toEqual([
        'Order online',
        'Directions',
      ]);
      /* Normalised on the way in, not on the way out. */
      expect(read.body.data.contacts[0].phone).toBe('+919876543210');
      expect(read.body.data.contacts[0].email).toBe('orders@mcdonalds.in');
    });

    it('survives a save that does not mention it, and clears on an empty list', async () => {
      const { auth } = await business();
      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ ...base(), ...PROFILE })
        .expect(200);

      /* An older client: timezone and currency only. Must not wipe anything. */
      await http().patch('/api/v1/enterprises/current').set(auth).send(base()).expect(200);

      const kept = await http().get('/api/v1/enterprises/current').set(auth).expect(200);
      expect(kept.body.data.links).toHaveLength(2);
      expect(kept.body.data.about).toBe(PROFILE.about);

      /* An empty list IS an instruction — "I removed them all". */
      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ ...base(), links: [] })
        .expect(200);

      const cleared = await http().get('/api/v1/enterprises/current').set(auth).expect(200);
      expect(cleared.body.data.links).toEqual([]);
      expect(cleared.body.data.contacts).toHaveLength(2);
    });

    /**
     * THE ONE THAT MATTERS MOST. These links are rendered as anchors in a
     * customer's browser, so a settings form must not be a way to publish a
     * `javascript:` URL into somebody else's session.
     */
    it('refuses a link that is not an ordinary web address', async () => {
      const { auth } = await business();
      for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd']) {
        await http()
          .patch('/api/v1/enterprises/current')
          .set(auth)
          .send({ ...base(), links: [{ label: 'Menu', url }] })
          .expect(422);
      }

      const read = await http().get('/api/v1/enterprises/current').set(auth).expect(200);
      expect(read.body.data.links).toEqual([]);
    });

    it('refuses a link name that is really an address, and a nameless contact', async () => {
      const { auth } = await business();
      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ ...base(), links: [{ label: 'mcdonalds.in', url: 'https://mcdonalds.in' }] })
        .expect(422);

      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ ...base(), contacts: [{ label: 'India' }] })
        .expect(422);
    });

    it('offers suggested link names through the options endpoint', async () => {
      const { auth } = await business();
      const options = await http()
        .get('/api/v1/enterprises/settings/options')
        .set(auth)
        .expect(200);
      expect(options.body.data.linkLabels).toContain('Website');
      expect(options.body.data.linkLabels).toContain('Directions');
    });

    /**
     * The audit row records THAT the lists changed, not every address in
     * them; the version snapshot keeps the full value, which is the thing
     * that exists to reconstruct a past state.
     */
    it('records counts in the audit trail and the full profile in the snapshot', async () => {
      const { auth } = await business();
      await http()
        .patch('/api/v1/enterprises/current')
        .set(auth)
        .send({ ...base(), ...PROFILE })
        .expect(200);

      const audit: { changes: Record<string, unknown> }[] = await db.query(
        `SELECT changes FROM audit_logs
          WHERE entity_type = 'enterprise' AND action = 'updated' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit[0]?.changes).toMatchObject({
        links: { from: 0, to: 2 },
        contacts: { from: 0, to: 2 },
      });
      expect(JSON.stringify(audit[0]?.changes)).not.toContain('mcdonalds.in');

      const versions: { snapshot: Record<string, unknown> }[] = await db.query(
        `SELECT snapshot FROM entity_versions WHERE entity_type = 'enterprise' ORDER BY version DESC`,
      );
      expect(versions[0]?.snapshot).toMatchObject({ about: PROFILE.about });
      expect((versions[0]?.snapshot as { links: unknown[] }).links).toHaveLength(2);
    });
  });
});
