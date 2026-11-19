# Keeping what a conversation knows

A study of the context-loss failure of 19 November 2026, what it cost, and
what to do about it. Written to be reviewed cold and argued with.

Every number here was measured on `wouchh_dev` on the night, not estimated.

---

## 1. What happened

The assistant's memory of anything older than its ten-message window is a
single block of running notes, rewritten by the model on every reply and
stored on the message it was written with.

At 23:20 one reply rewrote them:

| | chars | message ids | has the wedding |
|---|---|---|---|
| handed in (msg 1258) | 5,250 | 62 | yes |
| handed back (msg 1260) | 504 | 1 | no |

**61 of 62 anchors destroyed in one turn.** Four minutes later the customer
asked about the wedding and the assistant answered *"What wedding are you
talking about?"* — while the full account sat two messages up, untouched.

It then said the same thing for the next three hours across a dozen
messages, including when a colleague typed the exact message id into the
chat and the customer said *"please check"*.

### What it was not

- **Not a prompt failure.** The frame told it the notes were only the
  latest set, offered `get_earlier_messages` as "THE FIRST PLACE TO LOOK",
  stated "576 earlier messages in this conversation are not shown", and —
  after it tried to hand off — told it outright "YOU HAVE LOOKED AT
  NOTHING". It returned no tool call to any of it.
- **Not data loss.** Nothing was deleted. Every reply carries its own notes;
  only the newest is read back. The intact 5,250 characters were on msg 1258
  the entire time.
- **It was a model ceiling.** The identical 47,499 captured bytes replayed
  against `gemini-3.5-flash` produced `get_earlier_messages(count: 50)` on
  the first attempt. Same prompt, same key, different model, opposite
  outcome. Switching the model fixed it live within one message.

The same experiment had already settled a different question that morning:
`gemini-3.1-flash-lite` would not call tools at all; `3.5-flash-lite` would.
There is a capability ladder, and **multi-step retrieval — notice a gap,
search, fetch, read — sits one rung above single-step tool use.**

---

## 2. The economics, measured

This is the part that should drive the design, and it is not where intuition
puts it.

```
conversations            51          total messages      722
median conversation      14 messages
50 of 51                 1–31 messages
1 of 51                  605 messages      ← the test thread
avg prompt               13,091 input tokens
avg reply                 1,450 output tokens
notes                     2,424 chars ≈ 606 tokens  =  4.6% of the prompt
all notes ever stored     276 KB
messages table            1.5 MB
```

Three things follow.

**Storage is free and will stay free.** 276 KB of notes, 1.5 MB of messages.
Any plan whose cost is disk is a plan whose cost is nothing. Stop optimising
for it.

**The notes are not an input-token problem.** At 4.6% of the prompt they are
the cheapest section in it — smaller than `<rules>`, a fifth of `<tools>`.
Shrinking them saves almost nothing.

**The notes are an OUTPUT-token problem, and output is where the money is.**
They are regenerated *in full* on every single reply: ~1,450 output tokens a
turn, most of it the notes restating themselves. Output is typically three
to five times the input price. **The dominant marginal cost of this design is
asking the model to copy its own memory out, verbatim, every time it
speaks.** That is also exactly the operation that corrupted it.

**And the distribution is extreme.** Fifty conversations of 1–31 messages
have no memory problem at all — their whole history fits in the window.
One conversation of 605 has every problem. Any design that taxes all 51 to
serve the 1 is the wrong trade.

---

## 3. What is already in place

Shipped the same night, all tested:

- **A collapse guard.** A rewrite dropping more than 30% of the message ids
  is refused and the previous notes kept. Measured on anchors, not length,
  because compaction is legitimate and forgetting is not.
- **Recovery through `get_one_message`**, which returns `notes_at_the_time`
  for our own replies — the older, fuller notes are reachable.
- **Automatic re-merge.** What a lookup recovers is folded back into stored
  notes by the service, because the model used recovered notes to answer and
  then kept 1 of the 62 it had just been handed.

Together these stop the bleeding. **They do not remove the underlying
fragility: a single block of prose, rewritten in full by a model, every
turn.**

---

## 4. Options

Judged on: does it stop the failure, what does it cost per reply, and how
much is there to build.

### A. Append-only entries instead of a rewritten block — *recommended*

Stop asking the model to restate the whole memory. Ask only for **what is
new this turn**, and have the service keep the list.

- Notes become rows: `(conversation_id, message_id, entry, created_at)`.
- The prompt renders the most recent N entries — the same text it reads now.
- Output per reply drops from ~1,450 tokens to a few dozen.

**Why it is the right first move.** It removes the corrupting operation
entirely. There is no rewrite, so there is no collapse to guard against; the
guard becomes a backstop for a thing that can no longer happen. It cuts the
single largest marginal cost of every reply. And it needs no retrieval, no
embeddings, no new infrastructure.

