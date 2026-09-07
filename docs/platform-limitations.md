# What Meta will not tell us

Things the platform genuinely does not deliver, or delivers without enough to be
useful. Every entry is something we **tested against live traffic or the live
Graph API**, not something inferred from the docs — several of these contradict
what the docs imply, and two are undocumented entirely.

This file exists so nobody spends another afternoon rediscovering the same wall.
If you are about to go looking for a way to resolve a shared post, or wondering
why a removed reaction never disappears, read the relevant section first.

**Each entry says: what we expected, what actually happens, how it was verified,
and what we do about it.** Where a workaround exists it is named; where none
exists that is stated plainly rather than left open.

Last verified: **6 September 2026**, against `@ai_automation_demo`
(IG `17841472020051826`) on Graph `v23.0`.

---

## 0. Two kinds of limitation, and the difference matters

Every entry below is tagged, because "we cannot get it" has two completely
different meanings and only one of them is worth spending effort on:

- **[APP]** — our app or its granted scopes are the constraint. **Fixable** by
  adding a scope or passing App Review. Effort has a payoff.
- **[META]** — the platform does not expose it to anybody, at any permission
  level. **Not fixable.** Design around it and stop looking.

The tell is usually the error. `(#10) Application does not have permission for
this action` is **[APP]**. `(#100) Tried accessing nonexisting field` is
**[META]** — no permission conjures a field that does not exist. A `400` naming
the object, or a field silently omitted from a `200`, is usually **[META]**
enforcing a privacy boundary.

Our currently granted scopes:

```
pages_show_list, pages_messaging, instagram_basic, instagram_manage_comments,
instagram_manage_messages, pages_read_engagement, pages_manage_metadata,
public_profile
```

Notably **absent: `instagram_manage_insights`** — which is why every insight,
even on our own media, is refused today. That one is **[APP]**.

---

## 1. Mentions

### 1.1 An @mention inside a story reply produces no `mentions` webhook

**Expected:** tagging the business inside a reply/comment on another account's
story would raise the `mentions` field we subscribe to.

**Actual:** nothing arrives. Observed directly — a story reply carrying the
literal text `"@indian"` was delivered as an ordinary `messages` event with
`reply_to.story`, and no `mentions` change was ever sent for it.

**Verified:** live webhook capture, 6 Sep 2026, 20:15:58 IST.

**What we do:** nothing to do — there is no event to consume. An @mention in a
story reply is only ever visible as text inside the message body.

### 1.2 The `mentions` webhook carries no author and no content

**Expected:** a mention notification would say who mentioned us and what they
said.

**Actual:** the payload carries `media_id` and/or `comment_id` and **nothing
else** — no username, no caption, no text. So a live mention cannot be projected:
there is no author to attribute it to and no body to store.

**Verified:** `normalizeMention` in `comment-normalizer.ts` skips on exactly this
and says so in its skip reason. Only the `/tags` backfill, which returns the
tagging media *with* the tagger's username, produces a projectable mention.

**Workaround, BUILT and verified working.** Meta's **Mentions API**
resolves the ids off our own IG user node. It needs `instagram_manage_comments`,
which the connection **already holds** — no App Review.

One call returns everything a mention needs, the parent post included:

```
GET /{ig-user-id}?fields=mentioned_comment.comment_id(<comment_id>){
      id,text,timestamp,username,
      media{id,caption,media_type,permalink,username,owner,timestamp}
    }
```

Verified 6 Sep 2026 against a real mention (event 1514) — returned the comment
text, the commenter's handle, the parent post's caption, **its permalink, and its
owner's username**.

**Which edge to use is decided by the payload, not by guessing:**

| Payload | Edge | Note |
|---|---|---|
| `comment_id` present | `mentioned_comment` | The mention is in a comment |
| `comment_id` absent | `mentioned_media` | The mention is in the caption |

Using the wrong one fails loudly and usefully: asking `mentioned_media` for a
comment mention returns `(#10) User is not mentioned in the caption.`

### 1.3 What a tagged post will and will not tell us

A mention is read access to the post it sits on (§3.1), so a surprising amount
comes back for an account we do not manage. Probed field-by-field on a real
mention, 6 Sep 2026.

**Readable** via `mentioned_comment.comment_id(X){media{…}}`:

