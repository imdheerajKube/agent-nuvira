/**
 * Model command — Manage and switch inference providers and models seamlessly.
 *
 * This command enables "context-preserving" provider switching:
 * - Changes the active provider/model in a runtime state file
 * - Other commands (chat, execute) can read this state to pick up the current model
 * - The switch is instant — no need to restart any session
 * - Conversation history and agent state are preserved across switches
 *
 * Usage:
 *   buff model                           — Show current config + interactive switch
 *   buff model list                      — List all providers and their status
 *   buff model switch                    — Interactive categorized model picker
 *   buff model switch groq               — Switch to groq (default model)
 *   buff model switch groq/llama-3.3-70b — Switch to specific model
 *   buff model info                      — Show detailed current config
 *   buff model recommend                 — Show model routing recommendations
 *   buff model health                    — Quick health check for active provider
 */

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import inquirer from 'inquirer';

import { BaseCommand } from './commands.js';
import { showModelPicker } from './model-picker.js';
import { ProviderFactory } from '../inference/factory.js';
import { getPluginRegistry } from '../plugins/registry.js';
import type { ProviderType, ProviderConfig } from '../config/types.js';
import { getModelBadge } from '../inference/model-catalog.js';
import { getHybridRouter } from '../learning/hybrid-router.js';
import { logger } from '../utils/logger.js';

// ─── Active Model State ─────────────────────────────────────────────────────

/**
 * The runtime state file that preserves the active model across sessions.
 * Other commands (chat, execute) can read this to know which model to use.
 * Path: ~/.buff/active-model.json
 */
export interface ActiveModelState {
  /** Provider type identifier (e.g., 'groq', 'gemini', 'openrouter') */
  provider: string;
  /** Model identifier (e.g., 'llama-3.3-70b-versatile') */
  model: string;
  /** When this was last updated */
  updatedAt: number;
  /** Whether this was explicitly set by the user */
  explicit: boolean;
  /** Display name for the provider */
  providerLabel?: string;
}

const BUFF_DIR = join(homedir(), '.buff');
const ACTIVE_MODEL_PATH = join(BUFF_DIR, 'active-model.json');

function ensureBuffDir(): void {
  if (!existsSync(BUFF_DIR)) {
    mkdirSync(BUFF_DIR, { recursive: true });
  }
}

/**
 * Read the current active model state from disk.
 * Returns null if no state has been saved yet.
 */
export function readActiveModelState(): ActiveModelState | null {
  try {
    ensureBuffDir();
    if (!existsSync(ACTIVE_MODEL_PATH)) return null;
    const raw = readFileSync(ACTIVE_MODEL_PATH, 'utf-8');
    return JSON.parse(raw) as ActiveModelState;
  } catch {
    return null;
  }
}

/**
 * Save a new active model state to disk.
 * This is called when the user switches providers/models.
 */
export function saveActiveModelState(state: Omit<ActiveModelState, 'updatedAt'>): void {
  ensureBuffDir();
  const full: ActiveModelState = {
    ...state,
    updatedAt: Date.now(),
  };
  writeFileSync(ACTIVE_MODEL_PATH, JSON.stringify(full, null, 2), 'utf-8');
  logger.debug(`Active model saved: ${state.provider}/${state.model}`);
}

/**
 * Apply the active model state to CLI options.
 * Other commands call this to auto-select the user's last-used model.
 */
export function applyActiveModel(
  options: { provider?: string; model?: string },
): { provider?: string; model?: string } {
  const state = readActiveModelState();
  if (!state) return options;

  // CLI --provider/--model flags take priority
  return {
    provider: options.provider || state.provider,
    model: options.model || state.model,
  };
}

// ─── Provider Metadata ──────────────────────────────────────────────────────

const PROVIDER_ICONS: Record<string, string> = {
  local: '💻',
  nim: '🔶',
  gemini: '🔷',
  openrouter: '🟣',
  groq: '🟢',
};

const PROVIDER_LABELS: Record<string, string> = {
  local: 'Ollama (Local)',
  nim: 'NVIDIA NIM',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  groq: 'Groq',
};

const PROVIDER_ELIGIBILITY: Record<string, string> = {
  local: 'Works offline — install Ollama: brew install ollama',
  nim: 'Set NVIDIA_NIM_API_KEY (get at build.nvidia.com)',
  gemini: 'Set GEMINI_API_KEY (get at aistudio.google.com/apikey)',
  openrouter: 'Set OPENROUTER_API_KEY (get at openrouter.ai/keys)',
  groq: 'Set GROQ_API_KEY (get at console.groq.com)',
};

