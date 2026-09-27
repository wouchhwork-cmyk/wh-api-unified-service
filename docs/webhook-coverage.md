# Every webhook we have ever received, and what we do with it

A living checklist. One row per DISTINCT payload shape, not per delivery: the
ledger holds 1,148 real events and they collapse to 32 shapes, which is the
number that matters.

**The corpus is real.** Every shape below came from a delivery Meta actually
made to this account. Nothing here is invented, and nothing in it may be
replaced by an invented example — a fabricated payload that happens to project
proves only that the fabricator and the projector agree.

**How to re-run it:**

```
node --env-file=.env.dev --import tsx scripts/replay-corpus.ts --confirm
```

That clears everything derived from webhooks and resets every event to
`pending`, so the worker re-projects the whole corpus against current code.
Channels, provider connections and their tokens survive — clearing those would
disconnect the account. Take a `pg_dump` first anyway.

**Columns.** *Seen* is how many deliveries of that shape are in the ledger.
*Projected* is what the current code makes of it. *Gap* is what we know we are
losing, with a §reference into `platform-limitations.md` where one exists.

---

## Legend

| mark | meaning |
|---|---|
| OK | handled, and the outcome is what it should be |
| PARTIAL | handled, but something Meta gave us is dropped |
| GAP | not handled, or handled wrongly |
| BY DESIGN | not handled, and should not be — the reason is stated |

---

## 1. Direct messages

| shape | seen | projected | status |
|---|---|---|---|
| `text` | 54 | 54 messages | OK |
| `echo+text` (our own send, echoed back) | 11 | 11 | OK |
| `text+reply_to:{mid}` | 7 | 7, threaded under the parent | OK |
| `echo+text+reply_to:{mid}` | 2 | 2 | OK |
| `echo+text+reply_to:{story}` | 1 | 1, marked as a story reply | OK |
| `message_edit` | 35 | 0 — updates an existing message | **UNRESOLVED**, see the field audit |
| `message.is_deleted` (an unsend) | 1 | 0 — marks the held message deleted | OK, record kept on purpose |
| `reaction` | 1 | 0 — applies an emoji to a held message | OK |
| `is_unsupported` (a shared profile) | 2 | 2, flagged `contentUnavailable` | OK, §3.5 |

## 2. Direct message attachments

Every shape projects 1:1 and every payload key is captured (see the field
audit). `stableUrl` and `kindIsGuessed` are recorded where the link expires or
the media type is a guess.

| shape | seen | projected | status |
|---|---|---|---|
| `att:image` | 5 | 5 | OK |
| `att:video` | 1 | 1 | OK |
| `att:audio` | 2 | 2 | OK |
| `att:ig_post` (a shared post or advert) | 7 | 7, with `title` and `postMediaId` | OK |
| `att:ig_reel` | 1 | 1, with `reelVideoId` | OK |
| `att:ig_story` | 3 | 3, with `storyMediaId` | OK |
| `att:share` | 3 | 3 | OK |
| `att:story_mention` | 5 | 5, `kindIsGuessed` set | OK |
| `att:template` (a shared comment) | 7 | 7, flagged `contentUnavailable` | OK — Meta sends an empty box, §3.6 |
| `text+att:*` | 3 | 3 | OK |
| `echo+att:image+att:image` | 2 | 2, both attachments kept | OK |

## 3. Mentions

| shape | seen | projected | status |
|---|---|---|---|
| in a comment (`media_id`+`comment_id`) | 22 | 22, `mentionKind=comment` | OK |
| in a caption (`media_id` only) | 3 | 3, `mentionKind=caption` | OK |
| from the /tags backfill | 7 | 7, `mentionKind` inferred | OK — the only route for a collaborator tag, §1.2f |

## 4. Comments on our own posts

| shape | seen | projected | status |
|---|---|---|---|
| top-level | 9 | 9, author resolved from `from` | OK |
| reply (`parent_id`) | 7 | 3 — the rest are duplicates and our own | OK |
| no text at all | 1 | 1, flagged `platformSentNoText` | OK — a GIF or sticker, §1.4 |

## 5. Post updates

| shape | seen | projected | status |
|---|---|---|---|
| instagram | 539 | 159 post rows | OK — makes posts, not messages |
| facebook | 410 | (same set) | OK |

Post updates make **no Graph calls** — everything needed is in the payload,
which is why 949 of them replay without touching the rate limit.

---

## Results

Filled in by each replay run. Kept as a log rather than overwritten, so a
regression is visible as a change between runs.

### Run 1 — 27 Sep 2026, full corpus against current code

**1,102 processed, 52 skipped, 0 failed.** Rebuilt 49 conversations, 164
messages, 159 posts, 43 attachments and 7 customers from 1,154 events.

Every shape projects. The rows showing `made a message = 0` are correct rather
than broken, and it is worth saying which and why, because "nothing was
created" is what a silent failure looks like too:

