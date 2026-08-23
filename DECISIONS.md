# Design Decisions — Adaptive Modality Provider Onboarding

**Date:** August 23, 2026  
**Author:** Dheeraj Sharma <imdheeraj@gmail.com>  
**Status:** Approved  
**Impact:** Tool system architecture — image/audio/video/transcription routing

---

## Decision: Adaptive Modality Provider System

### Context

Agent-Nuvira's modality tools (image generation, TTS, video, transcription) were hardcoded to specific backends:

```typescript
// BEFORE: Hardcoded providers
if (backend.id === 'comfyui') { ... }
else if (backend.id === 'pollinations') { ... }
else if (backend.id === 'dalle') { ... }
```

**Problems:**
1. Adding a new provider (e.g., Replicate, Azure TTS) requires writing code
2. No user control — users can't add their own providers
3. Inconsistent patterns across different modality tools
4. Future AI capabilities require code changes

### Decision

Implement a **data-driven modality provider catalog** (like `provider-catalog.ts` for LLMs) that:

1. **Defines providers as data objects** (not code)
2. **Allows user-configurable providers** via config
3. **Uses generic API caller** with provider-specific parsers
4. **Follows the same routing pattern** as LLM routing (score, select, failover)

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MODALITY CATALOG                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  interface ModalityProvider {                               │
│    id: string;              // 'dalle', 'pollinations'      │
│    name: string;            // 'DALL-E 3'                   │
│    modality: ModalityType;  // 'image' | 'tts' | ...       │
│    apiType: ApiType;        // 'openai' | 'rest' | 'local'  │
│    baseUrl: string;         // API endpoint                 │
│    envVar: string;          // API key env var              │
│    costPerUnit: number;     // Cost per generation          │
│    quality: number;         // 0-1 quality score            │
│    speed: number;           // 0-1 speed score              │
│    models: string[];        // Available models             │
│    requestBuilder: Function;  // Build API request          │
│    responseParser: Function; // Parse API response          │
│  }                                                          │
│                                                             │
│  // Built-in providers (always available)                   │
│  // + User-configured providers (from config)               │
│  // + Auto-detected providers (from env vars)               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Principles

#### 1. Data Over Code

**Before:** Each provider was a code block:
```typescript
if (provider.id === 'dalle') {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'dall-e-3', prompt }),
  });
  // ... parse response
}
```

**After:** Each provider is a data object:
```typescript
{
  id: 'dalle',
  name: 'DALL-E 3',
  modality: 'image',
  apiType: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  envVar: 'OPENAI_API_KEY',
  requestBuilder: (prompt, opts) => ({
    model: 'dall-e-3',
    prompt,
    size: `${opts.width}x${opts.height}`,
  }),
  responseParser: (res) => res.data[0].url,
}
```

#### 2. User-Configurable

Users can add providers via config:
```bash
# Add Replicate for image generation
nuvira config set modality.image.replicate.apiKey=r8_xxxxx
nuvira config set modality.image.replicate.baseUrl=https://api.replicate.com/v1
nuvira config set modality.image.replicate.models="stability-ai/sdxl"

# Add Azure TTS
nuvira config set modality.tts.azure.apiKey=xxxxx
nuvira config set modality.tts.azure.region=eastus
```

#### 3. Generic API Caller

