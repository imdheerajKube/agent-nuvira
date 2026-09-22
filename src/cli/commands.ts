import { Command } from 'commander';
import { ConfigManager } from '../config/manager.js';

/**
 * Detect the CLI invocation name from process.argv.
 * Supports 'nuvira' and 'agent-nuvira'. `buff` is a legacy alias kept only so
 * an old shell script does not break — it is never the name we print.
 */
export function getCliName(): string {
  // Fast path: router sets this early
  if (process.env.NUVIRA_CLI_NAME) return process.env.NUVIRA_CLI_NAME;
  // Fallback: detect from argv
  const arg0 = process.argv[1] || '';
  if (/nuvira/i.test(arg0)) return 'nuvira';
  if (/agent-nuvira/i.test(arg0)) return 'agent-nuvira';
  return 'nuvira';
}

/**
 * Base class for all CLI commands
 */
export abstract class BaseCommand {
  protected configManager: ConfigManager;

  constructor() {
    this.configManager = new ConfigManager();
  }

  /**
   * Create the Commander command
   */
  abstract create(): Command;

  /**
   * Get the provider from CLI options
   */
  protected async getProvider(options: { provider?: string; model?: string }) {
    const { resolveProvider } = await import('./router.js');
    return resolveProvider(this.configManager, options.provider);
  }
}
