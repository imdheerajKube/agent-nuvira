# Assessment — RAG, routing honesty, and run-tracking (2026-10-05)

**Purpose.** A durable record of what was checked, on what evidence, and what
remains open — the thing a large execution should leave behind. Source of truth
for the claims below is the code in this repo and the live run store at
`~/.nuvira/memory/`, not recollection.

## 1. Does agent-nuvira have a RAG pipeline?

**Yes — a real, bespoke one (it does not use LangChain/LangGraph).**

| Piece | File | What it does |
|---|---|---|
| Embedder | `src/memory/embedder.ts` | 384-dim, tiered: `@huggingface/transformers` (all-MiniLM-L6-v2 default; `bge-small-en-v1.5` for retrieval) → Python sentence-transformers → LLM fallback |
| Vector store | `src/memory/vector-store.ts` | JSON / FAISS-style IVF / native FAISS backends; on-disk `~/.nuvira/memory/vectors*.json`; cosine search |
| Retrieval engine | `src/learning/retrieval.ts` | retrieval over code/docs/memory |
| CLI | `src/cli/retrieval.ts` (`nuvira retrieval`), `src/cli/memory.ts` | inspect/populate the store |
| Skill | bundled `rag-pipeline` (`.agents/skills/`, `skill-rag-pipeline`) | **instructions** for building a RAG pipeline in *your* project |

**So the honest answer to the user's question is two-sided.** The agent can do
semantic retrieval over its own memory/history/repo (that is a product feature),
and it ships a *skill* that tells it how to build a RAG pipeline for a user's
own data. What it does **not** have is a turnkey "point me at my health-report
folder and answer questions" workflow — that is a *build* task the agent must
actually execute.

**Why it produced instructions instead of doing the work.** See §3: when Auto's
floor relaxed, the turn fell through to `local/qwen2.5:0.5b` (a 0.5B toy). A
0.5B model can emit a plan about how to build RAG; it cannot build one. The
"gives instructions but does not do" behaviour is a *model-capability* artifact
of the weak fallback, not proof the harness lacks RAG.

## 2. Model-picker value — why Gemini reads lower than a small local model

The picker renders `provider/model · band (capability.toFixed(2))`, where the
number is `estimateModelCapability()` (`src/learning/model-capability.ts`,
served by `GET /api/chat/routable-models` in `src/web-dashboard/server.ts`).

That function is a **name heuristic**: it reads parameter counts (`120b`, `27b`,
`e4b`) and qualifier words. Two rules collide:

- `flash-lite | mini | nano | micro | tiny | small | lite | light | instant`
  → **0.40 (low)**. `gemini-3.1-flash-lite` matches → **0.40**.
- A name with **no** size/qualifier signal → neutral **0.55 (medium)**.
  `deepseek-coder:latest` matches → **0.55**; `gemma4:e4b` → 0.45; `qwen2.5:0.5b` → 0.30.

