# Assessment Opportunities — Agent-Nuvira Improvement Roadmap

> **Date:** 2026-08-02
> **Scope:** Gap analysis of Agent-Nuvira against a coding-assessment rubric focused on
> cost-efficient, quota-aware, resilient multi-model routing. Each item maps to the
> assessment's recommendations, the current state of the code, and the concrete
> implementation opportunity.

---

## Summary Verdict

| # | Assessment requirement | Agent-Nuvira today | Verdict |
|---|---|---|---|
| 1 | Subtasks labeled by complexity | Planner produces dependency-aware `TaskStep` plans; steps **do not carry a per-step complexity label** (complexity is re-derived per LLM call) | **Partial** |
| 2 | Cost-efficient tier routing (local→free→paid) | Complexity-weighted scoring exists; **no explicit tier ladder, no free-quota awareness** | **Partial** |
| 3 | Central quota ledger (tokens/model, reset windows, cooldown→auto re-enable) | Circuit breaker is failure-based; rate-limit headers parsed reactively in the dashboard only | **Missing — keystone** |
| 4 | Fail gracefully mid-task (retry next best, never surface quota errors) | Chat session failover (auth→session, rate-limit→120s re-admit) + shared circuit breaker | **Strong, extendable** |
| 5 | Prefer free/local; paid only when necessary/allowed | `cost-first` mode + $0 free-tier pricing; **no paid gate, no free-exhausted→paid escalation** | **Partial** |
| 6 | Serialize intermediate state for cross-model resume | `ContextVault.snapshot()` exists, "Phase 2 persistence" never built | **Missing** |
| 7 | Transparency: models used, quota mgmt, failover + cost dashboards | Dashboard routing/bandit/cost panels exist; **no quota card, no failover log, no tokens-saved metric** | **Partial** |

---

## Priority Order

| Priority | Item | Unlocks | Effort |
|---|---|---|---|
| **P0** | Central quota ledger (`src/learning/quota-ledger.ts`) | #3 fully; #2, #4, #5, #7 partially | Medium |
| **P0** | Per-subtask complexity labels (`TaskStep.complexity` from planner) | #1 fully; sharpens #2/#5 | Small |
| **P1** | Tier ladder + free-before-paid + `allowPaid` gate | #2/#5 fully | Medium |
| **P1** | Orchestrator session-exclusion ledger + reset-window cooldowns | #4 fully | Small–Medium |
| **P1** | Failover event log + "tokens saved" dashboard card | #7 fully | Small–Medium |
| **P2** | Checkpoint/resume (`buff run --resume`) | #6 | Large |

---

## Item-by-Item

### 1. Subtask decomposition & complexity labels — *Partial*
- **Exists:** `PlannerAgent` emits ordered, dependency-aware `TaskStep` plans; `routingHints`
  carry execution strategy; `analyzeComplexity()` is called on **every** LLM call.
- **Gap:** The plan never says "this step is `simple`, that one is `complex`" — routing is
  goal-global on the first hop, not subtask-local.
- **Opportunity (P0):** Planner emits `complexity` per step; orchestrator validates/labels
  each step (deterministic fallback via `analyzeComplexity`); thread it as a
  `complexityHint` through `createAutoRoutedLLM` → `AutoModelRouter.resolve()`.

### 2. Tier ladder routing — *Partial*
- **Exists:** `COMPLEXITY_WEIGHTS` shift cost/reasoning per complexity; free tiers price $0;
  Tier-0 handles mechanical edits for $0.
- **Gap:** No explicit `local → free-quota cloud → paid` ladder; a free-quota provider that is
  *currently exhausted* can still win a moderate task and fail over reactively.
- **Opportunity (P0/P1):** Ledger-backed exhaustion excludes parked providers *before* scoring
  (same sink as circuit-breaker cooldown); optional `routing.allowPaid: false` gate restricts
  paid providers to `complex`/`critical` tasks.

### 3. Central quota ledger — **MISSING (keystone)**
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

### 4. Fail gracefully — *Strong today, one extension*
- **Exists:** `classifyFallbackError` covers quota/token-limit/insufficient_quota; chat
  `sessionFailedProviders` (auth permanent / rate-limit 120s + re-admit); crash-proof catch
  blocks; orchestrator feeds the bandit.
- **Gap:** 120s cooldown is a guess, not the provider's reset window; orchestrator path lacks
  a session ledger.
- **Opportunity (P1):** Park quota-killed providers in the ledger until the window resets
  (persistent across sessions); the router then skips them predictively.

### 5. Cost optimization — *Partial*
- **Exists:** `cost-first` mode, $0 free-tier pricing, `routing.maxCostUsd` hard filter,
  cost-adjusted bandit rewards.
- **Gap:** No consent gate for paid usage; no "free exhausted → paid" escalation.
- **Opportunity (P1):** `routing.allowPaid: false` = "free/local only unless `complex`/`critical`
  or free tiers are exhausted"; every paid pick flagged in the routing explanation.

### 6. Intermediate-state serialization — **MISSING**
- **Exists:** `ContextVault.snapshot()` (structured clone) — Phase 2 never happened.
- **Opportunity (P2):** Persist plan+context per run to `~/.buff/memory/runs/<id>/checkpoint.json`,
  add `buff run --resume <id>`, restart only pending/failed subtasks on the next-best provider.

### 7. Transparency — *Partial*
- **Exists:** Dashboard routing insights, bandit α/β heatmap, cost panel, routing usage,
  live quota coloring in Models panel.
- **Gap:** No failover event log, no "tokens saved / paid triggered" metrics.
- **Opportunity (P1):** Quota ledger emits exhaustion/cooldown/re-enable events →
  `quota-events.jsonl` → Failover Timeline + "You saved $X on free/local" card.

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
