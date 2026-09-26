/**
 * Does our configured app secret match the app that issued the stored token?
 *
 *   node --env-file=.env.dev --import tsx scripts/proof-check.ts
 *
 * Read only, and prints no secret: one call with `appsecret_proof` and one
 * without. If the bare call works and the proof call does not, the secret in
 * configuration belongs to a different app than the token does.
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

  const rows: { access_token: string; platform_channel_id: string }[] = await ds.query(
    `SELECT access_token, platform_channel_id FROM channels
      WHERE platform = 'facebook' AND is_deleted = false AND access_token IS NOT NULL LIMIT 1`,
  );
  const channel = rows[0];
  if (!channel) throw new Error('no facebook channel with a token');

  const token = new TokenCipherService(config as never).decrypt(channel.access_token);
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');
  const base = `https://graph.facebook.com/${config.meta.graphApiVersion}/${channel.platform_channel_id}?fields=id,name`;

  const ask = async (label: string, url: string): Promise<void> => {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body: unknown = await response.json();
    const error = (body as { error?: { message?: string; code?: number } }).error;
    console.log(`${label.padEnd(22)} HTTP ${response.status}  ${error ? error.message : 'OK'}`);
  };

  console.log(`configured app id      ${config.meta.appId}`);
  console.log(`app secret configured  ${config.meta.appSecret ? 'yes' : 'NO'}\n`);
  await ask('without proof', base);
  await ask('with appsecret_proof', `${base}&appsecret_proof=${proof}`);

  // Which app does the token actually belong to? Meta will say.
  const debug = await fetch(
    `https://graph.facebook.com/${config.meta.graphApiVersion}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`,
  );
  const info = (await debug.json()) as { data?: { app_id?: string; application?: string } };
  console.log(`\ntoken belongs to app   ${info.data?.app_id ?? '(unknown)'} ${info.data?.application ?? ''}`);

  await ds.destroy();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
