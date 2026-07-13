import { InferenceProvider } from '../inference/interface.js';
import { ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';

/**
 * Plugin metadata
 */
export interface PluginMetadata {
  name: string;
  version: string;
  description: string;
  author?: string;
}

/**
 * Plugin interface for extending Buff with custom providers
 */
export interface ProviderPlugin {
  metadata: PluginMetadata;

  /**
   * Create an inference provider instance from this plugin
   */
  createProvider(config: ProviderConfig): InferenceProvider;

  /**
   * Get the provider type identifier (e.g., 'my-custom-provider')
   */
  getProviderType(): string;
}

/**
 * Plugin registry for managing provider plugins
 */
export class PluginRegistry {
  private plugins: Map<string, ProviderPlugin> = new Map();

  /**
   * Register a new provider plugin
   */
  register(plugin: ProviderPlugin): void {
    const type = plugin.getProviderType();

    if (this.plugins.has(type)) {
      logger.warn(`Overwriting existing plugin for provider type: ${type}`);
    }

    this.plugins.set(type, plugin);
    logger.success(`Registered plugin: ${plugin.metadata.name} v${plugin.metadata.version}`);
  }

  /**
   * Unregister a plugin
   */
  unregister(providerType: string): boolean {
    return this.plugins.delete(providerType);
  }

  /**
   * Get a plugin by provider type
   */
  getPlugin(providerType: string): ProviderPlugin | undefined {
    return this.plugins.get(providerType);
  }

  /**
   * Get all registered plugins
   */
  getAllPlugins(): ProviderPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Check if a provider type has a registered plugin
   */
  hasPlugin(providerType: string): boolean {
    return this.plugins.has(providerType);
  }

  /**
   * Create an inference provider from a plugin
   */
  createProviderFromPlugin(providerType: string, config: ProviderConfig): InferenceProvider {
    const plugin = this.plugins.get(providerType);
    if (!plugin) {
      throw new Error(`No plugin registered for provider type: ${providerType}`);
    }
    return plugin.createProvider(config);
  }

  /**
   * List all registered plugins with their metadata
   */
  listPlugins(): PluginMetadata[] {
    return this.getAllPlugins().map((p) => p.metadata);
  }
}

// Singleton registry
let registryInstance: PluginRegistry | null = null;

export function getPluginRegistry(): PluginRegistry {
  if (!registryInstance) {
    registryInstance = new PluginRegistry();
  }
  return registryInstance;
}
