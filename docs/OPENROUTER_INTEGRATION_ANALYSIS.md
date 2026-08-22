# OpenRouter Integration Analysis — Agent-Nuvira

**Author:** Dheeraj Sharma <imdheeraj@gmail.com>  
**Date:** August 22, 2026  
**Status:** Analysis Complete — Awaiting Approval

---

## Executive Summary

Agent-Nuvira already has **OpenRouter as a registered provider** in the provider catalog. The integration is **functional but basic** — we can route to OpenRouter, but lack advanced features like automatic model discovery, cost optimization, and fallback orchestration.

### Current State

| Feature | Our Status | OpenRouter Provides | Gap |
|---------|------------|---------------------|-----|
| **Basic Routing** | ✅ Works | ✅ | PARITY |
| **Model Discovery** | ❌ Static catalog | ✅ Dynamic API | **GAP** |
| **Cost Optimization** | ⚠️ Basic | ✅ Real-time pricing | **GAP** |
| **Fallback Orchestration** | ⚠️ Manual | ✅ Automatic | **GAP** |
| **Rate Limit Handling** | ❌ None | ✅ Built-in | **GAP** |
| **Usage Analytics** | ⚠️ Basic | ✅ Dashboard | **GAP** |
| **Model Comparison** | ❌ None | ✅ Side-by-side | **GAP** |

### Key Insight

**Our router is MORE SOPHISTICATED** than OpenRouter for intelligent model selection:
- We have ML-based task similarity routing
- We have Thompson sampling exploration/exploitation
- We have 5-dimensional scoring (reasoning, speed, cost, privacy, reliability)
- We have complexity-based model selection

**OpenRouter is BETTER** for API access:
- 100+ models from 10+ providers
- Unified API interface
- Automatic fallback
- Rate limiting

**They COMPLEMENT each other** — not compete.

---

## Architecture Comparison

### Our Router Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    AGENT-NUVIRA ROUTING                        │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1: Task Analysis (complexity, intent, privacy)          │
│ Layer 2: ML Router (task similarity, cosine matching)         │
│ Layer 3: Thompson Bandit (exploration/exploitation)           │
│ Layer 4: Auto Router (5 dimensions: reasoning/speed/cost/    │
│          privacy/reliability)                                  │
│ Layer 5: Fallback Chains (circuit breaker, cooldown)          │
│ Layer 6: Cost Tracker (budget enforcement)                    │
├─────────────────────────────────────────────────────────────────┤
│ Strengths:                                                     │
│ ✅ Intelligent model selection                                 │
│ ✅ Privacy-aware routing                                       │
│ ✅ Complexity-based selection                                  │
│ ✅ Budget enforcement                                          │
│ Weaknesses:                                                    │
│ ❌ Limited model catalog (~20 models)                         │
│ ❌ No automatic fallback                                       │
│ ❌ No rate limit handling                                      │
└─────────────────────────────────────────────────────────────────┘
```

### OpenRouter Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    OPENROUTER ROUTING                          │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1: API Gateway (100+ models from 10+ providers)         │
│ Layer 2: Rate Limiting (per-key, per-model)                   │
│ Layer 3: Fallback (automatic retry on failure)                │
│ Layer 4: Cost Optimization (cheapest provider)                │
├─────────────────────────────────────────────────────────────────┤
│ Strengths:                                                     │
│ ✅ Massive model catalog                                       │
│ ✅ Automatic fallback                                          │
│ ✅ Rate limit handling                                         │
│ ✅ Cost optimization                                           │
│ Weaknesses:                                                    │
│ ❌ No intelligent selection                                    │
│ ❌ No privacy awareness                                        │
│ ❌ No complexity-based routing                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Integrated Architecture (Best of Both)

```
┌─────────────────────────────────────────────────────────────────┐
│                 INTEGRATED ROUTING ARCHITECTURE                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              INTELLIGENCE LAYER (Our Router)            │   │
│  │  • Task analysis (complexity, intent, privacy)         │   │
│  │  • ML-based model selection                            │   │
│  │  • Thompson sampling exploration                       │   │
│  │  • 5-dimensional scoring                               │   │
│  │  • Budget enforcement                                  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                           ↓                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              TRANSPORT LAYER (OpenRouter)               │   │
│  │  • 100+ model catalog                                   │   │
│  │  • Automatic fallback                                   │   │
│  │  • Rate limit handling                                  │   │
│  │  • Cost optimization                                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Result: Best of both worlds                                   │
│  • Intelligent selection + Massive catalog                     │
│  • Privacy awareness + Automatic fallback                      │
│  • Complexity routing + Rate limit handling                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Integration Options

