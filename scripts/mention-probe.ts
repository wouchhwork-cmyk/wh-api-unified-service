/**
 * What ELSE will Meta tell us about a post we were mentioned in?
 *
 *   node --env-file=.env.dev --import tsx scripts/mention-probe.ts <media_id> [comment_id]
 *
 * READ ONLY — no comment is posted, nothing is written. Two questions:
 *   1. does `mentioned_media` expand a CAROUSEL into its slides?
 *   2. what does Meta say about our ability to comment on it?
 */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

async function main(): Promise<void> {
  const mediaId = process.argv[2];
  if (!mediaId) throw new Error('give a media_id');

  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();
  const rows: { access_token: string; platform_channel_id: string }[] = await ds.query(
    `SELECT c.access_token, c.platform_channel_id FROM channels c
      WHERE c.platform = 'instagram' AND c.is_deleted = false LIMIT 1`,
  );
  const ig = rows[0];
  const tokenRows: { access_token: string }[] = await ds.query(
    `SELECT access_token FROM channels
      WHERE platform = 'facebook' AND is_deleted = false AND access_token IS NOT NULL LIMIT 1`,
  );
  const token = new TokenCipherService(config as never).decrypt(
    (ig?.access_token || tokenRows[0]?.access_token) as string,
  );
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');
  const version = config.meta.graphApiVersion;
  const igId = ig?.platform_channel_id as string;

  const ask = async (label: string, fields: string): Promise<void> => {
    const url =
      `https://graph.facebook.com/${version}/${igId}?fields=${encodeURIComponent(fields)}` +
      `&appsecret_proof=${proof}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await response.text();
    console.log(`\n--- ${label}  (HTTP ${response.status})`);
    console.log(text.slice(0, 1100));
  };

  const commentId = process.argv[3];

  if (commentId) {
    // A mention inside a COMMENT: mentioned_media refuses it outright with
    // "User is not mentioned in the caption", so the comment edge is the only door.
    await ask(
      'what we ask for today',
      `mentioned_comment.comment_id(${commentId}){id,text,username,media{id,caption,media_type,media_url,permalink}}`,
    );
    await ask(
      'with children — the carousel slides',
      `mentioned_comment.comment_id(${commentId}){id,media{id,media_type,children{id,media_type,media_url,thumbnail_url}}}`,
    );
    await ask(
      'is commenting even open on it',
      `mentioned_comment.comment_id(${commentId}){id,media{id,owner,username,comments_count,is_comment_enabled}}`,
    );
  } else {
    await ask(
      'what we ask for today',
      `mentioned_media.media_id(${mediaId}){id,caption,media_type,media_url,permalink,username}`,
    );
    await ask(
      'with children — the carousel slides',
      `mentioned_media.media_id(${mediaId}){id,media_type,children{id,media_type,media_url,thumbnail_url}}`,
    );
  }

  await ds.destroy();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