// ─── ModelCommand ───────────────────────────────────────────────────────────

export class ModelCommand extends BaseCommand {
  create(): Command {
    const cmd = new Command('model')
      .description('Manage inference providers and models — switch, list, inspect, and recommend');

    cmd
      .command('list')
      .alias('ls')
      .description('List all providers and their configuration status')
      .option('--all', 'Show all providers including unconfigured', false)
      .action(async (opts) => this.listProviders(opts));

    cmd
      .command('switch [providerAndModel]')
      .description('Switch active provider/model (interactive or via argument)')
      .option('--provider <provider>', 'Provider to switch to')
      .option('--model <model>', 'Model to use with the provider')
      .action(async (providerAndModel, opts) => {
        await this.switchProvider(providerAndModel, opts);
      });

    cmd
      .command('info')
      .description('Show current active provider and model configuration')
      .option('--verbose', 'Show detailed configuration', false)
      .action((opts) => this.showInfo(opts));

    cmd
      .command('recommend')
      .description('Show model routing recommendations')
      .action(() => this.showRecommendations());

    cmd
      .command('health')
      .description('Quick health check for the currently active provider')
      .option('-p, --provider <provider>', 'Check a specific provider instead')
      .option('--verbose', 'Show detailed diagnostic info', false)
      .action(async (opts) => {
        await this.checkHealth(opts);
      });

    // Default action (no subcommand): show info and offer to switch
    cmd
      .action(async () => {
        await this.showInfo({ verbose: false });
        await this.promptSwitchIfWanted();
      });

    return cmd;
  }

  // ── Subcommand: list ───────────────────────────────────────────────────

  private async listProviders(opts: { all?: boolean }): Promise<void> {
    const builtinTypes: ProviderType[] = ['local', 'groq', 'nim', 'gemini', 'openrouter'];
    const registry = getPluginRegistry();
    const pluginTypes = registry.getAllPlugins().map((p) => p.getProviderType());
    const active = readActiveModelState();

    console.log('');
    logger.highlight('📡 Checking provider configurations...\n');

    const results: Array<{
      type: string;
      label: string;
      icon: string;
      configured: boolean;
      available: boolean;
      defaultModel: string | undefined;
      isActive: boolean;
      isPlugin: boolean;
    }> = [];

    // Check built-in providers (in parallel)
    const providerChecks = builtinTypes.map(async (pt) => {
      const icon = PROVIDER_ICONS[pt] || '🔹';
      const label = PROVIDER_LABELS[pt] || pt;
      const hasKey = this.configManager.hasRequiredCredentials(pt);
      const configured = pt === 'local' || hasKey;

      if (!configured && !opts.all) {
        return {
          type: pt,
          label,
          icon,
          configured: false,
          available: false,
          defaultModel: this.configManager.getAll().providers[pt]?.model,
          isActive: active?.provider === pt,
          isPlugin: false,
        };
      }

      try {
        const resolved = await this.getProvider({ provider: pt });
        const available = await resolved.provider.isAvailable();
        return {
          type: pt,
          label,
          icon,
          configured: true,
          available,
          defaultModel: this.configManager.getAll().providers[pt]?.model,
          isActive: active?.provider === pt,
          isPlugin: false,
        };
      } catch {
        return {
          type: pt,
          label,
          icon,
          configured,
          available: false,
          defaultModel: this.configManager.getAll().providers[pt]?.model,
          isActive: active?.provider === pt,
          isPlugin: false,
        };
      }
    });

    // Wait for all provider checks to complete in parallel
    const builtinResults = await Promise.all(providerChecks);
    results.push(...builtinResults);

    // Check plugin providers
    const pluginReg = getPluginRegistry();
    for (const plugin of pluginReg.getAllPlugins()) {
      const pt = plugin.getProviderType();
      let available = false;
      let defaultModel: string | undefined = undefined;
      let configured = true;

      try {
        const resolved = await this.getProvider({ provider: pt });
        available = await resolved.provider.isAvailable();
        defaultModel = this.configManager.getProviderConfig(pt).config.model;
      } catch {
        available = false;
        defaultModel = this.configManager.getProviderConfig(pt).config.model;
      }

      results.push({
        type: pt,
        label: plugin.metadata.name,
        icon: '🔌',
        configured,
        available,
        defaultModel,
        isActive: active?.provider === pt,
        isPlugin: true,
      });
    }

    // ── Render ─────────────────────────────────────────────────────────
    console.log('  ┌──────────────────────────────────┬──────────┬──────────┬──────────────────┐');
    console.log('  │ Provider                         │ Status   │ Available│ Model            │');
    console.log('  ├──────────────────────────────────┼──────────┼──────────┼──────────────────┤');

    for (const r of results) {
      const name = `${r.icon} ${r.label}`.padEnd(30).slice(0, 30);
      const status = r.isActive ? '✅ Active' : r.configured ? '⚙️  Ready' : '⏳ Needs key';
      const avail = r.available ? '✅' : '⛔';
      const model = (r.defaultModel || 'default').padEnd(15).slice(0, 15);
      console.log(`  │ ${name} │ ${status.padEnd(8)} │ ${avail}      │ ${model} │`);
    }

    console.log('  └──────────────────────────────────┴──────────┴──────────┴──────────────────┘');

    if (active) {
      console.log('');
      logger.success(`Active: ${active.provider}/${active.model}`);
      console.log(`  (set ${new Date(active.updatedAt).toLocaleString()})`);
    }

    console.log('');
    logger.info('Run `buff model switch` to change the active provider/model.');
    logger.info('Run `buff doctor` for full diagnostic checks.');
    console.log('');
  }