### Option 1: OpenRouter as Transport Layer (Recommended)

**How it works:**
1. Our router decides WHICH model to use (e.g., "Claude 3.5 Sonnet")
2. OpenRouter provides API access to that model
3. We get automatic fallback and rate limit handling

**Pros:**
- Best of both worlds
- Minimal code changes
- Full control over routing logic

**Cons:**
- Requires OpenRouter API key
- Adds latency (one more hop)
- Costs money (OpenRouter takes a cut)

**Effort:** 1 week

### Option 2: OpenRouter as Primary Router

**How it works:**
1. OpenRouter decides which model to use
2. We bypass our router entirely
3. We lose intelligent selection

**Pros:**
- Simple implementation
- Access to 100+ models

**Cons:**
- Lose intelligent routing
- Lose privacy awareness
- Lose complexity-based selection

**Effort:** 3 days (not recommended)

### Option 3: Hybrid Mode (User Choice)

**How it works:**
1. User chooses: "Use our router" OR "Use OpenRouter"
2. We respect user preference
3. Both modes available

**Pros:**
- User flexibility
- Best of both worlds
- No forced changes

**Cons:**
- More complex UI
- Requires user education

**Effort:** 2 weeks

---

## Recommended Approach: Option 1 (OpenRouter as Transport Layer)

### Implementation Plan

#### Phase 1: Basic Integration (Week 1)

**Goal:** Route through OpenRouter when API key is present

```typescript
// src/inference/openrouter-transport.ts
export class OpenRouterTransport {
  private client: OpenRouterClient;

  constructor(apiKey: string) {
    this.client = new OpenRouterClient({ apiKey });
  }

  // Route a request through OpenRouter
  async route(request: LLMRequest): Promise<LLMResponse> {
    // 1. Map our model name to OpenRouter format
    const openrouterModel = this.mapModel(request.model);

    // 2. Send through OpenRouter
    const response = await this.client.chat(request.messages, {
      model: openrouterModel,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
    });

    // 3. Map response back to our format
    return this.mapResponse(response);
  }

  // Map our model names to OpenRouter format
  private mapModel(model: string): string {
    const mapping: Record<string, string> = {
      'claude-3.5-sonnet': 'anthropic/claude-3.5-sonnet',
      'claude-3-opus': 'anthropic/claude-3-opus',
      'gpt-4o': 'openai/gpt-4o',
      'gpt-4-turbo': 'openai/gpt-4-turbo',
      'gemini-pro': 'google/gemini-pro',
      'llama-3-70b': 'meta-llama/llama-3-70b',
      // ... etc
    };
    return mapping[model] || model;
  }
}
```

**Deliverables:**
- `src/inference/openrouter-transport.ts` (200 lines)
- Integration with existing router
- Tests

**Effort:** 3 days

#### Phase 2: Dynamic Model Discovery (Week 2)

**Goal:** Auto-discover available models from OpenRouter

```typescript
// src/inference/model-discovery.ts
export class ModelDiscovery {
  private client: OpenRouterClient;
  private cache: Map<string, ModelInfo[]> = new Map();
  private cacheExpiry = 3600_000; // 1 hour

  // Fetch available models from OpenRouter
  async discover(): Promise<ModelInfo[]> {
    const cached = this.cache.get('models');
    if (cached && Date.now() - (cached as any).timestamp < this.cacheExpiry) {
      return cached;
    }

    const models = await this.client.listModels();
    this.cache.set('models', models as any);
    return models;
  }

  // Get models by provider
  async getModelsByProvider(provider: string): Promise<ModelInfo[]> {
    const all = await this.discover();
    return all.filter(m => m.provider === provider);
  }

  // Get cheapest model for a task
  async getCheapest(task: string): Promise<ModelInfo> {
    const all = await this.discover();
    // Sort by cost, return cheapest
    return all.sort((a, b) => a.pricing.prompt - b.pricing.prompt)[0];
  }

  // Get best model for a task
  async getBest(task: string, dimensions: string[]): Promise<ModelInfo> {
    const all = await this.discover();
    // Score each model based on dimensions
    // Return best match
    return all[0]; // Simplified
  }
}
```

**Deliverables:**
- `src/inference/model-discovery.ts` (300 lines)
- Cache management
- Tests

