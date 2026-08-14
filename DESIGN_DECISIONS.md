# Agent-Nuvira — Design Decisions

**Why this document exists:** the README says *what* Agent-Nuvira does; this document says *why*
it is built the way it is — the complete, reasoned record of the design decisions behind it. It is
written for technical readers who want the reasoning behind the architecture — and it is honest
about what is shipped today versus what is on the roadmap.

## How these decisions were made

Nothing in this document is asserted from library names or marketing claims. Each decision was
made the same way:

1. **Clone-verified code analysis.** Wherever a decision compares Agent-Nuvira to another coding
   agent, the comparison is grounded in the actual source of the compared products (cloned
   references of Freebuff and Hermes), not in their READMEs. When a claimed mechanism could not be
   found in the code, it was treated as *not real* until proven otherwise.
2. **Ecosystem research.** Libraries are adopted only after verifying they are maintained,
   prebuilt, and standard for the job (see decision 13).
3. **Shipped experience.** A design is claimed only once it is implemented, tested, and in the
   current release.

Each decision carries:

- **Status** — ✅ **Shipped** (implemented, tested, in the current release) · 🚧 **Roadmap** (the
  intended design; not yet shipped — do not treat it as available today) · 📌 **Adopted** (a
  process/direction rule the team follows, not a code feature).
- **Why** — the reasoning, including the alternatives considered and why they were rejected.
- **Evidence** — the code/analysis that grounded the choice.
- **Revisit trigger** — the specific condition under which the decision should be reconsidered.

## Decision index

**A. Request understanding (the product)**
1. Understanding is the product, not a cost center
2. LLM-native understanding, with a deterministic fast-path
3. The Request Contract — the one genuinely new layer
4. Clarify in the loop, never a menu
5. Follow-up recommendations are a native tool, not a CLI heuristic
6. One dispatch, every command (cross-command parity)

**B. Execution reliability**
7. Failure is a first-class input
8. Verification before "done"
9. Provider neutrality, with failover everywhere
10. Every subprocess is a visible lane

**C. Economics & portability**
11. Free-first economics
12. Zero native dependencies, OS-independent
13. Borrowed focused libraries, not frameworks

**D. Memory, recall & continuity**
14. Memory is pluggable
15. Memory & retrieval built ourselves, not borrowed
16. Agent-driven auto-recall & continuity
17. Auto-run background duties

**E. Evidence & positioning**
18. We measure ourselves against the field
19. Public docs claim only what's shipped

**F. Non-goals**
20. What we deliberately do NOT do

**G. Bridging actions (the experience-parity program)**
21. User-declared daily token budget (advisory, never a product hard cap)
22. Web research: free-first, availability-gated, SSRF-guarded
23. Rate-limit failures PARK, they never demote a verified model
24. Agent LLM calls fail over across providers (v1.62.1)
25. Consecutive rate limits auto-switch providers mid-task (v1.62.1)
26. Rate-limit recovery is fully automatic — no prompts, no grinding (v1.62.2)
27. The interactive rate-limit prompt is opt-in — askOnRateLimit (v1.62.2)
28. Where the pipeline loses to interactive execution — and the efficiency wins (v1.62.4)
29. Transient quota blips must never fail a task — the reviewer rate-limit gap (v1.62.5)
30. Strict file contracts, lenient recovery when NO stronger model exists (v1.69.0)
31. No-op escalation is detected — weak-model repair is bounded, never a loop (v1.69.0)
32. The weak-model prompt — human-in-the-loop, opt-in (routing.promptOnWeakModel) (v1.69.0)
33. The runner carries the project into the build — packaging-aware steps, reference docs, deterministic package fallback (v1.69.0)
34. Missing system tools are installed with user consent — OS-appropriate recipes, approval prompt, then continue (v1.69.0)
35. ML task-similarity routing + promotion-gate enforcement — closing the ruflo neural-router gap (v1.71.0)
36. Quota awareness is a veto filter, not a selector — the single resolve pipeline (v1.71.0)

---

# A. Request understanding (the product)

## 1. Understanding is the product, not a cost center

**Status: 🚧 Roadmap (direction adopted — carried by C2/E3/H1)**

The end-user experience of working and delivering against a request is the product's main
differentiator. Request understanding is therefore **not a cost center to be optimized away** — it
is the thing to get right first. Cost is managed by cheap-model discipline and prompt caching,
*never* by skipping understanding.

**Context / compared against:** an earlier design (Phase C as originally scoped) framed NLP as a
cost-first hybrid: rule-based classification with a model only below the rule's confidence
threshold. That framing was rejected because it produced the exact failure mode it claimed to
avoid — **half-understood requirements**. In the shipped code, `shouldAutoDispatch` gated *only*
the create intent; every other intent auto-dispatched on rule confidence ≥ 0.8 with **no model
confirmation**, so a rule misread ran the full pipeline against a wrong understanding.

**Why:** the cost of a wrong execution (a full pipeline run against a misread request) dwarfs the
cost of one cheap verification call per request. The compared products converge on the same
principle: both Freebuff and Hermes treat understanding as 100% the model's job (see decision 2),
and neither optimizes it away for cost.

**Evidence:** verified in the clones — Freebuff `agents/base-chat.ts` (understanding is the model,
with no classifier anywhere in the repo) and Hermes `agent/conversation_loop.py` (per-turn context
build with cached system prompts, sanitization, and memory prefetch before every loop).

## 2. LLM-native understanding, with a deterministic fast-path

**Status: ✅ Shipped (foundation) · 🚧 Roadmap (verification upgrade)**

Modern coding agents converged on a single pattern for understanding natural-language requests:
let the language model itself decide what the request means, in the context of the conversation
and the project — not a separate hand-built NLP classifier. That is the pattern Agent-Nuvira
follows.

Where Agent-Nuvira differs is a **deterministic fast-path** layered in front of the model:

