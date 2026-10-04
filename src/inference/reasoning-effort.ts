/**
 * Reasoning effort — ask a model to reason harder, WITHOUT breaking the models
 * that can't.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `max` capability mode raises a routing FLOOR (it requires a strong served
 * model — see `capability-mode.ts`). That decides WHICH model answers; it does
 * nothing about HOW HARD that model thinks. Provider-side reasoning controls
 * are what close that last gap, and until now no adapter sent one: a request to
 * a reasoning-capable model looked identical to a request to a toy.
 *
 * The obvious naive fix — hardcode per-model support and send the parameter —
 * is wrong in both directions and rots immediately:
 *   - a model that does NOT accept the parameter 400s the whole turn, and
 *   - a model that DOES accept it is capped by a list that stopped being true
 *     the day the provider shipped it.
 *
 * So this module is built on three rules:
 *
 *   1. GENERIC, NOT PER-PROVIDER-POLICY. The policy asks for an EFFORT
 *      (`low|medium|high`) in provider-neutral terms; the wire spelling is a
 *      property of the provider, translated here. Adding a provider is data.
 *   2. DEFAULT-DENY. The parameter is emitted ONLY when the ModelRegistry has
 *      positively recorded that the exact provider × model accepts it. Absent
 *      evidence ⇒ send nothing ⇒ behave exactly as before. A model the provider
 *      adds tomorrow is never sent a parameter it hasn't been verified for.
 *   3. CLOSED-LOOP. Providers change under us, so a "verified" flag can go
 *      stale. A rejected parameter (400/422 naming the field) is DETECTED,
 *      recorded as `learned-unsupported`, and the call is RETRIED ONCE without
 *      it. Worst case the knob silently does nothing; it can never fail a turn
 *      that would otherwise succeed.
 *
 * The knob is an UPLIFT, never a requirement. Every path here is safe to take:
 * the only request that carries the parameter is one the registry vouches for,
 * and even that path self-heals on rejection.
 */

import type { ReasoningCapability, ReasoningEffort, ReasoningShape } from '../config/types.js';
import { capabilityReasoningEffort } from '../config/capability-mode.js';

/** The default wire parameter name for each shape. */
export const SHAPE_DEFAULT_PARAM: Record<ReasoningShape, string> = {
  'openai-reasoning-effort': 'reasoning_effort',
  'anthropic-thinking': 'thinking',
  'gemini-thinking': 'thinkingConfig',
};

/** Thinking-token budget per effort, for the shapes that take a budget. */
const THINKING_BUDGET: Record<ReasoningEffort, number> = {
  low: 2_048,
  medium: 8_192,
  high: 24_576,
};

/**
 * Providers whose request body carries the OpenAI-family `reasoning_effort`
 * parameter — the one shape wired end-to-end today. A provider outside this
 * set returns `undefined` from `reasoningShapeForProvider`, and both the knob
 * and the probe stay inert for it (safer than guessing a wire shape we do not
 * apply).
 */
const OPENAI_REASONING_EFFORT_PROVIDERS = new Set([
  'openai',
  'azure',
  'groq',
  'deepseek',
  'openrouter',
  'xai',
  'mistral',
  'together',
  'fireworks',
  'deepinfra',
  'nim',
  'bedrock',
]);

/**
 * Providers with a NATIVE (non-OpenAI) reasoning control, mapped to their wire
 * shape:
 *   - anthropic → extended thinking (`thinking: { type, budget_tokens }`),
 *   - gemini    → a thinking token budget (`thinkingConfig.thinkingBudget`).
 */
const NATIVE_REASONING_SHAPES: Record<string, ReasoningShape> = {
  anthropic: 'anthropic-thinking',
  gemini: 'gemini-thinking',
};

/**
 * The wire shape a provider uses for a reasoning control, or `undefined` when
 * we have no wired shape for it. Data, not policy — the mapping lives here so
 * adding a provider is a one-line edit and nothing else.
 */
export function reasoningShapeForProvider(provider: string): ReasoningShape | undefined {
  if (OPENAI_REASONING_EFFORT_PROVIDERS.has(provider)) return 'openai-reasoning-effort';
  return NATIVE_REASONING_SHAPES[provider];
}

/**
 * Merge a flattened reasoning fragment into an OpenAI-family request body
 * (flat keys). Returns the body unchanged when there is nothing to add.
 */
export function mergeFlatReasoning(
  body: Record<string, unknown>,
  reasoningBody: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!reasoningBody || Object.keys(reasoningBody).length === 0) return body;
  return { ...body, ...reasoningBody };
}

/**
 * Advertised parameter names that indicate a model accepts a reasoning control.
 * Compared case-insensitively against a provider's `supported_parameters`.
 */
const ADVERTISED_REASONING_KEYS = ['reasoning', 'reasoning_effort', 'include_reasoning', 'thinking'] as const;

/**
 * Derive a reasoning capability from a provider's OWN advertised parameter
 * list (e.g. OpenRouter `/models` `supported_parameters`). The strongest
 * evidence available — the provider telling us — so it seeds the registry at
 * list time, before any probe. Returns `undefined` when nothing is advertised.
 */
export function reasoningCapabilityFromAdvertised(
  supportedParameters: readonly string[] | undefined,
  now: number = Date.now(),
): ReasoningCapability | undefined {
  if (!supportedParameters || supportedParameters.length === 0) return undefined;
  const set = new Set(supportedParameters.map((p) => String(p).toLowerCase()));
  const hit = ADVERTISED_REASONING_KEYS.find((k) => set.has(k));
  if (!hit) return undefined;
  return {
    supported: true,
    param: SHAPE_DEFAULT_PARAM['openai-reasoning-effort'],
    shape: 'openai-reasoning-effort',
    verifiedAt: now,
    source: 'advertised',
  };
}

