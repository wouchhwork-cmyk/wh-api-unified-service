/** What the stored token is actually allowed to do. Read only. */
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

async function main(): Promise<void> {
  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();
  const rows: { access_token: string; platform: string }[] = await ds.query(
    `SELECT access_token, platform FROM channels
      WHERE is_deleted = false AND access_token IS NOT NULL LIMIT 1`,
  );
  const token = new TokenCipherService(config as never).decrypt(rows[0]?.access_token as string);

  // An APP access token is what debug_token wants: app_id|app_secret.
  const appToken = `${config.meta.appId}|${config.meta.appSecret}`;
  const response = await fetch(
    `https://graph.facebook.com/${config.meta.graphApiVersion}/debug_token` +
      `?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appToken)}`,
  );
  const body = (await response.json()) as {
    data?: { scopes?: string[]; type?: string; app_id?: string; granular_scopes?: unknown };
    error?: { message?: string };
  };
  if (body.error) {
    console.log('debug_token refused:', body.error.message);
  } else {
    console.log('token type :', body.data?.type);
    console.log('app id     :', body.data?.app_id);
    console.log('scopes     :');
    for (const s of (body.data?.scopes ?? []).sort()) console.log('   ', s);
  }
  await ds.destroy();
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
