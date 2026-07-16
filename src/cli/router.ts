import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { ConfigManager } from '../config/manager.js';

/** Read version from package.json at build time */
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'));
import { ProviderFactory } from '../inference/factory.js';
import { InferenceProvider } from '../inference/interface.js';
import { ProviderType } from '../config/types.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { ChatCommand } from './chat.js';
import { EditCommand } from './edit.js';
import { PlanCommand } from './plan.js';
import { ConfigCommand } from './config.js';
import { CacheCommand } from './cache.js';
import { ModelsCommand } from './models.js';
import { ExecuteCommand } from './execute.js';
import { RunCommand } from './run.js';
import { WorkflowCommand } from './workflow.js';
import { PluginsCommand } from './plugins.js';
import { LearnCommand } from './learn.js';
import { InitCommand } from './init.js';
import { StatsCommand } from './stats.js';
import { HistoryCommand } from './history.js';
import { BenchmarkCommand } from './benchmark.js';
import { SandboxCommand } from './sandbox.js';
import { DoctorCommand } from './doctor.js';
import { MemoryCommand } from './memory.js';
import { DashboardCommand } from './dashboard.js';
import { AgentCommand } from './agent.js';
import { FederationCommand } from './federation.js';
import { TeamCommand } from './team.js';
import { SDKCommand } from './sdk.js';
import { logger } from '../utils/logger.js';

/**
 * Create and configure the CLI program
 */
export function createCLI(): Command {
  const program = new Command();

  program
    .name('buff')
    .description('Flexible AI inference CLI tool — local models & cloud APIs')
    .version(pkg.version);

  // Global options
  program
    .option('-d, --debug', 'Enable debug logging');

  // Register commands
  const chatCmd = new ChatCommand();
  const editCmd = new EditCommand();
  const planCmd = new PlanCommand();
  const configCmd = new ConfigCommand();
  const cacheCmd = new CacheCommand();
  const modelsCmd = new ModelsCommand();
  const executeCmd = new ExecuteCommand();

  program.addCommand(chatCmd.create());
  program.addCommand(editCmd.create());
  program.addCommand(planCmd.create());
  program.addCommand(configCmd.create());
  program.addCommand(cacheCmd.create());
  program.addCommand(modelsCmd.create());
  program.addCommand(executeCmd.create());

  const runCmd = new RunCommand();
  program.addCommand(runCmd.create());

  const workflowCmd = new WorkflowCommand();
  program.addCommand(workflowCmd.create());

  const pluginsCmd = new PluginsCommand();
  program.addCommand(pluginsCmd.create());

  const learnCmd = new LearnCommand();
  program.addCommand(learnCmd.create());

  // Register new Phase 1 commands
  const initCmd = new InitCommand();
  program.addCommand(initCmd.create());

  const statsCmd = new StatsCommand();
  program.addCommand(statsCmd.create());

  const historyCmd = new HistoryCommand();
  program.addCommand(historyCmd.create());

  // Register Phase 2 commands
  const benchmarkCmd = new BenchmarkCommand();
  program.addCommand(benchmarkCmd.create());

  const sandboxCmd = new SandboxCommand();
  program.addCommand(sandboxCmd.create());

  // Register Phase 2.5 new commands
  const doctorCmd = new DoctorCommand();
  program.addCommand(doctorCmd.create());

  const memoryCmd = new MemoryCommand();
  program.addCommand(memoryCmd.create());

  // Register Phase 3.3 new commands
  const dashboardCmd = new DashboardCommand();
  program.addCommand(dashboardCmd.create());

  const agentCmd = new AgentCommand();
  program.addCommand(agentCmd.create());

  const federationCmd = new FederationCommand();
  program.addCommand(federationCmd.create());

  const teamCmd = new TeamCommand();
  program.addCommand(teamCmd.create());

  // Register Phase 3.6 commands
  const sdkCmd = new SDKCommand();
  program.addCommand(sdkCmd.create());

  // Default action: show help
  program.action(() => {
    program.help();
  });

  return program;
}

/**
 * Check if a provider type is one of the built-in types.
 */
function isBuiltInProvider(type: string): boolean {
  return ['local', 'nim', 'gemini', 'openrouter', 'groq'].includes(type);
}

/**
 * Resolve the inference provider from CLI options.
 *
 * Supports both built-in providers (local, nim, gemini, openrouter, groq)
 * and auto-discovered plugin providers from ~/.buff/plugins/.
 *
 * For plugin providers, the type string returned is the plugin's provider type.
 */
export function resolveProvider(
  configManager: ConfigManager,
  providerOption?: string,
): { type: string; provider: InferenceProvider } {
  const rawType = providerOption || configManager.getAll().defaultProvider;

  // Check if it's a built-in provider
  if (isBuiltInProvider(rawType)) {
    const { config } = configManager.getProviderConfig(rawType as ProviderType);
    const provider = ProviderFactory.createProvider(rawType, config);
    logger.debug(`Resolved provider: ${rawType} (${provider.name})`);
    return { type: rawType, provider };
  }

  // Check plugin registry for auto-discovered providers
  const registry = getPluginRegistry();
  if (registry.hasPlugin(rawType)) {
    const plugin = registry.getPlugin(rawType)!;
    const config = configManager.getAll().providers[rawType as ProviderType] || {};
    const provider = plugin.createProvider(config);
    logger.debug(`Resolved plugin provider: ${rawType} (${plugin.metadata.name})`);
    return { type: rawType, provider };
  }

  // Unknown provider — warn and fall back to default
  logger.warn(`Unknown provider '${rawType}'. Falling back to '${configManager.getAll().defaultProvider}'`);
  const fallbackType = configManager.getAll().defaultProvider;
  const { config } = configManager.getProviderConfig(fallbackType);
  const provider = ProviderFactory.createProvider(fallbackType, config);
  logger.debug(`Resolved provider (fallback): ${fallbackType} (${provider.name})`);
  return { type: fallbackType, provider };
}
