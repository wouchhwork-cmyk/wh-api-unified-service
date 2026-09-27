/**
 * What the corpus replay actually produced, per payload shape.
 *
 *   node --env-file=.env.dev --import tsx scripts/coverage-report.ts [--md]
 *
 * Groups every event in the ledger by its STRUCTURAL shape — which keys Meta
 * sent, never their values — and reports what the projector made of each. One
 * row per shape is the number that matters: 1,148 deliveries collapse to a few
 * dozen distinct things, and a gap in one of them is invisible in a total.
 */
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';

interface Row {
  id: number;
  event_type: string;
  platform: string;
  status: string;
  last_error: string | null;
  payload: Record<string, unknown>;
  message_count: string;
}

/** The structural fingerprint. Values are deliberately ignored. */
function shapeOf(row: Row): string {
  const p = row.payload;
  const t = row.event_type;

  if (t === 'direct_message') {
    const m = (p.message ?? {}) as Record<string, unknown>;
    const bits: string[] = [];
    if (p.message_edit) return 'DM message_edit';
    if (m.is_deleted) return 'DM unsend';
    if (p.reaction) return 'DM reaction';
    if (p.read) return 'DM read-receipt';
    if (m.is_echo) bits.push('echo');
    if (m.is_unsupported) bits.push('unsupported');
    if (typeof m.text === 'string') bits.push('text');
    const replyTo = m.reply_to as Record<string, unknown> | undefined;
    if (replyTo) bits.push(replyTo.story ? 'reply_to:story' : 'reply_to:message');
    for (const a of (m.attachments ?? []) as { type?: string }[]) {
      bits.push(`att:${a.type ?? '?'}`);
    }
    if (p.referral) bits.push('referral');
    return `DM ${bits.length > 0 ? bits.join('+') : '(nothing recognised)'}`;
  }

  if (t === 'mention') {
    const v = (p.value ?? {}) as Record<string, unknown>;
    if (v.username) return 'MENTION from /tags backfill';
    return v.comment_id ? 'MENTION in a comment' : 'MENTION in a caption';
  }

  if (t === 'comment') {
    const v = (p.value ?? {}) as Record<string, unknown>;

    /*
     * THE TWO PLATFORMS DISAGREE ON BOTH FIELDS, and reading Instagram's names
     * against a Facebook payload reports every Facebook comment as a reply with
     * no text — which is what this did, silently, because the corpus happens to
     * contain no Facebook comments yet and nothing looked wrong.
     *
     * Instagram: the words are `text`, and `parent_id` is present only on an
     * actual reply.
     * Facebook: the words are `message`, and `parent_id` is ALWAYS present —
     * it equals `post_id` on a top-level comment. That equality is the only
     * thing distinguishing the two, and `normalizeFacebook` uses exactly the
     * same test.
     */
    const isFacebook = row.platform === 'facebook';
    const text = isFacebook ? v.message : v.text;
    const parentId = isFacebook && v.parent_id === v.post_id ? undefined : v.parent_id;

    const bits = [parentId ? 'reply' : 'top-level'];
    if (!text) bits.push('no text');
    return `COMMENT ${bits.join(', ')}`;
  }

  return `${t.toUpperCase()} ${row.platform}`;
}

async function main(): Promise<void> {
  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();

  const rows: Row[] = await ds.query(
    `SELECT e.id, e.event_type, e.platform, e.status, e.last_error, e.payload,
            (SELECT count(*)::text FROM messages m WHERE m.inbound_event_id = e.id) AS message_count
       FROM inbound_events e
      ORDER BY e.id`,
  );

  interface Agg {
    seen: number;
    projected: number;
    byStatus: Record<string, number>;
    errors: Set<string>;
  }
  const agg = new Map<string, Agg>();
  for (const row of rows) {
    const key = shapeOf(row);
    const a = agg.get(key) ?? { seen: 0, projected: 0, byStatus: {}, errors: new Set<string>() };
    a.seen += 1;
    if (Number(row.message_count) > 0) a.projected += 1;
    a.byStatus[row.status] = (a.byStatus[row.status] ?? 0) + 1;
    if (row.last_error) a.errors.add(row.last_error.slice(0, 90));
    agg.set(key, a);
  }

  const md = process.argv.includes('--md');
  const sorted = [...agg.entries()].sort((a, b) => b[1].seen - a[1].seen);

  if (md) {
    console.log('| shape | seen | made a message | statuses | note |');
    console.log('|---|---|---|---|---|');
    for (const [shape, a] of sorted) {
      const statuses = Object.entries(a.byStatus).map(([s, n]) => `${s}=${n}`).join(' ');
      const note = [...a.errors][0] ?? '';
      console.log(`| \`${shape}\` | ${a.seen} | ${a.projected} | ${statuses} | ${note} |`);
    }
  } else {
    console.log(`${agg.size} shapes across ${rows.length} events\n`);
    for (const [shape, a] of sorted) {
      const statuses = Object.entries(a.byStatus).map(([s, n]) => `${s}=${n}`).join(' ');
      console.log(`  ${String(a.seen).padStart(4)}  msg=${String(a.projected).padStart(4)}  ${shape.padEnd(38)} ${statuses}`);
      for (const e of a.errors) console.log(`        ! ${e}`);
    }
  }

  await ds.destroy();
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