| Field | Example |
|---|---|
| `like_count` | `6447` |
| `comments_count` | `43` |
| `caption` | full text |
| `permalink` | `https://www.instagram.com/p/Dc53LpVs_06/` |
| `username` | `alpha_series369` — the owner |
| `media_type` / `media_product_type` | `IMAGE` / `FEED` |
| `media_url` | a real CDN image |
| `timestamp` | post time |

**There is no share count on the media node, and no field for one** —
`share_count`, `shares`, `reshare_count`, `saved` and `video_view_count` all
return `(#100) Tried accessing nonexisting field`. **[META]**

Shares and saves live only in **Insights**, and this splits cleanly:

- On **somebody else's** post — **[META]**, permanently. Insights is own-media
  only; a tagged post returns 500 no matter what we hold.
- On **our own** posts — **[APP]**, and fixable. Every metric (`shares`,
  `saved`, `impressions`, `reach`, `total_interactions`) currently returns
  `(#10) Application does not have permission for this action` because
  `instagram_manage_insights` is not among our granted scopes. Add the scope and
  our own share and save counts become available. Verified 6 Sep 2026 against
  our own post `17993553824735399`.

Also refused: `shortcode`, `is_shared_to_feed`, `is_comment_enabled`
(`(#100) Please read documentation for supported fields`). **[META]** — these
exist for our own media and are simply not exposed on somebody else's.

Returned as **200 with the field silently absent** — present in the schema, not
applicable or not permitted here: `thumbnail_url` (video only), `children`
(carousel only), `owner` (own media only). An absent field is not an error, so
code must treat missing as normal rather than retrying.

### 1.4 The comment thread IS readable, but not who wrote it

**Replies to the comment that named us** — `mentioned_comment(X){replies{…}}`:
`id`, `text`, `timestamp` and `like_count` all come back.

**The whole post's comment list** is reachable too, paginated:
`media{comments.limit(N){id,text,timestamp,like_count}}` returned all 43 comments
on a stranger's post.

**What is NOT available is authorship.** `replies{username}`, `replies{from}`,
`replies{from{id,username}}` and `replies{user{id,username}}` all return **200
with the field omitted**. So a thread can be read but not attributed — every
reply is anonymous to us.

The boundary is precisely the mention: on the post's own comment list,
`comments{id,timestamp,username}` returns `username` **for the comment that
tagged us and for no other comment on that post**. The mention is the grant, and
it does not extend to the people around it.

Probably **[META]** — it reads as a deliberate privacy boundary rather than a
missing scope, and no error is raised, the field is simply absent. Not proven:
`Instagram Public Content Access` (App Review) might widen it. Treat as [META]
until somebody tests it with that feature granted.

**Some replies come back with no `text` at all**, and no field combination
recovers it — `replies{text}`, `{id,text}`, `{id,text,timestamp}` and
`{id,text,like_count}` all omit it for the same reply while returning `id`,
`timestamp` and `like_count` normally. Other replies on the same thread return
their text fine, so it is per-comment, not per-query. Fetching the reply id
directly is refused (`400`) — the mention edge is the only route to it.

We do not know the rule. Treat a reply's text as **optional**: render what came
back and say nothing about the rest, rather than showing an empty bubble.
Observed on events 1516 and 1517, 6 Sep 2026.

**A comment's own image is NOT retrievable — confirmed on a comment that had
one.** A mention carrying both text and an uploaded image returned the text and
nothing else; every candidate field is refused at comment level, where a bad
field name errors rather than being silently swallowed:

```
media_url, thumbnail_url, attachment(s), image, photo, media_type,
sticker, gif, file, asset, preview
  → (#100) Tried accessing nonexisting field
```

`(#100) nonexisting field` is **[META]**: no scope and no App Review adds a
field that does not exist on the object. So a comment that is a photo, a GIF or
a sticker reaches us as text-or-nothing, and a media-only one as an id and a
timestamp. This is also why some replies come back with no `text` — there was
never any text, and the media is unreachable.

### 1.5b A reel answers with a thumbnail and NO media_url

Verified 6–7 Sep 2026. A photo post returns `media_url` and omits
`thumbnail_url`; a **REEL returns `thumbnail_url` and omits `media_url`
entirely**. Reading only `media_url` therefore left every reel mention with no
preview at all, while the field that would have shown one sat one word away.

`media_product_type` distinguishes them (`FEED` vs `REELS`), and both are now
requested. The API exposes a single `previewUrl` so a client does not have to
know the rule.

