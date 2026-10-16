import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a mention find the mention it was replying to.
 *
 * When somebody tags us in a reply to a comment that ALSO tagged us, we hold
 * both as conversations — and everything needed to link them was already
 * stored: the child keeps `mentionParentId`, the parent keeps
 * `mentionedCommentId`, and they are the same comment id. Nothing derived it,
 * so the relationship existed in the data and not in the product.
 *
 * WHY AN INDEX AND NOT JUST A QUERY: the key lives inside `context_metadata`,
 * so matching on it without an expression index means a sequential scan of
 * every conversation a business owns — on a thread read, which is a hot path.
 *
 * Partial on `conversation_kind = 'mention'` because only a mention carries the
 * key; the index stays the size of the mention population rather than the
 * table.
 *
 * EXPAND ONLY, and idempotent: an index is additive, no column changes, no
 * backfill, and nothing reads it until the code that does ships. It is declared
 * in schema-objects.ts too, so a database built by `db:sync` gets it there and
 * this is a no-op — the same split every other index in this repo has.
 */
export class MentionParentLink1757400000000 implements MigrationInterface {
  name = 'MentionParentLink1757400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS conversations_mention_comment_idx
      ON conversations ((context_metadata->>'mentionedCommentId'))
      WHERE conversation_kind = 'mention' AND is_deleted = false
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS conversations_mention_comment_idx`);
  }
}
