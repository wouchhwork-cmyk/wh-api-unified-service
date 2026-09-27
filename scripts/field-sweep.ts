/**
 * Every field a node will give us, asked for ONE AT A TIME.
 *
 *   node --env-file=.env.dev --import tsx scripts/field-sweep.ts ig|page|post <id?>
 *
 * READ ONLY. Asked singly rather than in a batch because Graph fails a whole
 * request on one unknown field — so a batch tells you only that something in it
 * was wrong, and a sweep tells you exactly which are open to the token we hold.
 *
 * The point is not curiosity. A field we do not ask for is data we do not have,
 * and most of them cost nothing extra on a call we already make.
 */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

const CANDIDATES: Record<string, readonly string[]> = {
  ig: [
    'username', 'name', 'biography', 'website', 'profile_picture_url',
    'followers_count', 'follows_count', 'media_count', 'ig_id', 'shopping_product_tag_eligibility',
    'has_profile_pic', 'is_published', 'legacy_instagram_user_id', 'owner_business',
  ],
  page: [
    'name', 'about', 'category', 'category_list', 'link', 'username', 'website',
    'fan_count', 'followers_count', 'picture', 'cover', 'emails', 'phone',
    'single_line_address', 'location', 'hours', 'is_published', 'verification_status',
    'new_like_count', 'rating_count', 'overall_star_rating', 'were_here_count',
    'talking_about_count', 'engagement', 'connected_instagram_account', 'description',
  ],
  post: [
    'caption', 'media_type', 'media_product_type', 'media_url', 'permalink', 'thumbnail_url',
    'timestamp', 'username', 'like_count', 'comments_count', 'is_comment_enabled',
    'children', 'owner', 'shortcode', 'alt_text', 'boost_eligibility_info',
  ],
};

async function main(): Promise<void> {
  const kind = process.argv[2] ?? 'ig';
  const candidates = CANDIDATES[kind];
  if (!candidates) throw new Error('kind must be ig, page or post');

  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();
  const fb: { access_token: string; platform_channel_id: string }[] = await ds.query(
    `SELECT access_token, platform_channel_id FROM channels
      WHERE platform='facebook' AND is_deleted=false AND access_token IS NOT NULL LIMIT 1`,
  );
  const ig: { platform_channel_id: string }[] = await ds.query(
    `SELECT platform_channel_id FROM channels WHERE platform='instagram' AND is_deleted=false LIMIT 1`,
  );
  const post: { platform_post_id: string }[] = await ds.query(
    `SELECT platform_post_id FROM posts WHERE platform='instagram' AND is_deleted=false
      ORDER BY published_at DESC LIMIT 1`,
  );

  const node =
    process.argv[3] ??
    (kind === 'ig' ? ig[0]?.platform_channel_id : kind === 'page' ? fb[0]?.platform_channel_id : post[0]?.platform_post_id);
  const token = new TokenCipherService(config as never).decrypt(fb[0]?.access_token as string);
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');

  const open: string[] = [];
  const shut: string[] = [];

  for (const field of candidates) {
    const r = await fetch(
      `https://graph.facebook.com/${config.meta.graphApiVersion}/${node}?fields=${field}&appsecret_proof=${proof}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = (await r.json()) as Record<string, unknown> & { error?: { code?: number } };
    if (body.error) {
      shut.push(`${field} (#${body.error.code})`);
      continue;
    }
    const { id: _id, ...rest } = body;
    const value = JSON.stringify(rest);
    // A 200 with nothing in it means the field exists and is empty, which is a
    // different answer from "you may not have this".
    open.push(`${field} = ${value === '{}' ? '(empty)' : value.slice(0, 70)}`);
  }

  console.log(`\n${kind} ${node}\n`);
  console.log('READABLE:');
  for (const line of open) console.log(`  ${line}`);
  console.log('\nREFUSED:');
  console.log(`  ${shut.join(', ') || '(none)'}`);

  await ds.destroy();
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