**A misleading error worth knowing:** `comments{id,text}` fails with
`500 Please reduce the amount of data you're asking for`, while
`comments{id,text,timestamp}` succeeds. It is a field-combination quirk, **not**
a volume problem — adding a field fixes it. Do not treat that 500 as a signal to
back off and page smaller; it will not help.

### 1.5 Who tagged us: a handle, and never an id

`mentioned_comment.username` and `from{username}` both return the tagger's
handle. **`from{id}` returns nothing** — asking for it yields the comment id and
no `from` object at all; asking for `from{id,username}` returns the username
alone. **[META]**

This matters for identity: a handle can be changed and reused, so a mention is
stored under `IdentifierKind.InstagramUsername` rather than passed off as an
IGSID. If the same person later DMs us, that message WILL carry a real IGSID and
the two records will not automatically be the same person.

Per Meta's own IG Comment reference, `user` is **"only returned if the app user
created the IG Comment"** — which is why it is empty on every comment but ours.

**`business_discovery` would give the tagger's follower count, profile picture,
biography and recent media** — but returns `(#10) Application does not have
permission for this action` for every target we tried, our own and strangers'
alike. That is app-level, not target-level. **[APP]** — fixable via App Review
(Advanced Access), and the only route to enriching a tagger beyond their handle.
It resolves business and creator accounts only; personal accounts never.

### 1.6 We CAN reply to a comment that tagged us — with what we already hold

`POST /{ig-user-id}/mentions` posts a reply as a sub-thread comment beneath the
mention:

| Parameter | When |
|---|---|
| `media_id` | always |
| `message` | always |
| `comment_id` | only when replying to a COMMENT mention |

Required permissions are `instagram_basic`, `instagram_manage_comments`,
`pages_read_engagement` and `pages_show_list` — **we hold all four**. No App
Review needed.

**This is NOT the same call as an ordinary comment reply.** A comment reply goes
to `POST /{comment-id}/replies`, which works only on media we own — a mention
lives on somebody else's post, so that edge fails for it. This is why
`ConversationKind.Mention` routes to its own `OutboundEventType.MentionReply`
rather than sharing the comment path.

Documented limits: **mentions on Stories cannot be replied to**, and
**commenting on a photo you were tagged in is not supported**. Also, no webhook
is delivered at all when the media belongs to a **private account** — so a
mention from a private account is invisible from the start. **[META]**

### 1.8 A reply to a mention can never be deleted, or even read back

**Expected:** having authored a comment, we could delete it.

**Actual:** both refused. Verified 8 Sep 2026 against a reply we had just posted
ourselves (`17967234453157331`, "@_omlokhande"):

```
GET    /{comment-id}  → 400 Unsupported get request
DELETE /{comment-id}  → 400 Unsupported delete request
```

The comment survived; all five replies were still on the thread afterwards.

Meta's rule, quoted: *"A comment can only be deleted by the owner of the object
upon which the comment was made, even if the user attempting to delete the
comment is the comment's author."* A mention lives on somebody else's post, so
only THAT account can remove our reply. **[META]** — `deleteComment` already
works on comments on our own media, so this is not a missing scope.

**Consequence, and it is worth telling an agent:** a reply to a mention is
PERMANENT from our side. There is no unsend.

Note the `GET` failing too: our own reply, seconds old, is not addressable by id.
It is visible only through the mentions edge, inside the parent's `replies` list.
The mention is the only door, in both directions.

---

## 2. Reactions

### 2.1 Removing a reaction sends no event

**Expected:** Meta documents `reaction.action` with an `unreact` value, so
removing an emoji should arrive as `action: "unreact"`.

**Actual:** adding a reaction delivers a webhook; **removing it delivers
nothing**. The ledger holds exactly one reaction event ever — `action: react`,
`reaction: laugh` — and no `unreact` has ever arrived despite reactions being
removed.

**Verified:** `SELECT ... FROM inbound_events WHERE payload ? 'reaction'` returns
a single `react` row, 6 Sep 2026.

**Consequence:** a reaction removed on Instagram **stays visible in our inbox
permanently**. There is no way to detect it.

**What we do:** `handleReaction` already treats `action === 'unreact'` as a
removal and nulls the stored reaction, so if Meta ever starts sending it we
handle it correctly with no code change. We simply never receive it.

---

## 3. Content shared into a DM