- **Shipped:** a rule engine classifies the common cases (create / continue / fix / explain /
  configure) in under 5 ms with zero network, extracts temporal references ("continue last week's
  plan") deterministically, and resolves every request to one action that **every** command
  (chat, execute, plan, edit) consumes identically. The model is used to verify and enrich below
  the rule's confidence threshold.
- **Why:** the rules make the common case instant, free, and **offline-capable** (no provider, no
  key, no network). The model remains the authority on anything the rules cannot resolve with
  high confidence. Rules are a pre-filter and a fallback — never the decider.
- **Roadmap:** every request will get a model verification pass (the rules shape a smaller,
  cheaper prompt), and the verification will return a **request contract** (decision 3) instead of
  a bare intent label. A request whose contract is incomplete will be clarified with the user
  (decision 4) before any pipeline runs. The user will see what was understood before it is
  executed.

**Evidence:** the "spaCy backbone" claim — that Freebuff/Hermes use spaCy/JointBERT for NLP — was
**falsified against the clones**: neither repo contains a classifier. What they actually do is
LLM-native dispatch in a single tool-calling loop, plus deterministic helper libraries for the
mechanical slices (temporal/unit parsing). Agent-Nuvira mirrors that real methodology, and the
deterministic fast-path is the layer neither of them has.

## 3. The Request Contract — the one genuinely new layer

**Status: ✅ Shipped (Session 20 — `src/nlu/contract.ts`)**

Adopting the compared products' mechanism as the backbone (decision 2) buys parity, not
differentiation — and **pure adoption was rejected** because it makes us equal to Freebuff/Hermes
at best, and equal is losing. A from-scratch "revolutionary" rewrite was also rejected: unproven,
expensive, and unmeasurable without the benchmark (decision 18). The chosen path: **their
mechanism + our rules + ONE new layer — the Request Contract** — the honest answer to "what's
new".

1. **Contract, not classification.** The mandatory verification call returns
   `requestContract = { goal, target, scope, constraints, acceptanceCriteria[], riskFlags[],
   requirementState }` — a machine-checkable definition of *done*, not a bare intent label.
2. **Elicitation loop.** An incomplete contract (empty acceptance criteria, low confidence, or
   `requirementState: 'needs-clarification'`) never dispatches — it triggers the in-loop clarify
   tool with model-proposed interpretations (decision 4).
3. **Understand-card.** Before any pipeline runs, every action command shows the resolved contract
   as a live card — "🧠 Understood: … · scope: … · criteria: [1..n] · [run] [edit] [clarify]" —
   fast-accept by default (one keystroke), never a blocking wizard. **The request is seen before
   it is run.**
4. **Spec→verify feedback.** The contract's acceptance criteria feed the existing VerifyModule
   (decision 8) at pipeline end — "done" = criteria met (measured), not agent-declared done. This
   is the hook the M2b benchmark (decision 18) scores.
5. **Difficulty cascade.** The cheap router model builds the contract; on low self-confidence or
   risk flags it escalates to a stronger router-selected model — cost stays low where possible,
   correctness guaranteed where it matters.

**Why:** neither Freebuff nor Hermes ever shows the user what it understood — they just run. Making
understanding **visible, elicited, and verifiable** is the underexploited space; it directly
serves the "best experience of working against the request" goal.

**Revisit trigger:** if the M2b benchmark shows the contract does not move completion ↑ / rework ↓,
stop investing in it. Its worth is judged by measurement, not by belief.

### Shipped (Session 20) — implementation notes

- **`RequestContract`** (`{ goal, intent, confidence, action, actionLabel, mode, target[],
  scope[], constraints[], acceptanceCriteria[], riskFlags[], source }`) resolved by
  `buildRequestContract` / `buildRequestContractSync` / `contractFromParsed`. The rule path is
  deterministic and **zero-cost** (no extra model call); below `RULE_TRUST_THRESHOLD` the contract
  enriches from the **same C2 verify call** `parseRequest` makes — never a second call.
- **Understand-card** — `renderContractCard` prints the 🧠 card in `runPipelineTool` **before** the
  live board starts on every pipeline run (chat tool calls, `buff execute`, tool registry
  build/resume/repair/document/website/analyze/test). Fast-accept by default: display-only, never
  a blocking wizard. Risk flags + guardrail constraints are parsed deterministically.
- **Spec→verify** — `acceptanceCriteria` flow into `OrchestratorOptions` → vault metadata → the
  reviewer verification pass (per-criterion PASS/FAIL verdicts; any FAIL blocks) AND into
  `VerifyParams` / `TaskExecutionPipeline.PipelineConfig` (goal-alignment prompt checks each
  criterion). "Done" = the changes satisfy the contract.
- **Resumability made true** — the pipeline tool now passes `checkpoint: true`, so the card's
  "checkpoints keep it resumable" claim is real for every run (a Ctrl+C / quota kill can resume).
- **Cross-command parity (Sessions 21–22)** — the 🧠 card now prints before every entry surface:
  `buff execute` (before board.start, suppressed under --json-events, passes acceptance criteria),
  `buff plan` (before board.start with plan-only footer, zero-reparse from the hoisted parse),
  `buff edit` (before the routing gate, with a direct-edit footer), and the original `chat`
  pipeline runs (pipeline-tool.ts, Session 20). A cross-command structural wiring guard tests
  the ordering and zero-reparse invariant across all four surfaces.
- Remaining from the original decision: the **difficulty cascade** (escalate contract building to a
  stronger model on low confidence / risk flags) — folded into the existing routing escalation;
  and M2b measurement of completion ↑ / rework ↓.

## 4. Clarify in the loop, never a menu

**Status: 🚧 Roadmap (E3 — shipped today: pre-dispatch confirmation for ambiguous requests)**

Ambiguous or incomplete requests are resolved by **the model calling an `ask_user` tool inside the
loop** — question + ≤ 4 choices + `multi_select`, rendered with arrow-key/checkbox selection —
**never** by a pre-dispatch inquirer menu outside the conversation. The C2
`requirementState: 'needs-clarification'` result is the trigger: the model asks for exactly the
`missingInfo` items, gets the answer, re-verifies, then dispatches. **No pipeline runs between the
ask and the answer.**

**Compared against:** Hermes `tools/clarify_tool.py` (question + up to 4 choices + `multi_select` +
auto-appended "Other", rendered per platform) — the schema is mirrored. Freebuff `ask_user` tool —
same in-loop pattern. Today's pre-dispatch `promptDeveloperMode` menu was the anti-pattern being
replaced.

**Why:** a menu outside the conversation breaks the loop — the user answers a form, then the agent
runs anyway. An in-loop clarify keeps understanding inside the conversation where the model can
re-verify the answer against the request. The CLI renders it exactly like Hermes does.

## 5. Follow-up recommendations are a native tool, not a CLI heuristic

**Status: ✅ Shipped (E3b — `suggest_followups` registered tool)**

Follow-up recommendations are a **first-class tool the model is contractually required to call** —
not a post-hoc CLI heuristic. The chat loop's system prompt carries the same contract Freebuff
ships: *"End every response by calling `suggest_followups` with exactly 3 followups the user is
likely to want next — natural next questions, deeper dives, or related directions that build on
what you just said; specific to this conversation, not generic."*

- The H1 registry defines `suggest_followups` (zod schema `{ followups: [{ prompt, label? }][] }`,
  `endsAgentStep = false`); the CLI renders them as numbered clickable options; clicking sends the
  prompt as the next user message (clicked state persisted).
- Cross-command parity (decision 6): execute/plan post-run surface the same tool output — replacing
  the keyword-matched rule fallback in execute.ts (the rule fallback stays only when no model is
  available).

**Compared against:** Freebuff ships this as a native tool (`suggest-followups.ts` — zod schema,
guidance description, clickable cards with hover/clicked state); Hermes has **no** end-of-turn
followup tool (its continuity is clarify + turn summaries + memory). The follow-up experience is a
Freebuff differentiator, and it is exactly the pattern adopted. Today execute.ts has a
keyword-matched rule fallback ("add JSDoc if .ts files changed") — generic, not contextual; that
is the heuristic being replaced.

## 6. One dispatch, every command (cross-command parity)

**Status: ✅ Shipped**

Chat, execute, plan, and edit are not four products with four behaviors. They share a single
intent→action map: a request resolves to the same action no matter which command receives it. This
is enforced structurally (a shared dispatch choke point) and tested across commands via a source-level
structural wiring guard, so the product cannot silently diverge into chat-only behaviors.

**Standing rule (adopted Session 5b):** every capability this project adds must be validated AND
upgraded across **all** action commands (chat, execute, plan, edit, run, ci, workflow, eval,
benchmark, models, agent) — never chat-only. A row is not done if its behavior works in `buff
chat` but is missing from the others. The action-command set is fixed and listed in the project
plan; each phase's "Done when" names the commands it was validated on.

**Why:** capabilities have historically landed in `chat.ts` only (e.g. the dev-mode menu prompt
lives only in chat.ts), letting execute/plan/edit/run diverge and degrading the user experience —
exactly the failure this rule prevents. Follow-ups (decision 5), auto-recall (decision 16), and
background duties (decision 17) all shipped across every action command under this rule.

---

# B. Execution reliability

## 7. Failure is a first-class input

**Status: ✅ Shipped**

When an execution fails, Agent-Nuvira does more than report:

1. **Classify** — the failure is categorized (test failure, dependency issue, quota, network,
   tool error, …).
2. **Repair** — an error-repair engine retries with escalating strategy, including upgrading to a
   stronger model when the repair keeps failing.
3. **Verify** — after a fix, an independent verification pass checks the outcome rather than
   trusting the agent's own claim.
4. **Remember** — the failure and the fix that worked are stored in a persistent failure-lessons
   memory, so the same class of mistake is less likely on the next run.

**Why:** the differentiator users care about is not "the model is smart" — it is **runs finish,
or tell you exactly why**. Repair + verify + lessons is how a run that would have died in a
single-shot tool instead completes or degrades honestly.

**Compared against (clone-verified):** Freebuff has stream-parser + HTTP retry only — no
post-execution verify, no failure memory, no repair engine. Hermes has API-error classification +
adaptive backoff + failover + a verification hook — turn-level only, no failure-lessons memory, no
repair pipeline. Agent-Nuvira's classify → repair → verify → remember stack is the full version
neither of them ships. "Less stuck / less rework after a failure" is this machinery — and it is
measured by the benchmark (decision 18), not asserted.

## 8. Verification before "done"

**Status: ✅ Shipped (verification pass) · 🚧 Roadmap (acceptance criteria)**

Every pipeline ends with an independent verification step (a dedicated reviewer/verify agent
checks the work product). The roadmap closes the loop further: the request contract's
**acceptance criteria** (decision 3) will feed that verification, so "done" means *criteria
met* — measured — rather than the agent deciding it is done.

## 9. Provider neutrality, with failover everywhere

**Status: ✅ Shipped**

Agent-Nuvira is deliberately not bound to any one model or vendor:

- 17+ providers through one interface: local (Ollama, LM Studio), free tiers (Groq, Gemini), and
  paid clouds (OpenAI, Anthropic, Mistral, Cohere, Together, DeepInfra, Fireworks, Perplexity,
  NVIDIA NIM, OpenRouter, Azure, Anyscale, vLLM).
- A **learning router** (Thompson-sampling bandit) picks the best provider × model per task from
  real outcomes, with hard cost/speed/reasoning constraints and promotion gates that only keep
  changes that measurably improve quality without regressing cost.
- A **quota ledger** tracks free-tier usage with calendar-aware reset windows and parks exhausted
  providers until quota resets.
- **Automatic failover** — a dead key, expired token, or rate limit mid-session swaps to the next
  best provider. No stuck sessions, no quota errors thrown at the user.

**Why:** your workflow should not stop because one vendor's key expired at 4 PM. Availability is
a feature. **Compared against:** when a provider dies, the failover chain degrades to the next
candidate; the compared products stall on a dead provider.

## 10. Every subprocess is a visible lane

**Status: ✅ Shipped (E1)**

All shell execution flows through a single choke point — `runShell` / `runShellSync` in
`src/utils/shell.ts` (built on execa, decision 13) — which emits `exec:shell-start` / 
`exec:shell-end` events on the EventBus with command, cwd, exit code, and duration. Every
user-visible subprocess is a live `$ npm test` lane, consumed by the activity board and the
dashboard. The choke point also provides streaming output, timeout, abort, and a silent mode for
internal calls, and **never throws** on a non-zero exit code (the code is returned in the result).

**Why:** before the choke point, `execSync`/`spawn` calls were scattered with inconsistent options
and zero observability — a command could run and nobody could see it. The acceptance criterion is
*every user-visible subprocess is a visible lane*; git/credential plumbing (internal, not
user-facing) remains on raw `child_process` and is adopted incrementally.

---

# C. Economics & portability

## 11. Free-first economics

**Status: ✅ Shipped**

The product is free, local-first, and bring-your-own-keys: no subscription, no hosted backend, no
telemetry. Cost is a design constraint, not an afterthought:

- Free/local providers are preferred by default (with an optional paid gate).
- **Tier-0 deterministic routing** — mechanical edits (strip `console.*`, rename symbols, dedupe
  imports) are handled with AST validation in under a millisecond for $0, never touching a model.
- **Token-efficient retrieval** — gathered context is chunked, embedded locally, and reduced to
  the top-k relevant chunks before the model call, so free quotas stretch further.

Cost is managed by cheap-model discipline + prompt caching, never by skipping understanding
(decision 1).

## 12. Zero native dependencies, OS-independent

**Status: ✅ Shipped**

Everything runs on Node built-ins and pure-JS libraries; native acceleration (e.g. FAISS) is
optional and auto-detected. Execution, credential handling, and background processes are
implemented OS-aware across macOS, Windows, and Linux. 3,718 tests guard the behavior.

**Why:** a tool you depend on for work should install anywhere, not require a build toolchain or a
specific operating system.

## 13. Borrowed focused libraries, not frameworks

**Status: ✅ Shipped (adopted so far) · 🚧 Roadmap (remaining adoptions)**

Agent-Nuvira borrows **focused libraries for focused jobs** and rejects full agent frameworks.
Adoption rule: only libraries that are *maintained, prebuilt, and standard* for the job; native
dependencies become optional tiers with graceful fallback; and no library is adopted to replace
the product's own differentiators (the multi-agent pipeline, the 17-adapter router, the
memory stack).

