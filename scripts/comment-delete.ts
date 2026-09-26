/** Removes a comment this app posted. Used to clean up a probe. */
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
  const response = await fetch(
    `https://graph.facebook.com/${config.meta.graphApiVersion}/${commentId}?appsecret_proof=${proof}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  console.log(`DELETE ${commentId} -> HTTP ${response.status} ${await response.text()}`);
  await ds.destroy();
}
void main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
