import { InferenceProvider } from '../inference/interface.js';
import { ProviderConfig } from '../config/types.js';
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
export declare class PluginRegistry {
    private plugins;
    /**
     * Register a new provider plugin
     */
    register(plugin: ProviderPlugin): void;
    /**
     * Unregister a plugin
     */
    unregister(providerType: string): boolean;
    /**
     * Get a plugin by provider type
     */
    getPlugin(providerType: string): ProviderPlugin | undefined;
    /**
     * Get all registered plugins
     */
    getAllPlugins(): ProviderPlugin[];
    /**
     * Check if a provider type has a registered plugin
     */
    hasPlugin(providerType: string): boolean;
    /**
     * Create an inference provider from a plugin
     */
    createProviderFromPlugin(providerType: string, config: ProviderConfig): InferenceProvider;
    /**
     * List all registered plugins with their metadata
     */
    listPlugins(): PluginMetadata[];
}
export declare function getPluginRegistry(): PluginRegistry;
//# sourceMappingURL=registry.d.ts.map