# `buff model explain` — A Walkthrough of One Routing Decision

> v1.58.0 demo — the Nuvira-Router P2 chips: **🎯 capability fit**, **📏 measured
> wire-token cost**, and **⏳ context preflight** on every ranked row.

`buff model explain` shows *why* Auto routing would pick a provider/model for a
task — before you spend a single token. In v1.58.0 it also answers three new
questions that used to be invisible:

1. **Does the provider's capability profile fit this task type?** (`🎯 fit N%`)
2. **Is cost scored from real wire tokens or an estimate?** (`📏 measured` vs `📐 estimated`)
3. **Does the prompt fit inside the provider's context window?** (`⏳ ctx N%`)

---

## 1. The command

```bash
buff model explain "implement JWT authentication with refresh tokens"
```

Single task → one detailed decision. No task → all five complexity samples
(trivial → critical) so you can compare at a glance:

```bash
buff model explain                     # walks 5 sample complexities
buff model explain --agent writer "…"  # route for a specific agent
buff model explain "…" --json          # machine-readable (scripting/CI)
```

---

## 2. A real decision, narrated

```
═══  Auto Model Routing — Explain  ═══

Task: "implement JWT authentication with refresh tokens"  ·  Agent: chat

  Complexity: moderate  ·  Task type: code
```

### Step 1 — What does this task type care about?

```
  ── Dimension weights ──
   reasoning     ████████████░░░░░░░░ 60%
   speed         ████░░░░░░░░░░░░░░░░ 20%
   cost          ██░░░░░░░░░░░░░░░░░░ 10%
   privacy       ██░░░░░░░░░░░░░░░░░░ 10%
   reliability   █████░░░░░░░░░░░░░░░ 25%
```

Moderate-complexity code work weights **reasoning** hardest, with **reliability**
second. That ordering is what the dimension scores below are multiplied against.

### Step 2 — The ranked candidates (with the new chips)

```
  ── Ranked providers ──
   ✅ 1. gemini      score 0.870  strong reasoning + speed, good for complex work  🎯 fit 85% 📏 measured 12,480→3,110 tok  ⏳ ctx 3% (1,048,576 tok)
      2. nim         score 0.742  strong reasoning, reasonable cost                🎯 fit 72% 📏 measured 12,480→3,110 tok  ⏳ ctx 12% (131,072 tok)
      3. groq        score 0.698  fast + free, moderate reasoning                  🎯 fit 48% 📐 estimated                     ⏳ ctx 9% (131,072 tok)
      4. local       score 0.605  private + free, modest reasoning                 🎯 fit 31% 📐 estimated                     ⏳ ctx 41% (32,768 tok)
```

Reading the chips row by row:

| Chip | What it means here |
|---|---|
| `🎯 fit 85%` | Gemini's real capability profile (code + reasoning tags) matches the `code` task type well. Local gets `31%` — its profile is honest about modest reasoning. |
| `📏 measured 12,480→3,110 tok` | Gemini and NIM reported their **actual** usage on recent calls (provider `usage` from the response body / final SSE chunk). Cost was scored from real tokens, not the 2,000/500 default. |
| `📐 estimated` | Groq and local haven't reported wire usage yet (or their adapters don't return `usage`), so cost falls back to the length-based estimate — flagged honestly, never silently mixed. |
| `⏳ ctx 3% (1,048,576 tok)` | Gemini's 1M nominal window vs. the ~16K estimated prompt → 3% utilization, i.e. zero pressure. Local at 41% on a 32K window is still comfortable, but the signal is visible. |

### Step 3 — The decision

```
  Decision: gemini/gemini-2.0-flash-exp
  Gemini ranks first on reasoning + reliability for a moderate code task, and its
  1M context window makes it safe for the current conversation length.
```

### Step 4 — Context preflight, made auditable