So `deepseek-coder:latest (0.55)` ranks **above** `gemini-3.1-flash-lite (0.40)`.
**The user's instinct is correct: this is misleading.** The heuristic's own
doc-comment says it exists **only to prevent a silent downgrade** ("a tie-break
layer used by `model-validator` when a DEAD pin must be repaired"), yet the
picker displays it to a human as if it were a capability *measurement*. It is
not: a modern cloud flash-lite is discounted to "low", and a local tag with no
size in its name coasts to "medium".

**Recommended fix (open):** do not surface the downgrade-guard heuristic as a
user-facing capability value — either label it explicitly as a name heuristic,
or use a real per-model capability source (the router already keeps per-provider
capability profiles) for the picker.

## 3. "No model available" — the turn that stopped

`src/web-dashboard/chat-retry.ts` publishes
`😔 Still no model available — I'll keep checking.` when a **deferred retry**
re-runs a previously failed turn and the re-run still reports
`generationFailed`. So the sequence is: a turn could not get a model → it was
queued and the dashboard was told → the retry was still starved.

The upstream cause is provider exhaustion (429/quota) with the router's
last-resort fallback to a **local** model. The live traces confirm the fallback
target:

| Trace | Goal (abridged) | Steps | Models | Recorded outcome |
|---|---|---|---|---|
| `trace-1791196824439-xeew3k` | "…WhatsApp … fetch LDL from health report with tag Dheeraj_Health_report…" | 2 | `gemini/gemini-3.1-flash-lite`, `local/qwen2.5:0.5b` | **failed** — `incomplete`, `undeliveredArtifact: true` |
| `trace-1791196949659-4jthfi` | "Continue where the previous turn stopped…" | 2 | `gemini/gemini-3.1-flash-lite`, `local/qwen2.5:0.5b` | success — `acted`, tool `plan_todo` |
| `trace-1791196988038-8u2bw8` | "Continue where the previous turn stopped…" | 1 | `local/qwen2.5:0.5b` | success — `answered`, no tools |

**Two things to note.** The honesty layer is *working* in at least one
direction: `xeew3k` was correctly recorded as **failed** with
`undeliveredArtifact` (the harness did not let a missing deliverable pass as
success). But `8u2bw8` is a **questionable success**: a "continue the work" turn
ran on a 0.5B local model with **no tools** and was marked `success: true`
having done nothing measurable — a false-success shape worth a guard.

**Root cause to close (open):** the last-resort fallback should not be a 0.5B
model for a continuing/large task, and a "continue" turn that ran no tools and
produced no artifact should not read as success.

## 4. Consent gate — verified by test (the ask-first weak-model rule)

Implemented in `src/learning/agentic-route-gate.ts` and wired in
`src/cli/chat.ts` (`assertAgenticRoute`, `setWeakModelConsent`,
`weakRouteNotice`). Governing rule: **never a silent weak model for an agentic
task** — interactive surfaces **ask once per session**; the persistent
`routing.weakModelPolicy` (default `ask`) governs surfaces that cannot ask
(gateway/headless).

Verified this session:

```
tests/learning/agentic-route-gate.test.ts  14 passed
tests/cli/agentic-consent-gate.test.ts      4 passed
```

**But** the gate is scoped to **agentic/software** tasks. The user's
health-report question is a *question/answer* turn, so the gate may not apply —
which is why it ran on a weak model without asking. Worth deciding whether
"fetch data from an attached document" should be classified agentic.

## 5. Run-tracking — does the agent keep a plan/log document?

**Partially, and not as a document.** What exists:

- `src/tools/plan-store.ts` (P0.7) — `plan_todo` create/update, rendered as a
  live checklist card in chat; persisted per **scope** to
  `~/.nuvira/memory/plans/<scope>.json` (JSON, not markdown).
- Bundled `plan-create-track` skill — instructs the model to plan + track.
- `~/.nuvira/memory/reasoning-traces.json` — per-turn trace (turns, tools,
  outcomes). This is machine JSON.

**The gap the user names is real:** nothing automatically writes a durable,
human-readable **plan / changelog / tracking document** for a large execution,
and a later turn re-hydrates "what we did" only from a session-scoped plan file,
the trace JSON, or the memory store — never from a project-level document. And
tracking only happens if the **model chooses** to call `plan_todo`; a model that
does not plan leaves no plan.

**Recommended fix (open):** for a large execution, write a project-level
`PLAN_<task>.md` + `EXECUTION_LOG_<task>.md` (findings → changes → verification →
closed/open), tracked in the repo, and re-hydrate from it at the start of the
next turn on the same scope.

## 6. Open items

| # | Item | Status |
|---|---|---|
| O1 | Picker surfaces the downgrade-guard heuristic as a capability value | **open** |
| O2 | Last-resort fallback = 0.5B local model for continuing/large tasks | **open** |
| O3 | "Continue" turn that ran no tools / produced no artifact reads as success | **open** |
| O4 | Agentic consent gate may not cover "read data from an attached document" | **open** |
| O5 | No automatic durable plan/changelog document per large execution | **open** |
| O6 | Windows CI: PDF/document-extract tests fail (`document-extract`, `tool-truthfulness`) | **open** |
| V1 | Consent gate tests green (18) | **closed** |
| V2 | `test-unix` CI fully green (Bun + ubuntu/macOS) | **closed** |

## 7. DeepSeek v4.1 for parity testing — recommendation

Yes, but as a **pinned, measured arm**, not a free-form switch:

1. **Pin it** (`-m` / `NUVIRA_STRICT_MODEL=1`) so a quota blip cannot silently
   drop the run to `qwen2.5:0.5b` and make the harness look worse than it is.
2. **Confirm served == requested** (watch for the `🔀 Model substituted` line).
3. **Run the same tasks** the parity comparison uses (WS7 seeded-bug suite, M2b)
   so model and harness are the only variables.
4. The free/weak fallbacks seen above are the dominant cause of the "instructions,
   not work" behaviour — paying for one strong model removes that confound and
   measures the **harness**, which is the point.