- Cost: **negative** — saves roughly 1,200 output tokens a reply.
- Storage: rows instead of a blob, same bytes.
- Build: one table, one repository, change the contract field from "the
  whole notes" to "what you learned this turn", render the tail.
- Risk: the model currently *edits* entries when something is superseded.
  Append-only needs a way to mark an entry resolved rather than rewrite it —
  a `supersedes` column, or simply accepting that later entries win.

### B. Keyword retrieval over the conversation (Postgres `tsvector`)

A `search_conversation` tool over message bodies and media descriptions.

The practitioner guidance is consistent: start with built-in full-text
search and add vectors only when keyword recall is demonstrably inadequate
([Neon](https://neon.com/guides/pg-search-vs-tsvector),
[Tiger Data](https://tigerdata.com/learn/full-text-search-vs-vector-search)).
One guide's rule of thumb — if Postgres alone answers ~80% of queries, stop
there — fits this case well: customers ask about *words they used*
("wedding", "refund", "my order"), which is what keyword search is good at.

- Cost: one GIN index, no per-reply tokens, no LLM calls at write time.
- Build: one index, one repository method, one tool.
- Caveat: **it only helps a model that will call it.** On `flash-lite` this
  would have changed nothing. Worth doing *after* the model question is
  settled, not before.

### C. Embeddings / pgvector — *not now*

- At 722 messages total, a sequential scan is faster than any index.
- Adds an embedding call per message at write time — the "eager
  consolidation" cost that
  [LycheeMemory V2](https://arxiv.org/html/2608.12990v1) warns grows with
  conversation length.
- A 3×3 study of write strategies found raw chunking matched or beat
  costlier extraction with **zero LLM calls at write time**, and that
  retrieval quality mattered more than how memories were written
  ([arxiv 2603.02473](https://arxiv.org/html/2603.02473v2)).
- Revisit if keyword recall measurably fails. Not before.

### D. Model capability — *already actioned, keep watching*

`gemini-3.5-flash` does multi-step retrieval; `-flash-lite` does not, on
identical bytes. The switch is live.

The cost is real and should be tracked: **28s and 40s per reply against
5–16s on `-lite`**, and one 60s timeout, which is why the chat timeout is
now 120s. If that latency proves unacceptable, the honest answer is a
cheaper model *plus* option A — because A removes most of the work the
expensive model was being asked to do.

### E. A periodic repair job — *only if A is rejected*

Compare each conversation's latest notes against its richest recent set and
flag or restore drops. Cheap (one query, no LLM) but it is a mop under a
leak. Option A removes the leak.

---

## 5. Recommendation

1. **Build A.** It is the only option that removes the failure rather than
   detecting or recovering from it, and it *saves* money on every reply. Do
   it first and do it alone — it may well be sufficient.
2. **Then measure.** With A in place, see whether anything is still
   unreachable. The 605-message thread is the only one that can answer this.
3. **Then B, if the measurement justifies it.** A search tool is cheap and
   additive, but it is useless to a model that will not call it, so judge it
   on `gemini-3.5-flash`'s behaviour and not on hope.
4. **Hold C indefinitely.** At this data volume it is cost without benefit.
5. **Watch the latency bill on D.** If `3.5-flash` is too slow for comfort,
   A makes a cheaper model viable again.

### What not to do

- **Do not optimise the notes for input tokens.** They are 4.6% of the
  prompt. The saving is noise and the risk is losing history.
- **Do not add retrieval to compensate for a model that will not retrieve.**
  That was the mistake the whole of 19 November nearly repeated: five
  prompt rewrites against a ceiling that a one-line model change cleared.
- **Do not trust an instruction to protect memory.** Every prompt rule
  written to protect behaviour that night lost at least once. The fixes that
  held were the ones that removed the model's ability to get it wrong.

---

## 6. The general lesson, worth keeping

The failures of 19 November were not reasoning failures. In every case the
model had what it needed and did not act on it, and in every case the fix
that worked changed **what was true** rather than **what it was told**:

| problem | failed fix | what worked |
|---|---|---|
| refused to look up a number it held | 2 rules | a marker saying which contacts exist |
| deferred while holding the answer | 1 rule | moving the reminder into `<tool_results>` |
| handoff swallowed every later question | 1 rule | rewriting what the `handoff` field *is* |
| promised a colleague, flagged nobody | 1 rule | code raising the flag regardless |
| destroyed its own memory | the contract, in capitals | refusing the write |
| would not retrieve at all | 5 rewrites | a different model |

**The frame should make the wrong thing impossible, not discouraged.** That
is the principle option A applies to memory: a block that is never rewritten
cannot be emptied.
