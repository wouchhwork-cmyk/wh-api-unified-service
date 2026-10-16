/**
 * Clears everything derived from webhooks, then re-projects every real event.
 *
 *   node --env-file=.env.dev --import tsx scripts/replay-corpus.ts --confirm
 *
 * WHY THIS EXISTS. The ledger holds every webhook this account has ever
 * received — a corpus of real deliveries nobody could reconstruct. Re-running
 * the whole of it against a clean slate is the only way to ask "does the
 * current code handle everything we have ever actually seen?", and to keep
 * asking after each change.
 *
 * NOTHING IS FABRICATED. Every payload replayed is one Meta really sent. The
 * events themselves are never deleted, only reset to `pending` so the worker
 * claims them again.
 *
 * WHAT SURVIVES, and this is the part to get right: channels, provider
 * connections and their tokens — clearing those would disconnect the account.
 * Also enterprises, identities, roles, permissions and features, which are
 * configuration rather than webhook output.
 */
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';

/** Derived from webhooks, in dependency order — children before parents. */
const DERIVED = [
  'message_attachments',
  'messages',
  'customer_engagements',
  'conversations',
  'customer_identifiers',
  'customers',
  'outbound_events',
  'posts',
  'sync_jobs',
  'provider_api_usage',
  'audit_logs',
];

async function main(): Promise<void> {
  if (!process.argv.includes('--confirm')) {
    console.log('DRY RUN — pass --confirm to clear and replay.');
  }
  const apply = process.argv.includes('--confirm');

  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();

  const before: Record<string, number> = {};
  for (const t of [...DERIVED, 'inbound_events', 'channels', 'provider_connections']) {
    const r: { n: string }[] = await ds.query(`SELECT count(*)::text AS n FROM ${t}`);
    before[t] = Number(r[0]?.n ?? 0);
  }
  console.log('before:', JSON.stringify(before));

  if (!apply) {
    await ds.destroy();
    return;
  }

  await ds.query('BEGIN');
  try {
    // `conversations.last_conversation_id` style references are cleared by
    // deleting children first; the order above is what makes that true.
    for (const t of DERIVED) await ds.query(`DELETE FROM ${t}`);
    // Every event back to the queue. attempt_count too, or one that previously
    // dead-lettered stays dead and the replay quietly skips it.
    await ds.query(
      `UPDATE inbound_events
          SET status = 'pending', attempt_count = 0, lease_owner = NULL,
              lease_expires_at = NULL, next_attempt_at = now(), last_error = NULL`,
    );
    await ds.query('COMMIT');
  } catch (error) {
    await ds.query('ROLLBACK');
    throw error;
  }

  const after: Record<string, number> = {};
  for (const t of ['channels', 'provider_connections', 'inbound_events']) {
    const r: { n: string }[] = await ds.query(`SELECT count(*)::text AS n FROM ${t}`);
    after[t] = Number(r[0]?.n ?? 0);
  }
  console.log('cleared. preserved:', JSON.stringify(after));
  console.log('the worker will now re-project; watch inbound_events.status');

  await ds.destroy();
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
