import { ConfigManager } from '../config/manager.js';
/**
 * Base class for all CLI commands
 */
export class BaseCommand {
    configManager;
    constructor() {
        this.configManager = new ConfigManager();
    }
    /**
     * Get the provider from CLI options
     */
    async getProvider(options) {
        const { resolveProvider } = await import('./router.js');
        return resolveProvider(this.configManager, options.provider);
    }
}
//# sourceMappingURL=commands.js.map