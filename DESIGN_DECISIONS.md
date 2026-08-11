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
