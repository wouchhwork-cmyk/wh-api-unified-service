# How autonomous chat systems are actually built

Research for the autonomous chatting agent, 25 October 2026.

**On the sources.** Most writing on this is vendor marketing with a product to
sell, and its numbers are unverifiable. Where a figure comes from a vendor it is
labelled as one. The academic work is better evidence for *mechanism* and worse
evidence for *what survives production*. Everything below says which it is.

**Read this first, then `ai-driven-conversation.md`.** This one is the
machinery that holds a conversation. That one is the model inside it. The
second is useless without the first, which is the mistake most teams make.

---

## 1. The finding that matters most

> "LLMs are great at understanding and phrasing things. They're not great at
> being your operations workflow engine."
> — [Synthflow, conversational AI architecture playbook](https://synthflow.ai/blog/conversational-ai-architecture-playbook)

Every serious architecture found in this research separates **what to do** from
**how to say it**. The model decides phrasing and reads intent; a deterministic
layer decides what the business actually does. Teams that let the model drive
the workflow get systems that cannot be tested, cannot be audited, and fail in
ways nobody can reproduce.

For us this is not a new idea. It is the same split the reward engine already
makes: a rule decides *whether* somebody earns, a handler decides *what lands
in the wallet*, and neither improvises.

---

## 2. The layers everyone converges on

Independent sources describe near-identical stacks:

| Layer | Job | What we already have |
|---|---|---|
| Channel adapter | Platform in, platform out | `meta-webhook.*`, `outbound-relay.worker` |
| Ingestion / dedup | At-least-once delivery made exactly-once | `inbound_events`, `outboundDedupKey` |
| NLU / intent | What does this person want | **nothing** |
| Dialogue state | Where are we in this conversation | **nothing** — `conversations` holds status, not state |
| Policy / orchestration | What happens next | **nothing** |
| Tools / actions | Do the thing | rewards engine, inbox reply |
| Generation | Say it | templates in `customer-messages.ts` |
| Memory | What do we know about this person | `customers.metadata` only |
| Observability | What did it do and why | `audit_logs`, `entity_versions` |

**The honest read: we have the plumbing and none of the brain.** The transport,
idempotency, outbox, audit trail and send path are built and proven. What does
not exist is anything that decides what to say beyond a fixed template.

That is a better position than it sounds. The plumbing is the part that is
tedious to retrofit; most teams build the brain first and then discover their
delivery is lossy.

---

## 3. Dialogue state: the part that is always underestimated

Classic definition: conversational state is the cumulative meaning of the
conversation so far, usually expressed as **slot-value pairs**. Dialogue State
Tracking (DST) summarises history into a state that a policy then acts on
([arXiv 2504.16939](https://arxiv.org/pdf/2504.16939)).

Three implementations in use:

1. **Explicit state machine.** States, events, transitions, declared up front.
   Branching and recovery are designed rather than hoped for
   ([LangGraph tutorial](https://activewizards.com/blog/architecting-event-driven-conversational-agents-with-langgraph/)).
2. **Slot filling.** The conversation has a form to complete; the agent asks
   for what is missing. Old, boring, still the backbone of most task bots.
3. **Workflow tracker.** Track which functions have been called, derive the
   current step, and **prevent step-skipping**
   ([Google developer guide](https://discuss.google.dev/t/building-production-ready-conversational-ai-agents-a-practical-guide/285882)).

The third is the one worth stealing. It is auditable, it maps onto our existing
`audit_logs`, and "which step is this conversation on" becomes a column rather
than an inference.

**Named production failure:** skipping a confidence threshold on intent routing,
with a fallback below it, is reported as *the* most common cause of poor
containment. An agent that is 40% sure and acts anyway is worse than one that
asks.

---

## 4. What the platform permits — the constraint that shapes everything

For Instagram this is not a design preference, it is a wall.

- **The 24-hour window.** Free-form messages only within 24 hours of the
  person's last message; the clock resets each time they write
  ([Ceptice](https://ceptice.com/instagram-automation/metas-24-hour-messaging-window-instagram-rules),
  [Hooksend](https://hooksend.app/blog/instagram-24-hour-messaging-window)).
- **The Human Agent tag** extends it to 7 days and is **explicitly forbidden to
  automation**. Meta's documented case is a live person handling something that
  could not be resolved in the window. Misuse is detected and penalised
  ([Spur](https://www.spurnow.com/en/blogs/instagram-dm-automation-rules),
  [Creatorflow](https://creatorflow.so/blog/instagram-dm-compliance-meta-rules/)).
- **Rate limits** are usually quoted as ~200/hour. One source is explicit that
  this is a *tool convention, not a Meta-published number*
  ([Inflowave](https://inflowave.io/resources/instagram-messaging-api)).
- One source claims non-promotional message tags were deprecated in April 2026
  with requests now returning error 100. **Single source, unverified — check
  Meta's changelog before building on it**
  ([Coldabry](https://coldabry.com/blog/instagram-messaging-api/)).

**Sources disagree on promotional content inside the window.** One says it is
allowed outright; others frame it as needing a clear user-initiated trigger.
Treat the narrow reading as correct until Meta's own docs say otherwise.

### What this means for us, concretely

Our `CustomerNotifierService` already enforces the right shape, and it did so
before this research: only a thread the customer opened, only inside the
window, only when the thread is open, once per cause. That is not luck — those
constraints are forced by the platform, and any design that fights them
dead-letters.

**The design consequence people miss:** an autonomous agent on Instagram is
*reactive by construction*. It cannot open conversations. Every autonomous
exchange is a continuation of something the customer started, inside a window
they control. Any roadmap that assumes outbound initiation is a roadmap for a
different channel.

---

## 5. Hybrid routing, and why pure-LLM loses

The recommended shape across sources:

```
message → cheap classifier → in scope?
                              ├── no  → canned reply / human
                              └── yes → deterministic workflow
                                          ├── needs data?   → tool call
                                          ├── needs words?  → LLM
                                          └── needs a human → handoff
```

A small "bouncer" model or deterministic rules decide scope **before** the
expensive model runs ([Arthur](https://www.arthur.ai/blog/best-practices-for-building-agents-guardrails)).
Cited motivating failure: Air Canada's chatbot inventing a refund policy the
airline was then held to.

---

## 6. Handoff to a human

The research is unanimous that handoff quality matters more than handoff
*timing*, and that most implementations get this backwards.

**Triggers** ([Richpanel](https://www.richpanel.com/learn/ai-hallucination-defense)):
low confidence; a QA check rejecting the draft; sensitive intent (complaint,
legal, account closure); tool failure; the customer simply asking.

Plus one worth copying: **do not rely only on topic-based escalation — add a
repeated-failure trigger** when a conversation stays unresolved across turns.
Topic rules catch what you predicted; a failure counter catches what you did
not.

**What to hand over:** conversation history, what the agent considered, *why*
it escalated, what data it pulled. The human should see the reasoning, not
start cold.

We are well placed here: the inbox already shows the thread, and the agent's
reasoning would be an internal note — a concept `messages.is_internal_note`
already supports.

---

## 7. What I would build here, in order

Grounded in what this repo already has, not in a generic roadmap.

1. **Conversation state as a column, not an inference.** A `dialogue_state` on
   `conversations` plus a state-transition table. Auditable, queryable, and it
   makes "where is this conversation" answerable without an LLM.
2. **An intent classifier with a confidence floor and an explicit fallback.**
   The most-cited production failure is skipping exactly this.
3. **Automation as an outbox producer, never a direct sender.** Everything
   already goes through `outbound_events`; an agent must not become the one
   path that bypasses the window check and the dedup key.
4. **A kill switch per business.** `enterprise_features` already gates
   rewards; autonomous messaging deserves its own gate and its own audit trail,
   because "the system messaged my customer" is a question that will be asked.
5. **Only then, the model.** See the companion document.

---

## 8. What this research did NOT establish

Stated plainly so nobody treats absence as endorsement:

- **No independent benchmark** for containment, escalation thresholds or
  handoff design. Every number found was vendor-published.
- **No authoritative 2026 survey** of DST in production.
- **Meta's own documentation was not read** for this pass — every API claim
  above is second-hand from vendor blogs with an incentive to simplify. Before
  any of it is built, read
  `developers.facebook.com/docs/instagram-platform` directly. This matters more
  than usual: the 24-hour window and the Human Agent tag are compliance
  surfaces, not features.
- **Nothing here is tested against our traffic.** Six of our seven reward
  triggers have never fired once (see `backlog.md`); assumptions about what
  Meta actually delivers should be verified before being designed around.

---

## Sources

- [Synthflow — conversational AI architecture playbook](https://synthflow.ai/blog/conversational-ai-architecture-playbook)
- [ActiveWizards — LangGraph state machine for conversational agents](https://activewizards.com/blog/architecting-event-driven-conversational-agents-with-langgraph/)
- [Google Developers — production-ready conversational AI agents](https://discuss.google.dev/t/building-production-ready-conversational-ai-agents-a-practical-guide/285882)
- [arXiv 2504.16939 — A Desideratum for Conversational Agents](https://arxiv.org/pdf/2504.16939)
- [arXiv 2609.07152 — Auditable Symbolic-RAG-Generative architecture for goal-oriented orchestration](https://arxiv.org/pdf/2609.07152)
- [Arthur — agent guardrails, pre- and post-LLM](https://www.arthur.ai/blog/best-practices-for-building-agents-guardrails)
- [Richpanel — four-layer hallucination defence](https://www.richpanel.com/learn/ai-hallucination-defense)
- [Spur — Instagram DM automation rules](https://www.spurnow.com/en/blogs/instagram-dm-automation-rules)
- [Ceptice — Meta's 24-hour messaging window](https://ceptice.com/instagram-automation/metas-24-hour-messaging-window-instagram-rules)
- [Creatorflow — Instagram DM compliance](https://creatorflow.so/blog/instagram-dm-compliance-meta-rules/)
- [Inflowave — Instagram Messaging API rules and limits](https://inflowave.io/resources/instagram-messaging-api)
- [Coldabry — what the Instagram Messaging API can and cannot do](https://coldabry.com/blog/instagram-messaging-api/)
- [Hooksend — the 24-hour window explained](https://hooksend.app/blog/instagram-24-hour-messaging-window)
- [Rasa — 2026 State of Conversational AI](https://rasa.com/lp/2026-state-of-conversational-ai-report) (marketing; claims unverified)
