import { describe, expect, it } from 'vitest';
import { MentionKind } from '@/shared/enums';

/**
 * Telling the three kinds of tag apart.
 *
 * They all land as a Mention and they are NOT the same event:
 *
 *   caption   the @tag is in the post's caption. Webhook, `media_id` only.
 *   comment   the @tag is inside a comment. Webhook, plus `comment_id`.
 *   tagged    a collaborator or photo tag. NO WEBHOOK AT ALL — the customer
 *             sees it and the inbox never hears, until a backfill walks /tags.
 *
 * Verified against live deliveries on 27 Sep 2026.
 */

/** The webhook knows, because Meta says where the tag sits. */
const fromWebhook = (value: { media_id: string; comment_id?: string }): MentionKind =>
  value.comment_id ? MentionKind.Comment : MentionKind.Caption;

/**
 * The /tags walk has to infer it: both kinds appear on that edge, and by then
 * the "did it webhook?" signal is gone. Mirrors instagramTagPage.
 */
const fromTagsWalk = (caption: string | null, ourHandle: string | null): MentionKind => {
  const handle = ourHandle?.toLowerCase() ?? null;
  return handle !== null && (caption ?? '').toLowerCase().includes(handle)
    ? MentionKind.Caption
    : MentionKind.Tagged;
};

describe('which kind of tag this is', () => {
  describe('from a webhook, where Meta tells us', () => {
    it('reads a comment tag from comment_id', () => {
      // Real delivery: event 1740.
      expect(
        fromWebhook({ media_id: '18109176776162616', comment_id: '17949640701295733' }),
      ).toBe(MentionKind.Comment);
    });

    it('reads a caption tag from its ABSENCE', () => {
      /*
       * The absence is the entire discriminator, and it also decides which edge
       * resolves the mention — send a caption tag to `mentioned_comment` and it
       * fails with "(#10) User is not mentioned in the caption". Real delivery:
       * event 1910.
       */
      expect(fromWebhook({ media_id: '17911065744521471' })).toBe(MentionKind.Caption);
    });

    it('never says `tagged`, because that never webhooks', () => {
      // A collaborator tag cannot reach this path at all, so the webhook
      // classifier has only two answers by construction.
      const answers = [
        fromWebhook({ media_id: '1' }),
        fromWebhook({ media_id: '1', comment_id: '2' }),
      ];
      expect(answers).not.toContain(MentionKind.Tagged);
    });
  });

  describe('from the /tags walk, where it has to be inferred', () => {
    it('calls a collaborator tag what it is', () => {
      /*
       * THE CASE THAT WAS INVISIBLE. Verified 27 Sep: a collaborator tag
       * produced no `mentions` delivery, appeared on /tags within seconds, and
       * its post carried no caption at all.
       */
      expect(fromTagsWalk(null, 'ai_automation_demo')).toBe(MentionKind.Tagged);
      expect(fromTagsWalk('', 'ai_automation_demo')).toBe(MentionKind.Tagged);
      expect(fromTagsWalk('Buy now, link in bio', 'ai_automation_demo')).toBe(MentionKind.Tagged);
    });

    it('matches the handle BARE, because Meta strips the @', () => {
      // The caption comes back as "Superbbb.\n\nai_automation_demo" — no @ —
      // so matching on "@handle" would classify every caption tag as silent.
      expect(fromTagsWalk('Superbbb.\n\nai_automation_demo', 'ai_automation_demo')).toBe(
        MentionKind.Caption,
      );
    });

    it('ignores case, since a caption is somebody else’s typing', () => {
      expect(fromTagsWalk('thanks AI_Automation_Demo!', 'ai_automation_demo')).toBe(
        MentionKind.Caption,
      );
    });

    it('errs toward caption, never toward silent', () => {
      /*
       * A caption naming us in prose without tagging reads as a caption
       * mention. That is the harmless direction: over-reporting shows an agent
       * a post that mentions the business, where the other way round would
       * quietly downgrade a real mention to a tag nobody is told about.
       */
      expect(fromTagsWalk('shoutout to ai_automation_demo for the help', 'ai_automation_demo')).toBe(
        MentionKind.Caption,
      );
    });

    it('falls back to tagged when we do not know our own handle', () => {
      // Better to say "you were tagged" than to assert a mention we cannot
      // evidence.
      expect(fromTagsWalk('ai_automation_demo', null)).toBe(MentionKind.Tagged);
    });
  });
});