The full investigation is in the memory note; the conclusion is here.

### 3.1 An external account's shared post or story cannot be resolved to a link

**Expected:** `ig_post_media_id` and `story_media_id` would resolve through the
Graph API to a permalink, the way our own media does.

**Actual:** they resolve **only when the media belongs to the connected
account**. Everything else returns `400 GraphMethodException` (`error_subcode:
33`) on every field.

**Verified:** three shared `ig_post` ids tested field-by-field. The one that
resolved — permalink, caption, shortcode, owner, timestamp, like/comment counts —
turned out to be `owner.username: ai_automation_demo`, i.e. our own post shared
back to us. The two external ones refused all sixteen fields.

**One exception, and it is a real one:** media reached **through a mention edge**
IS readable even when somebody else owns it. `mentioned_comment{...media{...}}`
returned an external account's permalink, caption and owner username (§1.2). The
ownership rule governs media addressed *by id directly*; a mention is a grant.

**Every alternative route is closed, all tested:**

| Route | Result |
|---|---|
| Message node `shares` edge | Returns the link for `share`, **empty** for `ig_post` |
| `graph.instagram.com` | Rejects a Page token (`code 190`) |
| `business_discovery` | `(#10)` no permission, and needs a handle we do not have |
| `instagram_oembed` | `(#10)` requires Meta oEmbed Read via App Review |
| Facebook Page token instead of IG | Same 400 |

**The base64 shortcode trick cannot work**, and this is a proof rather than a
failed sample. Ground-truth pair:

```
webhook media id  : 17993553824735399      (17 digits — a Graph media id)
real shortcode    : DKhCcH5TDnJ
base64(media id)  : _7Qq3-GCn              ← the trick's output, nonsense
decode(shortcode) : 3648207901862672841    (19 digits — an internal pk)
```

The shortcode encodes a **different id** from the one the webhook gives us. No
encoding bridges the two.

### 3.2 What *does* yield a link

- **`share`** — the webhook payload's `url` already **is** an instagram.com
  permalink. Nothing to resolve.
- **`ig_post` we own** — `posts.permalink_url` already holds it locally, keyed by
  `posts_platform_uniq (channel_id, platform_post_id)`. No API call needed.
- **`story_mention`** — the story's owner **is the message sender**, so their
  profile link is correct by definition.

### 3.3 Shared content is unrecoverable after a dropped delivery

Meta exposes a shared post, story or reel **only on the live webhook**. Every
read path — the conversations edge, and the message node asked directly for
`attachments`, `shares`, `story` and `sticker` — returns them empty.

**What we do:** the projector sets `contentUnavailable` so the inbox says "the
customer sent something the platform will not show us" rather than rendering an
empty bubble.

---

## 4. Stories

### 4.1 Someone else's story id resolves to nothing

`ig_story.story_media_id` and a `story_mention`'s asset id both return
`400` on every field. Verified 6 Sep 2026 on `18031245590895452` and
`18101327498358721`.

### 4.2 Our own stories *are* readable

`GET /{ig-user-id}/stories?fields=id,media_type,media_url,permalink,timestamp`
returns **200**. (It returned `{"data":[]}` at time of testing only because no
story was live — the edge and the permission both work.)

**Not yet used.** When a customer replies to our story we currently keep the
expiring CDN link from `reply_to.story.url`; resolving the real story object
would survive the 24-hour expiry.

### 4.3 A story mention's media link can be refreshed — uniquely

`GET /{mid}?fields=story` re-issues a **fresh signed CDN link** for a
`story_mention`. This works for story mentions and **nothing else** — `ig_post`
and `ig_story` return nothing from the same call. Not yet used.

---

## 5. Undocumented payload shapes

`ig_post` and `ig_story` appear in **no Meta webhook documentation**. They arrive
anyway, and carry more than the documented `share` does:

```jsonc
// ig_post — CDN image, caption, and the post's own id
{ "type": "ig_post", "payload": { "url": "...", "title": "<caption>", "ig_post_media_id": "..." } }

// ig_story — note the link lives under its OWN key, not `url`
{ "type": "ig_story", "payload": { "story_media_id": "...", "story_media_url": "..." } }

// share — a real permalink, and nothing else
{ "type": "share", "payload": { "url": "https://www.instagram.com/reel/..." } }
```

