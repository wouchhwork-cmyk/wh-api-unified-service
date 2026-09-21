import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  MetaApiUsageRepository,
  type MetaUsageBucket,
} from '@/database/repositories/meta-api-usage.repository';
import { MetaUsageMeter } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * The rate-limit ledger, against real Postgres.
 *
 * Every behaviour worth pinning here is a property of the UPSERT, which is a
 * Postgres feature a mock cannot reproduce: the conflict target, the asymmetric
 * fold of counts against percentages, and `GREATEST` ignoring NULLs — which is
 * the single line standing between a monitor that remembers a reading of 80%
 * and one that forgets it on the next quiet response.
 */
describe('meta_api_usage', () => {
  let db: DataSource;
  let usage: MetaApiUsageRepository;
  let enterpriseId: number;
  let channelId: number;

  const MINUTE = new Date('2026-09-21T10:00:00.000Z');
  const NEXT_MINUTE = new Date('2026-09-21T10:01:00.000Z');

  beforeAll(async () => {
    db = await createTestDataSource();
    usage = new MetaApiUsageRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
    channelId = await seedChannel(enterpriseId, 'IG_ACCOUNT');
  });

  async function seedChannel(tenant: number, platformChannelId: string): Promise<number> {
    const connection: { id: string }[] = await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social',$2,'envelope') RETURNING id`,
      [tenant, `user-${platformChannelId}`],
    );
    const channel: { id: string }[] = await db.query(
      `INSERT INTO channels
         (provider_connection_id, enterprise_id, platform, channel_kind,
          platform_channel_id, name)
       VALUES ($1,$2,'instagram','instagram_business',$3,'The Shop') RETURNING id`,
      [connection[0]?.id, tenant, platformChannelId],
    );
    return Number(channel[0]?.id);
  }

  const bucket = (over: Partial<MetaUsageBucket> = {}): MetaUsageBucket => ({
    scopeKey: 'IG_ACCOUNT:instagram',
    meter: MetaUsageMeter.BusinessUseCase,
    product: 'instagram',
    metaBusinessId: 'IG_ACCOUNT',
    enterpriseId,
    channelId,
    bucketStart: MINUTE,
    calls: 1,
    throttledCalls: 0,
    failedCalls: 0,
    callPct: 10,
    cpuPct: 1,
    timePct: 1,
    regainMinutes: null,
    lastSeenAt: MINUTE,
    ...over,
  });

  const row = async (
    scopeKey = 'IG_ACCOUNT:instagram',
  ): Promise<Record<string, unknown> | undefined> => {
    const rows: Record<string, unknown>[] = await db.query(
      `SELECT * FROM meta_api_usage WHERE scope_key = $1 ORDER BY bucket_start DESC`,
      [scopeKey],
    );
    return rows[0];
  };

  describe('folding a flush into the minute', () => {
    it('writes a new minute', async () => {
      await usage.record([bucket()]);

      expect(await row()).toMatchObject({ calls: 1, call_pct: 10, product: 'instagram' });
    });

    it('ADDS our counts across flushes', async () => {
      /*
       * This is also what makes multiple replicas correct with no coordination:
       * two processes each reporting their own calls sum to the truth.
       */
      await usage.record([bucket({ calls: 30, failedCalls: 1 })]);
      await usage.record([bucket({ calls: 20, failedCalls: 2, throttledCalls: 3 })]);

      expect(await row()).toMatchObject({ calls: 50, failed_calls: 3, throttled_calls: 3 });
    });

    it('takes the HIGHEST percentage rather than adding or replacing', async () => {
      /*
       * Meta's figures describe ONE global position, not a contribution. Adding
       * them would report 110% on a pool that never passed 70; taking the last
       * would report 40 on a pool that reached 70 and is the number worth
       * alarming on.
       */
      await usage.record([bucket({ callPct: 70 })]);
      await usage.record([bucket({ callPct: 40 })]);

      expect(await row()).toMatchObject({ call_pct: 70 });
    });

    it('does not let a null reading erase what Meta already told us', async () => {
      /*
       * THE LINE THIS TABLE EXISTS FOR. Meta omits the header on some responses.
       * `GREATEST` ignores NULLs in Postgres, so a silent response leaves the
       * reading alone; almost any other formulation — COALESCE the wrong way,
       * a plain assignment, LEAST — blanks an 80% reading the moment a quiet
       * call follows it.
       */
      await usage.record([bucket({ callPct: 80, cpuPct: 60, timePct: 55 })]);
      await usage.record([bucket({ callPct: null, cpuPct: null, timePct: null })]);

      expect(await row()).toMatchObject({ call_pct: 80, cpu_pct: 60, time_pct: 55 });
    });

    it('accepts a first reading of null and fills it in later', async () => {
      await usage.record([bucket({ callPct: null })]);
      expect(await row()).toMatchObject({ call_pct: null });

      await usage.record([bucket({ callPct: 33 })]);
      expect(await row()).toMatchObject({ call_pct: 33 });
    });

    it('keeps attribution once learned', async () => {
      /*
       * A flush from a process whose cache had not yet resolved the channel
       * arrives with nulls. Letting it win would blank a name the console is
       * already showing, and the row would flicker between attributed and not.
       */
      await usage.record([bucket()]);
      await usage.record([bucket({ enterpriseId: null, channelId: null, product: null })]);

      const stored = await row();
      expect(stored).toMatchObject({ product: 'instagram' });
      expect(Number(stored?.enterprise_id)).toBe(enterpriseId);
      expect(Number(stored?.channel_id)).toBe(channelId);
    });

    it('keeps separate minutes separate', async () => {
      await usage.record([bucket({ bucketStart: MINUTE, calls: 5 })]);
      await usage.record([bucket({ bucketStart: NEXT_MINUTE, calls: 7 })]);

      const rows: { calls: number }[] = await db.query(
        `SELECT calls FROM meta_api_usage WHERE scope_key = $1 ORDER BY bucket_start`,
        ['IG_ACCOUNT:instagram'],
      );
      expect(rows.map((entry) => entry.calls)).toEqual([5, 7]);
    });

    it('keeps separate pools of one asset separate', async () => {
      await usage.record([
        bucket({ scopeKey: 'PAGE:pages', product: 'pages', callPct: 4 }),
        bucket({ scopeKey: 'PAGE:messenger', product: 'messenger', callPct: 90 }),
      ]);

      expect(await row('PAGE:pages')).toMatchObject({ call_pct: 4 });
      expect(await row('PAGE:messenger')).toMatchObject({ call_pct: 90 });
    });

    it('writes many pools in one statement', async () => {
      const written = await usage.record([
        bucket({ scopeKey: 'a:instagram' }),
        bucket({ scopeKey: 'b:instagram' }),
        bucket({ scopeKey: 'c:instagram' }),
      ]);

      expect(written).toBe(3);
    });

    it('does nothing when there is nothing to write', async () => {
      // The ordinary case on a quiet deployment: no statement at all.
      expect(await usage.record([])).toBe(0);
    });
  });

  describe('attributing Meta ids to channels', () => {
    it('finds the channel behind an id Meta named', async () => {
      const owners = await usage.resolveOwners(['IG_ACCOUNT']);

      expect(owners).toEqual([
        { platformChannelId: 'IG_ACCOUNT', channelId, enterpriseId },
      ]);
    });

    it('returns nothing for an id that is not ours', async () => {
      // A Meta Business id. Expected, not exceptional.
      expect(await usage.resolveOwners(['645699291956344'])).toEqual([]);
    });

    it('ignores a deleted channel', async () => {
      await db.query(`UPDATE channels SET is_deleted = true WHERE id = $1`, [channelId]);

      expect(await usage.resolveOwners(['IG_ACCOUNT'])).toEqual([]);
    });

    it('asks nothing when given nothing', async () => {
      expect(await usage.resolveOwners([])).toEqual([]);
    });
  });

  describe('what the console reads', () => {
    it('returns the NEWEST minute per pool, not every minute', async () => {
      await usage.record([bucket({ bucketStart: MINUTE, callPct: 10 })]);
      await usage.record([bucket({ bucketStart: NEXT_MINUTE, callPct: 20 })]);

      const current = await usage.current();
      const pool = current.find((entry) => entry.scopeKey === 'IG_ACCOUNT:instagram');
      expect(pool?.callPct).toBe(20);
      expect(current.filter((entry) => entry.scopeKey === 'IG_ACCOUNT:instagram')).toHaveLength(1);
    });

    it('totals OUR calls across the window, not just the newest minute', async () => {
      /*
       * The trap this guards: DISTINCT ON returns one row per pool, so summing
       * what it returns reports the last minute's calls and labels them the
       * day's. The totals come from a separate aggregate for that reason.
       */
      const recent = new Date(Date.now() - 60_000);
      const older = new Date(Date.now() - 180_000);
      await usage.record([bucket({ bucketStart: older, lastSeenAt: older, calls: 4 })]);
      await usage.record([bucket({ bucketStart: recent, lastSeenAt: recent, calls: 6 })]);

      const pool = (await usage.current()).find(
        (entry) => entry.scopeKey === 'IG_ACCOUNT:instagram',
      );
      expect(pool?.hourCalls).toBe(10);
      expect(pool?.dayCalls).toBe(10);
    });

    it('separates the hour from the day, because Meta meters over both', async () => {
      const withinHour = new Date(Date.now() - 10 * 60_000);
      const yesterdayish = new Date(Date.now() - 5 * 60 * 60_000);
      await usage.record([
        bucket({ bucketStart: yesterdayish, lastSeenAt: yesterdayish, calls: 100 }),
      ]);
      await usage.record([bucket({ bucketStart: withinHour, lastSeenAt: withinHour, calls: 7 })]);

      const pool = (await usage.current()).find(
        (entry) => entry.scopeKey === 'IG_ACCOUNT:instagram',
      );
      expect(pool?.hourCalls).toBe(7);
      expect(pool?.dayCalls).toBe(107);
    });

    it('names the business and the channel', async () => {
      const now = new Date();
      await usage.record([bucket({ bucketStart: now, lastSeenAt: now })]);

      const pool = (await usage.current()).find(
        (entry) => entry.scopeKey === 'IG_ACCOUNT:instagram',
      );
      expect(pool).toMatchObject({
        enterpriseName: 'Acme',
        channelName: 'The Shop',
        channelPlatform: 'instagram',
        platformChannelId: 'IG_ACCOUNT',
      });
    });

    it('still returns a pool it could not attribute', async () => {
      // Unattributed is a thing to SHOW, not a row to hide: it is quota being
      // spent by somebody.
      const now = new Date();
      await usage.record([
        bucket({
          scopeKey: 'BUSINESS:instagram',
          metaBusinessId: 'BUSINESS',
          enterpriseId: null,
          channelId: null,
          bucketStart: now,
          lastSeenAt: now,
        }),
      ]);

      const pool = (await usage.current()).find(
        (entry) => entry.scopeKey === 'BUSINESS:instagram',
      );
      expect(pool).toMatchObject({ enterpriseName: null, channelName: null });
      expect(pool?.metaBusinessId).toBe('BUSINESS');
    });

    it('leaves out anything older than a day', async () => {
      const ancient = new Date(Date.now() - 30 * 60 * 60_000);
      await usage.record([bucket({ bucketStart: ancient, lastSeenAt: ancient })]);

      expect(await usage.current()).toEqual([]);
    });
  });

  describe('history', () => {
    it('returns the points in a window', async () => {
      const now = new Date();
      await usage.record([bucket({ bucketStart: now, lastSeenAt: now })]);

      const points = await usage.history(60 * 60_000, 100, null);
      expect(points).toHaveLength(1);
      expect(points[0]?.scopeKey).toBe('IG_ACCOUNT:instagram');
    });

    it('narrows to one pool when asked', async () => {
      const now = new Date();
      await usage.record([
        bucket({ bucketStart: now, lastSeenAt: now }),
        bucket({ scopeKey: 'other:pages', bucketStart: now, lastSeenAt: now }),
      ]);

      const points = await usage.history(60 * 60_000, 100, 'other:pages');
      expect(points).toHaveLength(1);
      expect(points[0]?.scopeKey).toBe('other:pages');
    });

    it('keeps the RECENT end when the cap bites', async () => {
      // A chart that silently showed the oldest N points of a window would look
      // like the system had stopped.
      const now = Date.now();
      for (let index = 0; index < 5; index += 1) {
        const at = new Date(now - index * 60_000);
        await usage.record([
          bucket({ scopeKey: `s${index}:instagram`, bucketStart: at, lastSeenAt: at }),
        ]);
      }

      const points = await usage.history(60 * 60_000, 2, null);
      expect(points.map((point) => point.scopeKey)).toEqual(['s0:instagram', 's1:instagram']);
    });
  });

  describe('retention', () => {
    it('removes what is past the window and keeps what is not', async () => {
      const old = new Date(Date.now() - 72 * 60 * 60_000);
      const fresh = new Date();
      await usage.record([
        bucket({ scopeKey: 'old:instagram', bucketStart: old, lastSeenAt: old }),
        bucket({ scopeKey: 'fresh:instagram', bucketStart: fresh, lastSeenAt: fresh }),
      ]);

      const removed = await usage.sweep(48 * 60 * 60_000, 500);

      expect(removed).toBe(1);
      expect(await row('old:instagram')).toBeUndefined();
      expect(await row('fresh:instagram')).toBeDefined();
    });

    it('respects the batch limit, so one pass cannot run unbounded', async () => {
      const old = new Date(Date.now() - 72 * 60 * 60_000);
      await usage.record(
        [0, 1, 2, 3, 4].map((index) =>
          bucket({ scopeKey: `old${index}:instagram`, bucketStart: old, lastSeenAt: old }),
        ),
      );

      expect(await usage.sweep(48 * 60 * 60_000, 2)).toBe(2);
    });
  });

  describe('the guards on the table itself', () => {
    it('refuses a percentage that could not be one', async () => {
      // A monitor that silently reports a wrong number is worse than one that
      // fails loudly, so the range is a CHECK rather than a convention.
      await expect(
        db.query(
          `INSERT INTO meta_api_usage
             (scope_key, meter, bucket_start, call_pct, last_seen_at)
           VALUES ('bad','app',now(),-5,now())`,
        ),
      ).rejects.toThrow();
    });

    it('refuses a negative call count', async () => {
      await expect(
        db.query(
          `INSERT INTO meta_api_usage
             (scope_key, meter, bucket_start, calls, last_seen_at)
           VALUES ('bad','app',now(),-1,now())`,
        ),
      ).rejects.toThrow();
    });

    it('refuses two rows for the same pool and minute', async () => {
      await usage.record([bucket()]);

      await expect(
        db.query(
          `INSERT INTO meta_api_usage
             (scope_key, meter, bucket_start, last_seen_at)
           VALUES ($1,'business_use_case',$2,now())`,
          ['IG_ACCOUNT:instagram', MINUTE],
        ),
      ).rejects.toThrow();
    });
  });
});
