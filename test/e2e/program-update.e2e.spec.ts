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
 * Editing a programme is restating it — and the rules underneath are
 * SUPERSEDED, never edited.
 *
 * That is the whole point of this file. An award stores `rule_id` and
 * `rule_version`, so the row that decided a payment has to keep saying what it
 * said at the time. If an edit mutated the rule in place, every award ever
 * made under it would silently acquire a new justification, and "why did this
 * customer get 20 points in March" would answer with today's configuration.
 *
 * So an edit switches the old rules off, keeps them readable, and writes the
 * next version beside them, chained through `supersedes_rule_id`.
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

describe('editing a reward programme in one save', () => {
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

    const auth = { Authorization: `Bearer ${verified.body.data.accessToken as string}` };
    await http()
      .patch('/api/v1/enterprises/current')
      .set(auth)
      .send({ timezone: 'Asia/Kolkata', currencyCode: 'INR' })
      .expect(200);
    return { auth };
  }

  const POINTS = [{ benefitKind: 'grant_points', config: { points: 20 } }];

  const PROGRAM = {
    name: 'Monsoon loyalty',
    displayName: 'Chai Club',
    triggers: ['direct_message_inbound', 'story_mention'],
    capScope: 'week',
    capCount: 1,
    holdHours: 24,
    benefits: POINTS,
    schedule: { startsAt: null, endsAt: null, days: [{ isoDay: 5, slots: [] }] },
  };

  async function create(auth: { Authorization: string }): Promise<string> {
    const created = await http()
      .post('/api/v1/rewards/programs')
      .set(auth)
      .send(PROGRAM)
      .expect(201);
    return created.body.data.refId as string;
  }

  /* ------------------------------------------------------------------ */

  it('supersedes the rules instead of editing them, and keeps the old ones readable', async () => {
    const { auth } = await business();
    const refId = await create(auth);

    const before = await db.query(
      `SELECT id, trigger_kind, version, is_active, supersedes_rule_id
         FROM reward_rules WHERE is_deleted = false ORDER BY id`,
    );
    expect(before).toHaveLength(2);
    expect(before.every((r: { is_active: boolean }) => r.is_active)).toBe(true);

    await http()
      .put(`/api/v1/rewards/programs/${refId}`)
      .set(auth)
      .send({ ...PROGRAM, name: 'Monsoon loyalty v2', holdHours: 48 })
      .expect(200);

    const after = await db.query(
      `SELECT id, trigger_kind AS kind, version, is_active AS active,
              supersedes_rule_id AS supersedes, hold_hours AS hold
         FROM reward_rules WHERE is_deleted = false ORDER BY id`,
    );

    /* NOTHING WAS DELETED and nothing was edited: four rows, two retired. */
    expect(after).toHaveLength(4);
    const retired = after.filter((r: { active: boolean }) => !r.active);
    const live = after.filter((r: { active: boolean }) => r.active);
    expect(retired).toHaveLength(2);
    expect(live).toHaveLength(2);

    /* The retired rows still say 24, which is what they decided awards with. */
    expect(retired.every((r: { hold: number }) => Number(r.hold) === 24)).toBe(true);
    expect(live.every((r: { hold: number }) => Number(r.hold) === 48)).toBe(true);

    /* Each new rule is version 2, chained to the one it replaces. */
    for (const rule of live) {
      expect(rule.version).toBe(2);
      const parent = retired.find((r: { id: string }) => r.id === rule.supersedes);
      expect(parent).toBeDefined();
      expect(parent.kind).toBe(rule.kind);
    }
  });

  it('retires the rule for a trigger that was removed', async () => {
    const { auth } = await business();
    const refId = await create(auth);

    await http()
      .put(`/api/v1/rewards/programs/${refId}`)
      .set(auth)
      .send({ ...PROGRAM, triggers: ['direct_message_inbound'] })
      .expect(200);

    const rows = await db.query(
      `SELECT trigger_kind AS kind, is_active AS active
         FROM reward_rules WHERE is_deleted = false AND is_active = true`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('direct_message_inbound');
  });

  it('starts a fresh lineage for a trigger that was added', async () => {
    const { auth } = await business();
    const refId = await create(auth);

    await http()
      .put(`/api/v1/rewards/programs/${refId}`)
      .set(auth)
      .send({ ...PROGRAM, triggers: [...PROGRAM.triggers, 'story_reply'] })
      .expect(200);

    const rows = await db.query(
      `SELECT version, supersedes_rule_id AS supersedes
         FROM reward_rules
        WHERE is_deleted = false AND is_active = true AND trigger_kind = 'story_reply'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].supersedes).toBeNull();
  });

  /* ------------------------------------------------------------------ */

  it('appends a program version and mirrors its number onto the row', async () => {
    const { auth } = await business();
    const refId = await create(auth);

    const updated = await http()
      .put(`/api/v1/rewards/programs/${refId}`)
      .set(auth)
      .send({ ...PROGRAM, displayName: 'Chai Club Gold' })
      .expect(200);

    /* The response carries the version the edit produced, not the one before. */
    expect(updated.body.data.version).toBe(2);

    const [row] = await db.query(`SELECT version FROM reward_programs WHERE ref_id = $1`, [refId]);
    expect(row.version).toBe(2);

    const history = await http()
      .get(`/api/v1/rewards/programs/${refId}/versions`)
      .set(auth)
      .expect(200);
    const versions = history.body.data.items as { version: number; snapshot: { name: string } }[];
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    /* The snapshot is the WHOLE state, so version 1 still reads correctly. */
    expect(versions[1]?.snapshot.name).toBe('Monsoon loyalty');
  });

  it('writes an audit row naming what the edit replaced', async () => {
    const { auth } = await business();
    const refId = await create(auth);

    await http()
      .put(`/api/v1/rewards/programs/${refId}`)
      .set(auth)
      .send({ ...PROGRAM, name: 'Renamed' })
      .expect(200);

    const [row] = await db.query(
      `SELECT action, changes FROM audit_logs
        WHERE entity_type = 'reward_program' AND action = 'updated'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(row).toBeDefined();
    expect(row.changes.name).toBe('Renamed');
    expect(row.changes.rulesRetired).toBe(2);
  });

  /* ------------------------------------------------------------------ */

  it('reads back in exactly the shape it accepts', async () => {
    const { auth } = await business();
    const refId = await create(auth);

    const read = await http()
      .get(`/api/v1/rewards/programs/${refId}/configuration`)
      .set(auth)
      .expect(200);
    const config = read.body.data;

    expect(config.name).toBe('Monsoon loyalty');
    expect([...config.triggers].sort()).toEqual(['direct_message_inbound', 'story_mention']);
    expect(config.capScope).toBe('week');
    expect(config.holdHours).toBe(24);
    expect(config.benefits[0].benefitKind).toBe('grant_points');
    expect(config.uniform).toBe(true);
    /* A ticked day with no hours means the WHOLE day, and round trips as one
     * rather than coming back as a window that merely looks like one. */
    expect(config.schedule.days).toEqual([{ isoDay: 5, slots: [] }]);

    /* And what came out goes straight back in. */
    await http()
      .put(`/api/v1/rewards/programs/${refId}`)
      .set(auth)
      .send({
        name: config.name,
        displayName: config.displayName,
        triggers: config.triggers,
        capScope: config.capScope,
        capCount: config.capCount,
        holdHours: config.holdHours,
        benefits: config.benefits,
        destination: config.destination,
        schedule: config.schedule,
      })
      .expect(200);
  });

  it('records the destination toggle and reads it back', async () => {
    const { auth } = await business();
    const refId = await create(auth);

    const updated = await http()
      .put(`/api/v1/rewards/programs/${refId}`)
      .set(auth)
      .send({ ...PROGRAM, destination: 'external' })
      .expect(200);
    expect(updated.body.data.destination).toBe('external');

    const [row] = await db.query(
      `SELECT forward_provider_code AS code FROM reward_programs WHERE ref_id = $1`,
      [refId],
    );
    expect(row.code).toBe('noop');
  });

  /* ------------------------------------------------------------------ */

  it('refuses to edit an archived programme', async () => {
    const { auth } = await business();
    const refId = await create(auth);

    await http()
      .patch(`/api/v1/rewards/programs/${refId}/status`)
      .set(auth)
      .send({ status: 'archived' })
      .expect(200);

    const refused = await http()
      .put(`/api/v1/rewards/programs/${refId}`)
      .set(auth)
      .send({ ...PROGRAM, name: 'Resurrected' })
      .expect(409);
    expect(refused.body.error.code).toBe(ErrorCode.RewardProgramArchived);

    /* And the rules it had are untouched by the refusal. */
    const rows = await db.query(
      `SELECT count(*)::int AS n FROM reward_rules WHERE is_deleted = false`,
    );
    expect(rows[0].n).toBe(2);
  });

  /* ------------------------------------------------------------------ */
  /* Who it rewarded                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Awards are written straight to the table rather than driven through the
   * engine: this is testing the LISTING, and routing real events through
   * Instagram ingestion to produce them would be testing the engine instead,
   * with the paging boundary left to whatever order that produced.
   */
  async function award(
    refId: string,
    rows: { customer: string; status: string; at: string }[],
  ): Promise<void> {
    const [program] = await db.query(
      `SELECT id, enterprise_id AS "enterpriseId" FROM reward_programs WHERE ref_id = $1`,
      [refId],
    );
    const [rule] = await db.query(
      `SELECT id, version FROM reward_rules WHERE program_id = $1 AND is_active = true
        ORDER BY id LIMIT 1`,
      [program.id],
    );

    let source = 0;
    for (const row of rows) {
      const [customer] = await db.query(
        `INSERT INTO customers (enterprise_id, display_name, first_source)
         VALUES ($1, $2, 'manual') RETURNING id`,
        [program.enterpriseId, row.customer],
      );
      source += 1;
      await db.query(
        `INSERT INTO reward_awards
            (enterprise_id, program_id, rule_id, rule_version, program_version, customer_id,
             source_ref_kind, source_ref_id, status, occurred_at_utc)
         VALUES ($1, $2, $3, $4, 1, $5, 'message', $6, $7, $8)`,
        [
          program.enterpriseId,
          program.id,
          rule.id,
          rule.version,
          customer.id,
          source,
          row.status,
          row.at,
        ],
      );
    }
  }

  it('lists who it rewarded, newest first, with what it did for them', async () => {
    const { auth } = await business();
    const refId = await create(auth);
    await award(refId, [
      { customer: 'Asha', status: 'granted', at: '2026-03-01T10:00:00Z' },
      { customer: 'Bina', status: 'held', at: '2026-03-03T10:00:00Z' },
      { customer: 'Chandra', status: 'reversed', at: '2026-03-02T10:00:00Z' },
    ]);

    const page = await http()
      .get(`/api/v1/rewards/programs/${refId}/beneficiaries`)
      .set(auth)
      .expect(200);

    /* `data` IS the array: the envelope lifts `items` up and moves
     * `pagination` into `meta` whenever a payload carries one. */
    const items = page.body.data as { displayName: string; held: number }[];
    expect(items.map((i) => i.displayName)).toEqual(['Bina', 'Chandra', 'Asha']);
    expect(items[0]?.held).toBe(1);
    expect(page.body.meta.pagination.hasMore).toBe(false);
  });

  it('leaves out the refusals — they are people who got nothing', async () => {
    const { auth } = await business();
    const refId = await create(auth);
    await award(refId, [
      { customer: 'Asha', status: 'granted', at: '2026-03-01T10:00:00Z' },
      { customer: 'Refused', status: 'skipped_cap', at: '2026-03-04T10:00:00Z' },
      { customer: 'AlsoRefused', status: 'skipped_condition', at: '2026-03-05T10:00:00Z' },
    ]);

    const page = await http()
      .get(`/api/v1/rewards/programs/${refId}/beneficiaries`)
      .set(auth)
      .expect(200);
    const items = page.body.data as { displayName: string }[];
    expect(items.map((i) => i.displayName)).toEqual(['Asha']);
  });

  /*
   * THE BOUNDARY, which is where keyset paging goes wrong. Walking every page
   * must yield each customer exactly once — a cursor that is off by a row
   * either repeats the row on the boundary or loses it, and a single-page
   * assertion would never notice.
   */
  it('pages without repeating or losing anybody', async () => {
    const { auth } = await business();
    const refId = await create(auth);
    const people = ['A', 'B', 'C', 'D', 'E'];
    await award(
      refId,
      people.map((name, index) => ({
        customer: name,
        status: 'granted',
        at: `2026-03-0${index + 1}T10:00:00Z`,
      })),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const url =
        `/api/v1/rewards/programs/${refId}/beneficiaries?limit=2` +
        (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
      const page = await http().get(url).set(auth).expect(200);
      const rows = page.body.data as { displayName: string }[];
      const meta = page.body.meta.pagination as {
        nextCursor: string | null;
        hasMore: boolean;
      };
      seen.push(...rows.map((i) => i.displayName));
      if (!meta.hasMore) break;
      cursor = meta.nextCursor;
      expect(cursor).not.toBeNull();
    }

    expect(seen).toEqual(['E', 'D', 'C', 'B', 'A']);
    expect(new Set(seen).size).toBe(people.length);
  });

  it('counts several awards to one customer as one beneficiary', async () => {
    const { auth } = await business();
    const refId = await create(auth);
    await award(refId, [
      { customer: 'Asha', status: 'granted', at: '2026-03-01T10:00:00Z' },
      { customer: 'Asha', status: 'granted', at: '2026-03-02T10:00:00Z' },
      { customer: 'Asha', status: 'reversed', at: '2026-03-03T10:00:00Z' },
    ]);

    const page = await http()
      .get(`/api/v1/rewards/programs/${refId}/beneficiaries`)
      .set(auth)
      .expect(200);
    const items = page.body.data as {
      displayName: string;
      granted: number;
      reversed: number;
    }[];
    /* Three customers were inserted, because each insert makes a new one —
     * so this also proves the grouping is by customer and not by award. */
    expect(items.filter((i) => i.displayName === 'Asha')).toHaveLength(3);
    expect(items.reduce((sum, i) => sum + i.granted, 0)).toBe(2);
    expect(items.reduce((sum, i) => sum + i.reversed, 0)).toBe(1);
  });

  it('refuses a limit beyond the ceiling rather than honouring it', async () => {
    const { auth } = await business();
    const refId = await create(auth);
    await http()
      .get(`/api/v1/rewards/programs/${refId}/beneficiaries?limit=100000`)
      .set(auth)
      .expect(422);
  });

  it('404s on a programme that is not this business’s', async () => {
    const { auth } = await business();
    const missing = await http()
      .put('/api/v1/rewards/programs/11111111-1111-4111-8111-111111111111')
      .set(auth)
      .send(PROGRAM)
      .expect(404);
    expect(missing.body.error.code).toBe(ErrorCode.RewardProgramNotFound);
  });
});
