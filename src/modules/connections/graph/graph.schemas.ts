import { z } from 'zod';

/**
 * Runtime schemas for every Graph response this integration consumes.
 *
 * WHY THESE EXIST. Every response used to be cast — `return parsed as T` — so
 * the first thing that noticed a shape change was whatever consumed the value,
 * three layers down, as `undefined is not a function` or a column written null.
 * The cast asserted a contract with a system we do not control and cannot
 * version-pin. Checking at the boundary turns a mystery downstream into a named
 * failure at the call that caused it.
 *
 * WHAT THEY ARE DELIBERATELY NOT. Not strict. Meta adds fields constantly and a
 * schema that rejected unknown keys would break on their release schedule
 * rather than ours, so unknown keys are stripped and ignored. Nearly every field
 * is optional because Graph OMITS rather than nulls: a post with no text has no
 * `message` key at all, and treating absence as an error would abandon a walk
 * over a photo post.
 *
 * The narrow claim being made is: the fields we DO read are the types we think
 * they are, and an edge that should be a list is a list.
 */

/**
 * An id, however Meta spells it.
 *
 * Numeric ids have come back as JSON numbers on some edges and as strings on
 * others, for the same object, across versions. Both are accepted and
 * normalised to a string — which is what every column and every comparison in
 * this codebase expects. `z.coerce.string()` is NOT used: it would happily turn
 * an object into "[object Object]" and call it valid.
 */
const GraphId = z.union([z.string(), z.number().transform(String)]);

/**
 * A count.
 *
 * Coerced, because engagement counts have historically arrived as numeric
 * strings on some edges. The alternative — rejecting "42" — would fail a
 * backfill over a formatting difference that costs us nothing to absorb.
 */
const GraphCount = z.coerce.number();

/** An edge: a page of `data` plus the cursor to continue it. */
export const GraphPagingSchema = z
  .object({
    cursors: z.object({ before: z.string().optional(), after: z.string().optional() }).optional(),
    next: z.string().optional(),
  })
  .optional();

function edgeOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({ data: z.array(item).optional(), paging: GraphPagingSchema });
}

export const GraphActorSchema = z.object({
  id: GraphId,
  name: z.string().optional(),
  /** Instagram identifies people by handle; Facebook by name. */
  username: z.string().optional(),
});

/* ------------------------------------------------------------------ *
 * OAuth and account discovery
 * ------------------------------------------------------------------ */

export const GraphTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string().optional(),
  /** Seconds, captured into provider_connections.token_expires_at. */
  expires_in: GraphCount.optional(),
});

export const GraphMeResponseSchema = z.object({
  id: GraphId,
  name: z.string().optional(),
});

export const GraphInstagramAccountSchema = z.object({ id: GraphId, username: z.string().optional() });

export const GraphAccountSchema = z.object({
  id: GraphId,
  name: z.string().optional(),
  /** The PAGE token. Every downstream call for this Page authorises with it. */
  access_token: z.string().optional(),
  category: z.string().optional(),
  instagram_business_account: GraphInstagramAccountSchema.optional(),
});

export const GraphAccountsResponseSchema = z.object({
  data: z.array(GraphAccountSchema).optional(),
  paging: z
    .object({
      next: z.string().optional(),
      cursors: z.object({ after: z.string().optional() }).optional(),
    })
    .optional(),
});

export const GraphGranularScopeSchema = z.object({
  scope: z.string(),
  target_ids: z.array(z.string()).optional(),
});

export const GraphDebugTokenResponseSchema = z.object({
  data: z
    .object({
      app_id: z.string().optional(),
      is_valid: z.boolean().optional(),
      expires_at: GraphCount.optional(),
      scopes: z.array(z.string()).optional(),
      granular_scopes: z.array(GraphGranularScopeSchema).optional(),
    })
    .optional(),
});

/* ------------------------------------------------------------------ *
 * Facebook read edges
 * ------------------------------------------------------------------ */

export const GraphCommentSchema = z.object({
  id: GraphId,
  message: z.string().optional(),
  created_time: z.string().optional(),
  from: GraphActorSchema.optional(),
  parent: z.object({ id: GraphId.optional() }).optional(),
});

