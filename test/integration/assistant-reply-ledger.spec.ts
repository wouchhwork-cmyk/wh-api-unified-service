import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { AssistantReplyRepository } from '@/database/repositories/assistant-reply.repository';
import { AssistantReplyStatus } from '@/shared/enums';
import {
  createTestDataSource,
  returningRows,
  seedEnterprise,
  truncateTenantData,
} from './db.harness';

/**
 * The queue of replies the assistant owes, against real Postgres.
 *
 * EVERY GUARANTEE HERE IS A DATABASE GUARANTEE — a unique index, a claim with
 * SKIP LOCKED, a conditional status transition — and a mocked repository
 * would accept all of it while proving none of it. The one that matters most
 * is the first: two obligations for one message means a customer receives two
 * replies to one sentence, and there is no undo for that.
 */
describe('the assistant reply ledger', () => {
  let db: DataSource;
  let replies: AssistantReplyRepository;
  let enterpriseId: number;
  let otherEnterpriseId: number;
  let conversationId: number;
  let messageId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    replies = new AssistantReplyRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    await db.query(`DELETE FROM assistant_replies`);
    enterpriseId = await seedEnterprise(db, 'Reply Co', 'reply-co');
    otherEnterpriseId = await seedEnterprise(db, 'Rival Co', 'rival-co');
    ({ conversationId, messageId } = await seedInbound(enterpriseId));
  });

  /** A conversation with one inbound message in it, the thing a reply is owed to. */
  async function seedInbound(
    owner: number,
  ): Promise<{ conversationId: number; messageId: number }> {
    const key = `${owner}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const connection = returningRows<{ id: string }>(
      await db.query(
        `INSERT INTO provider_connections
           (enterprise_id, provider, provider_category, provider_user_id, access_token)
         VALUES ($1,'meta','social',$2,'envelope') RETURNING id`,
        [owner, `user-${key}`],
      ),
    )[0];
    const channel = returningRows<{ id: string }>(
      await db.query(
        `INSERT INTO channels
           (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id)
         VALUES ($1,$2,'instagram','instagram_business',$3) RETURNING id`,
        [connection?.id, owner, `ch-${key}`],
      ),
    )[0];
    const customer = returningRows<{ id: string }>(
      await db.query(
        `INSERT INTO customers (enterprise_id, display_name, first_source)
         VALUES ($1,'A Customer','instagram_dm') RETURNING id`,
        [owner],
      ),
    )[0];
    const conversation = returningRows<{ id: string }>(
      await db.query(
        `INSERT INTO conversations
           (enterprise_id, channel_id, customer_id, platform, conversation_kind,
            platform_thread_id, status)
         VALUES ($1,$2,$3,'instagram','direct_message',$4,'open') RETURNING id`,
        [owner, channel?.id, customer?.id, `dm:${key}`],
      ),
    )[0];
    const message = returningRows<{ id: string }>(
      await db.query(
        `INSERT INTO messages
           (enterprise_id, conversation_id, customer_id, direction, message_kind, body)
         VALUES ($1,$2,$3,'inbound','text','are you open?') RETURNING id`,
        [owner, conversation?.id, customer?.id],
      ),
    )[0];
    return { conversationId: Number(conversation?.id), messageId: Number(message?.id) };
  }

  /*
   * NO "make it due" STEP, and that is worth saying.
   *
   * A row written with `next_attempt_at = now()` sits up to half a
   * millisecond in the FUTURE, because every timestamp here stores
   * milliseconds and Postgres ROUNDS to that precision rather than
   * truncating. Two older specs work around it by writing
   * `now() - interval '1 second'` when they mean "already due". The shared
   * claim compares at the stored precision instead, so a row enqueued with
   * no delay is claimable immediately — which is what the code is supposed
   * to mean, and what these tests now prove rather than arrange.
   */
  const enqueue = (id = messageId, delayMs = 0) =>
    replies.enqueue({ enterpriseId, messageId: id, delayMs });

  const claim = (owner = 'worker-a', limit = 5) => replies.claimDueBatch(owner, limit, 60);

  describe('one obligation per message', () => {
    it('records that a message is owed an answer', async () => {
      await expect(enqueue()).resolves.toBe(true);

      const [claimed] = await claim();
      expect(claimed).toMatchObject({ enterpriseId, conversationId, messageId });
    });

    /**
     * THE MISTAKE THAT REACHES A CUSTOMER. A redelivered webhook and a
     * retried projection both arrive with the same message; two rows would
     * be two replies to one sentence.
     */
    it('refuses a second obligation for the same message', async () => {
      await expect(enqueue()).resolves.toBe(true);
      await expect(enqueue()).resolves.toBe(false);

      expect(await claim()).toHaveLength(1);
    });

    it('takes the conversation from the message rather than from the caller', async () => {
      await enqueue();
      const [claimed] = await claim();
      expect(claimed?.conversationId).toBe(conversationId);
    });

    it('creates no obligation to answer a message that is not there', async () => {
      await expect(enqueue(999_999)).resolves.toBe(false);
      expect(await claim()).toHaveLength(0);
    });

    it('will not queue one business a reply to another business’s message', async () => {
      const theirs = await seedInbound(otherEnterpriseId);
      await expect(
        replies.enqueue({ enterpriseId, messageId: theirs.messageId, delayMs: 0 }),
      ).resolves.toBe(false);
    });
  });

  describe('the pause before answering', () => {
    /*
     * People type in bursts, and answering the first of three messages means
     * answering a third of a question. It was a setTimeout before this table
     * existed, which a restart dropped along with the reply.
     */
    it('is not due until the pause has passed', async () => {
      await enqueue(messageId, 60_000);
      expect(await claim()).toHaveLength(0);
    });

    it('is due once it has', async () => {
      await enqueue(messageId, 0);
      expect(await claim()).toHaveLength(1);
    });
  });

  describe('claiming', () => {
    it('never hands the same row to two workers', async () => {
      await enqueue();

      const [first, second] = await Promise.all([claim('worker-a'), claim('worker-b')]);
      expect(first.length + second.length).toBe(1);
    });

    it('counts the attempt as it claims', async () => {
      await enqueue();
      const [claimed] = await claim();
      expect(claimed?.attemptCount).toBe(1);
    });

    it('does not claim a row that is already settled', async () => {
      await enqueue();
      const [claimed] = await claim();
      await replies.markSent(claimed!.id, 'worker-a', sent());

      expect(await claim()).toHaveLength(0);
    });
  });

  describe('settling', () => {
    const settled = async () =>
      (
        await db.query<{ status: string; attempt_count: number; skip_reason: string | null }[]>(
          `SELECT status, attempt_count, skip_reason FROM assistant_replies LIMIT 1`,
        )
      )[0];

    it('records what answered it, for the question somebody actually asks', async () => {
      await enqueue();
      const [claimed] = await claim();
      await replies.markSent(claimed!.id, 'worker-a', sent());

      const row = (
        await db.query<{ model: string; intent: string; total_tokens: number }[]>(
          `SELECT model, intent, total_tokens FROM assistant_replies LIMIT 1`,
        )
      )[0];
      expect(row).toMatchObject({ model: 'gpt-6-luna', intent: 'asking opening hours' });
      expect(Number(row?.total_tokens)).toBe(120);
    });

    it('files a deliberate silence as skipped rather than failed', async () => {
      await enqueue();
      const [claimed] = await claim();
      await replies.markSkipped(claimed!.id, 'worker-a', 'nothing_to_say');

      expect(await settled()).toMatchObject({
        status: AssistantReplyStatus.Skipped,
        skip_reason: 'nothing_to_say',
      });
    });

    it('refuses a settle from a worker that does not hold the lease', async () => {
      await enqueue();
      const [claimed] = await claim('worker-a');

      await expect(replies.markSent(claimed!.id, 'worker-b', sent())).resolves.toBe(false);
      expect((await settled())?.status).toBe(AssistantReplyStatus.InFlight);
    });

    /*
     * `backoffMs: 0` would write `next_attempt_at = now()`, which rounds up
     * to half a millisecond into the future at this column's precision and
     * is briefly not due — see timestamp-precision.ts. Production never
     * notices, because the writer and the claimer are worker ticks seconds
     * apart; a test reading back inside the same millisecond does, so it
     * says what it means instead.
     */
    const failOnce = async () => {
      const [claimed] = await claim();
      await replies.markFailed(claimed!.id, 'worker-a', {
        failureCode: 'CHAT_TIMEOUT',
        failureReason: 'the model did not answer',
        permanent: false,
        /* Due again at once: the backoff itself is covered below. */
        backoffMs: 0,
      });
    };

    it('keeps retrying while attempts remain', async () => {
      await enqueue();
      await failOnce();

      expect((await settled())?.status).toBe(AssistantReplyStatus.Failed);
      expect(await claim()).toHaveLength(1);
    });

    it('waits out the backoff before trying again', async () => {
      await enqueue();
      const [claimed] = await claim();
      await replies.markFailed(claimed!.id, 'worker-a', {
        failureCode: 'CHAT_TIMEOUT',
        failureReason: 'the model did not answer',
        permanent: false,
        backoffMs: 60_000,
      });

      expect(await claim()).toHaveLength(0);
    });

    it('gives up once they are spent', async () => {
      await enqueue();
      for (let attempt = 0; attempt < 3; attempt += 1) await failOnce();

      expect((await settled())?.status).toBe(AssistantReplyStatus.Unavailable);
      expect(await claim()).toHaveLength(0);
    });
  });

  describe('waiting for a photo to be described', () => {
    /*
     * A slow download is not a failed attempt. Charging it against
     * max_attempts would write off a perfectly answerable message because
     * somebody's photo took a while to fetch.
     */
    it('puts the row back without spending the attempt', async () => {
      await enqueue();
      const [claimed] = await claim();
      await replies.defer(claimed!.id, 'worker-a', 60_000);

      const row = (
        await db.query<{ status: string; attempt_count: number }[]>(
          `SELECT status, attempt_count FROM assistant_replies LIMIT 1`,
        )
      )[0];
      expect(row?.status).toBe(AssistantReplyStatus.Pending);
      expect(Number(row?.attempt_count)).toBe(0);
    });

    it('is not due again until the wait has passed', async () => {
      await enqueue();
      const [claimed] = await claim();
      await replies.defer(claimed!.id, 'worker-a', 60_000);

      expect(await claim()).toHaveLength(0);
    });

    it('comes forward the moment the description lands', async () => {
      await enqueue();
      const [claimed] = await claim();
      await replies.defer(claimed!.id, 'worker-a', 60_000);

      await expect(replies.wake(enterpriseId, [messageId])).resolves.toBe(1);
      expect(await claim()).toHaveLength(1);
    });

    it('never wakes a row that is already settled', async () => {
      await enqueue();
      const [claimed] = await claim();
      await replies.markSkipped(claimed!.id, 'worker-a', 'nothing_to_say');

      await expect(replies.wake(enterpriseId, [messageId])).resolves.toBe(0);
    });

    it('will not let one business wake another’s queue', async () => {
      await enqueue();
      await expect(replies.wake(otherEnterpriseId, [messageId])).resolves.toBe(0);
    });
  });

  describe('a worker that died holding the lease', () => {
    it('returns the row to the queue, keeping the attempt it spent', async () => {
      await enqueue();
      const [claimed] = await claim();
      await db.query(
        `UPDATE assistant_replies SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
        [claimed!.id],
      );

      await expect(replies.reclaimExpiredLeases()).resolves.toBe(1);

      const [again] = await claim();
      /* Two: the one the dead worker spent, and this one. A reply whose
       * worker keeps dying must not be retried for ever. */
      expect(again?.attemptCount).toBe(2);
    });
  });

  function sent() {
    return {
      replyMessageId: null,
      provider: 'openai',
      model: 'gpt-6-luna',
      promptVersion: 3,
      intent: 'asking opening hours',
      handoffReason: null,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    };
  }
});
