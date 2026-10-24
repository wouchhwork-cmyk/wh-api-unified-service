# AI-driven conversation: context, steering, and feeding the model in real time

Research for the AI-powered chatting agent, 25 October 2026.
Companion to `autonomous-chat-systems.md`, which covers the machinery this
sits inside. **Read that one first** — the model is the easy half.

This answers four questions, in the order they were asked:

1. How the AI, our system and the user actually interact
2. How the AI is given context about a user
3. How a conversation is steered toward a direction we want
4. How data is fed to the AI in real time, based on what its last response
   indicated it needed and where the conversation is going

---

## 1. How the three parties actually interact

The single most useful correction in this research:

> **The model is stateless. The harness holds the conversation.**

The model does not "remember" the conversation or "decide to look something
up". On every turn, our code re-sends everything it should know, and the model
replies with either words or a request for data.

The loop, as every source describes it:

```
our system                              the model
──────────                              ─────────
build context:
  system prompt
  tool definitions          ──────────▶
  message history
  prior tool results
                            ◀────────── either: a reply to the customer
                                        or:     "call these tools"
run the tools
  (OUR code, OUR auth,
   OUR tenant scoping)
append results to context   ──────────▶
                            ◀────────── reply, or more tool calls
                                        …until it answers
send the reply through the outbox
```

**Three consequences people get wrong:**

- **The model never touches the database.** It emits a tool *request*; our code
  decides whether to honour it, under our permissions and our tenant scoping. A
  model asking for another business's customer is a request we refuse, not a
  leak. This maps exactly onto the layering rule this repo already enforces.
