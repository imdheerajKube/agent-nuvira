import { Command } from 'commander';
import { ConfigManager } from '../config/manager.js';
import { resolveProvider } from './router.js';

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
  protected getProvider(options: { provider?: string; model?: string }) {
    return resolveProvider(this.configManager, options.provider);
  }
}
