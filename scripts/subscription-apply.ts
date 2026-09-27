/** Sets the live Page subscription to SUBSCRIBED_FIELDS and proves it took. */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';
import { SUBSCRIBED_FIELDS } from '../src/modules/connections/graph/graph-api.client';

async function main(): Promise<void> {
  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();
  const rows: { access_token: string; platform_channel_id: string }[] = await ds.query(
    `SELECT access_token, platform_channel_id FROM channels
      WHERE platform='facebook' AND is_deleted=false AND access_token IS NOT NULL LIMIT 1`,
  );
  const token = new TokenCipherService(config as never).decrypt(rows[0]!.access_token);
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');
  const { graphApiVersion: v } = config.meta;
  const page = rows[0]!.platform_channel_id;

  const res = await fetch(`https://graph.facebook.com/${v}/${page}/subscribed_apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscribed_fields: SUBSCRIBED_FIELDS.join(','), appsecret_proof: proof }),
  });
  console.log('POST:', JSON.stringify(await res.json()));

  const back = await fetch(
    `https://graph.facebook.com/${v}/${page}/subscribed_apps?appsecret_proof=${proof}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const live = ((await back.json()) as { data?: { subscribed_fields?: string[] }[] })
    .data?.[0]?.subscribed_fields ?? [];
  const missing = SUBSCRIBED_FIELDS.filter((f) => !live.includes(f));
  console.log(`LIVE (${live.length}): ${[...live].sort().join(', ')}`);
  console.log(missing.length ? `STILL MISSING: ${missing.join(', ')}` : 'POLICY SATISFIED');
  await ds.destroy();
}
void main().catch((e: unknown) => { console.error(e); process.exit(1); });
