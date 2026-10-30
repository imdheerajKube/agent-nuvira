/**
 * Prompt-cache capability — where a stable prompt PREFIX is actually a discount.
 *
 * WHY THIS EXISTS (measured 2026-10-25). W1 made the tool loop compact its
 * thread ONCE and then freeze everything before a watermark, because rewriting
 * earlier messages is what threw away the provider's prefix cache: the audit run
 * hit 99.8 % cache reads between rewrites and 12–17 % on them, re-billing ~90 K
 * tokens each at 50× the cached rate.
 *
 * That reasoning is CONDITIONAL, and the condition was missing from the code. A
 * frozen, growing prefix only pays where the provider caches identical prefixes:
 *
 *   - where it does   → each call reads the old span at the cached rate, so
 *                       keeping it is nearly free and rewriting it is the loss;
 *   - where it does not → the prefix is billed at FULL rate on every call and
 *                       never shrinks, which is strictly worse than the
 *                       oldest-first trimming the loop did before W1.
 *
 * So the strategy is gated on this module and the loop keeps its per-call
 * trimming as the fallback. The default for anything unknown is "do not assume a
 * cache" — an unearned assumption here does not make the agent wrong, it makes
 * the user's bill 50× larger.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: probe. A live probe would cost a request
 * per turn to learn something that is a property of the provider, not of the
 * conversation, and the answer is only ever used to choose between two correct
 * strategies. Static knowledge plus a conservative default is the honest trade.
 */

/**
 * - `supported` — the provider caches an identical prompt prefix automatically,
 *   with no request-side opt-in, so a frozen prefix is billed at the cache rate.
 * - `unsupported` — known not to cache (or to require an explicit breakpoint this
 *   adapter never sends), so a frozen prefix is full-price dead weight.
 * - `unknown` — no reliable knowledge; treated exactly like `unsupported`.
 */
export type PromptCacheSupport = 'supported' | 'unsupported' | 'unknown';

/**
 * Providers whose prefix cache needs no request-side opt-in.
 *
 * DeepSeek: context caching is automatic and server-side (`prompt_cache_hit_tokens`
 * is already parsed by `inference/sse.ts` — the ledger reports it).
 * OpenAI/Azure: automatic prefix caching for prompts above the documented minimum.
 *
 * NOT here on purpose:
 * - `anthropic` — its caching is opt-in via `cache_control` breakpoints, and this
 *   adapter sends none (checked: no `cache_control` anywhere in `src/inference`).
 *   Marking it supported would pay a write premium for a cache that is never read.
 * - `gemini` — implicit caching exists on some models with model-specific minimums;
 *   not a property we can rely on for every route.
 * - `openrouter` / `omniroute` — the upstream route decides; a gateway can serve the
 *   same model from a caching and a non-caching backend in one session.
 */
const AUTOMATIC_PREFIX_CACHE = new Set(['deepseek', 'openai', 'azure']);

/** Runners that execute locally: there is no server-side cache to hit. */
const LOCAL_NO_CACHE = new Set(['local', 'lmstudio', 'vllm', 'ollama', 'llama.cpp']);

/** Gateways/aggregators whose caching depends on the chosen upstream route. */
const ROUTE_DEPENDENT = new Set(['openrouter', 'omniroute', 'nuvira', 'bedrock']);

/**
 * What this provider×model offers, as far as we can honestly say.
 *
 * `model` is accepted because the answer can be model-specific (a provider may
 * cache on one family and not another). Today no provider here needs the
 * distinction, so it is documented rather than invented: an unknown model name
 * never upgrades the answer, it can only keep it as it is.
 */
export function promptCacheSupport(providerType: string, model?: string): PromptCacheSupport {
  const provider = (providerType || '').trim().toLowerCase();
  if (!provider) return 'unknown';
  if (AUTOMATIC_PREFIX_CACHE.has(provider)) return 'supported';
  if (LOCAL_NO_CACHE.has(provider)) return 'unsupported';
  if (ROUTE_DEPENDENT.has(provider)) return 'unknown';
  // Anthropic's cache is opt-in via `cache_control` breakpoints and this adapter
  // sends none, so a frozen prefix there buys nothing — see the table above.
  if (provider === 'anthropic') return 'unsupported';
  // A catalog provider we have no cache knowledge about, a plugin id calling a
  // first-party endpoint, or anything else: never assume a cache exists.
  void model;
  return 'unknown';
}

/**
 * Should the loop FREEZE its prompt prefix for this route?
 *
 * Only when the cache is known to exist. Both other answers fall back to
 * per-call trimming, which is the cheaper strategy when nothing is cached.
 */
export function cacheStablePrefixPaysOff(providerType: string, model?: string): boolean {
  return promptCacheSupport(providerType, model) === 'supported';
}

/** One clause a turn report can print — why the prefix was, or was not, frozen. */
export function promptCacheExplanation(providerType: string, model?: string): string {
  const support = promptCacheSupport(providerType, model);
  const who = model ? `${providerType}/${model}` : providerType || 'this provider';
  switch (support) {
    case 'supported':
      return `${who} caches identical prompt prefixes, so the turn's prefix is frozen after one compaction (cache reads stay warm).`;
    case 'unsupported':
      return `${who} does not cache prompt prefixes, so the turn trims old messages per call instead of freezing them (a frozen prefix would be full-price dead weight).`;
    default:
      return `${who} has no known prefix cache, so the turn trims old messages per call instead of freezing them.`;
  }
}