| Job | Chosen | Status |
|---|---|---|
| Shell/process execution | `execa` (streams, abort, rich errors) | ✅ Shipped (E1) |
| Schema validation (tool contracts) | `zod` | ✅ Shipped |
| Temporal/unit parsing ("last week", "2 days ago") | `@microsoft/recognizers-text-datetime` | ✅ Shipped |
| OS keychain / secret vault | `@napi-rs/keyring` (prebuilt binaries, keytar is archived) | ✅ Shipped (fallback tier = encrypted file) |
| SQLite persistence | `node:sqlite` (built-in) | 🚧 Roadmap |
| TUI live activity board | `ink` (React for CLIs — the standard behind Claude Code / Gemini CLI) | 🚧 Roadmap (E2) |
| Code search in projects | `ripgrep` (bundled or `$PATH`) | 🚧 Roadmap |
| MCP client | `@modelcontextprotocol/sdk` (official TS SDK) | 🚧 Roadmap |
| Memory backend (optional) | mem0 (opt-in only, never a hard dep) | 🚧 Roadmap |

**Rejected:** spaCy / JointBERT (Python-bound; the "Freebuff/Hermes backbone" claim was falsified
against the clones), and **full agent frameworks (LangChain/LangGraph)** — see decision 15 for the
full reasoning.

---

# D. Memory, recall & continuity

## 14. Memory is pluggable

**Status: ✅ Shipped (local) · 🚧 Roadmap (external backends)**

Projects, facts, preferences, and trajectories are persisted locally (SQLite + vector store) and
recalled automatically in later sessions. The memory layer is a pluggable provider interface —
local by default, with optional external backends for teams or cross-machine use — so memory is
never a hard dependency.

## 15. Memory & retrieval built ourselves, not borrowed

**Status: ✅ Shipped**

Agent-Nuvira ships its own memory and retrieval stack rather than adopting an agent framework
(LangChain/LangGraph) or a hosted memory service. This decision was made after a technical review
of both alternatives and is recorded here so it does not get re-litigated:

- **Our own stack:** local embeddings (`bge-small-en-v1.5`, 384-dim) + pure-JS vector store
  (cosine) + optional FAISS acceleration + fact store + trajectory store + a retrieval pipeline
  (chunk → embed → retrieve → assemble) that feeds the model only the relevant context. On top:
  context compaction and a reasoning cache.
- **Why not LangChain/LangGraph:** their claims are about *orchestration ergonomics* (graph state
  machines, durable checkpointing, human-in-the-loop, streaming, tool middleware) — not model
  capability — and everything we need from that list is already built bespoke: checkpoint store,
  phase engine, repair + verify + failure-lessons, clarify tool, retrieval, compaction. Adopting
  the framework would add a heavy dependency tree against our minimal footprint and hide the very
  cost/token visibility our cost tracker and quota ledger exist to provide. Neither major
  competitor uses one, so this was never a parity question.
- **Why not a hosted memory service (mem0-style):** memory that depends on a paid cloud
  contradicts our free-first, local-first economics; a local store keeps failure-lessons and
  trajectory data under the user's control and works offline. Where competitors delegate memory
  to hosted services, ours is local, free, and integrated with the repair pipeline.
- **Revisit trigger:** if Agent-Nuvira ever grows multi-agent federation beyond A2A (swarms,
  complex team topologies), a graph-orchestration framework becomes a candidate — evaluated then,
  with the M2b benchmark as the judge, never pre-adopted.

## 16. Agent-driven auto-recall & continuity

**Status: ✅ Shipped (D1)**

`continue` / `resume` requests now recall prior work automatically — no manual
`buff session`-style commands. `autoRecall` composes the workspace project row (last goal, run
summary), project-scoped temporal session history, relevant facts, and the latest checkpoint into
a recall card ("📦 Recalling: continue last week's plan — 4 sessions · resuming step 3/8") and an
injected context block that reaches the planner even when memory is off. Temporal references
("last week", "yesterday") are resolved deterministically by reusing the recognizer (decision 13),
no model call. Shipped across every action command per the parity rule (decision 6).

**Why:** continuity is a core part of "working against the request" — a user who says "continue
last week's plan" should not have to re-explain or hunt for state.

## 17. Auto-run background duties

**Status: ✅ Shipped (D2)**

Every session start shows a one-line health/model status with zero user action — the agent runs
the housekeeping, not the user. `maybeRunDuties()` is throttled (once per 12h, state scoped to the
active config dir) and produces a fast, **local** health line (provider count, vault tier,
workspace project count) plus models status (blocked/ok from the registry), silently suppressed
under `--json-events` so structured output stays pure. Mounted at all session-start entry points
per the parity rule (decision 6).

---

# E. Evidence & positioning

## 18. We measure ourselves against the field

**Status: 🚧 Roadmap (M2b) · 📌 decision rule adopted**

Claiming to be better without numbers is marketing, not engineering. The roadmap includes a
**black-box benchmark (M2b)**: the same curated task suite run through Agent-Nuvira and other
leading coding agents, scoring completion rate, user-visible stuck states, rework turns, and
time-to-done. Results will be published in this repository. Until then, this document avoids
comparative claims that are not measured.

**Anti-coverup decision rule (adopted):** a phase's acceptance criteria must move a benchmark
metric (completion ↑, stuck ↓, rework ↓, time-to-done ↓) — not just pass unit tests. A row that
only adds capability breadth without touching an experience metric is deferred behind the
differentiators (the understanding gates, the tool loop, follow-ups, repair surfacing). This rule
is what keeps the plan self-auditing instead of self-congratulatory: the honest verdict was that
today we lose head-to-head on capability breadth, that parity-by-borrowing is the coverup risk,
and that the genuine edges (repair/verify/lessons, anti-half-understanding, availability,
reliability) become provable only when measured.

## 19. Public docs claim only what's shipped

**Status: 📌 Adopted (process)**

