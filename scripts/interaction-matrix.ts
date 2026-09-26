/**
 * Exhausts what Meta will say about ONE direct message.
 *
 *   node --env-file=.env.dev --import tsx scripts/interaction-matrix.ts <mid>
 *
 * READ ONLY — nothing is posted. Every field combination worth trying against
 * a message node and its attachments edge, so a verdict about what is
 * recoverable rests on the whole grid rather than the first thing tried.
 */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

const NODE_FIELDS: string[] = [
  'message',
  'created_time',
  'from',
  'to',
  'shares',
  'story',
  'sticker',
  'reply_to',
  'is_unsupported',
  'tags',
  'attachments',
];

/** Everything an attachment could plausibly carry. */
const ATTACHMENT_SHAPES: [string, string][] = [
  ['generic_template all', 'attachments{generic_template}'],
  ['generic subfields', 'attachments{generic_template{title,subtitle,image_url,buttons,default_action}}'],
  ['media fields', 'attachments{id,mime_type,name,size,file_url,image_data,video_data}'],
  ['target/url/title', 'attachments{id,title,url,target}'],
  ['media_type/url', 'attachments{media_type,media_url,thumbnail_url}'],
  ['everything guessed', 'attachments{id,name,mime_type,size,file_url,image_data,video_data,generic_template,media_type,media_url,title,url,target,payload}'],
];

async function main(): Promise<void> {
  const mid = process.argv[2];
  if (!mid) throw new Error('give a message id');

  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();
  const rows: { access_token: string }[] = await ds.query(
    `SELECT access_token FROM channels
      WHERE platform = 'facebook' AND is_deleted = false AND access_token IS NOT NULL LIMIT 1`,
  );
  const token = new TokenCipherService(config as never).decrypt(rows[0]?.access_token as string);
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');
  const v = config.meta.graphApiVersion;

  const get = async (label: string, path: string, fields?: string): Promise<void> => {
    const url =
      `https://graph.facebook.com/${v}/${path}?appsecret_proof=${proof}` +
      (fields ? `&fields=${encodeURIComponent(fields)}` : '');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as Record<string, unknown> & {
      error?: { message?: string; code?: number };
    };
    if (body.error) {
      console.log(`  ${label.padEnd(24)} ${response.status}  #${body.error.code} ${String(body.error.message).slice(0, 72)}`);
      return;
    }
    // Drop the echoed id so the useful part is what prints.
    const { id: _ignored, ...rest } = body;
    const json = JSON.stringify(rest);
    console.log(`  ${label.padEnd(24)} ${response.status}  ${json === '{}' ? '(field absent)' : json.slice(0, 150)}`);
  };

  console.log('\n== message node, one field at a time ==');
  for (const field of NODE_FIELDS) await get(field, mid, `id,${field}`);

  console.log('\n== attachment shapes ==');
  for (const [label, fields] of ATTACHMENT_SHAPES) await get(label, mid, `id,${fields}`);

  console.log('\n== the attachments EDGE directly ==');
  await get('edge, default', `${mid}/attachments`);
  await get('edge, named fields', `${mid}/attachments`, 'id,image_data,video_data,file_url,mime_type,name,size');

  await ds.destroy();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
