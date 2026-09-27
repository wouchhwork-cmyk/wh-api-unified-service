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

| # | shape | seen | projected | status |
|---|---|---|---|---|
| 1.1 | `text` | 51 | | |
| 1.2 | `echo+text` (our own send, echoed back) | 8 | | |
| 1.3 | `text+reply_to:{mid,is_self_reply}` | 7 | | |
| 1.4 | `echo+text+reply_to:{mid,is_self_reply}` | 2 | | |
| 1.5 | `echo+text+reply_to:{story}` | 1 | | |
| 1.6 | `message_edit` | 35 | | |
| 1.7 | `message.is_deleted` (an unsend) | 1 | | |
| 1.8 | `reaction` | 1 | | |
| 1.9 | `is_unsupported` (a shared profile) | 2 | | |

## 2. Direct message attachments

| # | shape | seen | projected | status |
|---|---|---|---|---|
| 2.1 | `att:image` | 5 | | |
| 2.2 | `att:video` | 1 | | |
| 2.3 | `att:audio` | 2 | | |
| 2.4 | `att:ig_post` (a shared post or advert) | 7 | | |
| 2.5 | `att:ig_reel` | 1 | | |
| 2.6 | `att:ig_story` | 3 | | |
| 2.7 | `att:share` | 3 | | |
| 2.8 | `att:story_mention` | 5 | | |
| 2.9 | `att:template` (a shared comment — always empty) | 7 | | |
| 2.10 | `text+att:*` (words and media together) | 3 | | |
| 2.11 | `echo+att:image+att:image` (two in one message) | 1 | | |

## 3. Mentions

| # | shape | seen | projected | status |
|---|---|---|---|---|
| 3.1 | `media_id` + `comment_id` — tagged in a comment | 22 | | |
| 3.2 | `media_id` only — tagged in a caption | 3 | | |
| 3.3 | `media_id` + enriched fields — from the /tags backfill | 7 | | |

## 4. Comments on our own posts

| # | shape | seen | projected | status |
|---|---|---|---|---|
| 4.1 | `from,media,text` — a top-level comment | 9 | | |
| 4.2 | `from,media,parent_id,text` — a reply | 7 | | |
| 4.3 | `from,media` — no text at all | 1 | | |

## 5. Post updates

| # | shape | seen | projected | status |
|---|---|---|---|---|
| 5.1 | instagram | 539 | | |
| 5.2 | facebook | 410 | | |

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

