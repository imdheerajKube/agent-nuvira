import { InferenceProvider } from './interface.js';
import { NIMAdapter } from './nim-adapter.js';
import { GeminiAdapter } from './gemini-adapter.js';
import { OpenRouterAdapter } from './openrouter-adapter.js';
import { GroqAdapter } from './groq-adapter.js';
import { LocalAdapter } from './local-adapter.js';
import { NuviraAdapter } from './nuvira-adapter.js';
import { AnthropicAdapter } from './anthropic-adapter.js';
import { OpenAICompatAdapter } from './openai-compat-adapter.js';
import { ProviderType, ProviderConfig } from '../config/types.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { getCatalogProvider } from './provider-catalog.js';
import { withFaultInjection } from '../runtime/fault-injection.js';

/**
 * Providers with a DEDICATED adapter in this factory. Kept as a set so
 * `isConstructible` and `createProvider` can never drift apart: every id here
 * must have a `case` in the switch below.
 * `nuvira` is the first-party provider; the catalog ids are served generically.
 */
const BUILT_IN_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  'nim',
  'gemini',
  'openrouter',
  'groq',
  'local',
  'nuvira',
  'anthropic',
]);

/**
 * Factory to create the appropriate inference provider based on configuration
 * and type.
 *
 * Built-in providers use their dedicated adapters (vendor-specific behavior).
 * Every OTHER catalog provider (Issue 001: the full 17+ set) is served by the
 * generic OpenAICompatAdapter driven by provider-catalog metadata — or the
 * native Anthropic adapter for Anthropic's non-OpenAI-compatible API. Unknown
 * types fall back to auto-discovered plugin providers, then a clear error.
 */
export class ProviderFactory {
  /**
   * Create an inference provider instance.
   *
   * For built-in types, returns the standard adapter. For catalog types,
   * returns the generic OpenAI-compat (or native) adapter. For unknown types,
   * checks the plugin registry for a matching plugin. Throws if no built-in,
   * catalog, or plugin provider is found for the type.
   */
  /**
   * True when a provider id can actually be CONSTRUCTED — a built-in adapter,
   * a catalog provider that speaks the OpenAI protocol, or an installed
   * plugin. Non-throwing twin of `createProvider`.
   *
   * Why routing needs this: catalog ids exist for providers we have no adapter
   * for (e.g. `bedrock` is in the catalog but is neither built-in nor
   * `openAICompat`). Such an id is *credentialed* — a user can have an
   * AWS_BEARER_TOKEN — so credential checks alone let it into the failover
   * candidate pool, where resolution then silently fell back to a DIFFERENT
   * provider and mislabeled its models (live: "model 'anthropic.claude-3-5-
   * sonnet-20241022-v1:0' is not available on 'bedrock' — using 'qwen2.5:0.5b'",
   * i.e. a local Ollama model presented as a Bedrock one). Filtering the pool
   * by constructibility keeps unusable providers out entirely.
   */
  static isConstructible(type: string): boolean {
    if (BUILT_IN_PROVIDER_TYPES.has(type)) return true;
    try {
      if (getCatalogProvider(type)?.openAICompat) return true;
      return getPluginRegistry().hasPlugin(type);
    } catch {
      return false;
    }
  }

  /**
   * The provider a caller gets: the adapter below, wrapped by the WS6 fault seam
   * when this process has declared one (`NUVIRA_INJECT_FAULT`).
   *
   * MEASURED REASON FOR THE SEAM TO LIVE HERE. `createProvider` is the ONE place
   * every surface obtains a provider — the four in-process surfaces through
   * `resolveProvider`, and the forked child through its own call to this same
   * static (`child-agent-runtime.ts:493`). Wrapping here therefore covers all five
   * including the process boundary, without a second implementation that could
   * disagree. With no declaration the adapter is returned unchanged (see
   * `withFaultInjection`), so nothing about an ordinary run changes.
   */
  static createProvider(type: ProviderType | string, config: ProviderConfig): InferenceProvider {
    return withFaultInjection(ProviderFactory.construct(type, config));
  }

  /** The adapter itself, with no fault seam — what `createProvider` builds. */
  private static construct(type: ProviderType | string, config: ProviderConfig): InferenceProvider {
    switch (type) {
      case 'nim':
        return new NIMAdapter(config);
      case 'gemini':
        return new GeminiAdapter(config);
      case 'openrouter':
        return new OpenRouterAdapter(config);
      case 'groq':
        return new GroqAdapter(config);
      case 'local':
        return new LocalAdapter(config);
      case 'nuvira':
        return new NuviraAdapter(config);
      case 'anthropic':
        return new AnthropicAdapter(config);
      default: {
        // Catalog-driven generic adapter: any catalog provider that speaks the
        // OpenAI /v1 protocol gets the shared adapter with its metadata
        // (baseUrl, apiKeyHeader, api-version query, label, provider id). This
        // is what lets every configured provider participate in routing,
        // probing, and the provider list — no per-provider adapter code.
        const catalog = getCatalogProvider(type);
        if (catalog?.openAICompat) {
          return new OpenAICompatAdapter(config, {
            providerId: catalog.id,
            label: catalog.label,
            defaultBaseUrl: catalog.baseUrl || 'http://127.0.0.1:8080/v1',
            apiKeyHeader: catalog.apiKeyHeader,
            apiVersionQuery: catalog.apiVersionQuery,
            keyless: catalog.keyless,
            azureDeployments: catalog.azureDeployments,
          });
        }

        // Check plugin registry for auto-discovered providers
        const registry = getPluginRegistry();
        if (registry.hasPlugin(type)) {
          return registry.createProviderFromPlugin(type, config);
        }
        throw new Error(
          `Unknown provider type: '${type}'. Available built-in: nim, gemini, openrouter, groq, local, nuvira, anthropic. ` +
          `Available catalog (OpenAI-compatible): openai, mistral, cohere, together, deepinfra, fireworks, ` +
          `perplexity, azure, lmstudio, anyscale, vllm, deepseek, xai, replicate and more. ` +
          `Check ~/.nuvira/plugins/ for auto-discovered plugins.`,
        );
      }
    }
  }
}
