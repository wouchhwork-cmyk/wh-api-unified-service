import { ConversationKind, Permission } from '@/shared/enums';

/**
 * Which permission governs which kind of thread.
 *
 * WHY THIS EXISTS. A direct message, a comment thread and a mention are all
 * rows in `conversations` and all served by the same endpoints — but storing
 * three things in one table is not a reason to govern them with one permission.
 * Before this, `conversations.view` covered all three, with two consequences
 * that were genuinely wrong rather than merely coarse:
 *
 *   - A business could not let somebody handle public mentions without also
 *     giving them the private inbox. Those are very different levels of trust,
 *     and a social-media agency wants exactly the first without the second.
 *   - Comment threads were gated on `unified_inbox` rather than on
 *     `comment_management`, so a business whose comment feature had been
 *     REVOKED kept full comment access. Measured on real data: one tenant sat
 *     in exactly that state.
 *
 * The route can no longer decide this on its own, because the answer depends on
 * the row. So the route declares the union — hold any of them and you may reach
 * the endpoint — and the service checks the specific one once it knows what it
 * is looking at.
 *
 * REVIEW IS NOT MODELLED. `ConversationKind.Review` exists in the enum and
 * nothing produces one; giving it permissions would be inventing a surface.
 * It maps to the conversation codes so that a row appearing from somewhere
 * unexpected is governed by the strictest thing available rather than by
 * nothing.
 */
interface KindPermissions {
  readonly view: Permission;
  readonly reply: Permission;
  readonly assign: Permission;
  readonly manage: Permission;
}

const BY_KIND: Readonly<Record<ConversationKind, KindPermissions>> = {
  [ConversationKind.DirectMessage]: {
    view: Permission.ConversationsView,
    reply: Permission.ConversationsReply,
    assign: Permission.ConversationsAssign,
    manage: Permission.ConversationsManage,
  },
  [ConversationKind.CommentThread]: {
    view: Permission.CommentsView,
    reply: Permission.CommentsReply,
    assign: Permission.CommentsAssign,
    manage: Permission.CommentsManage,
  },
  [ConversationKind.Mention]: {
    view: Permission.MentionsView,
    reply: Permission.MentionsReply,
    assign: Permission.MentionsAssign,
    manage: Permission.MentionsManage,
  },
  [ConversationKind.Review]: {
    view: Permission.ConversationsView,
    reply: Permission.ConversationsReply,
    assign: Permission.ConversationsAssign,
    manage: Permission.ConversationsManage,
  },
};

export type ConversationAction = keyof KindPermissions;

/** The single code that governs this action on this kind of thread. */
export function permissionFor(kind: ConversationKind, action: ConversationAction): Permission {
  return BY_KIND[kind][action];
}

/**
 * Every code that could let somebody reach an endpoint serving all three kinds.
 *
 * Used by the route decorator. Holding ANY of them gets you in; the service
 * then decides whether you may touch the particular row. Without this a
 * business granting only `mentions.view` would be refused at the door of the
 * very endpoint that serves mentions.
 */
export function anyPermissionFor(action: ConversationAction): Permission[] {
  return [...new Set(Object.values(BY_KIND).map((kind) => kind[action]))];
}

/**
 * The kinds of thread this actor may see at all.
 *
 * The listing is filtered to these rather than checked per row: a page that
 * dropped rows after fetching would come back short while more matching rows
 * existed, and the caller reads a short page as the end of the results.
 */
export function visibleKinds(held: ReadonlySet<string>): ConversationKind[] {
  return (Object.keys(BY_KIND) as ConversationKind[]).filter((kind) =>
    held.has(BY_KIND[kind].view),
  );
}