**Effort:** 4 days

#### Phase 3: Cost Optimization (Week 3)

**Goal:** Automatically route to cheapest provider

```typescript
// src/inference/cost-optimizer.ts
export class CostOptimizer {
  private discovery: ModelDiscovery;
  private budget: BudgetTracker;

  // Find cheapest model that meets requirements
  async optimize(request: LLMRequest): Promise<string> {
    const models = await this.discovery.discover();

    // Filter by requirements
    const eligible = models.filter(m =>
      m.context_length >= request.contextLength &&
      m.pricing.prompt <= this.budget.maxCostPerToken
    );

    // Sort by cost
    eligible.sort((a, b) => {
      const costA = a.pricing.prompt * request.estimatedTokens;
      const costB = b.pricing.prompt * request.estimatedTokens;
      return costA - costB;
    });

    return eligible[0]?.id || request.model;
  }

  // Get cost estimate for a request
  async estimateCost(model: string, tokens: number): Promise<number> {
    const info = await this.discovery.discover();
    const m = info.find(i => i.id === model);
    if (!m) return 0;
    return m.pricing.prompt * tokens;
  }
}
```

**Deliverables:**
- `src/inference/cost-optimizer.ts` (250 lines)
- Budget tracking integration
- Tests

**Effort:** 3 days

#### Phase 4: Fallback Orchestration (Week 4)

**Goal:** Automatic fallback on failure

```typescript
// src/inference/fallback-orchestrator.ts
export class FallbackOrchestrator {
  private transport: OpenRouterTransport;
  private circuitBreaker: CircuitBreaker;

  // Execute with automatic fallback
  async execute(request: LLMRequest): Promise<LLMResponse> {
    const models = await this.getFallbackChain(request.model);

    for (const model of models) {
      try {
        const response = await this.transport.route({
          ...request,
          model,
        });
        return response;
      } catch (error) {
        if (this.isRateLimit(error)) {
          // Try next model
          continue;
        }
        if (this.isAuthError(error)) {
          // Don't retry auth errors
          throw error;
        }
        // Other errors, try next model
        continue;
      }
    }

    throw new Error('All models in fallback chain failed');
  }

  // Get fallback chain for a model
  private async getFallbackChain(model: string): Promise<string[]> {
    // OpenRouter automatically handles fallback
    // We just need to specify multiple models
    return [model]; // Simplified
  }
}
```

**Deliverables:**
- `src/inference/fallback-orchestrator.ts` (200 lines)
- Circuit breaker integration
- Tests

**Effort:** 3 days

---

## Integration Points

### 1. Router Integration

```typescript
// src/learning/auto-router.ts
// Add OpenRouter as transport option

export class AutoRouter {
  private transport: Transport;

  constructor() {
    // Choose transport based on config
    if (process.env.OPENROUTER_API_KEY) {
      this.transport = new OpenRouterTransport(process.env.OPENROUTER_API_KEY);
    } else {
      this.transport = new DirectTransport();
    }
  }

  async resolve(task: string): Promise<RoutingDecision> {
    // 1. Decide which model to use (our intelligence)
    const model = await this.selectModel(task);

    // 2. Route through transport (OpenRouter or direct)
    const response = await this.transport.route({
      model,
      messages: task.messages,
    });

    return response;
  }
}
```

### 2. Provider Catalog Integration

```typescript
// src/inference/provider-catalog.ts
// Add OpenRouter as dynamic provider

export const PROVIDER_CATALOG: Record<string, CatalogProviderEntry> = {
  // ... existing providers ...

  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    icon: '🌐',
    envVar: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    openAICompat: true,
    capabilities: {
      reasoning: 0.95,
      speed: 0.55,
      cost: 0.15,
      privacy: 0.10,
      reliability: 0.78,
    },
    pricing: {
      inputPer1K: 0.00250,
      outputPer1K: 0.01000,
    },
    contextWindow: 200_000,
  },
};
```

### 3. Cost Tracker Integration

```typescript
// src/inference/cost-tracker.ts
// Track OpenRouter costs separately

export class CostTracker {
  private costs: Map<string, number> = new Map();

  // Track cost for a request
  track(model: string, tokens: number, cost: number): void {
    const key = `openrouter:${model}`;
    const current = this.costs.get(key) || 0;
    this.costs.set(key, current + cost);
  }

  // Get total OpenRouter cost
  getOpenRouterCost(): number {
    let total = 0;
    for (const [key, cost] of this.costs) {
      if (key.startsWith('openrouter:')) {
        total += cost;
      }
    }
    return total;
  }
}
```