  // ── Subcommand: switch ─────────────────────────────────────────────────

  private async switchProvider(
    providerAndModel?: string,
    opts?: { provider?: string; model?: string },
  ): Promise<void> {
    // ── Case 1: Argument provided: "groq/llama-3.3-70b" or just "groq" ──
    if (providerAndModel) {
      const slashIdx = providerAndModel.indexOf('/');
      let provider: string;
      let model: string | undefined;

      if (slashIdx > 0) {
        // Format: "groq/llama-3.3-70b-versatile"
        provider = providerAndModel.slice(0, slashIdx);
        model = providerAndModel.slice(slashIdx + 1);
      } else {
        // Format: "groq" — use provided --model or default
        provider = providerAndModel;
        model = opts?.model;
      }

      await this.doSwitch(provider, model);
      return;
    }

    // ── Case 2: --provider / --model flags ────────────────────────────
    if (opts?.provider) {
      await this.doSwitch(opts.provider, opts.model);
      return;
    }

    // ── Case 3: Interactive model picker ──────────────────────────────
    const picked = await showModelPicker(this.configManager);
    if (!picked) {
      logger.info('Model selection cancelled.');
      return;
    }

    await this.doSwitch(picked.provider, picked.model);
  }

  /**
   * Perform the actual provider/model switch.
   * Saves the active model state and confirms to the user.
   */
  private async doSwitch(provider: string, model?: string): Promise<void> {
    try {
      // Resolve the actual model to use
      let resolvedModel = model;
      if (!resolvedModel) {
        // Use the provider's default model from config
        try {
          const { config } = this.configManager.getProviderConfig(provider as ProviderType);
          resolvedModel = config.model;
        } catch {
          // Provider might not be built-in; use a fallback
          resolvedModel = 'default';
        }
      }

      // Quick availability check
      const resolved = await this.getProvider({ provider });

      // Verify the resolved provider matches what was requested
      // resolveProvider() may fall back to the default if the provider is unknown
      const actualType = resolved.type;
      if (actualType !== provider) {
        logger.warn(`⚠️  Provider '${provider}' not found — using '${actualType}' instead.`);
        provider = actualType;
      }

      const available = await resolved.provider.isAvailable();

      if (!available) {
        const eligibility = PROVIDER_ELIGIBILITY[provider] || 'Check your API key configuration';
        logger.warn(`⚠️  Provider '${provider}' is not currently available.`);
        logger.info(`   ${eligibility}`);
        logger.info('   Saving anyway — it will be used when available.\n');
      }

      // Save the active model state
      const label = PROVIDER_LABELS[provider] || resolved.provider.name || provider;
      saveActiveModelState({
        provider,
        model: resolvedModel!,
        explicit: true,
        providerLabel: label,
      });

      console.log('');
      logger.success(`✅ Switched active model to:`);
      const icon = PROVIDER_ICONS[provider] || '🔹';
      console.log(`   ${icon}  ${label}`);
      const badge = getModelBadge(resolvedModel!);
      if (badge) {
        console.log(`   🧠  ${resolvedModel}  — ${badge}`);
      } else {
        console.log(`   🧠  ${resolvedModel}`);
      }
      console.log('');
      logger.info('This model will be used by default for `buff chat`, `buff execute`, and other commands.');
      console.log('');
    } catch (err) {
      logger.error(`Failed to switch: ${err instanceof Error ? err.message : String(err)}`);
      logger.info('Use `buff model list` to see available providers.');
    }
  }