Instead of provider-specific code, use a generic caller:
```typescript
async function callModalityProvider(
  provider: ModalityProvider,
  prompt: string,
  opts: ModalityOptions,
): Promise<ModalityResult> {
  const request = provider.requestBuilder(prompt, opts);
  const response = await fetch(provider.baseUrl + provider.endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getApiKey(provider)}` },
    body: JSON.stringify(request),
  });
  return provider.responseParser(response);
}
```

#### 4. Consistent Routing

All modality tools use the same pattern:
1. **Score** providers (cost, quality, speed, availability)
2. **Select** best provider
3. **Call** with generic API caller
4. **Failover** to next provider on failure
5. **Record** usage for warmup daemon

### Consequences

#### Positive
- ✅ New providers added via config (no code change)
- ✅ User control over provider selection
- ✅ Consistent patterns across all modality tools
- ✅ Future-proof for new AI capabilities
- ✅ Same routing intelligence as LLM routing

#### Negative
- ⚠️ More complex than hardcoded approach
- ⚠️ Provider-specific quirks need custom parsers
- ⚠️ Generic caller may not handle all edge cases

#### Mitigations
- Built-in providers handle common cases
- Custom parsers for provider-specific quirks
- Fallback to hardcoded path for complex cases

### Alternatives Considered

#### 1. Plugin System
- **Pros:** Maximum flexibility
- **Cons:** Security risks, complexity, harder to maintain
- **Verdict:** Overkill for this use case

#### 2. OpenAI-Compatible Only
- **Pros:** Simple, generic caller works for all
- **Cons:** Many providers aren't OpenAI-compatible
- **Verdict:** Too restrictive

#### 3. Hardcoded (Status Quo)
- **Pros:** Simple, predictable
- **Cons:** Not adaptive, requires code changes
- **Verdict:** Doesn't solve the problem

### Implementation Plan

| Phase | Component | Effort |
|-------|-----------|--------|
| 1 | Modality catalog definition | 2 days |
| 2 | Generic API caller | 1 day |
| 3 | Config integration | 0.5 day |
| 4 | Migration of existing tools | 1 day |
| 5 | Tests | 1 day |
| **Total** | | **5.5 days** |

### Success Criteria

1. ✅ Users can add new providers via config
2. ✅ No code changes required for new providers
3. ✅ All existing providers work unchanged
4. ✅ Routing intelligence preserved (score, select, failover)
5. ✅ 5,000+ tests pass

### References

- `src/inference/provider-catalog.ts` — LLM provider catalog (pattern to follow)
- `src/tools/modality/tool-router.ts` — Current hardcoded approach
- `src/tools/image-video-tool.ts` — Existing image/video tools
- `src/tools/modality/image-gen.ts` — Existing image generation

---

## Decision: Generic Modality API Caller

### Context

Different modality providers have different APIs:
- OpenAI: `/v1/images/generations`
- Stability: `/v1/generation/stable-diffusion-xl/text-to-image`
- Replicate: `/v1/predictions`
- FAL: `/run/{model}`

### Decision

Implement a **generic API caller** that:
1. Uses provider's `requestBuilder` to construct the request
2. Uses provider's `responseParser` to parse the response
3. Handles auth, timeouts, retries generically
4. Falls back to provider-specific logic when needed

### Implementation

```typescript
async function callModalityProvider(
  provider: ModalityProvider,
  prompt: string,
  opts: ModalityOptions,
): Promise<ModalityResult> {
  // 1. Build request
  const request = provider.requestBuilder(prompt, opts);
  
  // 2. Determine endpoint
  const endpoint = provider.endpoint || getDefaultEndpoint(provider.modality);
  
  // 3. Make API call
  const response = await fetch(provider.baseUrl + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...provider.headers,
      'Authorization': `Bearer ${getApiKey(provider)}`,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(provider.timeoutMs || 30000),
  });
  
  // 4. Handle errors
  if (!response.ok) {
    throw new ModalityError(provider.id, response.status, await response.text());
  }
  
  // 5. Parse response
  const data = await response.json();
  return provider.responseParser(data);
}
```

### Consequences

- ✅ Generic code handles all providers
- ✅ Provider-specific logic isolated to parsers
- ✅ Easy to add new providers (just define request/response)

---

## Decision: Modality Provider Scoring

### Context

How to select the best provider when multiple are available?

### Decision

Use the same scoring approach as LLM routing:

```typescript
function scoreModalityProvider(
  provider: ModalityProvider,
  context: ModalityContext,
): number {
  const weights = {
    cost: 0.35,      // Cost per generation
    quality: 0.30,   // Quality score
    speed: 0.20,     // Speed score
    availability: 0.15, // Is it available?
  };
  
  const costScore = 1 - (provider.costPerUnit / maxCost);
  const qualityScore = provider.quality;
  const speedScore = provider.speed;
  const availabilityScore = provider.available ? 1 : 0;
  
  return (
    costScore * weights.cost +
    qualityScore * weights.quality +
    speedScore * weights.speed +
    availabilityScore * weights.availability
  );
}
```

### Consequences

- ✅ Consistent with LLM routing
- ✅ Cost-optimized (free providers preferred)
- ✅ Quality-aware (better providers score higher)
- ✅ Availability-aware (skip unavailable providers)

---

## Decision: Failover Strategy

### Context

What happens when a provider fails?

### Decision

Use the same tiered failover as LLM routing:

```
1. Best provider (scored)
2. Same-tier providers (pre-check availability)
3. Escalate to higher tier
4. De-escalate to lower tier
5. Local fallback (if available)
```

### Implementation

```typescript
async function routeWithFailover(
  modality: ModalityType,
  prompt: string,
  opts: ModalityOptions,
): Promise<ModalityResult> {
  const providers = getModalityProviders(modality);
  const scored = providers.map(p => ({
    provider: p,
    score: scoreModalityProvider(p, { modality, prompt }),
  })).sort((a, b) => b.score - a.score);
  
  for (const { provider } of scored) {
    try {
      return await callModalityProvider(provider, prompt, opts);
    } catch (err) {
      logger.debug(`[modality-router] ${provider.id} failed: ${err.message}`);
      // Continue to next provider
    }
  }
  
  throw new Error(`All ${modality} providers failed`);
}
```

### Consequences

- ✅ Resilient to provider failures
- ✅ Automatic failover
- ✅ Same behavior as LLM routing

---

## Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Provider definition | Data objects | Easy to add/configure |
| User configuration | Config-based | No code changes required |
| API calling | Generic caller | Consistent, maintainable |
| Provider scoring | Cost/quality/speed | Same as LLM routing |
| Failover | Tiered approach | Same as LLM routing |

**The key insight:** Modality tools should follow the same pattern as LLM tools — data-driven, user-configurable, with intelligent routing and failover.

---

*Developed by Dheeraj Sharma <imdheeraj@gmail.com>*