---

## Pricing Comparison

### OpenRouter Pricing (approximate)

| Model | Input (per 1K tokens) | Output (per 1K tokens) |
|-------|----------------------|------------------------|
| Claude 3.5 Sonnet | $0.00300 | $0.01500 |
| GPT-4o | $0.00250 | $0.01000 |
| Gemini Pro | $0.00025 | $0.00050 |
| Llama 3 70B | $0.00059 | $0.00079 |
| Mixtral | $0.00060 | $0.00060 |

### Our Direct Pricing (approximate)

| Model | Input (per 1K tokens) | Output (per 1K tokens) |
|-------|----------------------|------------------------|
| Claude 3.5 Sonnet | $0.00300 | $0.01500 |
| GPT-4o | $0.00250 | $0.01000 |
| Gemini Pro | $0.00025 | $0.00050 |
| Llama 3 70B | $0.00059 | $0.00079 |

**Note:** OpenRouter adds ~5-10% markup on top of provider pricing.

### Cost Optimization Strategy

1. **Use direct API** for high-volume models (Claude, GPT-4)
2. **Use OpenRouter** for:
   - Rarely-used models
   - Fallback scenarios
   - Rate limit bypass
   - Quick prototyping

---

## Implementation Roadmap

```
┌─────────────────────────────────────────────────────────────────┐
│                 OPENROUTER INTEGRATION ROADMAP                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Phase 1: Basic Integration (Week 1)                           │
│  ├── Day 1-2: OpenRouter transport layer                       │
│  ├── Day 3: Model name mapping                                 │
│  └── Day 4-5: Tests + documentation                            │
│                                                                 │
│  Phase 2: Dynamic Model Discovery (Week 2)                     │
│  ├── Day 1-3: Model discovery API                              │
│  ├── Day 4: Cache management                                   │
│  └── Day 5: Tests                                              │
│                                                                 │
│  Phase 3: Cost Optimization (Week 3)                           │
│  ├── Day 1-2: Cost optimizer                                   │
│  ├── Day 3: Budget integration                                 │
│  └── Day 4-5: Tests                                            │
│                                                                 │
│  Phase 4: Fallback Orchestration (Week 4)                      │
│  ├── Day 1-2: Fallback chain                                   │
│  ├── Day 3: Circuit breaker                                    │
│  └── Day 4-5: Tests + documentation                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Timeline

| Phase | Duration | Effort | Impact |
|-------|----------|--------|--------|
| **Phase 1** | Week 1 | 450 lines | HIGH |
| **Phase 2** | Week 2 | 300 lines | MEDIUM |
| **Phase 3** | Week 3 | 250 lines | MEDIUM |
| **Phase 4** | Week 4 | 200 lines | LOW |
| **Total** | 4 weeks | 1,200 lines | FULL INTEGRATION |

---

## Success Metrics

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| **Model Catalog** | ~20 models | 100+ models | OpenRouter API |
| **Fallback Success** | Manual | 99% automatic | Error rate |
| **Cost Optimization** | Basic | Real-time | Cost per request |
| **Rate Limit Handling** | None | Automatic | 429 errors |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **OpenRouter downtime** | Low | High | Direct API fallback |
| **Cost increase** | Medium | Medium | Budget enforcement |
| **Model availability** | Low | Medium | Multiple providers |
| **API changes** | Low | Low | Version pinning |

---

## Open Questions

1. **Should we require OpenRouter API key?**  
   - No, make it optional (direct API as fallback)
   - Yes, for simplicity

2. **Should we cache model list?**  
   - Yes, for performance (1 hour TTL)
   - No, always fetch fresh

3. **Should we expose OpenRouter costs separately?**  
   - Yes, for transparency
   - No, aggregate all costs

4. **Should we support OpenRouter's streaming?**  
   - Yes, for real-time responses
   - No, for simplicity

---

## Conclusion

**OpenRouter integration is worth implementing** because:
1. It expands our model catalog from ~20 to 100+ models
2. It provides automatic fallback and rate limit handling
3. It complements our intelligent routing (doesn't replace it)

**Recommendation:** Approve Phase 1 (Basic Integration) — it has the highest impact and can be implemented in 1 week.

---

**Developed by Dheeraj Sharma <imdheeraj@gmail.com>**
