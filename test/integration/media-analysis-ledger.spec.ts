import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { MediaAnalysisRepository } from '@/database/repositories/media-analysis.repository';
import { PlatformSettingRepository } from '@/database/repositories/platform-setting.repository';
import { MediaAnalysisStatus, MediaKind } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * The media-analysis ledger, against real Postgres.
 *
 * EVERY GUARANTEE HERE IS A DATABASE GUARANTEE — a unique index, a claim with
 * SKIP LOCKED, a conditional status transition. A mocked repository would
 * accept all of it and prove none of it, and the one that matters most costs
 * real money when it is wrong: analysing the same media twice.
 */
describe('the media analysis ledger', () => {
  let db: DataSource;
  let analyses: MediaAnalysisRepository;
  let settings: PlatformSettingRepository;
  let enterpriseId: number;
  let otherEnterpriseId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    analyses = new MediaAnalysisRepository(db);
    settings = new PlatformSettingRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    await db.query(`DELETE FROM media_analyses`);
    /*
     * `platform_settings` is NOT tenant data, so `truncateTenantData` rightly
     * leaves it alone — which means a version counter survives between runs
     * and these assertions would drift upwards for ever. Determinism is the
     * test's job, not the harness's.
     */
    await db.query(
      `DELETE FROM platform_settings WHERE key IN ('media_analysis_test', 'never_written')`,
    );
    enterpriseId = await seedEnterprise(db, 'Media Co', 'media-co');
    otherEnterpriseId = await seedEnterprise(db, 'Rival Co', 'rival-co');
  });

  const seed = (mediaKey: string, kind = MediaKind.Image) => ({
    mediaKey,
    mediaKind: kind,
    mimeType: 'image/jpeg',
  });

  describe('once per unique media', () => {
    /**
     * THE EXPENSIVE MISTAKE. A refreshed CDN link is the same media with a new
     * signature; if it queued again we would pay a model to describe a photo
     * we have already described.
     */
    it('queues a piece of media once, however many times it arrives', async () => {
      expect(await analyses.enqueueMany(enterpriseId, [seed('asset:1')])).toBe(1);
      expect(await analyses.enqueueMany(enterpriseId, [seed('asset:1')])).toBe(0);
      expect(await analyses.enqueueMany(enterpriseId, [seed('asset:1')])).toBe(0);

      const [row] = await db.query(
        `SELECT count(*)::int AS n FROM media_analyses WHERE enterprise_id = $1`,
        [enterpriseId],
      );
      expect(row.n).toBe(1);
    });

    it('still queues the others when one of a batch is already known', async () => {
      await analyses.enqueueMany(enterpriseId, [seed('asset:1')]);
      const queued = await analyses.enqueueMany(enterpriseId, [
        seed('asset:1'),
        seed('asset:2'),
        seed('asset:3'),
      ]);
      expect(queued).toBe(2);
    });

    /**
     * An asset id is META'S, not ours. Two businesses could in principle be
     * sent the same file, and one must never read the other's description of
     * it — which is why the unique index is scoped by enterprise.
     */
    it('lets two businesses hold the same asset without sharing a row', async () => {
      await analyses.enqueueMany(enterpriseId, [seed('asset:shared')]);
      expect(await analyses.enqueueMany(otherEnterpriseId, [seed('asset:shared')])).toBe(1);

      const rows = await analyses.findByKeys(enterpriseId, ['asset:shared']);
      expect(rows).toHaveLength(1);
    });

    it('does nothing when asked to queue nothing', async () => {
      expect(await analyses.enqueueMany(enterpriseId, [])).toBe(0);
    });
  });

  describe('claiming work', () => {
    it('claims due rows and leaves them in flight', async () => {
      await analyses.enqueueMany(enterpriseId, [seed('asset:1'), seed('asset:2')]);
      const claimed = await analyses.claimDueBatch('worker-a', 10, 60);

      expect(claimed).toHaveLength(2);
      expect(claimed[0]?.attemptCount).toBe(1);
      const [row] = await db.query(
        `SELECT count(*)::int AS n FROM media_analyses WHERE status = $1`,
        [MediaAnalysisStatus.InFlight],
      );
      expect(row.n).toBe(2);
    });

    /** SKIP LOCKED: two workers can never take the same row. */
    it('never hands the same row to two workers', async () => {
      await analyses.enqueueMany(enterpriseId, [seed('asset:1')]);
      const first = await analyses.claimDueBatch('worker-a', 10, 60);
      const second = await analyses.claimDueBatch('worker-b', 10, 60);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
    });

    it('does not claim a row that is waiting out its backoff', async () => {
      await analyses.enqueueMany(enterpriseId, [seed('asset:1')]);
      await db.query(`UPDATE media_analyses SET next_attempt_at = now() + interval '1 hour'`);
      expect(await analyses.claimDueBatch('worker-a', 10, 60)).toHaveLength(0);
    });

    /**
     * A worker killed mid-call leaves a row in flight with nobody working it.
     * The claim only looks at pending and failed, so without this it would sit
     * there for ever.
     */
    it('returns a lapsed lease to the queue', async () => {
      await analyses.enqueueMany(enterpriseId, [seed('asset:1')]);
      await analyses.claimDueBatch('worker-a', 10, 60);
      await db.query(`UPDATE media_analyses SET lease_expires_at = now() - interval '1 minute'`);

      expect(await analyses.reclaimExpiredLeases()).toBe(1);
      expect(await analyses.claimDueBatch('worker-b', 10, 60)).toHaveLength(1);
    });
  });

  describe('settling', () => {
    const claimOne = async (key = 'asset:1') => {
      await analyses.enqueueMany(enterpriseId, [seed(key)]);
      const [claimed] = await analyses.claimDueBatch('worker-a', 10, 60);
      if (!claimed) throw new Error('nothing claimed');
      return claimed;
    };

    it('writes the description and clears the lease', async () => {
      const claimed = await claimOne();
      const settled = await analyses.markDone(claimed.id, 'worker-a', {
        summary: 'A plate of fries.',
        transcript: null,
        model: 'gemini-2.5-flash-lite',
        promptVersion: 1,
        inputTokens: 300,
        outputTokens: 40,
        totalTokens: 340,
      });

      expect(settled).toBe(true);
      const [row] = await analyses.findByKeys(enterpriseId, ['asset:1']);
      expect(row?.status).toBe(MediaAnalysisStatus.Done);
      expect(row?.summary).toBe('A plate of fries.');
      expect(row?.analyzedAt).toBeInstanceOf(Date);
    });

    /**
     * THE LEASE IS THE GUARD. A worker that timed out, had its row reclaimed
     * and then finished anyway must not overwrite whoever picked it up next.
     */
    it('refuses a write from a worker that no longer holds the lease', async () => {
      const claimed = await claimOne();
      const settled = await analyses.markDone(claimed.id, 'worker-b', {
        summary: 'written by the wrong worker',
        transcript: null,
        model: 'm',
        promptVersion: 1,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      });
      expect(settled).toBe(false);
    });

    it('retries a transient failure and backs off', async () => {
      const claimed = await claimOne();
      await analyses.markFailed(claimed.id, 'worker-a', {
        failureCode: 'MEDIA_MODEL_FAILED',
        failureReason: 'upstream hiccup',
        permanent: false,
        backoffMs: 60_000,
      });

      const [row] = await db.query(
        `SELECT status, next_attempt_at FROM media_analyses WHERE id = $1`,
        [claimed.id],
      );
      expect(row.status).toBe(MediaAnalysisStatus.Failed);
      expect(row.next_attempt_at).not.toBeNull();
    });

    /**
     * An expired link cannot be un-expired. Going straight to `unavailable`
     * saves two more attempts and two backoff windows to reach the same place.
     */
    it('gives up immediately on a permanent failure', async () => {
      const claimed = await claimOne();
      await analyses.markFailed(claimed.id, 'worker-a', {
        failureCode: 'MEDIA_EXPIRED',
        failureReason: 'the media link has expired',
        permanent: true,
        backoffMs: 60_000,
      });

      const [row] = await db.query(
        `SELECT status, next_attempt_at FROM media_analyses WHERE id = $1`,
        [claimed.id],
      );
      expect(row.status).toBe(MediaAnalysisStatus.Unavailable);
      expect(row.next_attempt_at).toBeNull();
    });

    it('gives up once the attempts are spent', async () => {
      const claimed = await claimOne();
      await db.query(`UPDATE media_analyses SET attempt_count = max_attempts WHERE id = $1`, [
        claimed.id,
      ]);
      await analyses.markFailed(claimed.id, 'worker-a', {
        failureCode: 'MEDIA_MODEL_FAILED',
        failureReason: 'still failing',
        permanent: false,
        backoffMs: 60_000,
      });

      const [row] = await db.query(`SELECT status FROM media_analyses WHERE id = $1`, [claimed.id]);
      expect(row.status).toBe(MediaAnalysisStatus.Unavailable);
    });
  });

  describe('what the console reads', () => {
    it('counts the queue by status and kind', async () => {
      await analyses.enqueueMany(enterpriseId, [
        seed('asset:1', MediaKind.Image),
        seed('asset:2', MediaKind.Image),
        seed('asset:3', MediaKind.Video),
      ]);

      const stats = await analyses.statsAcrossPlatform();
      const pendingImages = stats.find(
        (row) => row.status === MediaAnalysisStatus.Pending && row.mediaKind === MediaKind.Image,
      );
      expect(pendingImages?.count).toBe(2);
      expect(stats.reduce((sum, row) => sum + row.count, 0)).toBe(3);
    });

    it('adds up what has been spent', async () => {
      await analyses.enqueueMany(enterpriseId, [seed('asset:1')]);
      const [claimed] = await analyses.claimDueBatch('worker-a', 1, 60);
      await analyses.markDone(claimed!.id, 'worker-a', {
        summary: 'x',
        transcript: null,
        model: 'gemini-2.5-flash-lite',
        promptVersion: 1,
        inputTokens: 300,
        outputTokens: 40,
        totalTokens: 340,
      });

      expect(await analyses.tokenTotals()).toEqual({ analyses: 1, totalTokens: 340 });
    });
  });

  describe('the instruction staff edit', () => {
    /**
     * THE VERSION IS WHAT OTHER ROWS POINT AT. An analysis records the prompt
     * version that produced it, so the number has to move on every change or
     * two different instructions share one id.
     */
    it('bumps the version on every save', async () => {
      const first = await settings.put('media_analysis_test', { prompt: 'one' }, null);
      const second = await settings.put('media_analysis_test', { prompt: 'two' }, null);

      expect(first.version).toBe(1);
      expect(second.version).toBe(2);
      expect(second.value.prompt).toBe('two');
    });

    it('starts existing when it is first written', async () => {
      expect(await settings.find('never_written')).toBeNull();
      await settings.put('never_written', { a: 1 }, null);
      expect((await settings.find('never_written'))?.value).toEqual({ a: 1 });
    });
  });
});