export const GraphFeedPostSchema = z.object({
  id: GraphId,
  message: z.string().optional(),
  story: z.string().optional(),
  created_time: z.string().optional(),
  permalink_url: z.string().optional(),
  status_type: z.string().optional(),
  full_picture: z.string().optional(),
  attachments: z
    .object({
      data: z
        .array(
          z.object({
            type: z.string().optional(),
            media: z.object({ image: z.object({ src: z.string().optional() }).optional() }).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  comments: edgeOf(GraphCommentSchema).optional(),
  reactions: z.object({ summary: z.object({ total_count: GraphCount.optional() }).optional() }).optional(),
  comment_summary: z
    .object({ summary: z.object({ total_count: GraphCount.optional() }).optional() })
    .optional(),
  shares: z.object({ count: GraphCount.optional() }).optional(),
});

export const GraphMessageAttachmentSchema = z.object({
  id: GraphId.optional(),
  name: z.string().optional(),
  mime_type: z.string().optional(),
  image_data: z
    .object({ url: z.string().optional(), width: GraphCount.optional(), height: GraphCount.optional() })
    .optional(),
  video_data: z
    .object({ url: z.string().optional(), width: GraphCount.optional(), height: GraphCount.optional() })
    .optional(),
  file_url: z.string().optional(),
});

export const GraphConversationMessageSchema = z.object({
  id: GraphId,
  message: z.string().optional(),
  created_time: z.string().optional(),
  from: GraphActorSchema.optional(),
  to: z.object({ data: z.array(GraphActorSchema).optional() }).optional(),
  attachments: edgeOf(GraphMessageAttachmentSchema).optional(),
  reply_to: z.object({ mid: z.string().optional(), is_self_reply: z.boolean().optional() }).optional(),
  shares: edgeOf(
    z.object({
      link: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
    }),
  ).optional(),
});

export const GraphConversationSchema = z.object({
  id: GraphId,
  updated_time: z.string().optional(),
  messages: edgeOf(GraphConversationMessageSchema).optional(),
  participants: z.object({ data: z.array(GraphActorSchema).optional() }).optional(),
});

/* ------------------------------------------------------------------ *
 * Instagram read edges
 * ------------------------------------------------------------------ */

export const GraphInstagramUserProfileSchema = z.object({
  id: GraphId.optional(),
  name: z.string().optional(),
  username: z.string().optional(),
  profile_pic: z.string().optional(),
  follower_count: GraphCount.optional(),
  is_verified_user: z.boolean().optional(),
  is_user_follow_business: z.boolean().optional(),
  is_business_follow_user: z.boolean().optional(),
});

export const GraphInstagramCommentSchema = z.object({
  id: GraphId,
  text: z.string().optional(),
  timestamp: z.string().optional(),
  username: z.string().optional(),
  like_count: GraphCount.optional(),
  hidden: z.boolean().optional(),
  from: z.object({ id: GraphId.optional(), username: z.string().optional() }).optional(),
  parent_id: GraphId.optional(),
});

export const GraphInstagramMediaSchema = z.object({
  id: GraphId,
  caption: z.string().optional(),
  media_type: z.string().optional(),
  permalink: z.string().optional(),
  media_url: z.string().optional(),
  thumbnail_url: z.string().optional(),
  timestamp: z.string().optional(),
  comments_count: GraphCount.optional(),
  like_count: GraphCount.optional(),
  comments: edgeOf(GraphInstagramCommentSchema).optional(),
});

export const GraphInstagramTagSchema = z.object({
  id: GraphId,
  caption: z.string().optional(),
  media_type: z.string().optional(),
  media_url: z.string().optional(),
  permalink: z.string().optional(),
  timestamp: z.string().optional(),
  username: z.string().optional(),
  like_count: GraphCount.optional(),
  comments_count: GraphCount.optional(),
});

/* ------------------------------------------------------------------ *
 * Mentions API
 * ------------------------------------------------------------------ */

export const GraphMentionedMediaSchema = z.object({
  id: GraphId.optional(),
  caption: z.string().optional(),
  media_type: z.string().optional(),
  media_url: z.string().optional(),
  /** A VIDEO or REEL carries this and NO media_url. */
  thumbnail_url: z.string().optional(),
  media_product_type: z.string().optional(),
  permalink: z.string().optional(),
  username: z.string().optional(),
  timestamp: z.string().optional(),
  like_count: GraphCount.optional(),
  comments_count: GraphCount.optional(),
});

export const GraphMentionedCommentReplySchema = z.object({
  id: GraphId.optional(),
  text: z.string().optional(),
  timestamp: z.string().optional(),
  like_count: GraphCount.optional(),
});

export const GraphMentionedCommentSchema = z.object({
  id: GraphId.optional(),
  parent_id: GraphId.optional(),
  text: z.string().optional(),
  timestamp: z.string().optional(),
  username: z.string().optional(),
  like_count: GraphCount.optional(),
  media: GraphMentionedMediaSchema.optional(),
  replies: z.object({ data: z.array(GraphMentionedCommentReplySchema).optional() }).optional(),
});

/* ------------------------------------------------------------------ *
 * Response envelopes used at individual call sites
 * ------------------------------------------------------------------ */

export const GraphEdgeOfFeedPostSchema = edgeOf(GraphFeedPostSchema);
export const GraphEdgeOfConversationSchema = edgeOf(GraphConversationSchema);
export const GraphEdgeOfInstagramMediaSchema = edgeOf(GraphInstagramMediaSchema);
export const GraphEdgeOfInstagramTagSchema = edgeOf(GraphInstagramTagSchema);

/** A write that answers with the created object's id, and nothing else. */
export const GraphCreatedIdSchema = z.object({ id: GraphId });

/**
 * A send.
 *
 * `message_id` on the Send API, `id` on the comment edges — and which one
 * arrives decides what gets stored as the platform id, so both are optional and
 * the caller picks.
 */
export const GraphSendResponseSchema = z.object({
  message_id: GraphId.optional(),
  id: GraphId.optional(),
});

/** A write with no useful body: subscribing, hiding, deleting. */
export const GraphAckSchema = z.object({ success: z.boolean().optional() });

export const GraphMentionedMediaEnvelopeSchema = z.object({
  mentioned_media: GraphMentionedMediaSchema.optional(),
});

export const GraphMentionedCommentEnvelopeSchema = z.object({
  mentioned_comment: GraphMentionedCommentSchema.optional(),
});

export const GraphMentionedCommentRepliesEnvelopeSchema = z.object({
  mentioned_comment: z
    .object({
      media: z
        .object({
          comments: z.object({ data: z.array(GraphMentionedCommentReplySchema).optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
});

export const GraphSubscribedAppsSchema = z.object({
  data: z.array(z.object({ subscribed_fields: z.array(z.string()).optional() })).optional(),
});

export const GraphChannelProfileSchema = z.object({
  name: z.string().optional(),
  username: z.string().optional(),
  followers_count: GraphCount.optional(),
  fan_count: GraphCount.optional(),
  profile_picture_url: z.string().optional(),
});

export const GraphPageDetailSchema = z.object({
  id: GraphId.optional(),
  name: z.string().optional(),
  access_token: z.string().optional(),
  category: z.string().optional(),
  instagram_business_account: GraphInstagramAccountSchema.optional(),
});
