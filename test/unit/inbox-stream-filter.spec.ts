import { describe, expect, it } from 'vitest';
import { deliverableChange } from '@/modules/inbox/inbox-events.service';
import { ConversationKind } from '@/shared/enums';

/**
 * Who hears about a conversation changing.
 *
 * THIS FILE EXISTS BECAUSE ITS ABSENCE LET A DEFECT SHIP. The live-inbox route
 * was widened to `@RequireAnyPermission` so a business granting only
 * `mentions.view` could reach the endpoint that serves mentions — and for a
 * while it got the widened door with none of the filtering every other inbox
 * path received. Then the filter arrived and the comment projector announced
 * every MENTION as a comment thread, breaking it in both directions at once.
 *
 * Neither was caught, because nothing tested the fan-out at all: it lives
 * behind a Postgres LISTEN connection, so testing it in place means standing up
 * a client, and it quietly went untested. The decision is a pure function now
 * for exactly that reason.
 *
 * What reaches a subscriber is ids only — never content — so the leak this
 * guards is not messages. It is the existence, stable refId, count, direction
 * and real-time timing of threads somebody was explicitly denied.
 */
describe('who hears about a conversation changing', () => {
  const TENANT = 42;
  const payload = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      enterpriseId: TENANT,
      conversationRefId: 'c1',
      kind: 'inbound',
      conversationKind: ConversationKind.DirectMessage,
      ...over,
    });

  const sees = (...kinds: ConversationKind[]) => new Set(kinds);

  describe('filtering by kind', () => {
    it('delivers a kind the subscriber may see', () => {
      const change = deliverableChange(payload(), TENANT, sees(ConversationKind.DirectMessage));

      expect(change).toEqual({
        conversationRefId: 'c1',
        kind: 'inbound',
        conversationKind: ConversationKind.DirectMessage,
      });
    });

    it('DROPS a kind the subscriber may not see', () => {
      /*
       * The original leak. Somebody holding only `mentions.view` was receiving
       * a change event for every private DM in the business.
       */
      expect(deliverableChange(payload(), TENANT, sees(ConversationKind.Mention))).toBeNull();
    });

    it('delivers a mention to somebody who may see mentions', () => {
      /*
       * The other half, and the one that broke second: announcing every mention
       * as a comment thread meant the tenant this whole split was built for —
       * an agency handling public mentions and never the private inbox —
       * received nothing at all.
       */
      const change = deliverableChange(
        payload({ conversationKind: ConversationKind.Mention }),
        TENANT,
        sees(ConversationKind.Mention),
      );

      expect(change?.conversationKind).toBe(ConversationKind.Mention);
    });

    it('does not let a comment viewer hear about mentions', () => {
      expect(
        deliverableChange(
          payload({ conversationKind: ConversationKind.Mention }),
          TENANT,
          sees(ConversationKind.CommentThread),
        ),
      ).toBeNull();
    });

    it('delivers every kind to somebody who may see them all', () => {
      const all = sees(
        ConversationKind.DirectMessage,
        ConversationKind.CommentThread,
        ConversationKind.Mention,
      );

      for (const kind of all) {
        expect(deliverableChange(payload({ conversationKind: kind }), TENANT, all)).not.toBeNull();
      }
    });

    it('delivers nothing to a subscriber allowed nothing', () => {
      expect(deliverableChange(payload(), TENANT, new Set())).toBeNull();
    });
  });

  describe('fail-closed', () => {
    it('DROPS a payload with no conversation kind', () => {
      /*
       * A rolling deploy is the case that matters: an older instance still
       * publishing the previous shape would otherwise have its events fanned
       * out unfiltered, which is the exact leak this closes. The cost of
       * dropping is a client that re-reads on its own poll a beat later.
       */
      const old = JSON.stringify({
        enterpriseId: TENANT,
        conversationRefId: 'c1',
        kind: 'inbound',
      });

      expect(deliverableChange(old, TENANT, sees(ConversationKind.DirectMessage))).toBeNull();
    });

    it('DROPS a kind nobody recognises', () => {
      expect(
        deliverableChange(
          payload({ conversationKind: 'something_new' }),
          TENANT,
          sees(ConversationKind.DirectMessage),
        ),
      ).toBeNull();
    });

    it('drops a payload for another business', () => {
      // The tenant is re-checked here and not only when the subscriber set is
      // found, because this is the function that decides delivery.
      expect(
        deliverableChange(payload({ enterpriseId: 7 }), TENANT, sees(ConversationKind.DirectMessage)),
      ).toBeNull();
    });

    it('drops malformed JSON rather than throwing', () => {
      // This runs inside a LISTEN callback; a throw here takes the connection
      // down and every stream on this instance with it.
      expect(deliverableChange('not json', TENANT, sees(ConversationKind.DirectMessage))).toBeNull();
      expect(deliverableChange(undefined, TENANT, sees(ConversationKind.DirectMessage))).toBeNull();
    });

    it('drops a payload with no conversation reference', () => {
      expect(
        deliverableChange(
          payload({ conversationRefId: 42 }),
          TENANT,
          sees(ConversationKind.DirectMessage),
        ),
      ).toBeNull();
    });
  });

  describe('the direction hint', () => {
    it('passes outbound through', () => {
      const change = deliverableChange(
        payload({ kind: 'outbound' }),
        TENANT,
        sees(ConversationKind.DirectMessage),
      );

      expect(change?.kind).toBe('outbound');
    });

    it('treats anything else as inbound', () => {
      // A hint, not a decision — the client re-reads regardless — so an
      // unexpected value falls back rather than dropping a real change.
      const change = deliverableChange(
        payload({ kind: 'who knows' }),
        TENANT,
        sees(ConversationKind.DirectMessage),
      );

      expect(change?.kind).toBe('inbound');
    });
  });
});
