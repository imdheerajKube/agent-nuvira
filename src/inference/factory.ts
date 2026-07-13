import { InferenceProvider } from './interface.js';
import { NIMAdapter } from './nim-adapter.js';
import { GeminiAdapter } from './gemini-adapter.js';
import { OpenRouterAdapter } from './openrouter-adapter.js';
import { LocalAdapter } from './local-adapter.js';
import { ProviderType, ProviderConfig } from '../config/types.js';

/**
 * Factory to create the appropriate inference provider
 * based on configuration and type
 */
export class ProviderFactory {
  /**
   * Create an inference provider instance
   */
  static createProvider(type: ProviderType, config: ProviderConfig): InferenceProvider {
    switch (type) {
      case 'nim':
        return new NIMAdapter(config);
      case 'gemini':
        return new GeminiAdapter(config);
      case 'openrouter':
        return new OpenRouterAdapter(config);
      case 'local':
        return new LocalAdapter(config);
      default:
        throw new Error(`Unknown provider type: ${type}`);
    }
  }
}
