import { Command } from 'commander';
import { ConfigManager } from '../config/manager.js';
/**
 * Base class for all CLI commands
 */
export declare abstract class BaseCommand {
    protected configManager: ConfigManager;
    constructor();
    /**
     * Create the Commander command
     */
    abstract create(): Command;
    /**
     * Get the provider from CLI options
     */
    protected getProvider(options: {
        provider?: string;
        model?: string;
    }): Promise<{
        type: string;
        provider: import("../index.js").InferenceProvider;
    }>;
}
//# sourceMappingURL=commands.d.ts.map