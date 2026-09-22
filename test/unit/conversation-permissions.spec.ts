import { describe, expect, it } from 'vitest';
import { anyPermissionFor, permissionFor, visibleKinds } from '@/shared/rbac';
import { ConversationKind, Permission } from '@/shared/enums';

/**
 * Which permission governs which kind of thread.
 *
 * WRITTEN BECAUSE THIS MODULE HAD NO DIRECT TEST, which is how the stream
 * defect survived. `inbox-stream-filter.spec.ts` is a good spec for the
 * delivery decision, but it hand-builds the set of kinds a subscriber may see —
 * so `visibleKinds` could have returned EVERY kind regardless of what the actor
 * held and every test in that file would still have passed. The one rule that
 * decides what a person may see was covered only indirectly, through a single
 * e2e.
 *
 * The three functions here are small and the mistakes they invite are not: a
 * wrong entry in the map hands somebody another business's private inbox on a
 * screen built for public mentions.
 */
describe('which permission governs which kind of thread', () => {
  describe('the map itself', () => {
    it('gives direct messages, comments and mentions DIFFERENT codes', () => {
      /*
       * The whole point of the split. All three are rows in `conversations`,
       * and governing them with one permission meant a business could not let
       * somebody handle public mentions without also handing them the private
       * inbox — and meant comment threads were gated on the inbox feature
       * rather than the comment one.
       */
      expect(permissionFor(ConversationKind.DirectMessage, 'view')).toBe(
        Permission.ConversationsView,
      );
      expect(permissionFor(ConversationKind.CommentThread, 'view')).toBe(Permission.CommentsView);
      expect(permissionFor(ConversationKind.Mention, 'view')).toBe(Permission.MentionsView);
    });

    it('keeps the four actions distinct within one kind', () => {
      const kind = ConversationKind.Mention;
      const codes = (['view', 'reply', 'assign', 'manage'] as const).map((action) =>
        permissionFor(kind, action),
      );

      expect(new Set(codes).size).toBe(4);
      expect(codes).toEqual([
        Permission.MentionsView,
        Permission.MentionsReply,
        Permission.MentionsAssign,
        Permission.MentionsManage,
      ]);
    });

    it('covers every conversation kind the enum has', () => {
      /*
       * A kind with no entry would throw at runtime on the first thread of that
       * type. `Review` exists in the enum and nothing produces one yet, which
       * is exactly the sort of gap that stays invisible until it does not.
       */
      for (const kind of Object.values(ConversationKind)) {
        expect(permissionFor(kind, 'view')).toBeTruthy();
        expect(permissionFor(kind, 'manage')).toBeTruthy();
      }
    });
  });

  describe('the union a route declares', () => {
    it('is every code that could open the door for that action', () => {
      const codes = anyPermissionFor('view');

      expect(codes).toContain(Permission.ConversationsView);
      expect(codes).toContain(Permission.CommentsView);
      expect(codes).toContain(Permission.MentionsView);
    });

    it('is deduplicated, because two kinds share a code', () => {
      // `Review` maps to the conversation codes, so the raw list has a repeat.
      const codes = anyPermissionFor('view');

      expect(new Set(codes).size).toBe(codes.length);
    });

    it('never widens beyond the action asked for', () => {
      // A route declaring the `view` union must not accidentally admit somebody
      // holding only a reply or manage right.
      const codes = anyPermissionFor('view');

      expect(codes).not.toContain(Permission.ConversationsReply);
      expect(codes).not.toContain(Permission.CommentsManage);
    });
  });

  describe('what one actor may see', () => {
    it('returns ONLY the kinds whose view permission is held', () => {
      /*
       * THE ASSERTION THAT WAS MISSING. Make this function return every kind
       * regardless of `held` and nothing else in the suite notices — the stream
       * filter tests build their own set, and the listing test grants
       * everything.
       */
      const kinds = visibleKinds(new Set([Permission.MentionsView]));

      expect(kinds).toEqual([ConversationKind.Mention]);
    });

    it('gives somebody with every view right every kind', () => {
      const kinds = visibleKinds(
        new Set([Permission.ConversationsView, Permission.CommentsView, Permission.MentionsView]),
      );

      expect(kinds).toEqual(
        expect.arrayContaining([
          ConversationKind.DirectMessage,
          ConversationKind.CommentThread,
          ConversationKind.Mention,
        ]),
      );
    });

    it('gives somebody holding nothing no kinds at all', () => {
      // Fail-closed. The listing turns this into an empty page rather than an
      // unfiltered one.
      expect(visibleKinds(new Set())).toEqual([]);
    });

    it('is not fooled by holding a REPLY right without the VIEW right', () => {
      /*
       * Visibility is decided by `view` alone. A business that granted reply
       * without view has made a strange choice, and the answer is that they
       * cannot see the thread — not that reply implies view.
       */
      expect(visibleKinds(new Set([Permission.MentionsReply]))).toEqual([]);
    });

    it('does not leak the private inbox to somebody granted only mentions', () => {
      // The persona the whole split exists for: an agency handling public
      // mentions and never the customer's DMs.
      const kinds = visibleKinds(new Set([Permission.MentionsView]));

      expect(kinds).not.toContain(ConversationKind.DirectMessage);
      expect(kinds).not.toContain(ConversationKind.CommentThread);
    });
  });
});
