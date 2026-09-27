/**
 * What are we ACTUALLY subscribed to, and what could we be?
 *
 *   node --env-file=.env.dev --import tsx scripts/subscription-sweep.ts
 *
 * READ ONLY. The corpus replay can only ever verify events that arrive, and an
 * unsubscribed field produces none — so no amount of replaying reveals a whole
 * category of data we never asked for. This asks directly.
 */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

/** Every field Meta documents for a Page/Instagram webhook, as of v25. */
const KNOWN_FIELDS = [
  'messages', 'message_reactions', 'messaging_postbacks', 'messaging_optins',
  'messaging_seen', 'messaging_referral', 'messaging_handovers', 'standby',
  'message_echoes', 'message_deliveries', 'message_reads',
  'comments', 'mentions', 'mention', 'feed', 'live_comments', 'story_insights',
  'messaging_policy_enforcement', 'messaging_account_linking', 'ratings',
];

async function main(): Promise<void> {
  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();
  const fb: { access_token: string; platform_channel_id: string }[] = await ds.query(
    `SELECT access_token, platform_channel_id FROM channels
      WHERE platform='facebook' AND is_deleted=false AND access_token IS NOT NULL LIMIT 1`,
  );
  const token = new TokenCipherService(config as never).decrypt(fb[0]?.access_token as string);
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');
  const v = config.meta.graphApiVersion;
  const page = fb[0]?.platform_channel_id as string;

  /* What the PAGE says it is subscribed to right now. */
  const live = await fetch(
    `https://graph.facebook.com/${v}/${page}/subscribed_apps?appsecret_proof=${proof}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const liveBody = (await live.json()) as {
    data?: { subscribed_fields?: string[] }[];
    error?: { message?: string };
  };
  const subscribed = new Set(liveBody.data?.[0]?.subscribed_fields ?? []);

  console.log(`\nSUBSCRIBED ON THE PAGE RIGHT NOW (${subscribed.size}):`);
  console.log(`  ${[...subscribed].sort().join(', ') || (liveBody.error?.message ?? 'none')}`);

  /* What the APP is configured for, which is a different question. */
  const appToken = `${config.meta.appId}|${config.meta.appSecret}`;
  const appSubs = await fetch(
    `https://graph.facebook.com/${v}/${config.meta.appId}/subscriptions?access_token=${encodeURIComponent(appToken)}`,
  );
  const appBody = (await appSubs.json()) as {
    data?: { object?: string; fields?: ({ name?: string } | string)[] }[];
    error?: { message?: string };
  };

  console.log('\nCONFIGURED ON THE APP:');
  if (appBody.error) {
    console.log(`  refused: ${appBody.error.message}`);
  } else {
    for (const row of appBody.data ?? []) {
      const names = (row.fields ?? []).map((f) => (typeof f === 'string' ? f : (f.name ?? '?')));
      console.log(`  ${String(row.object).padEnd(12)} ${names.sort().join(', ')}`);
    }
  }

  const ours = new Set(KNOWN_FIELDS.filter((f) => subscribed.has(f)));
  console.log('\nDOCUMENTED FIELDS WE ARE **NOT** SUBSCRIBED TO:');
  for (const field of KNOWN_FIELDS) {
    if (!ours.has(field)) console.log(`  ${field}`);
  }

  await ds.destroy();
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
