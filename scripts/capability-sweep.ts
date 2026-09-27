/**
 * What ELSE will Meta let this app do?
 *
 *   node --env-file=.env.dev --import tsx scripts/capability-sweep.ts
 *
 * READ ONLY. Every entry is a GET against a surface the product does not use
 * today, to find out which are open to the token we already hold. A refusal is
 * as useful as a success: it tells us the answer without an App Review cycle.
 *
 * Grouped by what they would buy us, because "the endpoint answers 200" is
 * only interesting if somebody would act on what it returns.
 */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

async function main(): Promise<void> {
  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();

  const ig: { platform_channel_id: string }[] = await ds.query(
    `SELECT platform_channel_id FROM channels WHERE platform='instagram' AND is_deleted=false LIMIT 1`,
  );
  const fb: { platform_channel_id: string; access_token: string }[] = await ds.query(
    `SELECT platform_channel_id, access_token FROM channels
      WHERE platform='facebook' AND is_deleted=false AND access_token IS NOT NULL LIMIT 1`,
  );
  const post: { platform_post_id: string }[] = await ds.query(
    `SELECT platform_post_id FROM posts WHERE platform='instagram' AND is_deleted=false
      ORDER BY published_at DESC LIMIT 1`,
  );

  const IG = ig[0]?.platform_channel_id as string;
  const PAGE = fb[0]?.platform_channel_id as string;
  const POST = post[0]?.platform_post_id as string;
  const token = new TokenCipherService(config as never).decrypt(fb[0]?.access_token as string);
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');
  const v = config.meta.graphApiVersion;

  const probe = async (group: string, label: string, path: string): Promise<void> => {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`https://graph.facebook.com/${v}/${path}${sep}appsecret_proof=${proof}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await r.json()) as { error?: { message?: string; code?: number }; data?: unknown[] };
    const verdict = body.error
      ? `REFUSED #${body.error.code} ${String(body.error.message).slice(0, 56)}`
      : `OK ${JSON.stringify(body).slice(0, 88)}`;
    console.log(`  ${label.padEnd(30)} ${verdict}`);
  };

  console.log('\n== INSIGHTS — the numbers a business actually asks for ==');
  await probe('i', 'account insights', `${IG}/insights?metric=impressions,reach&period=day`);
  await probe('i', 'post insights', `${POST}/insights?metric=impressions,reach,saved,shares`);
  await probe('i', 'page insights', `${PAGE}/insights?metric=page_impressions&period=day`);

  console.log('\n== DISCOVERY — reading accounts we do not manage ==');
  await probe('d', 'business_discovery', `${IG}?fields=business_discovery.username(natgeo){followers_count,media_count}`);
  await probe('d', 'hashtag search', `ig_hashtag_search?user_id=${IG}&q=coffee`);

  console.log('\n== MESSAGING SETUP — what greets a customer ==');
  await probe('m', 'ice breakers', `${PAGE}/messenger_profile?fields=ice_breakers`);
  await probe('m', 'persistent menu', `${PAGE}/messenger_profile?fields=persistent_menu`);
  await probe('m', 'greeting', `${PAGE}/messenger_profile?fields=greeting`);

  console.log('\n== OUR OWN ACCOUNT — fields we never read ==');
  await probe('o', 'ig profile + counts', `${IG}?fields=username,followers_count,follows_count,media_count,biography,website`);
  await probe('o', 'our stories', `${IG}/stories?fields=id,media_type,permalink,timestamp`);
  await probe('o', 'live media', `${IG}/live_media?fields=id`);
  await probe('o', 'content publishing limit', `${IG}/content_publishing_limit?fields=quota_usage`);

  console.log('\n== FACEBOOK PAGE — barely touched ==');
  await probe('f', 'page conversations', `${PAGE}/conversations?fields=id,updated_time&limit=1`);
  await probe('f', 'page ratings', `${PAGE}/ratings?fields=rating,review_text&limit=1`);
  await probe('f', 'page roles', `${PAGE}/roles`);
  await probe('f', 'blocked users', `${PAGE}/blocked?limit=1`);

  await ds.destroy();
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
