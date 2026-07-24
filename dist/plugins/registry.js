import { logger } from '../utils/logger.js';
/**
 * Plugin registry for managing provider plugins
 */
export class PluginRegistry {
    plugins = new Map();
    /**
     * Register a new provider plugin
     */
    register(plugin) {
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
    unregister(providerType) {
        return this.plugins.delete(providerType);
    }
    /**
     * Get a plugin by provider type
     */
    getPlugin(providerType) {
        return this.plugins.get(providerType);
    }
    /**
     * Get all registered plugins
     */
    getAllPlugins() {
        return Array.from(this.plugins.values());
    }
    /**
     * Check if a provider type has a registered plugin
     */
    hasPlugin(providerType) {
        return this.plugins.has(providerType);
    }
    /**
     * Create an inference provider from a plugin
     */
    createProviderFromPlugin(providerType, config) {
        const plugin = this.plugins.get(providerType);
        if (!plugin) {
            throw new Error(`No plugin registered for provider type: ${providerType}`);
        }
        return plugin.createProvider(config);
    }
    /**
     * List all registered plugins with their metadata
     */
    listPlugins() {
        return this.getAllPlugins().map((p) => p.metadata);
    }
}
// Singleton registry
let registryInstance = null;
export function getPluginRegistry() {
    if (!registryInstance) {
        registryInstance = new PluginRegistry();
    }
    return registryInstance;
}
//# sourceMappingURL=registry.js.map