import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ConversationRepository } from '@/database/repositories/conversation.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { PostRepository } from '@/database/repositories/post.repository';
import { TransactionManager } from '@/database/transaction';
import { GraphApiError } from '@/modules/connections/graph/graph-api.error';
import { CommentProjectorService } from '@/modules/inbox/comment-projector.service';
import { ConversationKind, Platform } from '@/shared/enums';
import { createTestDataSource, truncateTenantData } from './db.harness';

function silentLogger(): never {
  return {
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  } as never;
}

/**
 * A live Instagram mention, end to end.
 *
 * The `mentions` webhook carries two ids and nothing else, so the projector has
 * to call the Mentions API before it can store anything. Everything below is
 * the real payload and the real resolution observed on 6 September 2026
 * (docs/platform-limitations.md §1.2-1.4).
 *
 * Against real Postgres because the point is WHERE things land: the tagged post
 * belongs on the conversation, not the message, since answering a mention needs
 * the media id and the reply path reads it from there.
 */
describe('instagram mention projection', () => {
  let db: DataSource;
  let enterpriseId: number;
  let channelId: number;

  const WEBHOOK = {
    field: 'mentions',
    value: { media_id: '18141779110574991', comment_id: '18090191117413844' },
  };

  /** What `mentioned_comment` actually returned for that mention. */
  const RESOLUTION = {
    authorUsername: 'genzrelics',
    text: '@ai_automation_demo check this out , its good no',
    timestamp: '2026-09-06T15:06:59+0000',
    mediaId: '18141779110574991',
    permalink: 'https://www.instagram.com/p/Dc53LpVs_06/',
    mediaOwnerUsername: 'alpha_series369',
    media: {
      id: '18141779110574991',
      caption: 'Just Man things',
      permalink: 'https://www.instagram.com/p/Dc53LpVs_06/',
      ownerUsername: 'alpha_series369',
      mediaType: 'IMAGE',
      mediaUrl: 'https://scontent.cdninstagram.com/v/whatever.jpg',
      timestamp: '2026-09-05T11:32:41+0000',
      likeCount: 6447,
      commentsCount: 43,
    },
    replies: [
      {
        platformId: 'R1',
        text: '@genzrelics are you there',
        timestamp: '2026-09-06T15:08:10+0000',
        likeCount: 0,
      },
      // A media-only reply: Meta returns no text and no field recovers it.
      { platformId: 'R2', text: null, timestamp: '2026-09-06T15:09:00+0000', likeCount: 0 },
    ],
    // The tagged post's own comment section — anonymous, and none of it ours.
    postComments: [
      { platformId: 'P1', text: 'Reality 😅', timestamp: '2026-09-06T14:50:03+0000', likeCount: 0 },
    ],
  };

  function projector(resolve: () => Promise<unknown>): CommentProjectorService {
    return new CommentProjectorService(
      new CustomerRepository(db),
      new ConversationRepository(db),
      new MessageRepository(db),
      new ChannelRepository(db),
      new PostRepository(db),
      { resolveInstagramMention: resolve } as never,
      { decrypt: () => 'TOKEN' } as never,
      new TransactionManager(db, silentLogger()),
      silentLogger(),
    );
  }

  async function event(key: string): Promise<number> {
    const rows: { id: string }[] = await db.query(
      `INSERT INTO inbound_events
         (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key, payload)
       VALUES ($1,$2,'webhook','instagram','mention',$3,'{}') RETURNING id`,
      [enterpriseId, channelId, key],
    );
    return Number(rows[0]?.id);
  }

  beforeAll(async () => {
    db = await createTestDataSource();
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    const enterprise: { id: string }[] = await db.query(
      `INSERT INTO enterprises (name, slug, email) VALUES ('Acme','acme','a@acme.test') RETURNING id`,
    );
    enterpriseId = Number(enterprise[0]?.id);
    const connection: { id: string }[] = await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social','fbu','envelope') RETURNING id`,
      [enterpriseId],
    );
    const channel: { id: string }[] = await db.query(
      `INSERT INTO channels
         (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id, access_token)
       VALUES ($1,$2,'instagram','instagram_business','IG_1','envelope') RETURNING id`,
      [connection[0]?.id, enterpriseId],
    );
    channelId = Number(channel[0]?.id);
  });

  it('resolves a bare mention webhook into a real conversation', async () => {
    const outcome = await projector(async () => RESOLUTION).projectMention(
      enterpriseId,
      channelId,
      Platform.Instagram,
      await event('m1'),
      WEBHOOK,
      ['IG_1'],
    );

    expect(outcome.projected).toBe(true);

    const rows: {
      body: string;
      conversation_kind: string;
      context_metadata: Record<string, unknown>;
      display_name: string;
    }[] = await db.query(
      `SELECT m.body, cv.conversation_kind, cv.context_metadata, cu.display_name
         FROM messages m
         JOIN conversations cv ON cv.id = m.conversation_id
         JOIN customers cu ON cu.id = m.customer_id
        WHERE m.platform_message_id = '18090191117413844'`,
    );

    expect(rows[0]?.body).toBe('@ai_automation_demo check this out , its good no');
    expect(rows[0]?.conversation_kind).toBe(ConversationKind.Mention);
    // WHO TAGGED US — not the post's owner.
    expect(rows[0]?.display_name).toBe('genzrelics');

    /*
     * The media id has to be on the CONVERSATION. Meta's mentions edge needs it
     * to post a reply, and without it an agent's answer dead-letters after they
     * have typed it.
     */
    const context = rows[0]?.context_metadata ?? {};
    expect(context.mentionedMediaId).toBe('18141779110574991');
    expect(context.postPermalink).toBe('https://www.instagram.com/p/Dc53LpVs_06/');
    expect(context.postOwnerUsername).toBe('alpha_series369');
    expect((context.postDetails as Record<string, unknown>).likeCount).toBe(6447);
    expect((context.replyThread as unknown[]).length).toBe(2);
  });

  it('skips rather than inventing an author when the mention will not resolve', async () => {
    /*
     * A deleted comment, or a post gone private. The event must not be projected
     * with a made-up author, and must not retry against Meta forever.
     */
    const outcome = await projector(async () => null).projectMention(
      enterpriseId,
      channelId,
      Platform.Instagram,
      await event('m2'),
      WEBHOOK,
      ['IG_1'],
    );

    expect(outcome.projected).toBe(false);
    expect(outcome.reason).toContain('carries no author');

    const count: { count: number }[] = await db.query(`SELECT count(*)::int FROM messages`);
    expect(count[0]?.count).toBe(0);
  });

  it('skips a PERMANENT Mentions API failure for the honest reason', async () => {
    /*
     * A refusal that will never succeed — a deleted comment, a post gone
     * private — must not fail the projection or be retried forever. There is
     * still no author to project, so it skips and says so.
     */
    const outcome = await projector(async () => {
      throw new Error('graph is down');
    }).projectMention(enterpriseId, channelId, Platform.Instagram, await event('m3'), WEBHOOK, [
      'IG_1',
    ]);

    expect(outcome.projected).toBe(false);
    expect(outcome.reason).toContain('carries no author');
  });

  it('RETRIES a throttled mention instead of writing it off', async () => {
    /*
     * This is the case that cost us a real mention. Twelve replays in a burst
     * hit a rate limit; the resolver swallowed it, the normalizer saw a payload
     * with no author, and the event went TERMINAL as "carries no author" —
     * describing the webhook rather than what happened.
     *
     * A retryable Graph failure must throw, so the ledger asks again with
     * backoff once the limit clears.
     */
    const throttled = new GraphApiError(
      429,
      4,
      null,
      'OAuthException',
      'trace',
      'Application request limit reached',
    );

    await expect(
      projector(async () => {
        throw throttled;
      }).projectMention(enterpriseId, channelId, Platform.Instagram, await event('m4'), WEBHOOK, [
        'IG_1',
      ]),
    ).rejects.toThrow(/will be retried/u);
  });
});

