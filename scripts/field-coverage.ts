/**
 * Which fields Meta sent us, and which ones we kept.
 *
 *   node --env-file=.env.dev --import tsx scripts/field-coverage.ts
 *
 * The standing rule is to take the most granular data available every time,
 * because a field not captured on arrival usually cannot be captured later.
 * This checks it: every leaf key in every real payload, against what actually
 * reached a row. A key that appears in the ledger and nowhere else is either a
 * deliberate omission or a fact we threw away, and the two look identical until
 * somebody lists them.
 */
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';

/** Every leaf path in an object, array indices collapsed to `[]`. */
function leaves(value: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    for (const item of value) leaves(item, `${prefix}[]`, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object') leaves(v, path, out);
      else out.add(path);
    }
    return out;
  }
  out.add(prefix);
  return out;
}

async function main(): Promise<void> {
  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();

  const rows: { event_type: string; payload: Record<string, unknown> }[] = await ds.query(
    `SELECT event_type, payload FROM inbound_events`,
  );

  /** Everything we store anywhere, flattened the same way. */
  const stored = new Set<string>();
  for (const table of ['messages', 'conversations', 'message_attachments']) {
    const column = table === 'conversations' ? 'context_metadata' : 'metadata';
    const metas: { m: Record<string, unknown> }[] = await ds.query(
      `SELECT ${column} AS m FROM ${table} WHERE ${column} IS NOT NULL`,
    );
    for (const r of metas) for (const p of leaves(r.m)) stored.add(p);
  }

  /** The same set, reduced to final segments — what the comparison needs. */
  const storedLeaves = new Set([...stored].map((path) => path.split('.').pop() ?? path));

  const byType = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const m = byType.get(row.event_type) ?? new Map<string, number>();
    for (const p of leaves(row.payload)) m.set(p, (m.get(p) ?? 0) + 1);
    byType.set(row.event_type, m);
  }

  /*
   * Noise, not omissions. Routing keys (who sent it, to whom, when) live in
   * COLUMNS, not metadata, so their absence from the metadata bag says nothing.
   */
  const ROUTING = /^(sender|recipient|timestamp|field|id|time|entry|object|value\.(id|media\.id))/;

  console.log('Fields Meta sends that reach no row (excluding routing):\n');
  for (const [type, fields] of [...byType.entries()].sort()) {
    const missing = [...fields.entries()]
      .filter(([path]) => !ROUTING.test(path))
      .filter(([path]) => {
        /*
         * COMPARE THE FINAL SEGMENT, not the tail of the whole path.
         *
         * `endsWith` over full stored paths reported dropped fields as kept:
         * `from.name` looked captured because some stored path happened to end
         * in `...authorUsername`, which ends with neither but shares a suffix
         * with something that does. That defeats the entire purpose of a tool
         * whose only job is to find fields nobody kept.
         */
        const leaf = path.split('.').pop() ?? path;
        const camel = leaf.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        return !storedLeaves.has(leaf) && !storedLeaves.has(camel);
      })
      .sort((a, b) => b[1] - a[1]);
    if (missing.length === 0) continue;
    console.log(`${type}:`);
    for (const [path, n] of missing.slice(0, 14)) console.log(`  ${String(n).padStart(5)}  ${path}`);
    console.log('');
  }

  await ds.destroy();
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
