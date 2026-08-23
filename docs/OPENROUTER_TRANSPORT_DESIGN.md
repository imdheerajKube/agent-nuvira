# OpenRouter Transport Layer — Design Document

## Status: DESIGN ONLY — Not implemented yet

## Overview

This document describes how OpenRouter could be used as an optional transport layer
for agent-nuvira, providing access to 100+ models from 10+ providers.

**Key insight:** OpenRouter is a TRANSPORT layer (proxy), not an INTELLIGENCE layer.
Our auto-router is the intelligence. They complement each other.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                 INTEGRATED ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              INTELLIGENCE LAYER (Our Router)            │   │
│  │  • Task analysis (complexity, intent, privacy)         │   │
│  │  • ML-based model selection (5 dimensions)             │   │
│  │  • Thompson sampling exploration                       │   │
│  │  • Budget enforcement                                  │   │
│  │  • Cross-pipeline failure memory                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                           ↓                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              TRANSPORT LAYER (Optional)                 │   │
│  │                                                         │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │   │
│  │  │ Direct API   │  │ OpenRouter   │  │ Custom       │ │   │
│  │  │ (default)    │  │ (optional)   │  │ Gateway      │ │   │
│  │  │              │  │              │  │ (optional)   │ │   │
│  │  │ • Groq       │  │ • 100+ models│  │ • Enterprise │ │   │
│  │  │ • Gemini     │  │ • Auto       │  │ • Self-hosted│ │   │
│  │  │ • NIM        │  │   fallback   │  │ • Private    │ │   │
│  │  │ • Local      │  │ • Rate limit │  │              │ │   │
│  │  │ • OpenRouter │  │   handling   │  │              │ │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘ │   │
│  │                                                         │   │
│  │  User chooses which transport to use via config:       │   │
│  │  routing.transport = "direct" | "openrouter" | "custom"│   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## How It Would Work

### 1. Configuration

```json
// .nuvira/config.json
{
  "routing": {
    "transport": "openrouter",  // or "direct" (default)
    "openrouter": {
      "apiKey": "sk-or-v1-...",
      "baseUrl": "https://openrouter.ai/api/v1",
      "fallbackToDirect": true  // If OpenRouter fails, try direct API
    }
  }
}
```

### 2. Transport Selection Logic

```typescript
// Pseudocode for transport selection
function selectTransport(provider: string, model: string): Transport {
  const config = getConfig();

  // 1. User explicitly chose direct — use it
  if (config.routing.transport === 'direct') {
    return new DirectTransport(provider);
  }

  // 2. User chose OpenRouter — route through it
  if (config.routing.transport === 'openrouter') {
    return new OpenRouterTransport(config.routing.openrouter);
  }

  // 3. Default: direct API (current behavior)
  return new DirectTransport(provider);
}
```

### 3. OpenRouter Transport Implementation

```typescript
class OpenRouterTransport implements Transport {
  private apiKey: string;
  private baseUrl: string;

  async call(prompt: string, model: string): Promise<string> {
    // OpenRouter uses OpenAI-compatible API
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,  // e.g., "anthropic/claude-3.5-sonnet"
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    return data.choices[0].message.content;
  }
}
```

## What We Gain

| Feature | Without OpenRouter | With OpenRouter |
|---------|-------------------|-----------------|
| **Model catalog** | ~20 models (direct APIs) | 100+ models |
| **Provider diversity** | 5-6 providers | 10+ providers |
| **Automatic fallback** | Manual (our router) | Built-in |
| **Rate limit handling** | Our auto-switch | Built-in |
| **Cost optimization** | Per-provider | Cross-provider |

## What We Keep

| Feature | Status |
|---------|--------|
| **Intelligent routing** | ✅ Unchanged — our router still decides |
| **Task analysis** | ✅ Unchanged — 5-dimension scoring |
| **Learning** | ✅ Unchanged — Thompson bandit + ML |
| **Privacy routing** | ✅ Unchanged — local-first option |
| **Cross-pipeline memory** | ✅ Unchanged — persisted failures |

## Implementation Phases (Future)

### Phase 1: Basic Integration (1 week, ~200 lines)
- Add `routing.transport` config option
- Create `OpenRouterTransport` class
- Wire into `ProviderFactory.createProvider()`
- Add `OPENROUTER_API_KEY` to env detection

### Phase 2: Dynamic Model Discovery (1 week, ~150 lines)
- Call OpenRouter `/models` endpoint
- Auto-register discovered models into routing pool
- Update model catalog with OpenRouter models

### Phase 3: Cost Optimization (1 week, ~100 lines)
- Compare prices across OpenRouter vs direct API
- Route to cheapest option for same model
- Track cost savings in dashboard

### Phase 4: Fallback Orchestration (1 week, ~100 lines)
- If OpenRouter fails, fall back to direct API
- If direct API fails, fall back to OpenRouter
- Automatic failover between transport layers

## Decision Criteria

**Implement OpenRouter transport when:**
1. Users need access to models we don't directly support (Cohere, AI21, etc.)
2. Users want automatic failover across 100+ models
3. Users are willing to pay OpenRouter's markup (if any)

**Don't implement when:**
1. Current direct API coverage is sufficient
2. Users prefer privacy (direct API = no third-party)
3. Cost is a concern (OpenRouter may add markup)

## Current Status

- ✅ OpenRouter adapter exists (`src/inference/openrouter-adapter.ts`)
- ✅ OpenRouter is a first-class provider in the factory
- ✅ Auto-router already routes to OpenRouter when it scores highest
- ❌ OpenRouter transport layer (proxy all requests) — NOT implemented
- ❌ Dynamic model discovery from OpenRouter — NOT implemented
- ❌ Cross-provider cost optimization — NOT implemented

## Recommendation

**Keep OpenRouter as an optional provider, not a mandatory transport.**

Reasons:
1. Our routing is more sophisticated than OpenRouter's
2. Direct API is more private (no third-party)
3. Users can already use OpenRouter by setting `OPENROUTER_API_KEY`
4. Adding a transport layer adds complexity without clear benefit for most users

**Future consideration:** If users frequently need models we don't support,
implement Phase 1 (basic integration) as an opt-in feature.
