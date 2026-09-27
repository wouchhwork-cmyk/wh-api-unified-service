/**
 * What we may do to a comment on OUR OWN post.
 *
 *   node --env-file=.env.dev --import tsx scripts/moderation-probe.ts <comment_id>
 *
 * Safe by construction. Hide is reversed immediately. A reply is posted and
 * then deleted again — and deleting works here precisely because the media is
 * ours (contrast platform-limitations 4.6, where a reply under a stranger's
 * post is a one-way door). The customer's own comment is never deleted.
 */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

async function main(): Promise<void> {
  const commentId = process.argv[2];
  if (!commentId) throw new Error('give a comment id');

  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();
  const rows: { access_token: string }[] = await ds.query(
    `SELECT access_token FROM channels WHERE is_deleted = false AND access_token IS NOT NULL LIMIT 1`,
  );
  const token = new TokenCipherService(config as never).decrypt(rows[0]?.access_token as string);
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');
  const v = config.meta.graphApiVersion;

  const call = async (
    label: string,
    method: string,
    path: string,
    body?: Record<string, string>,
  ): Promise<string | null> => {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`https://graph.facebook.com/${v}/${path}${sep}appsecret_proof=${proof}`, {
      method,
      ...(body
        ? {
            headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(body),
          }
        : { headers: { Authorization: `Bearer ${token}` } }),
    });
    const out = (await r.json()) as { id?: string; success?: boolean; error?: { message?: string; code?: number } };
    console.log(
      `  ${label.padEnd(26)} ${r.status}  ` +
        (out.error ? `#${out.error.code} ${String(out.error.message).slice(0, 62)}` : `OK ${out.id ?? (out.success ? 'success' : '')}`),
    );
    return out.id ?? null;
  };

  console.log(`\ncomment ${commentId} (on our own media)`);
  await call('read it', 'GET', `${commentId}?fields=id,text,timestamp,like_count,hidden`);
  await call('hide', 'POST', commentId, { hide: 'true' });
  await call('unhide', 'POST', commentId, { hide: 'false' });
  const replyId = await call('reply to it', 'POST', `${commentId}/replies`, { message: 'Thanks for reaching out!' });
  if (replyId) await call('delete OUR reply', 'DELETE', replyId);

  await ds.destroy();
}
void main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
