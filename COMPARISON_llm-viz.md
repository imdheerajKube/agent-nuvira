# Comparison: `bbycroft/llm-viz` vs. agent-nuvira routing / model monitoring

> **Date:** 2026-08-04
> **Method:** `git clone --depth 1 https://github.com/bbycroft/llm-viz.git /tmp/llm-viz-compare`, then source-level inspection of both repos (llm-viz: Next.js/React/WebGPU/WASM rendering stack; agent-nuvira: `src/learning/*`, `src/inference/*`, `src/web-dashboard/*`).

---

## 1. Premise correction — what this repo actually is

`bbycroft/llm-viz` is **not** a provider/model token & availability manager. It is Brendan Bycroft's **homepage repository** containing the famous **3D interactive visualization of a GPT-style transformer running real inference in the browser**, plus a WIP CPU simulator and a fluid sim.

Verified from the source:

| Claim | Reality in `llm-viz` |
|---|---|
| Provider routing | ❌ None — zero code for provider selection, failover, or routing decisions |
| Token / quota accounting | ❌ None — no ledger, no reset windows, no rate-limit parking |
| Model availability monitoring | ❌ None — no health probes, no persistence, no model registry |
| What it *does* | ✅ Renders one tiny GPT (Karpathy's minGPT "nano", sorts A/B/C) with pre-baked weights, as an interactive 3D model at 60fps |

So on the **routing / monitoring axis there is nothing to compare** — agent-nuvira is in a different league by construction. But on the **visualization / dashboard axis** `llm-viz` is world-class, and that is where the transferable insights live (Section 5).

---

## 2. Stack vs. stack

| Dimension | **llm-viz** | **agent-nuvira** |
|---|---|---|
| Purpose | Visualize one LLM's internal mechanics | Route real traffic across 17+ providers |
| Frontend | Next.js 13 + React 18 + Tailwind / SCSS | Vite + React 18 + React Router + Recharts |
| Rendering | **Custom WebGPU compute + Odin→WASM** (`WebGpuMain.ts`, `gpt_model.odin`, `math.odin`, own `me_malloc` allocator); **hand-rolled 3D renderer** (no three.js): `modelRender.ts`, `blockRender.ts`, `threadRender.ts`, `triRender.ts`, `lineRender.ts`, `fontRender.ts`, `blurRender.ts`, `queryManager.ts`, `syncObjects.ts` | Charts + cards (`ModelsPanel`, `RoutingInsightsPanel`, `CostDashboard`, `DAGView`, `BenchmarkCharts`, `HealthPanel`) |
| Data source | Pre-baked `.dump` tensors; single model | Live FAISS/JSON model-registry, quota-ledger, cost-tracker, routing-history, event-bus |
| UX depth | 10-step guided **walkthrough**, **scrubbable phase timeline**, saved camera/phase state, inline annotations/commentary | Static snapshots + refresh button; rich routing insights panels |
| Engineering | Private repo, no CI, effectively no tests (only CPU-sim tests), personal project | npm-published CLI, 2,940 tests, GitHub Actions matrix (unix/windows), VS Code extension |

### llm-viz internals observed

- **Inference engine:** WebGPU compute shaders + Odin-compiled WASM (`gpt_model.odin`, `math.odin`, `me_malloc.odin` — a custom memory allocator) running actual forward passes with real weights.
- **Declarative layout:** `GptModelLayout.ts` / `IBlkDef` — the whole model topology is described declaratively (position, dims, opacity, highlight, deps, splits, transposes), keeping the renderer generic.
- **Phase timeline:** `PhaseTimeline.tsx` — draggable timeline where inference phases are rendered as blocks with start/duration; the caret scrubs time and pauses the run.
- **Guided walkthrough:** `src/llm/walkthrough/Walkthrough00_Intro.tsx … Walkthrough09_Output.tsx` — scripted narration with camera moves, highlights, and phase stepping (Intro → Prelim → Embedding → LayerNorm → SelfAttention → Softmax → Projection → MLP → Transformer → Output).
- **Saved state:** `SavedState.ts` — persists `{ phase, phaseTime, camera }` for shareable / restorable views.
- **Typography/rendering craft:** MSDF font atlases, custom font/texture render passes.

### agent-nuvira dashboard observed

- **Routes:** `/` Overview · `/dag` DAGView · `/history` HistoryBrowser · `/costs` CostDashboard · `/benchmarks` · `/memory` · `/system` HealthPanel · `/models` ModelsPanel · `/routing` RoutingInsightsPanel.
- **ModelsPanel:** per-provider cards with status badges (available / limited / unavailable), expandable model rows, aggregate progress bars, plus a RegistryCard view with per-model registry status and **remaining tokens**.
- **Server:** registry / health endpoints feeding the panel (added in the predictive-routing feature commit).

---

## 3. Strengths

| **llm-viz** | **agent-nuvira** |
|---|---|
| Visualizes *many moving parts* in real time — proves tens of thousands of nodes can be made legible at 60fps | Real routing intelligence: Thompson-sampling bandit, promotion gates (A/B), tier-0 / hybrid routers, routing rules, hard constraints, credential-aware filtering |
| Guided **walkthrough** of a complex machine (10 scripted steps: camera moves + highlights + narration) | Predictive health store: registry write-through from every command → dead providers skipped *before* the first call (shipped Aug 2026) |
| **Phase-timeline scrubbing** — drag through inference events as blocks with start/duration | Token accounting with calendar-aware reset windows + quota parking |
| **SavedState** — share / restore an exact view (phase + camera) | Real operational telemetry: latency, error classification, circuit breakers, cost tracking, benchmark suite |
| Declarative layout (`IBlkDef`) — topology described once, renderer-agnostic | Multi-platform CI + test discipline + a published, installable product |

---

## 4. Weaknesses

| **llm-viz** | **agent-nuvira** |
|---|---|
| A demo: single model, single machine, no real scale | Dashboard is **charts, not "moving parts"** — you cannot *watch* a routing decision or pipeline run happen |
| No routing / quota / availability logic whatsoever | **No explanation layer** — a routing decision is opaque ("why did the router pick local?") |
| No persistence, no operational concerns, no tests / CI | **No timeline scrubbing** — HistoryBrowser lists runs but cannot scrub one phase-by-phase |
| Private monolith mixing homepage + projects | **No deep-linkable view state**; dashboard refreshes by polling rather than animating live events |
| — | ModelsPanel is a card list — no spatial / side-by-side model comparison layout |

---

## 5. Actionable insights (worthy of porting)

1. **"Why did the router pick this?" walkthrough** — the single most transferable idea. A narrated, step-by-step playback of one routing decision (candidates → exclusions → scores → pick), styled like llm-viz's walkthrough, on `RoutingInsightsPanel`. The data already exists (`routing-history.ts`, scoring internals); the pattern is what's missing.
2. **Phase-timeline scrubber for pipeline runs** — reuse the event-bus timeline: scrub a run (plan → gather → write → review → test) with per-agent highlights. `PhaseTimeline.tsx`'s scrubbing pattern maps 1:1 onto our pipeline events.
3. **Live animated state instead of refresh-polling** — we already have SSE infra (`src/inference/sse.ts`) and the `MODEL_REGISTRY_UPDATED` event; push model-status changes to `ModelsPanel` and animate availability flips instead of requiring a manual refresh.
4. **Saved / deep-linkable dashboard state** — URL-encode the selected provider / model / registry view (llm-viz `SavedState` pattern) so a specific comparison is shareable.
5. **Inline annotations over the DAG** — layer llm-viz's "commentary" style directly onto `DAGView` to explain each agent's step in-place.

---

## 6. Bottom line

agent-nuvira **dwarfs** llm-viz on routing, monitoring, and availability management (llm-viz has none of these). But llm-viz's visualization craftsmanship — guided walkthrough, scrubbing timeline, live multi-node animation, saved state — is exactly the polish our dashboard lacks. Insights 1–5 above are cheap to port because the underlying data already exists in our event-bus, registry, and routing-history.
