/**
 * Which values Meta sent us, and which ones reached a row.
 *
 *   node --env-file=.env.dev --import tsx scripts/field-coverage.ts
 *
 * The standing rule is to take the most granular data available every time,
 * because a field not captured on arrival usually cannot be captured later.
 * This checks it against the real corpus.
 *
 * IT COMPARES VALUES, NOT FIELD NAMES, and that took two wrong versions to
 * arrive at. We rename constantly on capture — `media_product_type` is stored
 * as `postProductType`, `permalink` as `postPermalink`, `ig_post_media_id` as
 * `postMediaId` — so a name comparison reported every one of those as lost.
 * Loosening the name match enough to catch them let genuinely dropped fields
 * through instead: the two failure modes are opposite and no threshold avoids
 * both. Whether the VALUE reached a row has no such ambiguity.
 */
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';

/** Every leaf in an object, keyed by path, array indices collapsed to `[]`. */
function leaves(
  value: unknown,
  prefix = '',
  out = new Map<string, unknown>(),
): Map<string, unknown> {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    for (const item of value) leaves(item, `${prefix}[]`, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object') leaves(v, path, out);
      else out.set(path, v);
    }
    return out;
  }
  out.set(prefix, value);
  return out;
}

/**
 * A value distinctive enough to trace, as a comparable string.
 *
 * Booleans and short numbers are skipped: `true` and `0` appear everywhere and
 * finding one stored proves nothing about which field it came from.
 */
function comparable(value: unknown): string | null {
  if (typeof value === 'string') return value.length >= 4 ? value : null;
  if (typeof value === 'number') return String(value).length >= 4 ? String(value) : null;
  return null;
}

/**
 * Routing and bookkeeping, not content. Who sent it, to whom, when, and the
 * flags we add ourselves — none of it belongs in a report about what we lost.
 */
const IGNORED = /^(sender|recipient|timestamp|field|id|time|entry|object|recovered)/;

async function main(): Promise<void> {
  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();

  /*
   * Every value that reached a row — metadata bags AND the columns beside
   * them, because plenty of what Meta sends is stored in a column and reading
   * only the bags reports all of it as lost.
   */
  const stored = new Set<string>();
  const add = (value: unknown): void => {
    /*
     * A Date is stored as an instant and arrives from Meta as either an ISO
     * string or epoch millis, so both renderings go in. Without this every
     * timestamp in the corpus reports as lost while sitting in a column.
     */
    if (value instanceof Date) {
      stored.add(value.toISOString());
      stored.add(String(value.getTime()));
      stored.add(String(Math.floor(value.getTime() / 1000)));
      return;
    }
    const c = comparable(value);
    if (c !== null) stored.add(c);
  };

  /*
   * Every place a fact can land. Columns matter as much as the bags: an id
   * ends up in customer_identifiers, a timestamp in platform_sent_at, and
   * reading only metadata reports all of it as thrown away.
   */
  const sources: readonly (readonly [string, string, string])[] = [
    ['messages', 'metadata', 'body, platform_message_id, platform_sent_at'],
    ['conversations', 'context_metadata', 'subject, platform_thread_id'],
    ['message_attachments', 'metadata', 'source_url, file_name, mime_type'],
    ['posts', 'media', 'caption, permalink_url, platform_post_id, post_kind, published_at'],
    ['customers', 'metadata', 'display_name'],
    // No jsonb bag on this one; the identifier itself is the whole point.
    ['customer_identifiers', 'NULL::jsonb', 'identifier_value, identifier_value_raw'],
  ];

  for (const [table, bagColumn, extra] of sources) {
    const rows: Record<string, unknown>[] = await ds.query(
      `SELECT ${bagColumn} AS bag, ${extra} FROM ${table}`,
    );
    for (const row of rows) {
      for (const [, v] of leaves(row.bag)) add(v);
      for (const [key, v] of Object.entries(row)) if (key !== 'bag') add(v);
    }
  }

  const events: { event_type: string; payload: Record<string, unknown> }[] = await ds.query(
    `SELECT event_type, payload FROM inbound_events`,
  );

  /** Per event type: payload paths whose value nothing kept. */
  const byType = new Map<string, Map<string, number>>();
  for (const event of events) {
    const missing = byType.get(event.event_type) ?? new Map<string, number>();
    for (const [path, value] of leaves(event.payload)) {
      if (IGNORED.test(path)) continue;
      const c = comparable(value);
      // A value too generic to trace tells us nothing either way, so it is not
      // reported as lost.
      if (c === null || stored.has(c)) continue;
      missing.set(path, (missing.get(path) ?? 0) + 1);
    }
    byType.set(event.event_type, missing);
  }

  console.log(`Values Meta sent that reached no row`);
  console.log(`compared against ${stored.size} distinct stored values\n`);

  for (const [type, fields] of [...byType.entries()].sort()) {
    const ranked = [...fields.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) {
      console.log(`${type}: nothing lost\n`);
      continue;
    }
    console.log(`${type}:`);
    for (const [path, n] of ranked.slice(0, 14)) console.log(`  ${String(n).padStart(5)}  ${path}`);
    console.log('');
  }

  await ds.destroy();
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
