# Assessment Opportunities — Agent-Nuvira Improvement Roadmap

> **Date:** 2026-08-02
> **Status:** All seven items are now **implemented** (see the Summary Verdict below
> for the live status of each). This document retains the original gap analysis for
> reference; the verdict column reflects current code.
> **Scope:** Gap analysis of Agent-Nuvira against a coding-assessment rubric focused on
> cost-efficient, quota-aware, resilient multi-model routing. Each item maps to the
> assessment's recommendations, the current state of the code, and the concrete
> implementation opportunity.

---

## Summary Verdict

| # | Assessment requirement | Agent-Nuvira today | Verdict |
|---|---|---|---|
| 1 | Subtasks labeled by complexity | Planner emits a `complexity` label per `TaskStep`; the orchestrator validates/labels any step missing one and threads it as `complexityHint` so each subtask routes by its OWN complexity | **✅ Implemented** |
| 2 | Cost-efficient tier routing (local→free→paid) | Tier ladder `local → free-quota cloud → paid` via quota-aware scoring + `routing.allowPaid` gate + Tier-0 $0 codemods; exhausted free providers sink predictively | **✅ Implemented** |
| 3 | Central quota ledger (tokens/model, reset windows, cooldown→auto re-enable) | `QuotaLedger` write-throughs every LLM call; calendar-aware reset windows auto re-enable parked providers at the exact reset boundary; persists to `~/.buff/memory/quota-ledger.json` | **✅ Implemented** |
| 4 | Fail gracefully mid-task (retry next best, never surface quota errors) | Quota-killed providers park in the ledger (persistent across sessions); chat failover walks ranked candidates; orchestrator never surfaces quota errors to the user | **✅ Implemented** |
| 5 | Prefer free/local; paid only when necessary/allowed | `routing.allowPaid: false` = free/local-only unless `complex`/`critical` or free tiers exhausted; every paid pick flagged in the routing explanation | **✅ Implemented** |
| 6 | Serialize intermediate state for cross-model resume | `--checkpoint` / `--resume [id]` / `--checkpoint-list` persist plan+context per batch to `~/.buff/memory/checkpoints/`; resume skips completed steps + planner and continues on the next-best provider | **✅ Implemented** |
| 7 | Transparency: models used, quota mgmt, failover + cost dashboards | Dashboard quota card (free vs paid tokens + estimated $ saved), `buff model quota` CLI cost summary, routing audit trail, bandit heatmap + promotion gate | **✅ Implemented** |

---

## Priority Order

> **All items shipped** (v1.44.0 → v1.45.2). Retained for the historical roadmap.

| Priority | Item | Unlocks | Effort | Status |
|---|---|---|---|---|
| **P0** | Central quota ledger (`src/learning/quota-ledger.ts`) | #3 fully; #2, #4, #5, #7 partially | Medium | ✅ v1.44.0 |
| **P0** | Per-subtask complexity labels (`TaskStep.complexity` from planner) | #1 fully; sharpens #2/#5 | Small | ✅ v1.44.0 |
| **P1** | Tier ladder + free-before-paid + `allowPaid` gate | #2/#5 fully | Medium | ✅ v1.44.0 |
| **P1** | Orchestrator session-exclusion ledger + reset-window cooldowns | #4 fully | Small–Medium | ✅ v1.44.0 |
| **P1** | Failover event log + "tokens saved" dashboard card | #7 fully | Small–Medium | ✅ v1.45.0 (dashboard card) + v1.45.2 (CLI cost summary) |
| **P2** | Checkpoint/resume (`buff run --resume`) | #6 | Large | ✅ v1.45.0 (+ v1.45.1 stale-resume fix) |

---

## Item-by-Item

### 1. Subtask decomposition & complexity labels — ✅ *Implemented (v1.44.0)*
- **Exists:** `PlannerAgent` emits ordered, dependency-aware `TaskStep` plans; `routingHints`
  carry execution strategy; `analyzeComplexity()` is called on **every** LLM call.
- **Gap (now closed):** The plan never said "this step is `simple`, that one is `complex`" —
  routing was goal-global on the first hop, not subtask-local.
- **Implemented:** Planner emits `complexity` per step; orchestrator validates/labels
  each step (deterministic fallback via `analyzeComplexity`); threaded as a
  `complexityHint` through `createAutoRoutedLLM` → `AutoModelRouter.resolve()`.

### 2. Tier ladder routing — ✅ *Implemented (v1.44.0)*
- **Exists:** `COMPLEXITY_WEIGHTS` shift cost/reasoning per complexity; free tiers price $0;
  Tier-0 handles mechanical edits for $0.