Reading only `payload.url` therefore loses a shared story's link entirely — the
normalizer reads `story_media_url` as a fallback for exactly this reason.

Observed: reels arrive as `share` (with a permalink), posts as `ig_post` (without
one). Both shapes were still arriving on 6 Sep 2026.

---

## 6. Media and storage

Meta's terms forbid storing or caching the **media itself** on our servers. The
**CDN link may** be stored, and that is what we keep.

Signed Meta CDN links (`fbsbx.com`, `fbcdn.net`, `cdninstagram.com`) expire with
the content they point at — about 24 hours for a story. Links on any other host
are treated as permanent, which is why `isExpiringMediaUrl` matches on host
rather than assuming everything expires.

---

## 7. Delivery behaviour

### 7.1 A `message_edit` can arrive *before* the message it names

Observed 6 Sep 2026: a `message_edit` for a mid we had never seen arrived
**0.7 seconds before** the message itself. The lost-delivery detector treats an
orphan edit as evidence of a dropped webhook, so it fired a resync that recovered
`synced_item_count: 0`.

Harmless — one wasted Graph call per occurrence, no data harm — but it is a false
positive, not a real loss. A short grace before acting on an orphan edit would
remove nearly all of them.

### 7.2 Meta never resends a delivery we answered 200

A webhook item that fails to store after we have answered 200 is **gone**. This
is why item-level failures are counted and logged at `error` rather than
swallowed, and why one bad item must never fail the whole delivery — a non-2xx
run of retries ends with Meta **disabling the subscription**.

### 7.3 The published app receives other accounts' traffic

Deliveries reach this backend through the published socialLift app, which other
Instagram accounts have also authorized. We therefore receive webhooks —
including other people's DM text and story media URLs — for accounts that are not
ours.

`ingest` resolves the tenant from `entry.id` and drops anything it cannot
attribute (`unmatched`), so none of it is stored. **But it does arrive**, and it
passes through the relay and any request logging on the way. Filtering by account
id at the relay is worth considering.

Observed 6 Sep 2026: three deliveries for IG `17841419871844792`, an account with
no channel here, all correctly dropped.

---

## 8. Known-wrong

### 8.1 `entry.time` has no consistent unit — **[META]**, fixed 8 Sep 2026

**Expected:** one unit for `entry.time`, as the webhook reference implies.

**Actually:** the unit depends on the entry. A `changes` entry (mentions,
comments) carries **seconds**; a `messaging` entry (Instagram DMs) carries
**milliseconds**. Meta documents neither, and nothing in the payload labels it.

**Verified:** a DM delivery on 6 Sep 2026 carried `1788705985749`, which is
`2026-09-06T14:46:25Z` read as milliseconds. Mention event 1514 carried a
second-epoch and stored correctly as `2026-09-06 20:37:03`.

**What went wrong:** `meta-webhook.service.ts` multiplied every `entry.time` by
1000. That is right for a `changes` entry, so mentions and comments were fine —
which is what hid it — and wrong by a factor of a thousand for a `messaging`
one. **72** ledger rows were left with a `received_at` in the year **58649**
or later — an earlier note here said seven, which was the count of one
afternoon's DMs rather than of the table. `received_at` orders recovered history
against live events, so this was not cosmetic.

**What we do about it:** `normalizeEntryTime` in
`src/modules/connections/entry-time.ts` decides the unit **by magnitude, not by
entry type** — a value past the year 2100 read as seconds must be milliseconds,
and nothing a webhook can deliver falls in the band between the two readings. So
a third entry type, or a unit Meta changes without saying, needs no new case.
The same bound rejects the implausible: non-finite, zero, negative and
absurdly-large values become `null` rather than a Date nobody can order by.

Migration `1757300000000-RepairInboundReceivedAt` repairs the rows already
stored, dividing the epoch back down and scoped to `received_at > now() +
interval '1 year'` so it cannot reach a good row. All 72 divide back to an
instant on 5-6 Sep 2026, so every corrupted row is wrong by exactly this factor
and none is left behind.

### 8.2 Still not fixed

- **A video `story_mention` is stored as `mediaKind: image`.** The CDN serves it
  as `video/mp4`; it only renders because the client retries a failed image as
  `<video>`.
- **`ConversationKind.StoryReply` is never assigned.** The projector files every
  DM as `DirectMessage`. Harmless today — both kinds have identical reply
  semantics — but the enum value and its reply-window entry are dead.
