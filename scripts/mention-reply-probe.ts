/**
 * Can we comment DIRECTLY on a post we were mentioned in?
 *
 *   node --env-file=.env.dev --import tsx scripts/mention-reply-probe.ts <media_id>
 *
 * THIS IS A WRITE, and deliberately the one shape that should be REFUSED:
 * `POST /{ig-user-id}/mentions` with a media_id and NO comment_id is "comment
 * on the post", which Meta allows only when the mention is in the CAPTION.
 * Every mention we hold is a COMMENT mention, so this must come back #10. If it
 * ever succeeds, the verdict is wrong and a comment really was posted.
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
    `SELECT access_token, platform_channel_id FROM channels
      WHERE platform = 'instagram' AND is_deleted = false LIMIT 1`,
  );
  const fb: { access_token: string }[] = await ds.query(
    `SELECT access_token FROM channels
      WHERE platform = 'facebook' AND is_deleted = false AND access_token IS NOT NULL LIMIT 1`,
  );
  const igId = rows[0]?.platform_channel_id as string;
  const token = new TokenCipherService(config as never).decrypt(
    (rows[0]?.access_token || fb[0]?.access_token) as string,
  );
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');

  const commentId = process.argv[3];
  const body = new URLSearchParams({
    media_id: mediaId,
    message: 'checking reply routing',
    appsecret_proof: proof,
    ...(commentId ? { comment_id: commentId } : {}),
  });

  const response = await fetch(
    `https://graph.facebook.com/${config.meta.graphApiVersion}/${igId}/mentions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    },
  );
  const result = (await response.json()) as { id?: string; error?: { message?: string; code?: number } };

  console.log(
    `POST /mentions  ${commentId ? 'WITH comment_id (reply under it)' : 'media_id only (comment on post)'}` +
      `  ->  HTTP ${response.status}`,
  );
  if (result.error) {
    console.log(`  REFUSED  #${result.error.code}  ${result.error.message}`);
  } else {
    console.log(`  POSTED — id ${result.id}  <-- a real comment now exists; delete it`);
  }

  await ds.destroy();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