```
  ── Context preflight (M2.5, estimation only) ──
   Estimated prompt: 15,920 tokens (basis: caller-provided payload)
   gemini       window 1,048,576 tok · utilization 2% · context-fit 100%
   nim          window 131,072 tok    · utilization 12% · context-fit 88%
   groq         window 131,072 tok    · utilization 12% · context-fit 88%
   local        window 32,768 tok     · utilization 49% · context-fit 51%
   (estimation only — models may exceed nominal windows; never a hard block)
```

Because `buff chat` passes the **real** growing conversation length (and
`buff plan` / `buff execute` pass real per-task payload estimates), the router
knows the prompt is ~16K tokens. Everyone fits easily today — but imagine the
same task inside a **500K-token conversation**: local's 49% would become
>100%, the soft penalty (capped at 35%) would sink it below big-window
providers, and the pick would flip to Gemini automatically.

### Step 5 — The fallback chain

```
  ── Fallback chain ──
   → nim/nvidia-nim-llama3.1-70b   (fallback: switch to NVIDIA NIM)
   → groq/llama-3.3-70b-versatile  (fallback: switch to Groq)
   → local/llama3.2                (final fallback: offline)
```

If Gemini dies mid-session (rate limit, expired key, quota park), the chain
holds the next-best options with their own reasons.

---

## 3. The same decision as JSON (`--json`)

For CI / scripting, the important new fields:

```json
{
  "task": "implement JWT authentication with refresh tokens",
  "agentType": "chat",
  "complexity": "moderate",
  "taskType": "code",
  "winner": { "provider": "gemini", "model": "gemini-2.0-flash-exp", "score": 0.87 },
  "ranked": [
    {
      "provider": "gemini",
      "score": 0.87,
      "reason": "strong reasoning + speed, good for complex work",
      "capabilityFit": 0.85,
      "costSource": "measured",
      "costBasis": { "inputTokens": 12480, "outputTokens": 3110 }
    }
  ],
  "context": {
    "estimatedPromptTokens": 15920,
    "basis": "hint",
    "providers": [
      { "provider": "gemini", "contextWindowTokens": 1048576, "utilization": 0.02, "fit": 1.0 }
    ]
  },
  "governanceBlocked": [],
  "pricing": {
    "gemini": { "inputPer1K": 0, "outputPer1K": 0, "overridden": false }
  }
}
```

---

## 4. When policy gets in the way (M2.4)

If your admin policy blocks a provider, it's **eliminated, then shown** — never
silently missing:

```
  ── Governance policy — eliminated providers ──
   ⛔ openrouter: denied by admin policy (governance.denyProviders)
   ⛔ groq: denied by admin policy (governance.denyProviders)
```

And if governance eliminates *everything*, the router refuses to serve a policy
violator:

```
  ⛔ PIIPolicyError: task matches piiPatterns; only providers with privacy >= 1.0 may handle it
     • openrouter — privacy 0.10 below required 1.00 (PII policy)
     • groq — privacy 0.15 below required 1.00 (PII policy)
```

(`--json` emits the same as a structured error object instead of crashing.)

---

## 5. Tying the chips to their gates

| Chip / signal | Config gate | Default | Effect when OFF |
|---|---|---|---|
| `🎯 fit` | `routing.capabilityFit` | ON | Pure dimension-weight scoring, no task-type nudge |
| `⏳ ctx` | `routing.contextFit` | ON | Context-window signal removed entirely (no `⏳` chips, no preflight section) |
| `📏 measured` | n/a (auto) | measured-when-available | Providers without `usage` reporting stay on `📐 estimated` |

---

## 6. Try it

```bash
npm install -g agent-nuvira        # 1.58.0+
buff model switch auto             # enable Auto routing
buff model explain                 # walk all 5 complexity samples
buff model explain "design a distributed event-driven microservices architecture"
buff model explain "your task" --json | jq '.ranked[] | {provider, capabilityFit, costSource, costBasis}'
```
