/**
 * Provider resolution SERVICE.
 *
 * This module exists to be imported INWARD: it resolves a CLI `--provider`
 * value (built-in id, catalog id, plugin id, or the `auto` directive) to a
 * concrete `InferenceProvider`. It must never import a command module — the
 * dispatcher that wires commands lives in `./cli-program.ts`, and the two used
 * to share one file, which put 28 modules into a single static import cycle
 * (every command imported this file for `resolveProvider`, while this file
 * imported every command for `createCLI`).
 *
 * Layering rule: `cli-program.ts` and `index.ts` may depend on this file; this
 * file depends only on config / inference / learning / plugins.
 *
 * Verified with `node scripts/check-import-cycles.mjs`.
 */
import { ConfigManager } from '../config/manager.js';
import { ProviderFactory } from '../inference/factory.js';
import { rankAvailableProviders, buildOnboardingGuidance } from '../learning/model-selection.js';
import { InferenceProvider } from '../inference/interface.js';
import { ProviderType } from '../config/types.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';

/**
 * Check if a provider type is one of the built-in types.
 */
function isBuiltInProvider(type: string): boolean {
  return ['local', 'nim', 'gemini', 'openrouter', 'groq', 'nuvira'].includes(type);
}

/**
 * Resolve the inference provider from CLI options.
 *
 * Supports both built-in providers (local, nim, gemini, openrouter, groq)
 * and auto-discovered plugin providers from ~/.nuvira/plugins/.
 *
 * For plugin providers, the type string returned is the plugin's provider type.
 */
export function resolveProvider(
  configManager: ConfigManager,
  providerOption?: string,
): { type: string; provider: InferenceProvider } {
  const rawType = providerOption || configManager.getAll().defaultProvider;

  // Check if it's a built-in provider
  if (isBuiltInProvider(rawType)) {
    const { config } = configManager.getProviderConfig(rawType as ProviderType);
    const provider = ProviderFactory.createProvider(rawType, config);
    logger.debug(`Resolved provider: ${rawType} (${provider.name})`);
    return { type: rawType, provider };
  }

  // Check plugin registry for auto-discovered providers
  const registry = getPluginRegistry();
  if (registry.hasPlugin(rawType)) {
    const plugin = registry.getPlugin(rawType)!;
    const { config } = configManager.getProviderConfig(rawType as ProviderType);
    const provider = plugin.createProvider(config);
    logger.debug(`Resolved plugin provider: ${rawType} (${plugin.metadata.name})`);
    return { type: rawType, provider };
  }

  // ── 'auto' is a routing directive, not a concrete provider ─────────────
  // Auto must be resolved per-task through the AutoModelRouter. If it leaks
  // into resolveProvider (e.g. a stale active-model state), NEVER fall back to
  // a hardcoded provider (that caused confusing 401s when the default had no
  // API key). Resolve to the best AVAILABLE provider right now: registry-
  // verified first, then configured-with-key, then local (zero-config). If
  // nothing is configured, surface onboarding guidance instead of failing
  // into a dead provider.
  if (rawType === 'auto') {
    const ranked = rankAvailableProviders(configManager);
    const configuredFallback = ranked[0]?.provider || 'local';
    if (!ranked.some((r) => r.provider !== 'local')) {
      // No cloud provider configured (and local is the only zero-config pick)
      // — tell the user how to unlock providers instead of silently using a
      // dead default.
      logger.warn(
        `Provider 'auto' resolved to '${configuredFallback}' (the only zero-config option). ` +
          `${buildOnboardingGuidance(configManager)}`
      );
    } else {
      logger.debug(`Resolved provider (auto fallback): ${configuredFallback}`);
    }
    const { config } = configManager.getProviderConfig(configuredFallback);
    const provider = ProviderFactory.createProvider(configuredFallback, config);
    return { type: configuredFallback, provider };
  }

  // ── Catalog providers (non-built-in, served by the generic adapter) ───────
  // This branch used to be MISSING, which was the real root cause of the
  // cross-provider substitution: catalog ids (bedrock, openai, mistral, xai,
  // deepseek, …) have no dedicated adapter here, so they skipped the built-in
  // branch, were not plugins, were not 'auto' — and landed in the unknown path
  // below, which returned the DEFAULT provider's adapter while every caller
  // kept using the REQUESTED id as the provider type. A Bedrock candidate
  // therefore ran on another provider entirely, and `resolveWorkingModel`
  // validated that other provider's model list under the name `bedrock`:
  //   "model 'anthropic.claude-3-5-sonnet-20241022-v1:0' is not available on
  //    'bedrock' — using 'qwen2.5:0.5b'"   ← a LOCAL Ollama model.
  // The factory supports these ids (`openAICompat` catalog metadata or an
  // installed plugin), so resolve them properly instead.
  if (ProviderFactory.isConstructible(rawType)) {
    const { config } = configManager.getProviderConfig(rawType as ProviderType);
    const provider = ProviderFactory.createProvider(rawType, config);
    logger.debug(`Resolved catalog provider: ${rawType} (${provider.name})`);
    return { type: rawType, provider };
  }

  // ── Unknown provider ──────────────────────────────────────────────────────
  // A provider we cannot construct must NOT be answered with a DIFFERENT
  // provider's adapter. Callers pair the returned adapter with the provider id
  // they ASKED for (`resolveWorkingModel(resolved.provider, candidate.provider,
  // …)`), so a silent substitution attributes one provider's models to another.
  //
  // Throwing is the honest answer: the caller's failover walk already treats a
  // resolution failure as "skip this candidate", and a primary pick surfaces a
  // clear, sanitized error instead of quietly running on an unrelated model.
  logger.warn(`Unknown provider '${rawType}' — not constructible, refusing to substitute another provider.`);
  throw new Error(
    `Provider '${rawType}' is not available in this build (no adapter). ` +
      `Run \`nuvira models\` to see the providers you can use, or remove it from your fallback chain.`,
  );
}