- **`DM message_edit` (35)** — an edit UPDATES the message it names. Eleven of
  these failed on the first pass with *"a message_edit arrived before the
  message it names"* and all eleven succeeded on retry. That is the intended
  behaviour meeting the one condition it was written for: a replay claims
  events concurrently, so an edit really can be processed before its message,
  where live traffic arrives in order. It self-healed with no intervention.
- **`DM reaction` (1)** — applies an emoji to an existing message.
- **`DM unsend` (1)** — marks the existing message deleted; the record is kept
  deliberately (the business is accountable for the conversation).
- **`POST_UPDATE` (949)** — makes posts, not messages. Confirmed to make NO
  Graph calls: the payload carries everything, which is why 949 of them replay
  without touching the rate limit.
- **`COMMENT reply` (7 seen, 3 messages)** — the rest are duplicate deliveries
  and the business's own replies, both skipped on purpose.

**Attachments went UP, 39 to 43**, because the carousel-children fix (1.3) now
keeps slides that the previous run discarded. That is the replay earning its
keep: a fix landing on history, visible as a number.

**Rate limit cost of a full replay:** app pool peaked at 4%, ~205 calls. A
replay is cheap because only mentions resolve through Graph.


---

## Field-level audit — 27 Sep 2026

The shape audit asks "did this project?". This asks the harder question: **of
everything Meta sent, what did we keep?** Done by comparing every leaf key in
the real corpus against what reached a row.

### Attachments: nothing is lost

Every payload key Meta sends on an attachment is captured:

| Meta sends | we store |
|---|---|
| `ig_post.ig_post_media_id` | `postMediaId` |
| `ig_post.title` | `title` — the caption, often the whole message |
| `ig_reel.reel_video_id` | `reelVideoId` |
| `ig_story.story_media_id` | `storyMediaId` |
| `ig_story.story_media_url` | `source_url` |
| `*.url` | `source_url` |
| `template.generic` | nothing — it is always an empty array (§3.6) |

Plus `assetId`, `stableUrl` and `kindIsGuessed`, which are ours rather than
Meta's. **No gap.**

### Comments: two fields were being discarded — now fixed

- **`media.media_product_type`** (FEED / REELS / STORY) arrives on every
  comment delivery and reached nothing. Now kept as `postProductType` and
  promoted to a named DTO field, because an agent acts on it: a reel comment is
  usually a stranger the algorithm delivered, a feed comment usually somebody
  who already follows.
- **`from.self_ig_scoped_id`** appears only on the connected account's OWN
  comments. Now kept as `authorSelfScopedId`.

All 13 comments in the corpus link correctly to the post row they belong to, so
`media.id` was already being used.

### `message_edit`: detected, and then ignored — UNRESOLVED

35 deliveries. The payload carries **`mid` and `num_edit` only — no text**:

```json
{"message_edit":{"mid":"aWdfZAG1f…","num_edit":0}}
```

The handler looks the message up and, when we already hold it, **skips**. So
nothing ever refreshes the body. If an edit changes the words, the inbox shows
the old ones for ever.

**What cannot be settled from the corpus.** All 35 events carry `num_edit: 0`,
and the one message checked against Meta still reads exactly what we stored
(`"Hmm"`). So either these are not content edits at all, or no text has ever
actually changed in this account's history. Building a Graph re-read on that
guess would be speculative work on the DM projector, which today has no Graph
client at all.

**To settle it:** edit a DM that we already hold, then compare
`messages.body` against `GET /{mid}?fields=message`. That call is known to work
(§probe-message). One live case decides whether this is a bug or a non-event.

`num_edit` itself is dropped and should be kept either way.

---

## Review rounds — 27 Sep 2026

Seven rounds over the replay work and the fixes it prompted. Twenty-nine
findings, all fixed or recorded. Two things are worth keeping from the shape of
them.

**Most findings were caused by the previous round's fix.** Rounds 2 to 7 were
almost entirely repairs of repairs. The comment-moderation path alone went:
a deleted comment vanished while its conversation counted it → the fix let hide
be sent on a deleted comment → that fix refused every retry → that fix reported
a dropped duplicate as success → that fix made a double-clicked delete queue one
event per click. Five bugs, each introduced by the fix for the last.

The cause was not carelessness in any one round. The path read a state, decided
on it, and wrote it back across three steps outside a transaction, so every
check that read as authoritative was advisory — and each round tried to repair
that with a cleverer dedup key, which is the wrong layer. Once the row was
locked for the whole operation the churn stopped. **When fixes keep breeding
fixes, the layer is wrong.**

**Two guards had the same blind spot, and only one was survivable.** Both asked
"does this route declare a permission?" and both read only `@RequirePermission`,
missing `@RequireAnyPermission` — the whole inbox controller. For the scope
guard nothing came of it, because an actor with no scope resolves no
permissions and gate 2 refused them anyway. For the active guard nothing else
checks that a business is still switched on, so a **suspended enterprise kept
full read and reply access to its inbox**. Found only by reviewing the fix to
the first one. They now share a single function, because a question asked in two
places is eventually answered differently in each, and the second answer is the
one nobody tests.