/**
 * Linking a mention to the mention it answered.
 *
 * A tag placed in a reply to another tag gives us TWO conversations for one
 * exchange, and both halves of the link were already stored — the child keeps
 * `mentionParentId`, the parent keeps `mentionedCommentId`, and they are the
 * same comment id. Nothing derived it, so an agent saw the parent's words
 * duplicated into the child with no way to reach the thread they belong to.
 *
 * Observed live on 9 Sep 2026: conversation 153 answered conversation 151 and
 * the API reported no relationship at all.
 */
describe('findMentionByCommentId', () => {
  let db: DataSource;
  let ours: { id: number; channelId: number };
  let theirs: { id: number; channelId: number };

  beforeAll(async () => {
    db = await createTestDataSource();
  });
  afterAll(async () => {
    await db.destroy();
  });

  /*
   * A tenant needs its OWN channel: `conversations_channel_fk` is composite on
   * (channel_id, enterprise_id), so one business cannot borrow another's — which
   * is the isolation this suite is here to check, and it fails closed at the
   * schema before any query runs.
   */
  async function seedEnterprise(slug: string): Promise<{ id: number; channelId: number }> {
    const rows: { id: string }[] = await db.query(
      `INSERT INTO enterprises (name, slug, email) VALUES ($1,$1,$2) RETURNING id`,
      [slug, `${slug}@test.test`],
    );
    const id = Number(rows[0]?.id);

    const connection: { id: string }[] = await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social',$2,'envelope') RETURNING id`,
      [id, `fbu-${slug}`],
    );
    const channel: { id: string }[] = await db.query(
      `INSERT INTO channels
         (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id)
       VALUES ($1,$2,'instagram','instagram_business',$3) RETURNING id`,
      [connection[0]?.id, id, `IG_${slug}`],
    );
    return { id, channelId: Number(channel[0]?.id) };
  }

  /** A mention conversation carrying the two ids the link is derived from. */
  async function seedMention(
    forEnterprise: { id: number; channelId: number },
    threadKey: string,
    ownCommentId: string,
    parentCommentId: string | null,
  ): Promise<string> {
    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source)
       VALUES ($1,'tagger','instagram_comment') RETURNING id`,
      [forEnterprise.id],
    );
    const context: Record<string, unknown> = { mentionedCommentId: ownCommentId };
    if (parentCommentId) context.mentionParentId = parentCommentId;

    const rows: { ref_id: string }[] = await db.query(
      `INSERT INTO conversations
         (enterprise_id, channel_id, customer_id, platform, conversation_kind,
          platform_thread_id, subject, context_metadata)
       VALUES ($1,$2,$3,'instagram',$4,$5,$6,$7::jsonb) RETURNING ref_id`,
      [
        forEnterprise.id,
        forEnterprise.channelId,
        Number(customer[0]?.id),
        ConversationKind.Mention,
        threadKey,
        `subject ${ownCommentId}`,
        JSON.stringify(context),
      ],
    );
    return String(rows[0]?.ref_id);
  }

  beforeEach(async () => {
    await truncateTenantData(db);
    ours = await seedEnterprise('acme');
    theirs = await seedEnterprise('rival');
  });

  it('finds the parent mention by the comment it is about', async () => {
    const parentRef = await seedMention(ours, 'mention:PARENT', 'C_PARENT', null);
    await seedMention(ours, 'mention:CHILD', 'C_CHILD', 'C_PARENT');

    const found = await new ConversationRepository(db).findMentionByCommentId(ours.id, 'C_PARENT');

    expect(found?.refId).toBe(parentRef);
    expect(found?.subject).toBe('subject C_PARENT');
  });

  it('returns null when the parent is a stranger comment we do not hold', async () => {
    // The common case: the tag sat under somebody else's comment, which Meta
    // will not describe at all.
    await seedMention(ours, 'mention:CHILD', 'C_CHILD', 'C_STRANGER');

    const found = await new ConversationRepository(db).findMentionByCommentId(
      ours.id,
      'C_STRANGER',
    );
    expect(found).toBeNull();
  });

  it('never reaches across the tenant boundary', async () => {
    /*
     * The comment id is a PLATFORM id, so two businesses tagged in the same
     * comment thread hold the same value. Without the enterprise predicate this
     * lookup would hand one business a link into another's conversation.
     */
    await seedMention(theirs, 'mention:THEIRS', 'C_SHARED', null);

    const found = await new ConversationRepository(db).findMentionByCommentId(ours.id, 'C_SHARED');
    expect(found).toBeNull();
  });

  it('ignores a soft-deleted conversation', async () => {
    await seedMention(ours, 'mention:GONE', 'C_GONE', null);
    await db.query(
      `UPDATE conversations SET is_deleted = true WHERE platform_thread_id = 'mention:GONE'`,
    );

    const found = await new ConversationRepository(db).findMentionByCommentId(ours.id, 'C_GONE');
    expect(found).toBeNull();
  });
});
