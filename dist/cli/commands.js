import { ConfigManager } from '../config/manager.js';
/**
 * Detect the CLI invocation name from process.argv.
 * Supports 'nuvira', 'agent-nuvira', or 'buff'.
 */
export function getCliName() {
    // Fast path: router sets this early
    if (process.env.NUVIRA_CLI_NAME)
        return process.env.NUVIRA_CLI_NAME;
    // Fallback: detect from argv
    const arg0 = process.argv[1] || '';
    if (/nuvira/i.test(arg0))
        return 'nuvira';
    if (/agent-nuvira/i.test(arg0))
        return 'agent-nuvira';
    return 'buff';
}
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