- **Failures must be told to the model, in words.** A bare error code is
  wasted. Return a readable reason so it can retry, change approach, or tell
  the customer — otherwise it loops or invents
  ([lhotka.net](https://blog.lhotka.net/2026/04/22/Agent-Context-Needs-Timing)).
- **Context grows every turn,** and growth is itself the failure mode. See §5.

---

## 2. Giving the AI context about a user

The consensus shape is **tiered memory** — not one store, three or four, with
different lifetimes and different retrieval rules.

| Tier | Holds | Lifetime | Our nearest equivalent |
|---|---|---|---|
| Core / profile | Who they are, standing facts | permanent, always in context | `customers` + `metadata` |
| Short-term | The last few turns | this conversation | `messages` |
| Episodic / recall | Searchable past exchanges | across sessions | `messages`, unindexed |
| Semantic / archival | Extracted facts | permanent, retrieved on demand | **nothing** |

The MemGPT/Letta framing is the clearest: **core memory is RAM** (always in the
window), **recall is disk cache** (searchable history), **archival is long-term
storage** the agent queries deliberately
([Vectorize comparison](https://vectorize.io/articles/best-ai-agent-memory-systems)).

### Findings worth acting on

- **Write-side management is the hard part, not retrieval.** Mem0 extracts core
  facts from conversations and supports add/update/**delete** so memory stays
  consistent. Memory that only ever accumulates becomes noise.
- **Facts expire, and conflict.** Zep uses a temporal knowledge graph to track
  fact *validity* and contradictions. "Prefers oat milk" from March may be
  false in October, and a store with no notion of time will assert both.
- **Deliberate forgetting is a real design.** MemoryBank applies an
  Ebbinghaus-style forgetting curve so records fade in activation rather than
  persisting equally ([arXiv 2510.07925](https://arxiv.org/pdf/2510.07925)).
- **Compression beats history.** PersonaMem-v2 reports compact compressed user
  memory cuts token overhead *drastically* versus feeding full dialogue
  history, with personalisation largely intact. Vendor-adjacent claim,
  directionally consistent across sources.

### For us

Our profile layer is thin and our semantic layer does not exist. But we hold
something most chat products do not: **a behavioural record**. Awards, wallet
balances, which triggers fired, what they engaged with. That is user context of
a quality a summariser cannot invent, and it is already tenant-scoped and
audited.

The obvious first move is not a vector store. It is **exposing what we already
know as tools** — balance, award history, tenure — and letting the model ask.

---

## 3. Steering a conversation toward a direction

This is the most researched and least productised area found.

**The field's name for it is "proactive conversational agents"** — agents that
plan the conversation to reach a goal rather than answering turn by turn
([ACM survey](https://dl.acm.org/doi/10.1145/3715097)).

### Techniques that exist

- **Proactive Chain-of-Thought**: add explicit *goal planning* on top of
  reasoning chains, so the model plans toward an objective rather than
  responding locally ([ACL Findings EMNLP 2023](https://aclanthology.org/2023.findings-emnlp.711.pdf)).
- **Target-guided transitions**: generate a *transition utterance* that moves
  the conversation from where it is toward a designated target — the OTTers
  task. This is the mechanism behind "bridge to the offer naturally".
- **Script-based dialogue policy planning**: a declared script constrains what
  the model may pursue next. Built for an "AI therapist", where off-script is
  dangerous ([arXiv 2412.15242](https://arxiv.org/pdf/2412.15242)).
- **Strategic question-asking**: the sales-agent work proactively guides through
  questions and persuasion, profiling the user to pick the next move
  ([arXiv 2504.08754](https://arxiv.org/pdf/2504.08754)).
- **RL for clarification**: SpeakRL trains agents to ask the clarifying question
  that most increases task success — the question *worth* asking, not just a
  question ([arXiv 2512.13159](https://arxiv.org/html/2512.13159v1)).
- **Non-collaborative dialogue**: the explicit study of users who do not want
  to go where you are steering. Named as a key open challenge.

### The uncomfortable part, stated plainly

The nearest work to "steer a customer toward a business outcome" is outbound
sales research, and it describes the goal as to *push the dialogue toward a
predefined goal and persuade users to take a target action*
([arXiv 2605.22240](https://arxiv.org/pdf/2605.22240)).

That is persuasion architecture. It is legitimate for "help this customer find
the right product" and it is the same machinery as manipulation when the goal
is not in the customer's interest. Three design positions worth taking
deliberately rather than by default:

1. **The goal should be stated in the system prompt and logged**, so "what was
   this agent trying to achieve" is answerable after the fact. Our
   `audit_logs` is the natural home.
2. **Non-collaboration should end the pursuit, not escalate it.** If somebody
   declines twice, the goal is abandoned. This needs to be a hard rule in code,
   not a tone instruction, because a model optimising a goal will not stop on
   its own.
3. **Meta's policy is a floor, not a ceiling.** Promotional content in DMs is
   already restricted, and an agent that steers toward purchase inside a
   support thread is the shape of problem that gets app access revoked.

---

## 4. Feeding data in real time, based on what the model asked for

This was the core question, and it has a clean answer: **this is tool calling,
and the "real time" part is the loop, not a stream.**

### The mechanism

The model does not request data out of band. It returns a *tool call* as its
response, our code executes it, and the result becomes part of the next
request. The cycle repeats until it answers. So "feed it what it needs, when it
needs it" is implemented as: offer the right tools, run them, return results
including failures.

### What goes back every turn

- the tool list (re-sent each time)
- results of the tools just run — **successes and failures**
- the full history to that point

### Techniques for "what does it need next"

- **Tool RAG.** Do not offer every tool. Retrieve relevant tool *descriptions*
  per turn. LangChain cites work reporting **~3× better tool selection
  accuracy** from this alone
  ([LangChain](https://www.langchain.com/blog/context-engineering-for-agents)).
- **Dynamic tool sets.** MemTool gives the model explicit operations to **add
  and remove tools** from its own active context as relevance shifts
  ([arXiv 2507.21428](https://arxiv.org/pdf/2507.21428)).
- **Conversational query rewriting.** Before retrieving, rewrite the query
  against the conversation. Prepending chat history to the latest message is
  *explicitly called insufficient* — and the common failure is a follow-up
  like "what about the other one?", which retrieves nothing on its own
  ([Haystack](https://haystack.deepset.ai/tutorials/48_conversational_rag)).
- **Safe vs sensitive tools.** Safe tools run unattended; sensitive ones
  require confirmation first. A reward grant or a refund belongs in the second
  category.
- **Verify the tool exists before calling it.** MARCO's guardrail checks the
  generated function name against the real registry — models invent plausible
  tool names ([arXiv 2410.21784](https://arxiv.org/pdf/2410.21784)).

### Where the conversation is going

Two patterns, and they compose:

- **Hierarchical routing.** A root assistant converses until the request is
  clear, then hands to a specialist via an ML classifier; specialists carry
  *data-fetching tools*, and the FAQ RAG becomes one tool among many rather
  than the whole system (Doctolib, via
  [ZenML LLMOps database](https://www.zenml.io/llmops-database/implementing-multi-agent-rag-architecture-for-customer-care-automation)).
  This is the closest published architecture to what we would want.
- **Orchestrator loads history before routing.** Microsoft's reference
  architecture has the orchestrator read conversation history from storage
  *before* deciding where the request goes
  ([Microsoft](https://microsoft.github.io/multi-agent-reference-architecture/docs/reference-architecture/Reference-Architecture.html)).

**Latency note:** single-agent agentic RAG runs subtasks sequentially, each
waiting on the last. Fanning independent lookups across agents is the standard
counter ([arXiv 2607.22319](https://arxiv.org/pdf/2607.22319)). Relevant to us:
inside a 24-hour window we have seconds of budget, not milliseconds, so this is
a cost concern before it is a latency one.

---

## 5. How this fails — the named failure modes

Drew Breunig's taxonomy, via LangChain, is the most useful vocabulary found:

| Failure | What happens |
|---|---|
| **Context poisoning** | A hallucination enters context and *persists*, being re-fed every turn |
| **Context distraction** | Context grows until it overwhelms the model's trained behaviour |
| **Context confusion** | Irrelevant context bends the answer |
| **Context clash** | Two parts of context contradict each other |

Poisoning is the one that matters most for a long-running customer thread: a
wrong fact invented in turn 3 is still being asserted in turn 30, with growing
confidence, because it now looks like history.

**Mitigations found:** summarise/compact (Claude Code auto-compacts above ~95%
of the window); trim by heuristic or trained pruner; isolate via sub-agents
with their own windows (**at up to 15× the tokens of a single chat**); sandbox
token-heavy outputs and return only what is needed.

### Security, which is not optional here

Tool outputs from **untrusted content persist across turns and can steer later
tool selection** — the indirect prompt-injection threat model
([AgentSentry](https://arxiv.org/html/2602.22724v1),
[AgentVisor](https://arxiv.org/pdf/2604.24118)).

**This is the one that should worry us most.** Our tool inputs are *customer
DMs*. A customer can write anything, including instructions aimed at the model.
If a DM body reaches the model unlabelled, a customer can attempt to make our
agent grant rewards, reveal another customer's data, or message on their
behalf.

Required, not optional:
- **Mark customer content as data, never instruction**, structurally.
- **Never let a model-chosen tool call bypass our authorisation.** Tenant
  scoping and permission checks stay where they are; the model's request is an
  input to them, never a substitute.
- **Anything that moves value is a sensitive tool** requiring confirmation. We
  have an `idempotencyKey` on adjustments now for exactly the retry case; an
  AI-initiated adjustment needs a human gate as well.

---

## 6. Guardrails that reach production

The pattern is **layered cheap checks**, not one clever detector. Each catches a
different error; none catches all; the pipeline ends in *pass, abstain,
disclaim, or escalate*
([ai-tldr](https://ai-tldr.dev/learn/production-llmops/guardrails-reliability/hallucination-detection-production/)).

Most-cited concrete design: **a second model reviews every response before the
customer sees it; disagreement escalates to a human.** Richpanel claims this
keeps production hallucination under 1% — **a vendor figure with no independent
verification**. Openlayer cites LLM-as-judge at ~81% human correlation, also
vendor-reported.

Treat both as "this approach is widely used", not as "these numbers are true".

---

## 7. What I would build here, in order

1. **Expose what we know as tools first.** Balance, award history, tenure,
   recent interactions — all already tenant-scoped and audited. A model with
   good tools and no memory store beats the reverse.
2. **Query rewriting before any retrieval.** The cheapest large win, and the
   failure it prevents ("what about the other one?") is the most common turn in
   a real DM thread.
3. **Confidence floor and explicit fallback** — carried over from the other
   document because it is the most-cited production failure in both.
4. **Treat every customer message as untrusted data.** Structurally, from the
   first line of code, not as a later hardening pass.
5. **Sensitive-tool gate on anything touching value.** The reward engine is
   reachable from this agent in principle; it must not be reachable without a
   human in the loop.
6. **Log the goal and the reasoning.** `audit_logs` with `actor_kind='system'`
   already exists and already records that nobody decided an action. An AI
   deciding is a third case, and it should be distinguishable from both a
   person and a rule.
7. **A per-business kill switch, independent of rewards.**

---

## 8. What this research did NOT establish

- **No canonical schema** for agent context, memory or tool results. Every
  framework invents its own; I found no standard to adopt.
- **Every performance number here is vendor-published.** The <1% hallucination
  and ~81% judge-correlation figures have no independent verification.
- **No production case study of goal-steering with measured outcomes.** The
  persuasion work is academic; what survives contact with real customers, and
  what it does to trust, is not in these results.
- **The papers were read via search summaries, not in full.** Treat specific
  mechanisms as leads to verify, not as settled.
- **Nothing here is tested against our traffic**, and our traffic is thin:
  six of seven reward triggers have never fired. Design decisions that assume
  rich conversational volume are untested assumptions.

---

## Sources

**Context and tool-calling**
- [LangChain — context engineering for agents](https://www.langchain.com/blog/context-engineering-for-agents)
- [lhotka.net — agent context needs timing](https://blog.lhotka.net/2026/04/22/Agent-Context-Needs-Timing)
- [Mem0 — context engineering in multi-turn agents](https://mem0.ai/blog/context-engineering-in-multi-turn-ai-agents)
- [arXiv 2507.21428 — MemTool, dynamic tool calling](https://arxiv.org/pdf/2507.21428)
- [arXiv 2603.22862 — evolution of tool use in LLM agents](https://arxiv.org/pdf/2603.22862)

**Memory and personalisation**
- [arXiv 2510.07925 — persistent memory and user profiles](https://arxiv.org/pdf/2510.07925)
- [arXiv 2511.13593 — O-Mem, omni memory system](https://arxiv.org/pdf/2511.13593)
- [arXiv 2608.16168 — QUMem, query-conditioned user state](https://arxiv.org/pdf/2608.16168)
- [Vectorize — agent memory systems compared](https://vectorize.io/articles/best-ai-agent-memory-systems)

**Steering and proactivity**
- [ACM — proactive conversational AI survey](https://dl.acm.org/doi/10.1145/3715097)
- [arXiv 2412.15242 — script-based dialogue policy planning](https://arxiv.org/pdf/2412.15242)
- [arXiv 2605.22240 — proactivity in task-oriented dialogue](https://arxiv.org/pdf/2605.22240)
- [arXiv 2504.08754 — contextual user profiling for sales agents](https://arxiv.org/pdf/2504.08754)
- [ACL 2023 — clarification, target-guided, non-collaboration](https://aclanthology.org/2023.findings-emnlp.711.pdf)
- [arXiv 2512.13159 — SpeakRL](https://arxiv.org/html/2512.13159v1)

**Orchestration and RAG**
- [ZenML — Doctolib multi-agent RAG for customer care](https://www.zenml.io/llmops-database/implementing-multi-agent-rag-architecture-for-customer-care-automation)
- [Microsoft — multi-agent reference architecture](https://microsoft.github.io/multi-agent-reference-architecture/docs/reference-architecture/Reference-Architecture.html)
- [Haystack — conversational RAG](https://haystack.deepset.ai/tutorials/48_conversational_rag)
- [arXiv 2607.22319 — naive RAG to agentic RAG](https://arxiv.org/pdf/2607.22319)
- [arXiv 2410.21784 — MARCO, multi-agent real-time chat orchestration](https://arxiv.org/pdf/2410.21784)

**Safety and guardrails**
- [arXiv 2602.22724 — AgentSentry, indirect prompt injection](https://arxiv.org/html/2602.22724v1)
- [arXiv 2604.24118 — AgentVisor, semantic virtualization](https://arxiv.org/pdf/2604.24118)
- [arXiv 2503.15547 — prompt flow integrity](https://arxiv.org/pdf/2503.15547)
- [ai-tldr — hallucination detection in production](https://ai-tldr.dev/learn/production-llmops/guardrails-reliability/hallucination-detection-production/)
- [Richpanel — four-layer hallucination defence](https://www.richpanel.com/learn/ai-hallucination-defense) (vendor figures)
- [Openlayer — stopping LLM hallucinations](https://www.openlayer.com/blog/stop-llm-hallucinations) (vendor figures)
