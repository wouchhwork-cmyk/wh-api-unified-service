/**
 * Fills `mentionKind` in on mention threads that predate the field.
 *
 *   node --env-file=.env.dev --import tsx scripts/backfill-mention-kind.ts [--apply]
 *
 * WHY A SCRIPT AND NOT A REPLAY. The ledger dedups a mention on its media id,
 * so re-running the mentions backfill re-reads every tag from Meta and inserts
 * nothing — the projector never sees the new field, and the rows stay blank
 * for ever. Nothing is re-fetched here: the classification is derived from what
 * each row already holds.
 *
 *   mentionedCommentId present  -> comment   (Meta said where the tag sat)
 *   caption contains our handle -> caption
 *   otherwise                   -> tagged    (collaborator or photo tag)
 *
 * The last two mirror instagramTagPage exactly, including matching the handle
 * BARE because Meta strips the `@`. Idempotent: a row that already has a kind
 * is left alone. Dry run by default.
 */
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { ConversationKind, MentionKind } from '../src/shared/enums';

interface Row {
  id: number;
  subject: string | null;
  caption: string | null;
  comment_id: string | null;
  handle: string | null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();

  const rows: Row[] = await ds.query(
    `SELECT c.id,
            c.subject,
            c.context_metadata->'postDetails'->>'caption' AS caption,
            c.context_metadata->>'mentionedCommentId'     AS comment_id,
            ch.username                                    AS handle
       FROM conversations c
       JOIN channels ch ON ch.id = c.channel_id
      WHERE c.conversation_kind = $1
        AND c.is_deleted = false
        AND c.context_metadata->>'mentionKind' IS NULL
      ORDER BY c.id`,
    [ConversationKind.Mention],
  );

  const tally: Record<string, number> = {};
  for (const row of rows) {
    let kind: MentionKind;
    if (row.comment_id) {
      kind = MentionKind.Comment;
    } else {
      const handle = row.handle?.toLowerCase() ?? null;
      // The caption as stored, else the subject, which is the caption trimmed.
      const text = (row.caption ?? row.subject ?? '').toLowerCase();
      kind = handle !== null && text.includes(handle) ? MentionKind.Caption : MentionKind.Tagged;
    }
    tally[kind] = (tally[kind] ?? 0) + 1;

    if (apply) {
      await ds.query(
        `UPDATE conversations
            SET context_metadata = context_metadata || jsonb_build_object('mentionKind', $2::text),
                updated_at = now()
          WHERE id = $1`,
        [row.id, kind],
      );
    }
  }

  console.log(`${rows.length} thread(s) without a kind`);
  for (const [kind, n] of Object.entries(tally)) console.log(`  ${kind.padEnd(8)} ${n}`);
  console.log(apply ? 'applied' : 'DRY RUN — pass --apply to write');

  await ds.destroy();
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