- **Gap (now closed):** No explicit `local → free-quota cloud → paid` ladder; a free-quota
  provider that is *currently exhausted* could still win a moderate task and fail over reactively.
- **Implemented:** Ledger-backed exhaustion excludes parked providers *before* scoring
  (same sink as circuit-breaker cooldown); `routing.allowPaid: false` gate restricts
  paid providers to `complex`/`critical` tasks.

### 3. Central quota ledger — ✅ *Implemented (v1.44.0, the keystone)*
- **Exists (nearby but not a ledger):** `CostTracker` (post-hoc $/tokens), `ProviderFallback`
  circuit breaker (failure-based 3/60s→120s), dashboard rate-limit header parsing.
- **Gap:** No persistent record of *"model X consumed N tokens in window W, resets at T"*;
  cooldown is a flat 120s, not calendar-aware.
- **Opportunity (P0 — implement):** `src/learning/quota-ledger.ts`
  - Per `provider|model` entries: `tokensConsumed`, `requests`, `windowStart`,
    `windowLengthMs`, `cooldownUntil`.
  - Write-through on every LLM call (hook `CostTracker.recordCall`, which all adapters use).
  - Reset windows from `routing.quota.<provider>.{requestsPerWindow,tokensPerWindow,windowMs}`;
    **auto re-enable when the window rolls** (calendar-aware, no arbitrary timers).
  - `isExhausted()` / `getBestAvailable()` / `getRouterQuotaStatus()` APIs consumed by the
    router, chat, orchestrator, CLI (`buff model quota`), and dashboard.

### 4. Fail gracefully — ✅ *Implemented (v1.44.0)*
- **Exists:** `classifyFallbackError` covers quota/token-limit/insufficient_quota; chat
  `sessionFailedProviders` (auth permanent / rate-limit 120s + re-admit); crash-proof catch
  blocks; orchestrator feeds the bandit.
- **Gap (now closed):** 120s cooldown was a guess, not the provider's reset window; the
  orchestrator path lacked a persistent ledger.
- **Implemented:** Quota-killed providers are parked in the central ledger until the window
  resets (persistent across sessions); the router skips them predictively.

### 5. Cost optimization — ✅ *Implemented (v1.44.0)*
- **Exists:** `cost-first` mode, $0 free-tier pricing, `routing.maxCostUsd` hard filter,
  cost-adjusted bandit rewards.
- **Gap (now closed):** No consent gate for paid usage; no "free exhausted → paid" escalation.
- **Implemented:** `routing.allowPaid: false` = "free/local only unless `complex`/`critical`
  or free tiers are exhausted"; every paid pick flagged in the routing explanation.

### 6. Intermediate-state serialization — ✅ *Implemented (v1.45.0)*
- **Exists:** `ContextVault.snapshot()` (structured clone) — Phase 2 never happened.
- **Implemented:** Persist plan+context per batch to `~/.buff/memory/checkpoints/`,
  `buff execute --checkpoint` / `--resume [id]` / `--checkpoint-list`; resume skips
  completed steps + the planner and continues on the next-best provider.

### 7. Transparency — ✅ *Implemented (v1.44.0 → v1.45.2)*
- **Exists:** Dashboard routing insights, bandit α/β heatmap, cost panel, routing usage,
  live quota coloring in Models panel.
- **Gap (now closed):** No failover event log, no "tokens saved / paid triggered" metrics.
- **Implemented:** Dashboard 📒 Quota card splits free vs paid tokens + estimated $ saved
  (v1.45.0); `buff model quota` CLI shows the same cost summary (v1.45.2); routing audit
  trail + failover transparency from the existing panels.

---

## Implementation Notes

- Ledger storage honors `BUFF_MEMORY_DIR` (same as the bandit) so CLI/chat/orchestrator/dashboard
  all read one file: `~/.buff/memory/quota-ledger.json`.
- All ledger writes are best-effort (`try/catch`) — a failed write must never break routing.
- Enforcement is **opt-in via config**: the ledger always *tracks*; it only *parks* providers
  when `routing.quota` limits are configured (or a failure parks them explicitly).
- New config keys:
  ```jsonc
  {
    "routing": {
      "bandit": true,
      "allowPaid": false,                          // paid only for complex/critical
      "quota": {
        "gemini": { "requestsPerWindow": 1500, "windowMs": 86400000 },  // 1500 req/day
        "groq":   { "requestsPerWindow": 14400, "windowMs": 86400000 }  // 14400 req/day
      }
    }
  }
  ```