  // ── Subcommand: info ───────────────────────────────────────────────────

  private showInfo(opts: { verbose?: boolean }): void {
    const active = readActiveModelState();
    const config = this.configManager.getAll();

    console.log('');
    logger.highlight('═══  Model Configuration  ═══');
    console.log('');

    if (active) {
      const icon = PROVIDER_ICONS[active.provider] || '🔹';
      logger.success(`  Active: ${icon} ${active.providerLabel || active.provider}`);
      console.log(`  Model:  🧠  ${active.model}`);
      console.log(`  Since:  ${new Date(active.updatedAt).toLocaleString()}`);
      console.log('');

      // Show model details
      const badge = getModelBadge(active.model);
      if (badge) {
        console.log(`  📌 ${badge}`);
        console.log('');
      }
    } else {
      logger.info('  No active model set.');
      logger.info('  Run `buff model switch` to select one.');
      console.log('');
    }

    if (opts.verbose) {
      logger.highlight('  ── All Provider Configurations ──');
      console.log('');

      const builtinTypes: ProviderType[] = ['local', 'groq', 'nim', 'gemini', 'openrouter'];
      const pluginReg_2 = getPluginRegistry();
      const pluginProviders = pluginReg_2.getAllPlugins();

      for (const pt of builtinTypes) {
        const icon = PROVIDER_ICONS[pt] || '🔹';
        const label = PROVIDER_LABELS[pt] || pt;
        const providerConfig = config.providers[pt] || {};
        const isActive = active?.provider === pt;

        console.log(`  ${icon} ${label}${isActive ? '  ← active' : ''}`);
        console.log(`     Model:     ${providerConfig.model || '(not set)'}`);
        console.log(`     API Key:   ${providerConfig.apiKey ? '✅ configured' : '⏳ not set'}`);
        if (providerConfig.temperature !== undefined) {
          console.log(`     Temp:      ${providerConfig.temperature}`);
        }
        if (providerConfig.maxTokens !== undefined) {
          console.log(`     Max tokens: ${providerConfig.maxTokens}`);
        }
        if (providerConfig.baseUrl) {
          console.log(`     Base URL:  ${providerConfig.baseUrl}`);
        }
        console.log('');
      }

      for (const plugin of pluginProviders) {
        const pt = plugin.getProviderType();
        const providerConfig = config.providers[pt] || {};
        const isActive = active?.provider === pt;
        const icon = '🔌';

        console.log(`  ${icon} ${plugin.metadata.name}${isActive ? '  ← active' : ''}`);
        console.log(`     Type:      ${pt}`);
        console.log(`     Model:     ${providerConfig.model || '(not set)'}`);
        if (providerConfig.apiKey) {
          console.log(`     API Key:   ✅ configured`);
        }
        if (providerConfig.temperature !== undefined) {
          console.log(`     Temp:      ${providerConfig.temperature}`);
        }
        if (providerConfig.maxTokens !== undefined) {
          console.log(`     Max tokens: ${providerConfig.maxTokens}`);
        }
        if (providerConfig.baseUrl) {
          console.log(`     Base URL:  ${providerConfig.baseUrl}`);
        }
        console.log('');
      }
    }

    console.log('');
    logger.info('Run `buff model switch` to change providers.');
    logger.info('Run `buff model list` to see availability status.');
    console.log('');
  }

  // ── Subcommand: recommend ──────────────────────────────────────────────