The README and public docs highlight strengths — clean, detailed, and **shipped-only**.
Roadmap items (the understand-card, the contract gate, follow-ups, the benchmark) are never
marketed as available today. Findings are turned into value statements ("runs that fail are
classified, repaired, and the lesson is remembered"), never into negative claims about other
products. The most credible public artifact is the measured benchmark table (decision 18): when it
ships, "we think we're better" becomes "here are the numbers."

**Why:** marketing a plan as reality is the exact coverup the anti-coverup rule exists to prevent.
The internal analysis (including honest self-assessment) stays private; public docs say what we
do and why.

---

# F. Non-goals

## 20. What we deliberately do NOT do

**Status: 📌 Adopted (standing non-goals)**

- **No hand-built NLP classifier pipeline.** The industry's converged pattern — the model
  understands the request — is also the best one; a separate classifier would add a second,
  weaker source of truth (decision 2).
- **No spaCy / JointBERT.** Python-bound, no TS binding, and the "backbone of the compared
  products" claim was falsified against their actual code. The genuinely useful slice of that
  claim (rule-based temporal/unit parsing) is adopted as a TS-native library instead
  (decision 13).
- **No full agent framework (LangChain-style).** Agent-Nuvira's multi-agent pipeline, router, and
  memory stack are the product; borrowed libraries are chosen for focused jobs (decision 13),
  never to replace the core (decision 15).
- **No hosted memory as a hard dependency.** Memory is local-first; external backends are optional
  (decision 15).
- **No paid SaaS as a hard dependency.** Every capability uses open-source libraries or free
  tiers; nothing requires a paid API to function.
- **No mode menus.** The pre-dispatch mode picker is being deleted, not demoted — every command
  shares the same intent-first dispatch (decisions 4, 6).
- **No removing commands.** The CLI evolves by adding and aliasing, never by silently removing
  behavior.

## 21. User-declared daily token budget (advisory, never a product hard cap)

**Status:** Decided (Session 36) — CLI + dashboard quota-budget surfaces landed.

**Problem:** the M2b phase-gate re-run (Session 35) was destroyed by Groq free-tier **tokens-per-DAY
(TPD) exhaustion** — 12 TPD 429s, 0 TPM events, cost collapsing to $0.0018, 8/9 tasks stuck for want
of ANY model response. The same setup scored 72.2% / 55.0% / 26.9% across three runs: a ±45-point
noise band. No provider API exposes its TPD allowance (same as context windows — Groq's `/models`
carries no window or daily-cap metadata), so the **only** correct source of a daily budget is the
user, who knows their plan.

**Why we do NOT hard-code a product-imposed TPD cap:** a fixed cap would be wrong twice — it would
throttle paid-tier users below their plan, and it can't know free-tier org budgets either. A hard
cap removes the user's say, which is exactly what this decision exists to protect.

**What we do instead — the user declares their budget; the system paces around it:**
- The knob is the pre-existing `routing.quota.<provider>.<field>` config
  (`tokensPerWindow` / `requestsPerWindow` / `windowMs`) + the existing admin cost cap
  `routing.governance.maxCostUsd` — surfaced for the first time as a **discoverable editor** in
  BOTH the CLI (`buff model quota set`) and the dashboard (Admin → Budget panel). Both write the
  SAME config file via `ConfigManager.save()` (dashboard is a parallel GUI, never a fork).
- **Semantics are advisory + pacing, not crippling:** unset = current behavior (provider 429s
  happen, reliability stack recovers). Set = the quota ledger tracks measured + estimated tokens
  per provider per window, and when a window hits the declared cap it **parks that provider**
  (auto routing sinks it like a circuit-breaker and prefers other providers) and **auto-re-enables
  on window rollover**. The feature never stops — the provider pauses, and the user is always one
  click/command away from raising the budget or clearing the window.
- **RBAC-aware:** in single-user legacy mode everything is editable; once roles are assigned,
  quota writes need `routing.operate` (admin + operator) and the cost cap needs `policy.write`
  (admin) — the same matrix the CLI enforces (dashboard parity via `roleCan`).
- **Backend control is real, not cosmetic:** `QuotaLedger.getRouterQuotaStatus()` derives
  configured-limit exhaustion from `routing.quota` and feeds the auto-router before every pick;
  `failure-bookkeeping` parks a rate-limited provider for the configured `windowMs`. The user's
  number is therefore enforced by the agent itself, in the loop, before requests go out.

**Why this is the right trade:** it converts an invisible provider constraint (TPD) into an
actionable, user-owned budget — the exact opposite of a hidden product cap. It also gives the
Part 1.9 gate a usable path on free tiers (pace a run under the declared budget instead of letting
TPD exhaustion invalidate the measurement).

**Scope boundary (Session 37, user-confirmed) — eval gates vs. the declared budget are two
different knobs, and only ONE of them ever touches real work:**
- `buff eval run --budget <USD>` and `buff eval run --pace` (Session 37) are **eval-only,
  opt-in, per-invocation gates** for measurement runs — the "$1 / $0.5 / no cap" cost option from
the gate analysis. They are registered on NO other command: `buff chat`, `buff plan`, `buff
execute`, sub-agent delegation, and the dashboard are untouched. Without the flag, nothing
changes. Their purpose is to keep TPD/cost exhaustion from invalidating an M2b measurement
mid-run — never to limit the user's normal requests.
- The **declared daily budget** (`routing.quota.<provider>.tokensPerWindow`, Decision 21) IS
consulted by auto-routing for all work — but only as a soft preference, per the semantics above:
when a provider exhausts the user-declared cap, the quota ledger parks it and routing PREFERS
other providers (sink like a circuit-breaker; picked only when every candidate is parked). It
never blocks an explicit user choice, never hard-stops a task, is unset = current behavior, and
is always one command/click away from being raised or cleared.
- **Rule of thumb:** the eval gates decide *whether a measurement run starts/stops*; the declared
budget decides *which provider wins auto-picks*. Neither restricts the user's day-to-day
requests, and both are fully opt-in.

## 22. Web research: free-first, availability-gated, SSRF-guarded (I1)

**Status: ✅ Shipped (Session 38)** — `web_search` + `read_page` tools registered in H1 and the
safe MCP surface.

**Problem (capability gap #3, 🔴 MAJOR):** of the three products compared, only agent-nuvira had
**zero web-search capability** — Freebuff ships `researcher-web.ts` / `researcher-docs.ts`,
Hermes ships `agent/web_search_registry.py`, and ours had nothing. A user asking "what's the
latest version of X" or "compare approaches Y and Z" forces the model to answer from stale
training data or hallucinate — the exact "half-understood requirement" failure this program
exists to eliminate. This was the largest remaining *understanding* gap after the NLP dispatch
work (decisions 1–6).

**Why free backends only (extends decision 11 / 20):** DuckDuckGo HTML needs no key, SearXNG is
self-hostable OSS, and Jina Reader has a free tier. No capability of this product may require a
paid API to function, and web research is no exception. `JINA_API_KEY` and `BUFF_SEARXNG_URL`
are opt-in enrichments, never requirements.

**Why availability-gated, not installed-forever (the Hermes registry pattern):** `web_search`
works out of the box (DDG), and `read_page` degrades gracefully — Jina when configured, plain
fetch otherwise. Zero config → zero behavior change, which is the I-series rule every modality
pack follows.

**Why an SSRF guard on `read_page` (security, not paranoia):** the tool fetches arbitrary URLs
the model chooses, and a prompt-injected instruction could point it at loopback / link-local /
cloud-metadata endpoints (169.254.169.254, 10/8, 192.168/16, etc.). Blocking those by default
(with `BUFF_WEB_ALLOW_PRIVATE=1` as the explicit escape hatch) is cheap and prevents the tool
from becoming an internal-network probe. This is why the tools are safe to expose on the MCP
surface: read-only, no LLM, no loop, and the network blast radius is bounded.

**Why DDG redirect URLs are decoded:** DDG HTML lite wraps every hit in `/l/?uddg=…` — without
decoding, the model would hand `read_page` a relative redirect that fails, silently losing the
"search then read" flow that makes research work.

**Why caching:** results are cached in `context/cache.ts` (6h search / 24h page TTL) — repeated
queries cost zero network and zero tokens, keeping the free-tier economics (decision 11) intact.

**Deliberate non-goals (this decision):** no browser automation (that's I2, Playwright, and it
stays availability-gated), no scraping of sites that forbid it (the tool carries a real browser
UA and respects robots via standard HTTP), and no always-on crawling — the model calls search
when it needs grounding, it doesn't crawl.

**Why this decision is recorded:** so the "why free backends / why a guard / why decode redirects"
questions never re-open as debates. The tool ships; the reasoning is pinned here.

## 23. Rate-limit failures PARK, they never demote a verified model

**Decision (post-revamp bug fix, v1.62.1):** a `rate-limit` (429 / quota-exhausted) failure
must NOT flip a model's registry status to `unavailable`. It sets `lastError`, applies a
quota park (`quotaParkedUntil`), and PRESERVES the existing status (`verified` stays
`verified`). `auth` failures still demote permanently (the key is dead until re-probed).

**What broke before:** `recordCall(ok=false, 'rate-limit')` flipped `status → 'unavailable'`.
`isUsable()` requires `status === 'verified'`, so a rate-limited cloud model was excluded
FOREVER even after the park window lapsed — it only ever came back via a manual
`buff models unblock` / `models refresh`. On free tiers (Groq/Gemini) a single busy burst
(repair loops, parallel runs) 429s → every cloud model parked AND demoted → the auto-router
silently routed ALL agents to the weak local model → slow pipelines + false-success code
artifacts. The user-visible symptom was "chat answers in seconds, execute is slow + wrong".

**Why park (not demote) is correct:** a 429 is transient by definition. The park is already
the exclusion mechanism — `getBlockedProviders()` counts a parked entry as a definitive no,
so routing still predictively skips the provider while the window is active, and the
per-action telemetry still records the failed call. `markVerified()` clears registry-level
parks on any real success and `syncQuota()` re-applies only LIVE ledger parks, so recovery
is self-correcting: if the quota is genuinely exhausted the next call fails and re-parks.

**Recovery window:** governed by the quota ledger (`routing.quota.<provider>.windowMs`,
default 24h — set from the dashboard quota UI). Free-tier RPM resets are much shorter; a
24h default can still strand a provider for a day after one burst, so teams on free tiers
should set a shorter `windowMs` (e.g. 4h) in the dashboard. The registry-level hour-aligned
park is a floor for the case where no ledger window is configured.

**Why this decision is recorded:** so "why did my cloud provider vanish after a 429" never
re-opens as a debate, and so no future refactor re-introduces the permanent-demotion bug.
Tests pin the behavior in `model-registry`, `provider-fallback`, `failure-bookkeeping`,
`orchestrator`, `plan`/`edit` CLI, and the `failover-learning`/`sidecar-learning` E2E suites.

**Addendum — park for the provider's ACTUAL reset time, not a fixed window (v1.62.1):**
most 429s are available again in seconds-to-minutes (Groq free tier resets per-minute/hour;
the registry's own status display says "resets in 17h 51m"), and providers TELL us the reset
via `Retry-After`, Groq/Anthropic's "Please try again in 16.5s", or Groq's
`x-ratelimit-reset-*` epoch headers. So the park duration now honors that hint:
`extractRetryAfterMs(err)` (shared util in `provider-fallback.ts`, also replacing the three
duplicated `parseRetryAfterHint` copies) reads attached fields → headers → message patterns
("try again in Xs/ms", "Retry-After: N", "reset in N minutes", "resets in Nh Nm"), and both
the ledger park (`failure-bookkeeping`) and the registry floor (`recordCall`) park for
`clamp(hint, 10s, configured windowMs)` instead of `windowMs`/hour-aligned defaults. The
configured window remains the hard CAP (the user's `routing.quota.<provider>.windowMs` is the
final say), and a bare 429 with no hint still falls back to the conservative window. Verified
model + 16.5s hint = parked 16.5s, then auto-recovers — no manual unblock.

## 24. Agent LLM calls fail over across providers (v1.62.1)

**Decision:** an auto-routed agent LLM call (orchestrator's `createAutoRoutedLLMFromDecision`)
that fails with a RETRYABLE error (503 high-demand / 429 / network / timeout) walks the
router's next-ranked provider candidates (best-first, up to 3, skipping circuit-breaker
cooldown) instead of exhausting the repair budget on the single winner. Auth failures on
the winner never fail over; a user-PINNED provider (ranked list empty) is honored as-is.
The board shows the live move ("⚠️ gemini server — failing over to groq").

**Why:** the end-to-end NVDA-addon run proved the gap — gemini 503'd ("high demand") and
the writer retried gemini 3× and died, while groq (verified, available) sat idle. Chat
already had this failover walk; the orchestrator didn't. Each failed provider×model still
records exactly once through the shared telemetry path, so the NEXT task routes around
the dead combo predictively. The repair/escalation engine still fires after all
candidates fail (the original winner error rethrows as the primary signal).

**Companion decisions in the same release:** adapter errors now carry their HTTP context
(`attachHttpContext` — status + Retry-After / x-ratelimit-reset-* headers on every
adapter), so even body-less 429s feed decision #23's hint-aware park; and the pinned
Gemini model was updated from the retired `gemini-2.0-flash-exp` to the live
`gemini-flash-latest` (2026 accounts 404 on the 2.x line).

**Why this decision is recorded:** so "the reviewer hit a rate limit — why didn't it take
another model" never re-opens as a debate, and so a future refactor doesn't reintroduce
single-provider-only agent calls.

## 25. Consecutive rate limits auto-switch providers mid-task (v1.62.1)

**Decision:** the orchestrator's per-task rate-limit handler counts CONSECUTIVE rate
limits. After the 2nd within one task, it stops prompting the user and auto-switches to
the router's next healthy provider (returns `{ action: 'switch-model', callLLM }`, which
writer/edit-module already honor by rebinding `latestCallLLM`/`currentCallLLM`).

**Why the storm guard, not the interactive prompt:** a single rate limit is a "wait and
retry" situation — the prompt is right. But an agent's `callLLM` is bound to one provider
mid-task, so grinding the same provider's "wait and retry" after a burst is futile (the
registry park can't help the ALREADY-bound call, and the failover walk only fires if the
error propagates past the writer's prompt). Two in a row is the signal that the provider
is having a burst; the fix is a different provider, not patience.

**Target selection semantics (learned in review):**
- **Auto mode** — trust the fresh decision's winner. By the 2nd hit, the hint-aware park
  (decision #23) has already moved the winner OFF the rate-limited provider, so the
  winner IS the best healthy pick. Excluding it (as an earlier draft did) skipped ranked[0]
  and forced a worse ranked[1] provider.
- **Pinned mode** — exclude the bound provider explicitly; the fresh winner may still be
  the rate-limited one when the park hasn't propagated, and switching back to it would loop.
- **Model never leaks:** the override passes `model: 'default'` (the codebase's "no pin"
  sentinel), so `resolveWorkingModel` picks the target provider's best VERIFIED model. The
  spread must not carry the rate-limited provider's model ID (a gemini ID on groq = 404).
- **Cooldown-aware:** candidates in circuit-breaker cooldown are never chosen; if no
  healthy alternative exists, the guard falls through to the interactive prompt.
- **No ping-pong (added in review):** the handler closure keeps `triedProviders` — the
  bound provider (pinned mode) plus every provider auto-switched-to this task. Without
  it, two providers both in quota-storms (gemini 503 + groq TPM, the live NVDA failure)
  ping-pong: their short hint-aware parks (~16s) can lapse mid-task, making each the
  fresh winner again right after we switched away. The set forces the guard to keep
  moving forward; when every ranked provider is tried/cooldown-parked it falls through
  to the interactive prompt.

**Why this decision is recorded:** the "gemini 503'd → writer retried gemini 3× and died"
failure (observed live in the NVDA-addon end-to-end) is precisely the class of failure the
multi-provider stack exists to prevent. Future refactors must keep the storm guard BEFORE
any interactive rate-limit prompt, or the auto-failover guarantee silently disappears.

## 26. Rate-limit recovery is fully automatic — no prompts, no grinding (v1.62.2)

**Decision:** rate-limit handling in the orchestrator is FULLY AUTOMATIC by default. The
user is never interrupted mid-build because a provider is temporarily exhausted:

- **Transient hit** (reset hint ≤ 60s, e.g. "try again in 16.5s"): silently wait out the
  hint and auto-retry on the same provider. Waiting is cheaper than switching for a
  sub-minute pause.
- **Exhaustion** (reset hint > 60s, e.g. "resets in 17h 51m" — a daily-quota cap): the
  provider is down for a while, so auto-switch to the router's next healthy provider on
  the FIRST hit — not after two.
- **Storm** (2+ consecutive hits in one task): same auto-switch (decision #25 semantics).
- **No healthy alternative / resolution error:** fall through to silent wait + retry, or —
  only when `routing.askOnRateLimit: true` is configured AND the run is on a real TTY —
  the legacy interactive prompt (wait / switch / skip / abort).

**Why fully automatic rather than asking:** the user's explicit requirement — "if gemini
failed/exhausted it should leverage another model in the build, why throw an error to the
user?" A build that pauses to ask on every quota burst is a build that feels broken; a
build that silently continues on whichever provider is healthy is the multi-provider
promise actually working. The single-provider edge (no alternative exists) is the only
case where a user decision is meaningful, and even there the default is to wait and retry,
not to fail.

**Trade-off considered — always prompt:** rejected. It reintroduces the exact failure
class the stack exists to prevent (the pipeline dying on one provider), and is hostile to
non-interactive/CI runs. `askOnRateLimit` preserves the choice for operators who want
fine-grained control (e.g. cost-sensitive users who prefer to pause than burn a quota on
an unplanned provider).

**Interactions with prior decisions:** builds on #23 (hint-aware registry park — the fresh
decision's winner usually already moved off the rate-limited provider) and #25 (storm
guard + triedProviders + `model: 'default'` no-leak). #24's cross-provider failover walk
remains the backstop for non-rate-limit retryable errors.

**Why this decision is recorded:** the threshold (60s), the opt-in flag, and the
"exhausted on first hit" rule are subtle behavioral contracts. Future refactors must keep
this ordering — auto-switch before any prompt, prompt only when explicitly opted in and
TTY — or the "silently continue on a healthy provider" guarantee silently disappears.

**Review refinements (added after review):**
- **Honest "consecutive":** the storm counter resets after each successful auto-switch
  (the new provider starts a fresh streak) and strikes farther apart than 5 minutes are
  treated as a new incident. Without this, a single transient hit on a provider that just
  succeeded 10× would re-trigger a switch because the counter carried over from the
  previous provider's storm.
- **Auto-mode bound-provider seed:** `createRateLimitHandler` now receives the task's
  routed provider (captured from `createAutoRoutedLLM` — no extra resolve), so the guard
  skips the provider the agent is already bound to even when the fresh decision re-picks
  it (park lag). Previously only pinned mode seeded this; auto mode could "switch" to the
  very provider that just rate-limited, burn one wasted switch, then self-correct.
- **Dashboard visibility:** every auto-switch writes a `failover` event to the quota
  timeline (`quota-events.jsonl`, via `getQuotaLedger().recordEvent`) with the reason
  ("rate-limited 2x" / "exhausted"), so the dashboard's Failover Timeline card shows
  mid-task provider swaps live — same store the CLI `model quota` last-20 and the audit
  chain read. Verified live: the NVDA-addon run's "auto-switched to local" and
  "auto-switched to groq" events now land in the timeline instead of only the event bus.

## 27. The interactive rate-limit prompt is opt-in — askOnRateLimit (v1.62.2)

**Decision:** the legacy interactive rate-limit prompt (wait / switch / skip / abort) is
now **opt-in** via `routing.askOnRateLimit: true` in `.buffconfig.json`, and even then it
only appears on a real TTY. The default — and the only behavior in non-interactive/CI
runs — is fully automatic recovery (decision #26): silent wait + retry for transient
hits, silent auto-switch for exhaustion and storms.

**Why opt-in rather than removed or default-on:**
- **Removed** would strand operators who genuinely want to intervene on every quota hit
  (e.g. cost-sensitive users who prefer to pause rather than burn quota on an unplanned
  provider). The flag preserves that choice explicitly.
- **Default-on** would reintroduce the exact failure class the multi-provider stack
  exists to prevent (the pipeline dying on one provider while the user is away) and
  breaks non-interactive/CI runs, where no one can answer the prompt.
- **TTY-only** keeps the flag honest: on a pipe there is no one to ask, so asking would
  hang the run — the handler silently degrades to automatic instead.

**Precedence:** `options.askOnRateLimit ?? (config.routing.askOnRateLimit === true)` — an
explicit CLI/API option wins over config; an explicit `false` disables prompts even if
config enables them.

**Why this decision is recorded:** the flag is the escape hatch for the automatic default
of #26. Future refactors must keep the ordering — auto-switch before any prompt, prompt
only when explicitly opted in AND on a TTY — or the "silently continue on a healthy
provider" guarantee silently disappears.

## 28. Where the pipeline loses to interactive execution — and the efficiency wins (v1.62.4)

**Context:** a live NVDA-addon task ("create an addon that speaks 'Hello Anuj Mote' on
NVDA+alt+1") took 12–18 minutes through `execute` and failed, while the same question in
`chat` answers in seconds. This decision records the root-cause comparison and the
concrete efficiency levers.

**How the pipeline executed the task (observed, real run):**
- Linear stage chain with one LLM call per stage and **no parallelization**: planner
  (94s) → context-gatherer (LLM deciding which files to read) → writer step 1 (~68s) →
  writer step 2 (~3 min, incl. a 2× parse-failure retry loop) → reviewer (3 passes,
  ~1–2 min each) → runner (2 failed build attempts, ~2 min) — 771s+ total.
- The **model hallucinated the NVDA API** (`nvda.register_key_handler`, `from nvda
  import ui`) — no reference material was in the prompt — which drove the reviewer's
  repeated "critical issues" verdicts and the repair-budget exhaustion.
- A step reported ✅ while writing the **wrong file** (manifest step wrote
  `globalPlugins/hello_anuj.py`), so later steps built on a lie.
- The runner **didn't check the toolchain**: `python` (exit 127 — not installed),
  then `python3 -m venv` without verifying `requirements.txt` existed.

**How interactive/tool-driven execution (the Buffy-style loop) does the same task:**
- Context is gathered by **tools, not LLM calls** (directory listing, globs, greps run
  in parallel in one round-trip; the model only reads what actually matters).
- Independent subtasks **fan out in parallel** instead of serializing.
- Files are **applied directly** (precise string replaces / full-file writes) — no
  LLM-emitted diff blocks to parse, so the parse-failure retry loop cannot exist.
- Domain knowledge is **verified up front** (reference docs / docs research) rather
  than regenerated from model memory — no hallucinated APIs to review-reject.
- **Deterministic checks run as tools, not reviewer LLM passes**: syntax check, file
  existence, imports resolution, build command — instant and exact. The LLM is
  reserved for semantic review only.
- Build/verify happens **continuously** (write → run the real build → fix), so the
  failing command surfaces within seconds of the code that caused it.

**Seven concrete efficiency wins adopted or queued for the pipeline:**
1. **Parallel step fan-out** — steps whose `expectedFiles` don't overlap (and which
   don't read each other's outputs) run concurrently instead of sequentially. The
   NVDA task's two writer steps were independent and ran back-to-back (~4 min → ~2).
2. **Tool-based context gathering** — deterministic manifest/directory scanning for
   the inspection step instead of an LLM call that re-discovers the obvious.
3. **Structured writer output** — a JSON file-changes envelope (or direct apply)
   replaces prose+code-block parsing; the 2–3 min parse-failure retries disappear.
4. **Latency-based provider failover** — v1.62.2/3 handle quota errors; the 94s
   planner stall shows a per-call wall-clock budget with auto-switch would cut the
   critical path by minutes.
5. **Toolchain pre-flight in the runner** — detect `python`/`python3`/`node`,
   presence of `requirements.txt`/`package.json`, and buildability BEFORE attempting
   commands (the NVDA run burned ~2 min on exit-127 then a missing requirements file).
6. **Deterministic-first review** — syntax/import/file-existence checks run as tools
   before any LLM review; the LLM only reviews what mechanical checks can't.
7. **Reference-docs injection (shipped in v1.62.4)** — curated, verified API
   snippets for known domains (NVDA first) at prompt time, eliminating the
   hallucination→review-reject→repair loop at its source.

**Status:** #7 (reference docs) and the deliverable match check are shipped in
v1.62.4; the NVDA eval task (`py-nvda-addon`) locks both in. #1–#6 are queued as the
next performance program; they target wall-clock, not correctness — correctness
already improved with the deliverable check + reference docs.

## 29. Transient quota blips must never fail a task — the reviewer rate-limit gap (v1.62.5)

**Observed:** a `buff eval run` against groq/llama-3.3-70b produced 6/9 tasks
marked "Provider interference" and a composite of 51.6% — not because the agent
was stuck, but because the Reviewer died with:

    ✖ Reviewer failed after 3 API attempts: Groq API error (429) …
      Limit 12000, Used 11036, Requested 4597. Please try again in 18.165s.

The whole suite ran in 59.9s, which proves no wait ever happened: honoring an
18s reset per task would alone have taken longer. Decision #26 made the
orchestrator's rate-limit recovery fully automatic, but that recovery is only
reachable through `context.onRateLimit` — which agents must invoke themselves.

**Root cause:** the reviewer's retry loop used a fixed 1s/2s exponential backoff
and never called `context.onRateLimit`. All three attempts fired inside the
18s reset window, each 429d, and the review returned failure. The writer,
context-gatherer, and edit-module all had the correct hint-aware pattern; the
reviewer was the missing piece — and since the reviewer runs at the END of
nearly every pipeline, its failure killed tasks that had already been written
and tested.

**Fix (v1.62.5):**
1. **Reviewer mirrors the proven pattern.** Rate-limit errors with a reset hint
   >= 3s delegate to `context.onRateLimit`, so the orchestrator's decision #26
   logic applies: silent wait for transient hints (an 18s TPM blip is waited
   out and retried), silent auto-switch for exhaustion/storms (with the
   dashboard failover event), opt-in interactive prompt on a TTY. Shorter
   hints use the hint-aware delay; non-rate-limit transients keep backoff.
   `switch-model` swaps the active callLLM mid-review; `skip`/`abort` are
   honored.
2. **Single source of truth.** `src/agents/rate-limit-retry.ts` now holds the
   shared helpers; writer and context-gatherer were refactored onto it
   (removing their local copies) so the hint parsing, thresholds, and backoff
   base can never drift between agents.
3. **Regression coverage.** Fake-timer tests assert an 18.2s hint is fully
   waited out before retry (not a 1s backoff), switch-model routes the retry
   through the handler-provided LLM, and abort fails fast.

**Remaining policy:** tasks whose TERMINAL error is still provider interference
(rare now) are classified non-stuck by the eval framework and surfaced on the
'Provider interference' line — the measurement never counts them as agent
stuckness. A full eval re-run is the acceptance test for this decision.

## 30. Strict file contracts, lenient recovery when NO stronger model exists (v1.69.0)

**Observed:** the same NVDA add-on task ("build an addon that says 'Hello
Dheeraj' on NVDA+alt+1, NVDA 2026.1-aligned, deployable") succeeded in chat
mode but failed *brutally* in execute mode on a machine where every cloud
provider was unavailable (rate-limited/quota-exhausted) and only a small local
model was left. Chat produced correct NVDA code in plain ```python blocks and
displayed it — no parsing required. Execute mode's Writer agent demands strict
```filepath:<path> fences; the same model wrapped valid code in plain fences,
the strict parser found ZERO changes, repair "escalated to a stronger model"
(which resolved to the SAME weak local model), failed identically, and repeated
— 3 repair cycles × 1–2 min each on 7–12 tok/s local generation = **10+
minutes of spinning, then total failure**, even though the model knew the
answer (it proved that in chat).

**Root cause:** two independent gaps. (1) The writer's strict fence contract
had no lenient fallback — any model that deviates from the exact format (small
models commonly do) yields zero parseable changes, a total failure even when
the content is correct. (2) Escalation "to a stronger model" silently resolved
to the *same* model when none stronger existed, so repair was guaranteed to
fail again — wasting minutes per cycle instead of failing fast.

**Fix (v1.69.0):**
1. **Lenient file-change recovery in the writer** (`src/agents/agents/writer.ts`):
   strict ```filepath: parsing is still tried FIRST and never weakened for a
   healthy pipeline. Only when strict parsing finds ZERO changes AND the
   orchestrator explicitly set `metadata.lenientFileParsing` does the writer
   run `parseFileChangesLenient` — recovering plain ```lang blocks by inferring
   each block's path from the response's own prose → task description →
   reference docs, in that order. Ambiguous blocks are skipped, never guessed.
2. **The gate is "no better model available."** The lenient flag is set ONLY in
   the no-op-escalation path (decision 31). A user with a strong cloud model —
   the common case — never sees lenient parsing; strict format compliance is
   preserved where it matters. This is the constraint you asked for: lenient
   recovery happens only when escalating to a better model is impossible.
3. **Deliverable preserved.** When lenient parsing recovers the writer's
   changes, the files are written and the pipeline continues — the model's
   correct work is saved instead of being discarded for a format miss.

**Live verification:** the same NVDA task (auto/auto, local-only) went from
"10+ min spin then total failure" to a complete run in ~2 min with both addon
files written correctly (`manifest.ini`, `globalPlugins/hello_dheeraj.py` with
`@scriptHandler.script(gesture="kb:NVDA+alt+1")` / `ui.message("Hello
Dheeraj")`). A second, healthy task (Python CLI + unittest) ran with ZERO
repairs — proving the lenient path never fires when the strict contract is met.

---

## 31. No-op escalation is detected — weak-model repair is bounded, never a loop (v1.69.0)

**Observed (same incident as decision 30):** when the only available model was
weak, the error-repair engine "escalated" at the next complexity tier
(`moderate → complex`) but the model registry had every stronger candidate
blocked — so escalation resolved to the same provider×model that just failed.
The result was an identical-failure loop: each repair cycle re-ran the weak
writer, produced the same format miss, burned 1–2 min, and repeated up to the
full repair budget. The user saw 10+ minutes of grinding that could never
succeed.

**Root cause:** escalation was decided by complexity tier alone — nobody asked
whether the escalated route actually landed on a *different, stronger* model.
When the router is constrained to one provider (local-only, or a single
degraded key), "escalation" is a no-op by construction.

**Fix (v1.69.0):**
1. **The orchestrator records every routed decision** (`src/agents/orchestrator.ts`):
   `createAutoRoutedLLM` and `createEscalatedLLM` now record the provider×model
   each task was routed to (`routedProviderModelByTask` /
   `escalatedProviderModelByTask`).
2. **`isNoOpEscalation(taskId, escalated)` compares them.** When the escalated
   route equals the task's original route, it's a no-op — logged clearly
   ("No stronger model available (escalation resolves to the same model)").
3. **No-op ⇒ bounded + lenient.** The task's repair budget is capped at 1 and
   the writer's lenient parsing (decision 30) is enabled, so the weak model
   gets its single best shot — then the pipeline fails fast and surfaces the
   model's real output instead of looping on the identical failure. A healthy
   pipeline (a real stronger model available) keeps the full configured budget
   and never touches either mechanism.

**Live verification:** the NVDA task's runner step (which *cannot* run outside
NVDA — `ModuleNotFoundError: addonHandler`) previously triggered the same
escalation loop; after this fix it failed once, clearly, in ~1 min instead of
spinning for 10+. The writer, reviewer, and planner steps completed normally
with the correct deliverables.

---

## 32. The weak-model prompt — human-in-the-loop, opt-in (routing.promptOnWeakModel) (v1.69.0)

**Observed:** after decisions 30–31, a user on a weak-only model gets silent,
bounded degradation — the pipeline continues on the weak model (lenient
parsing, repair budget 1) or fails fast. Both are *silent*: the user has no
say. On a big deliverable, a user may prefer to WAIT for a stronger model (or
fix their provider config) rather than accept a recommendations-only result —
and should be told plainly that the available model is weak. This decision
adds the missing human-in-the-loop layer on top of 30–31.

**Design constraints (what makes it safe):**
1. **Opt-in, default OFF** (`routing.promptOnWeakModel`, default `false`).
   Silent auto-behavior stays the default for everyone; the prompt is a
   control users enable deliberately (`buff config set routing.promptOnWeakModel
   true`). Existing users see zero change. The option was added to the CLI
   config whitelist so `buff config set` accepts it.
2. **Asked at the DECISION point, once per pipeline.** The trigger is exactly
   the no-op-escalation point from decision 31 — no new detection needed. A
   latch (`weakModelChoice`) guarantees a multi-task pipeline asks once, never
   re-prompts per task.
3. **The 'wait' option is honest.** It is offered ONLY when a stronger
   candidate is actually in a short cooldown (circuit-breaker or rate-limit
   exclusion remaining ≤ 3 min, `MAX_WEAK_WAIT_MS`). Choosing it sleeps out
   the cooldown, re-routes fresh, and — if a stronger model recovered — runs
   with the NORMAL repair budget (the lenient flag is dropped). When every
   stronger provider is quota-exhausted for hours, 'wait' is not offered; the
   honest choices are continue or abort.
4. **Non-interactive safety.** TTY-gated (`process.stdin.isTTY`): piped/CI
   stdin falls through silently to the decision-30/31 weak path and NEVER
   blocks. Verified live with piped stdin.

**The prompt** (`src/cli/weak-model-prompt.ts`, mirrors `failover-prompt.ts`):

    ⚠️ Only a weak model is available (local/gemma4:e4b) — it can give guidance
       but may not reliably deliver this task.
    ? Only a weak model is available — how would you like to proceed?
      ▶  Continue on the weak model — use its best effort
      ⏳  Wait and retry when a stronger model is back   ← only when honest
      ⛔  Abort — I will fix the provider config

**Outcomes:** 'continue' runs the decision-30/31 weak path unchanged (byte-for-
byte today's behavior). 'wait' sleeps the short cooldown and re-routes (a
recovered stronger model restores full capability). 'abort' skips repair,
fails the task with an actionable message ("add a provider API key or wait for
a stronger model, then re-run"), and stops the pipeline — never burning
minutes on a model the user already declined.

**Why it does NOT roll back decisions 30–31:** they remain the silent default
and the 'continue' path. The prompt only adds a user decision BEFORE the
weak-model path runs, and only when opted in.

**Tests:** +16 across the three decisions (5 lenient-parser, 3 no-op
escalation incl. budget cap, 7 weak-model prompt module incl. honest-wait
gating + choice rendering, 2 orchestrator wiring incl. abort + once-per-
pipeline latch). Full suite green (4426 passed), typecheck clean.

## 33. The runner carries the project into the build — packaging-aware steps, reference docs, deterministic package fallback (v1.69.0)

**Observed (live NVDA-addon run):** the same task that succeeded in chat mode
failed brutally in execute mode — and the failure was NOT model capability. The
chain, traced end-to-end from the pipeline log:

1. **The planner lost the goal's build requirement.** The goal said "build the
   addon in **deployable format**", but the planner emitted a runner step that
   invented a nonexistent deliverable: *"Simulate loading and testing the addon
   by running a test script that verifies the key handler registers…"* — there
   was no test script. It never planned a packaging step at all.
2. **The runner's command-selection prompt was starved of project context.** It
   asked a weak model "what single command verifies this?" with only file
   *paths* and npm scripts — no file contents, no curated reference docs (the
   NVDA knowledge in `referenceDocsFor` was injected into the writer only,
   never the runner). The model guessed `python3 globalPlugins/addon_main.py`.
3. **The repair loop compounded it.** On failure it re-asked the same weak
   model "propose the NEXT command" with only the failed command + stderr — it
   re-guessed in the same useless family (`python3 -m …`) until the budget
   died. The correct approach was never fetched with a clear task.

The user's diagnosis was correct: **the agent did not carry the task as a
project** — each stage re-derived its approach from a starved prompt instead of
the artifacts the previous stage actually produced, so a model that *knew* the
answer (it proved that in chat) failed in execute mode.

**Root cause (architectural, not model):** the runner was a single-command
verifier with context-blind prompts, and the planner had no guidance for
packaging goals. A strong cloud model would also have been steered wrong by
that starved prompt — it would just hallucinate more confidently.

**Fix (v1.69.0):**
1. **Planner is build-aware.** The system prompt now instructs: for
   deployable-format goals, plan the runner step with the explicit PACKAGING
   command in backticks (`zip -r <name>.nvda-addon manifest.ini globalPlugins`,
   or a static check like `python3 -m py_compile`) — never a hallucinated
   "simulate/run a test script" step.
2. **The runner's LLM prompts now carry the project.** Both `askLLMForCommand`
   and `askLLMForRepairCommand` inject the curated reference docs
   (`referenceDocsFor`), the actual contents of the written files, and explicit
   guidance: *"if the deliverable CANNOT RUN in this environment (an NVDA addon
   needs NVDA; an iOS app needs Xcode), propose the PACKAGING command or a
   static check — do NOT try to execute it."*
3. **Deterministic packaging fallback** (`detectPackagingCommand`): when the
   written project is a known cannot-run-here deliverable (NVDA addon =
   `manifest.ini` + `globalPlugins/` + addon goal), the runner returns the real
   build command `zip -r <name>.nvda-addon manifest.ini globalPlugins`
   directly — no weak model re-guessing, on both the first attempt and repair.

**Live verification:** the same NVDA task went from "3× `python3
globalPlugins/addon_main.py` → `ModuleNotFoundError` → 10+ min spin" to:
planner emits a packaging step → runner executes `zip -r
Hello-Dheeraj-Addon.nvda-addon manifest.ini globalPlugins` → **exit 0, 11ms** →
reviewer passes → a valid `.nvda-addon` archive with `manifest.ini` +
`globalPlugins/hello_dheeraj.py` (correct NVDA 2026.1 APIs). A healthy task
(Python CLI + unittest) still runs with ZERO repairs — the new context never
interferes with a working pipeline.

---

## 34. Missing system tools are installed with user consent — OS-appropriate recipes, approval prompt, then continue (v1.69.0)

**Observed:** when a build needs a system tool that is not installed (e.g.
`zip` for packaging an NVDA addon), the old runner failed with a raw "command
not found" and, when it tried to "fix" it, either mis-classified it as a
project-dependency problem or silently skipped it. Enterprise parity demands
the behavior of a human agent: detect the missing tool, recommend the
OS-appropriate install, ASK for approval, execute the install if approved, and
continue the task — and when the agent cannot do the manual part itself (sudo,
tokens, brew bootstrap), hand the exact steps to the user instead of failing
silently.

**Fix (v1.69.0):**
1. **Per-OS install recipes** (`src/cli/tool-install-prompt.ts`): a curated map
   of build/infra tools → install commands per platform — Homebrew on macOS,
   apt-get/dnf/yum/apk (auto-detected) on Linux, winget (choco fallback) on
   Windows. Covers packaging tools (zip, unzip, 7z, tar), compilers (gcc,
   g++, clang, make, cmake), language toolchains (go, cargo, java, mvn,
   gradle, dotnet, flutter, php, ruby), cloud CLIs (aws, az, gcloud, gh,
   glab), infra (docker, kubectl, terraform, helm, minikube, vault, packer),
   and db clients (psql, redis, sqlite3, mongosh).
2. **Detection before execution** (`detectMissingSystemTool`): the runner scans
   every token of a command (so `cd addon && zip -r …` is covered, not just the
   first word) for known tools missing from PATH — before running, and again on
   the failure path.
3. **Consent prompt (TTY):** `🛠️ Tool 'ffmpeg' is not installed — this task
   needs it.` with three choices — **Install it now** (runs the recommended
   command, verifies the tool, continues the original command), **Show me the
   manual steps** (fails with actionable instructions), **Skip** (fails
   clearly). Never installs OS software silently.
4. **Non-interactive safety (CI/piped):** never blocks — prints the exact
   manual install command and fails with actionable steps, exactly like handing
   the user a step the agent cannot complete alone (generating a token,
   entering sudo, bootstrapping brew).

**Live verification:** with `ffmpeg` (genuinely absent on the test machine),
the runner returns *"The tool 'ffmpeg' is required but not installed…
Install it manually, e.g.: `brew install ffmpeg`… Then re-run the task."* —
no silent failure, no blocking. With `zip` present, the packaging command runs
unchanged (exit 0) — the consent flow only engages when a tool is actually
missing.

**Why consent is mandatory (not just nice):** installing OS-level software is
a side effect on the user's machine — unlike `npm install` (project-local,
already auto-managed), `brew install`/`apt-get install` changes the system.
Enterprise tooling must never do that without the user's explicit approval,
and must always leave a clear manual path when it cannot complete the install
itself.

---

## 35. ML task-similarity routing + promotion-gate enforcement — closing the ruflo neural-router gap (v1.71.0)

**Observed (the honest gap):** the v1.68/v1.69 router upgrade mirrored ruflo's
(omniroute) architecture on three axes — uncertainty escalation,
Thompson-sampling bandit learning, and an A/B promotion gate — but the
comparison left two edges open vs ruflo's design:

1. **No task-similarity generalization.** The bandit learns per
   provider × complexity-bucket. It cannot say "tasks that LOOK like this
   task succeeded on provider X" — a capability ruflo gets from its
   neural router (KNN/FastGRNN over task embeddings).
2. **The promotion gate was advisory, not enforced.** `buff model bandit`
   could report "the bandit has NOT proven itself" — but a failing bandit
   could still change picks at runtime. ruflo refuses to promote without the
   criteria passing; we never blocked steering.

**Fix (v1.71.0) — two layers, both built on what already shipped:**

1. **ML task-similarity router (`src/learning/ml-router.ts`)** — a pure-TS,
   zero-dependency analog of ruflo's neural router that rides the SAME
   `resolve()` pipeline and SAME `recordOutcome()` feed as the bandit:
   - **Feature extraction:** task text is lowercased, tokenized, and hashed
     (FNV-1a) into a 256-dim sparse binary vector; a 64-dim one-hot tail
     hashes complexity + intent so the similarity signal carries the exact
     same bucketing the bandit learns by (select-time and record-time buckets
     always match — the same lesson as the bandit's intent-aware v3).
   - **Learning:** every real outcome is persisted as a feature vector in
     `~/.buff/memory/ml-router.jsonl` (honors `BUFF_MEMORY_DIR`, capped at
     MAX_RECORDS=5000, oldest trimmed, best-effort writes).
   - **Resolve-time blend:** cosine similarity to all records → top-k
     neighbors (default k=8) → per-provider similarity-weighted win rate
     ('escalated' counts as a half-win, same convention as the bandit) →
     learned factor `1 + strength × (winRate − 0.5)` → the factor multiplies
     each candidate's (post-bandit) score, then re-sorts. The reason string
     gains an `ml:` tag so the audit trail explains the nudge.
2. **Promotion-gate enforcement (`src/learning/auto-router.ts`)** — when
   `routing.promotionEnforce` is on AND the gate has SUFFICIENT diverged A/B
   data (≥ `promotionMinDecisions`, default 20) AND the bandit is NOT
   promoted, the bandit's picks are replaced by the deterministic heuristic
   ranking (`routedBy: 'bandit-gated'`), and escalation is cancelled. The
   bandit KEEPS learning and recording while gated — the trajectory must keep
   accumulating so a future promotion re-enables it. A learned layer must
   prove itself before it steers.

**Config surface (all opt-in, all default-off):**
- `routing.mlRouter` (true/false) — enable the ML blend; `mlK` (default 8),
  `mlMinSamples` (default 5), `mlStrength` (default 0.5)
- `routing.promotionEnforce` (true/false) — enable the gate to block a
  non-promoted bandit; `promotionMinDecisions` (default 20)
- Config keys validated in `buff config set routing.*`; unknown keys rejected.

**Observability:**
- `buff model ml` — shows learned-record count, enabled state, and the
  per-provider win rates/factors currently influencing picks (plus `--json`)
- `buff model bandit` — shows the promotion gate status (the criteria deltas,
  diverged sample count, promoted yes/no) so the enforcement decision is
  always explainable

**Design rules and WHY (the reasoning that shipped):**
1. **Cold start is NEUTRAL (factor 1.0).** With zero records the ML router
   must reproduce today's deterministic picks exactly — a learning feature
   must never change behavior out of the box. It only engages after the user
   opts in AND real outcomes accumulate.
2. **Min-samples guard (5).** A provider needs ≥ 5 similar-task neighbors
   before its win rate is trusted; below that the factor stays 1.0. A 1–2
   sample win rate is noise, not signal.
3. **Strength-clamped (±25% at default strength 0.5).** A raw win rate can
   only nudge scores by `strength × (winRate − 0.5)`. The ML layer can never
   overturn a large deterministic edge on its own — it refines, it doesn't
   override. This is the same conservatism the bandit's cold-start
   Beta(1,1) sampling already guarantees.
4. **One learning pipeline, two views.** `recordOutcome()` feeds the bandit
   AND the ML router from the same outcome — no extra plumbing, no divergent
   attribution between the two learned layers, and both generalize in
   complementary dimensions (per-bucket vs per-task-features).
5. **Why pure hashing + cosine instead of real ML (FastGRNN/KNN)?** ruflo
   needs a Python runtime for its neural router; this package is
   zero-native-dependency by design (decision 12). FNV-1a hashing + cosine is
   sub-ms at 5000 records, deterministic across runs, fully offline, and
   needs no model download — it delivers the same "generalize across
   complexity buckets by task similarity" capability without the runtime.
6. **Why enforcement is opt-in, not default:** the bandit's per-bucket
   learning is mature and already shipped default-on; flipping enforcement on
   by default would change routing behavior for existing users overnight. The
   gate's job is discipline when the operator wants it (ruflo parity), not
   surprise.
7. **Why the gate blocks but never deletes learning:** a gated bandit keeps
   sampling and recording so the promotion criteria accumulate on real
   trajectories — the moment it crosses the +2% quality / <+1% cost / <+5%
   latency thresholds, enforcement lifts automatically.

**Live verification:** 13 new tests — 8 unit tests on the ML router
(deterministic hashing, similar-tasks-land-closer, complexity/intent tail,
cold-start neutrality, min-samples trust, strength clamp, persistence across
restart, reset) and 5 resolve-level integration tests (ML nudge changes the
pick with an `ml:` reason, cold-start no-op, gate blocks a failing bandit with
`routedBy: 'bandit-gated'`, gate allows with insufficient data, gate allows a
promoted bandit). Full suite: 4467/4467 green, typecheck clean.

---

## 36. Quota awareness is a veto filter, not a selector — the single resolve pipeline (v1.71.0)

**Observed (assessment question):** "we have an omni-route style quota-aware
router that makes a final selection — is that right?" A third-party (Copilot)
suggestion described a four-layer "Hybrid Dispatcher" — ML embeddings
front-end, routing gateway, resilience layer (quota ledger / fallback /
circuit breaker / context relay), analytics dashboard. Both prompted a code
audit to pin down, precisely, what role quota awareness plays in selection.

**Finding (verified against `src/learning/auto-router.ts`, `quota-ledger.ts`):**
quota awareness is a genuine, deep part of routing — but it is a **veto filter,
NOT a selection stage**. There is ONE integrated `resolve()` pipeline; the
layers stack in order:

1. Deterministic weighted scorer (cost/speed/quality/capability-fit/context-fit)
   + hard governance constraints (`maxCostUsd`, `minSpeed`, `minReasoning`,
   allow/deny lists)
2. Circuit-breaker cooldowns → `inCooldown`
3. Quota-ledger status (`getRouterQuotaStatus`) → exhausted providers
   `quotaParked`
4. Bandit learning (Thompson sampling, provider × complexity × intent)
5. Escalation + promotion-gate enforcement (decision 35)
6. ML task-similarity blend (decision 35)
7. **Final pick:** `scored.find(s => !s.inCooldown && !s.quotaParked) || scored[0]`

So quota EXCLUDES exhausted providers before the pick; the scorer/learning
selects among the healthy remainder. If every provider is parked, the
best-scored candidate is still chosen — degraded but functional, and the
orchestrator's failover runner then handles the actual call failure.

**Why filter-not-selector is the right design (reasoning):**
1. **Selection is a quality/cost judgment; quota is a constraint.** A selector
   must weigh quality vs cost vs latency — the scorer's job. Quota only says
   "this candidate is unavailable right now"; conflating the two would let a
   cheap-but-dead provider win on price alone, or let a parked one win by
   ignoring constraints. Separation keeps each layer single-purpose.
2. **Predictive, not reactive.** Because the ledger sinks parked providers
   BEFORE a call is attempted, we never waste a request on a dead provider —
   the omni-route philosophy. Reactive-only handling (try, fail, retry) is
   what the circuit breaker + failover exist for as the SECOND line.
3. **Calendar-aware, not arbitrary.** `rotateWindow` zeros counters exactly at
   the provider's real reset boundary (daily/hourly free tiers), so a parked
   provider auto re-enables the moment its quota returns — no fixed timers,
   no manual intervention.
4. **Multi-account rotation (M2.3)** is the escape hatch within the filter:
   when one KEY of a provider is exhausted, the ledger's `AccountState` lets
   failover rotate to another key of the SAME provider before switching
   providers — preserving continuity and often the free tier.

**External validation:** the Copilot "Hybrid Dispatcher" suggestion is
essentially a description of the architecture already built (ML scoring,
ledger + audit reasons, quota ledger + fallback + circuit breaker + context
relay, cost/token dashboards). The audit confirmed each layer exists in code;
the only open item is surfacing routing-accuracy + fallback-frequency metrics
on the web dashboard. Recorded in full in ROUTER_COMPARISON.md §8.
