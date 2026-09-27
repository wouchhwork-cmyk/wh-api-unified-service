/**
 * Two things the docs are vague about: more than one attachment in a single
 * message, and media in a COMMENT reply.
 *
 *   node --env-file=.env.dev --import tsx scripts/multi-send-probe.ts <igsid> <comment_id> <imageUrl> <gifUrl>
 */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

async function main(): Promise<void> {
  const [, , recipient, commentId, imageUrl, gifUrl] = process.argv;
  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();
  const page: { platform_channel_id: string; access_token: string }[] = await ds.query(
    `SELECT platform_channel_id, access_token FROM channels
      WHERE platform = 'facebook' AND is_deleted = false AND access_token IS NOT NULL LIMIT 1`,
  );
  const token = new TokenCipherService(config as never).decrypt(page[0]?.access_token as string);
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');
  const v = config.meta.graphApiVersion;
  const pageId = page[0]?.platform_channel_id as string;

  const post = async (label: string, path: string, body: unknown, form = false): Promise<void> => {
    const r = await fetch(`https://graph.facebook.com/${v}/${path}?appsecret_proof=${proof}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      },
      body: form
        ? new URLSearchParams(body as Record<string, string>)
        : JSON.stringify(body),
    });
    const out = (await r.json()) as { id?: string; message_id?: string; error?: { message?: string; code?: number; error_subcode?: number } };
    console.log(
      `  ${label.padEnd(30)} ${r.status}  ` +
        (out.error
          ? `#${out.error.code}${out.error.error_subcode ? '/' + out.error.error_subcode : ''} ${String(out.error.message).slice(0, 64)}`
          : `OK ${out.message_id ?? out.id ?? ''}`),
    );
  };

  console.log('\n== two attachments in ONE message ==');
  await post('attachments: [image, gif]', `${pageId}/messages`, {
    recipient: { id: recipient },
    message: {
      attachments: [
        { type: 'image', payload: { url: imageUrl } },
        { type: 'image', payload: { url: gifUrl } },
      ],
    },
  });
  await post('text + attachment together', `${pageId}/messages`, {
    recipient: { id: recipient },
    message: { text: 'with a picture', attachment: { type: 'image', payload: { url: imageUrl } } },
  });

  console.log('\n== media in a COMMENT reply (our own post) ==');
  await post('reply: message only', `${commentId}/replies`, { message: 'thanks!' }, true);
  await post('reply: attachment_url', `${commentId}/replies`, { attachment_url: imageUrl }, true);
  await post('reply: message + attachment', `${commentId}/replies`, { message: 'here', attachment_url: gifUrl }, true);

  await ds.destroy();
}
void main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