  private showRecommendations(): void {
    const router = getHybridRouter();
    const recommendations = router.getBenchmarkRecommendations();
    const active = readActiveModelState();

    console.log('');
    logger.highlight('═══  Model Routing Recommendations  ═══');
    console.log('');

    if (active) {
      const icon = PROVIDER_ICONS[active.provider] || '🔹';
      console.log(`  Current: ${icon} ${active.providerLabel || active.provider} / ${active.model}`);
      console.log('');
    }

    // Default agent-to-model mapping
    const defaultMapping: Array<{ agent: string; icon: string; recommended: string }> = [
      { agent: 'planner', icon: '📋', recommended: 'gemini/gemini-2.0-flash-exp' },
      { agent: 'context-gatherer', icon: '📂', recommended: 'groq/llama-3.3-70b-versatile' },
      { agent: 'writer', icon: '✏️', recommended: 'groq/llama-3.3-70b-versatile' },
      { agent: 'reviewer', icon: '👁️', recommended: 'openrouter/meta-llama/llama-3.1-8b-instruct' },
      { agent: 'tester', icon: '🧪', recommended: 'groq/llama-3.3-70b-versatile' },
      { agent: 'debugger', icon: '🐛', recommended: 'openrouter/meta-llama/llama-3.1-8b-instruct' },
    ];

    if (recommendations.length > 0) {
      logger.highlight('  ── Benchmark-Driven Recommendations ──');
      console.log('');

      for (const rec of recommendations) {
        const confidence = rec.confidence === 'high' ? '✅' : rec.confidence === 'medium' ? '📊' : '🔬';
        console.log(`  ${confidence} ${rec.agentType.padEnd(20)} → ${rec.recommendedModel}`);
      }
    }

    console.log('');
    logger.highlight('  ── Default Recommendations ──');
    console.log('');

    for (const { agent, icon, recommended } of defaultMapping) {
      console.log(`  ${icon} ${agent.padEnd(20)} → ${recommended}`);
    }

    console.log('');
    logger.info('To use routing: add `--auto-route` to `buff execute` commands.');
    logger.info('To set a specific model per agent: `buff execute --planner-model <model>`');
    console.log('');
  }

  // ── Subcommand: health ─────────────────────────────────────────────────

  private async checkHealth(opts: { provider?: string; verbose?: boolean }): Promise<void> {
    const targetProvider = opts.provider || readActiveModelState()?.provider || 'local';
    const icon = PROVIDER_ICONS[targetProvider] || '🔹';
    const label = PROVIDER_LABELS[targetProvider] || targetProvider;

    console.log('');
    logger.highlight(`═══  Health Check: ${icon} ${label}  ═══`);
    console.log('');

    try {
      const resolved = await this.getProvider({ provider: targetProvider });
      const provider = resolved.provider;
      const providerName = provider.name;

      // 1. Provider instantiation
      logger.success(`✅ Provider module: ${providerName} loaded`);

      // 2. API Key check
      const isLocal = targetProvider === 'local';
      const hasKey = this.configManager.hasRequiredCredentials(targetProvider as ProviderType);
      if (isLocal) {
        logger.success('✅ No API key needed (local provider)');
      } else if (hasKey) {
        logger.success('✅ API key is configured');
      } else {
        logger.warn('⚠️  No API key configured. Run `buff doctor` for setup help.');
      }

      // 3. Availability
      const available = await provider.isAvailable();
      if (available) {
        logger.success('✅ Endpoint reachable');
      } else {
        const eligibility = PROVIDER_ELIGIBILITY[targetProvider] || 'Check configuration';
        logger.warn(`⛔ Endpoint not reachable — ${eligibility}`);
      }

      // 4. Model listing (verbose only)
      if (opts.verbose && available) {
        try {
          const models = await provider.listModels();
          const count = models.length;
          if (count > 0) {
            logger.success(`✅ ${count} model(s) available`);
            if (opts.verbose) {
              console.log('');
              for (const m of models.slice(0, 10)) {
                console.log(`     • ${m.id}`);
              }
              if (count > 10) {
                console.log(`     ... and ${count - 10} more`);
              }
            }
          } else {
            logger.warn('⚠️  No models found');
          }
        } catch {
          logger.warn('⚠️  Could not list models');
        }
      }

      // Active model info
      const active = readActiveModelState();
      if (active && active.provider === targetProvider) {
        console.log('');
        logger.success(`📌 Active model: ${active.model}`);
      }

      console.log('');
      logger.info('Run `buff doctor` for a full system health check.');
      console.log('');

    } catch (err) {
      logger.error(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log('');
    }
  }

  // ── Interactive prompt ─────────────────────────────────────────────────

  private async promptSwitchIfWanted(): Promise<void> {
    console.log('');
    const answer = await inquirer.prompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: 'Would you like to switch providers/models?',
        prefix: '🔄',
        choices: [
          { name: '🎯  Yes, show me the model picker', value: 'switch' },
          { name: '❌  No, keep current configuration', value: 'keep' },
        ],
      },
    ]);

    console.log('');

    if (answer.action === 'switch') {
      await this.switchProvider(undefined, {});
    }
  }
}