/**
 * The narrow slice of the ModelRegistry this module needs. Structural so tests
 * (and callers) can pass a stub, and so the inference layer never imports the
 * whole registry just for a lookup.
 */
export interface ReasoningRegistryLike {
  getReasoningCapability(provider: string, model: string): ReasoningCapability | undefined;
  markReasoningUnsupported(provider: string, model: string, param: string): void;
}

/** A resolved request-side reasoning parameter (body fragment + its name). */
export interface ReasoningRequest {
  /** Body keys to merge into the provider request. */
  body: Record<string, unknown>;
  /** The wire parameter name — used to recognise a rejection. */
  param: string;
  shape: ReasoningShape;
}

/**
 * Build the request-body fragment for a verified capability at a given effort.
 * Pure. Unknown shapes fall back to the OpenAI `reasoning_effort` string.
 */
export function reasoningRequestBody(
  cap: Pick<ReasoningCapability, 'param' | 'shape'>,
  effort: ReasoningEffort,
): Record<string, unknown> {
  const param = cap.param || SHAPE_DEFAULT_PARAM[cap.shape] || 'reasoning_effort';
  switch (cap.shape) {
    case 'anthropic-thinking':
      return { [param]: { type: 'enabled', budget_tokens: THINKING_BUDGET[effort] } };
    case 'gemini-thinking':
      return { [param]: { thinkingBudget: THINKING_BUDGET[effort] } };
    case 'openai-reasoning-effort':
    default:
      return { [param]: effort };
  }
}

/**
 * Resolve the request-side reasoning parameter for a provider × model, or
 * `undefined` when none should be sent.
 *
 * DEFAULT-DENY: returns a request only when the registry has a `supported:true`
 * capability for this exact pair. Everything else (no entry, unsupported,
 * mismatched model) returns `undefined`, so the caller sends nothing extra.
 */
export function resolveReasoningRequest(
  provider: string,
  model: string,
  effort: ReasoningEffort | undefined,
  registry: ReasoningRegistryLike | undefined,
): ReasoningRequest | undefined {
  if (!effort || !registry) return undefined;
  let cap: ReasoningCapability | undefined;
  try {
    cap = registry.getReasoningCapability(provider, model);
  } catch {
    return undefined;
  }
  if (!cap || cap.supported !== true || !cap.param) return undefined;
  return {
    body: reasoningRequestBody(cap, effort),
    param: cap.param,
    shape: cap.shape,
  };
}

/**
 * True when an error looks like the provider REJECTED our reasoning parameter
 * (rather than failing for an unrelated reason).
 *
 * Deliberately narrow: we require a 4xx client status AND either the parameter
 * name appearing in the message, or an explicit "unsupported/unknown/invalid
 * <parameter|field>" phrasing. A generic 400 without either is NOT treated as a
 * disagreement about the parameter — guessing here would silently drop the knob
 * on unrelated failures and never learn the truth.
 */
export function isReasoningParamRejection(error: unknown, param: string): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  if (!msg) return false;
  if (!/\b(400|422)\b/.test(msg)) return false;
  const lower = msg.toLowerCase();
  if (param && lower.includes(param.toLowerCase())) return true;
  return /\b(unsupported|unknown|unrecognized|unexpected|invalid|not supported)\b/.test(lower) &&
    /\b(parameter|field|argument|key|option)\b/.test(lower);
}

/** Calls `run` with a reasoning body fragment; retries once without it on rejection. */
export interface ReasoningFallbackOptions<T> {
  provider: string;
  model: string;
  /** The resolved request, or undefined to run with no parameter at all. */
  request: ReasoningRequest | undefined;
  registry: ReasoningRegistryLike | undefined;
  /** Runs the request. `extra` is the body fragment to merge (empty on retry). */
  run: (extra: Record<string, unknown>) => Promise<T>;
}

/**
 * Run a request with the reasoning parameter (when one was resolved), and if the
 * provider REJECTS it, learn that fact and retry ONCE without the parameter.
 *
 * This is the safety net that makes the knob safe against a stale/unverified
 * capability: the worst case is one extra round trip, never a failed turn. On a
 * rejection we mark the pair `learned-unsupported` so the very next call skips
 * the parameter entirely (default-deny now has positive negative evidence).
 *
 * A no-op wrapper when `request` is undefined: the call runs exactly as before.
 */
export async function withReasoningFallback<T>(opts: ReasoningFallbackOptions<T>): Promise<T> {
  const { request, registry, run } = opts;
  if (!request) return run({});
  try {
    return await run(request.body);
  } catch (err) {
    if (!isReasoningParamRejection(err, request.param)) throw err;
    // Record the negative evidence BEFORE retrying so a concurrent caller also
    // stops sending it. Best-effort: a registry write must never break the call.
    try {
      registry?.markReasoningUnsupported(opts.provider, opts.model, request.param);
    } catch {
      // Best-effort.
    }
    return run({});
  }
}

/**
 * The ambient reasoning effort for this process (from the capability mode), for
 * an adapter that was handed no explicit `options.reasoningEffort`. Reading the
 * env is free; the config-file path is threaded explicitly by the routing
 * layer, and this covers the env/default case.
 */
export function ambientReasoningEffort(): ReasoningEffort | undefined {
  try {
    return capabilityReasoningEffort();
  } catch {
    return undefined;
  }
}
