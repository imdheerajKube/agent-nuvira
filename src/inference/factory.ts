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
  static createProvider(type: ProviderType | string, config: ProviderConfig): InferenceProvider {
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
          `Check ~/.buff/plugins/ for auto-discovered plugins.`,
        );
      }
    }
  }
}
