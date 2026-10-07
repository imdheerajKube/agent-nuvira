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
 *   nuvira model                           — Show current config + interactive switch
 *   nuvira model list                      — List all providers and their status
 *   nuvira model switch                    — Interactive categorized model picker
 *   nuvira model switch groq               — Switch to groq (default model)
 *   nuvira model switch groq/llama-3.3-70b — Switch to specific model
 *   nuvira model info                      — Show detailed current config
 *   nuvira model recommend                 — Show model routing recommendations
 *   nuvira model health                    — Quick health check for active provider
 */

import { Command } from 'commander';
import { formatCount } from '../utils/format.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import inquirer from 'inquirer';
import { resolveNuviraHome } from '../config/paths.js';

import { BaseCommand, getCliName } from './commands.js';
import { showModelPicker } from './model-picker.js';
import { ProviderFactory } from '../inference/factory.js';
import { CATALOG_PROVIDER_IDS } from '../inference/provider-catalog.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { recommendModel } from '../learning/model-router.js';
import type { ProviderType, ProviderConfig, BuffConfig } from '../config/types.js';
import { getModelBadge } from '../inference/model-catalog.js';
import { getHybridRouter } from '../learning/hybrid-router.js';
import {
  AUTO_MODEL,
  AUTO_PROVIDER,
  getAutoRouter,
  isAutoModel,
  isAutoProvider,
  PIIPolicyError,
  GovernancePolicyError,
  type AutoModelRouter,
  type RoutingDimension,
} from '../learning/auto-router.js';
import { buildAutoResolveOptions } from '../learning/resolve-options.js';
import { parseRequestSync } from '../nlu/parser.js';
import { resolveDispatch } from '../nlu/actions.js';
import { recordRoutingDecision, getExplainSnapshots, type RoutingHistoryEntry, type RoutingSnapshot } from '../learning/routing-history.js';
import { diffRoutingDecisions, formatDecisionDiff } from '../learning/decision-diff.js';
import {
  getRouterBandit,
  COMPLEXITY_BUCKETS,
  type RouterBanditState,
} from '../learning/router-bandit.js';
import { getQuotaLedger } from '../learning/quota-ledger.js';
import { getModelRegistry } from '../learning/model-registry.js';
import {
  ENTITLEMENT_LABEL,
  areTwins,
  classifyPairEntitlement,
  entitlementNote,
} from '../learning/pair-entitlement.js';
import { identityKey, identityProvenance } from '../learning/model-identity.js';
import {
  DEFAULT_PRIORS,
  capabilityLines,
  deriveTier,
  effectiveParameter,
  type CapabilityParameter,
} from '../learning/capability-evidence.js';
import { externalPriorsFor } from '../learning/catalog-feed.js';
import { getProviderFallback } from '../learning/provider-fallback.js';
import {
  getRouterPromotion,
  DEFAULT_MIN_PROMOTION_DECISIONS,
  type PromotionStatus,
} from '../learning/router-promotion.js';
import { getMlRouter } from '../learning/ml-router.js';
import { logger } from '../utils/logger.js';

// ─── Active Model State ─────────────────────────────────────────────────────

/**
 * The runtime state file that preserves the active model across sessions.
 * Other commands (chat, execute) can read this to know which model to use.
 * Path: ~/.nuvira/active-model.json
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

const NUVIRA_DIR = resolveNuviraHome();
const ACTIVE_MODEL_PATH = join(NUVIRA_DIR, 'active-model.json');

function ensureBuffDir(): void {
  if (!existsSync(NUVIRA_DIR)) {
    mkdirSync(NUVIRA_DIR, { recursive: true });
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
  auto: '🤖',
};

const PROVIDER_LABELS: Record<string, string> = {
  local: 'Ollama (Local)',
  nim: 'NVIDIA NIM',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  auto: 'Auto (Agent decides)',
};

const PROVIDER_ELIGIBILITY: Record<string, string> = {
  local: 'Works offline — install Ollama: brew install ollama',
  nim: 'Set NVIDIA_NIM_API_KEY (get at build.nvidia.com)',
  gemini: 'Set GEMINI_API_KEY (get at aistudio.google.com/apikey)',
  openrouter: 'Set OPENROUTER_API_KEY (get at openrouter.ai/keys)',
  groq: 'Set GROQ_API_KEY (get at console.groq.com)',
};

/**
 * Sample tasks used by `nuvira model explain` (no-task mode) to walk every
 * complexity level. Shared by the human rendering and the --json output so
 * they never drift apart.
 */
const EXPLAIN_SAMPLES: Array<{ label: string; task: string }> = [
  { label: '🟢 trivial', task: 'format this code' },
  { label: '🔵 simple', task: 'add a simple utility function' },
  { label: '🟡 moderate', task: 'implement JWT authentication with refresh tokens' },
  { label: '🟠 complex', task: 'design a distributed event-driven microservices architecture' },
  { label: '🔴 critical', task: 'deploy to production with zero downtime' },
];

/** Repeatable `--exclude-provider <provider>` collector. */
function collectProvider(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

/**
 * Item 14 — the runtime-only inputs `model explain` otherwise cannot see. A
 * live turn carries a context-payload token count and a set of providers that
 * already failed THIS SESSION; without them `explain` answers a hypothetical.
 * These are the two a user can reproduce offline.
 */
interface ExplainRuntimeInputs {
  /** Prompt tokens the runtime would have seen (context preflight basis). */
  contextTokens?: number;
  /** Providers failed this session — sunk by scoring, as the runtime does. */
  excludeProviders?: string[];
}

/**
 * A session failure sinks a provider by scoring exactly like a live cooldown
 * (`circuitBreakerStatus`). Any positive value parks it, so this is not a real
 * duration — it says "this provider is out for this decision".
 */
const SESSION_EXCLUDE_COOLDOWN_MS = 60_000;

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
      .option('-j, --json', 'Output as JSON (for scripting and IDE integration)', false)
      .action(async (opts) => this.listProviders(opts));

    cmd
      .command('switch [providerAndModel]')
      .description('Switch active provider/model (interactive or via argument). Use `auto` for smart routing')
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
      .command('explain [task]')
      .description('Explain Auto model routing — why a provider/model would be picked for a task')
      .option('-a, --agent <type>', 'Agent type to route for (default: chat)', 'chat')
      .option('-j, --json', 'Output as JSON (for scripting and CI)', false)
      .option('--since <ref>', 'P3-M3.3: diff against a previous decision — an explain id, @n (nth most recent explain), or an epoch-ms timestamp', undefined)
      .option('--context-tokens <n>', 'Item 14: the prompt token count the runtime would have seen (context preflight basis) — reproduce a decision made with a large history', undefined)
      .option('--exclude-provider <provider>', 'Item 14: a provider already failed THIS SESSION, repeatable — it sinks by scoring exactly as the runtime excludes it', collectProvider, [] as string[])
      .action((task: string | undefined, opts: { agent?: string; json?: boolean; since?: string; contextTokens?: string; excludeProvider?: string[] }) =>
        this.showExplain(task, {
          agent: opts.agent,
          json: opts.json,
          since: opts.since,
          contextTokens: opts.contextTokens !== undefined ? Number(opts.contextTokens) : undefined,
          excludeProviders: opts.excludeProvider,
        }),
      );

    cmd
      .command('health')
      .description('Quick health check for the currently active provider')
      .option('-p, --provider <provider>', 'Check a specific provider instead')
      .option('--verbose', 'Show detailed diagnostic info', false)
      .action(async (opts) => {
        await this.checkHealth(opts);
      });

    cmd
      .command('bandit [action]')
      .description('Show learning-router bandit state (Thompson-sampling priors per provider × complexity bucket). Action: reset')
      .option('-j, --json', 'Output as JSON (for scripting and CI)', false)
      .action((action: string | undefined, opts: { json?: boolean }) => this.showBandit(action, opts));

    cmd
      .command('ml [action]')
      .description('Show the ML task-similarity router state (learned outcomes per provider, kNN over task features). Action: reset')
      .option('-j, --json', 'Output as JSON (for scripting and CI)', false)
      .action((action: string | undefined, opts: { json?: boolean }) => this.showMl(action, opts));

    cmd
      .command('quota [action] [provider]')
      .description('Show the central quota ledger (tokens/requests per provider × model, reset windows, parked state). Actions: reset | set <provider> | clear <provider>')
      .option('-j, --json', 'Output as JSON (for scripting and CI)', false)
      .option('-t, --tokens <n>', 'Max tokens per reset window (with `set <provider>`; the user-declared daily budget)', parseInt)
      .option('-r, --requests <n>', 'Max requests per reset window (with `set <provider>`)', parseInt)
      .option('-w, --window-ms <n>', 'Reset window length in ms, default 24h (with `set <provider>`)', parseInt)
      .option('-c, --cost-usd <n>', 'Admin hard max cost per call — writes routing.governance.maxCostUsd (with `set <provider>`)', parseFloat)
      .action((action: string | undefined, provider: string | undefined, opts: { json?: boolean; tokens?: number; requests?: number; windowMs?: number; costUsd?: number }) =>
        this.showQuota(action, provider, opts));

    // Default action (no subcommand): show info and offer to switch
    cmd
      .action(async () => {
        await this.showInfo({ verbose: false });
        await this.promptSwitchIfWanted();
      });

    return cmd;
  }

  // ── Subcommand: list ───────────────────────────────────────────────────

  private async listProviders(opts: { all?: boolean; json?: boolean }): Promise<void> {
    /**
     * The provider set the ROUTER uses — not a hand-written list of five.
     *
     * `rankAvailableProviders` (the router's source of truth) builds its candidate
     * set from the catalog PLUS whatever the user configured. A literal array here
     * made `model list` disagree with routing about which providers even exist:
     * measured live, a machine whose turns were served by `deepseek` — with the
     * debug header and the trace both naming it — printed only
     * local/groq/nim/gemini/openrouter, so `deepseek` (and every other catalog
     * provider: bedrock, openai, mistral, …) was invisible in the one command whose
     * whole job is "what can I use?". One source, one inventory.
     *
     * The familiar five keep their place at the top so the table does not reorder
     * itself for existing users; the rest follow in catalog order.
     */
    const builtinTypes: string[] = (() => {
      const preferred = ['local', 'groq', 'nim', 'gemini', 'openrouter'];
      let configured: string[] = [];
      try {
        configured = Object.keys(this.configManager.getAll().providers ?? {});
      } catch {
        // Best-effort — an unreadable config must not empty the table.
      }
      const all = new Set([...preferred, ...CATALOG_PROVIDER_IDS, ...configured]);
      return [...all];
    })();
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

    // ── JSON output (for scripting / IDE integration) ───────────────
    if (opts.json) {
      console.log(JSON.stringify({
        active,
        providers: results,
      }, null, 2));
      return;
    }

    // ── Render ─────────────────────────────────────────────────────────
    console.log('  ┌──────────────────────────────────┬──────────┬──────────┬──────────────────┐');
    console.log('  │ Provider                         │ Status   │ Available│ Model            │');
    console.log('  ├──────────────────────────────────┼──────────┼──────────┼──────────────────┤');

    // Usable first. The table now carries the WHOLE catalog (so it agrees with
    // routing), which means most rows are providers this machine has no key for.
    // Putting the callable ones on top keeps the answer to "what can I use?" in
    // the first few lines rather than below a dozen `Needs key` rows. Stable
    // sort, so the familiar five keep their relative order.
    const rankOf = (r: (typeof results)[number]): number =>
      r.available ? 0 : r.configured ? 1 : 2;
    const ordered = [...results].sort((a, b) => rankOf(a) - rankOf(b));

    for (const r of ordered) {
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

    // ── A1: the SAME model, opposite verdicts ──────────────────────────────
    // Two rows for one model can disagree completely (`openrouter` refuses a
    // model `deepseek` serves), and the table above shows only each provider's own
    // default — so the pair was invisible. Print only the groups whose verdicts
    // genuinely DISAGREE: same identity, different answer about whether it can be
    // called. Each verdict is read from its own row (identity groups capability
    // and legibility, never availability).
    try {
      const registry = getModelRegistry();
      const rows = registry.getTrackedProviders().flatMap((p) => registry.getAllModelsForProvider(p));
      const groups = new Map<string, typeof rows>();
      for (const r of rows) {
        const key = identityKey(r.model);
        if (!key) continue;
        const list = groups.get(key);
        if (list) list.push(r);
        else groups.set(key, [r]);
      }
      const mixed = [...groups.values()].filter(
        (g) => new Set(g.map((r) => classifyPairEntitlement(r))).size > 1,
      );
      if (mixed.length > 0) {
        console.log('');
        logger.highlight('  ── The same model, different verdicts (A1) ──');
        for (const g of mixed.slice(0, 5)) {
          console.log(`   ${g[0].model}`);
          for (const r of g) {
            const e = classifyPairEntitlement(r);
            console.log(`     ${ENTITLEMENT_LABEL[e]} ${r.provider} — ${entitlementNote(e, r)}`);
          }
        }
        if (mixed.length > 5) console.log(`   … and ${mixed.length - 5} more.`);
      }
    } catch {
      // Best-effort — this section must never break `model list`.
    }

    console.log('');
    logger.info('Run `nuvira model switch` to change the active provider/model.');
    logger.info('Run `nuvira doctor` for full diagnostic checks.');
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
   * Special-cases `auto` — the agent decides the best provider/model per task.
   */
  private async doSwitch(provider: string, model?: string): Promise<void> {
    // ── Auto mode: agent decides per task ─────────────────────────────────
    if (isAutoProvider(provider) || isAutoModel(model)) {
      saveActiveModelState({
        provider: AUTO_PROVIDER,
        model: AUTO_MODEL,
        explicit: true,
        providerLabel: 'Auto (Agent decides)',
      });
      console.log('');
      logger.success('🤖  Auto routing enabled');
      console.log('   Agent-Nuvira will pick the best provider/model for each task');
      console.log('   based on complexity, cost, latency, privacy, and reliability.');
      console.log('');
      logger.info('Run `nuvira model switch <provider>` to pin a specific provider instead.');
      console.log('');
      return;
    }

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
      logger.info('This model will be used by default for `nuvira chat`, `nuvira execute`, and other commands.');
      console.log('');
    } catch (err) {
      logger.error(`Failed to switch: ${err instanceof Error ? err.message : String(err)}`);
      logger.info('Use `nuvira model list` to see available providers.');
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
      logger.info('  Run `nuvira model switch` to select one.');
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
    logger.info('Run `nuvira model switch` to change providers.');
    logger.info('Run `nuvira model list` to see availability status.');
    console.log('');
  }

  // ── Subcommand: explain ───────────────────────────────────────────────

  private showExplain(
    task: string | undefined,
    opts: { agent?: string; json?: boolean; since?: string } & ExplainRuntimeInputs,
  ): void {
    const router = getAutoRouter();
    const agentType = opts.agent || 'chat';
    const runtime: ExplainRuntimeInputs = {
      contextTokens: opts.contextTokens,
      excludeProviders: opts.excludeProviders,
    };

    if (opts.json) {
      try {
        console.log(JSON.stringify(this.buildExplainJSON(router, agentType, task, opts.since, runtime), null, 2));
      } catch (err) {
        // A PII/governance policy block must not crash the JSON contract —
        // emit a machine-readable error object instead.
        if (err instanceof PIIPolicyError || err instanceof GovernancePolicyError) {
          console.log(JSON.stringify({
            error: (err as Error).message,
            governanceBlocked: err instanceof GovernancePolicyError ? err.blocked : undefined,
          }, null, 2));
          return;
        }
        throw err;
      }
      return;
    }

    console.log('');
    logger.highlight('═══  Auto Model Routing — Explain  ═══');
    console.log('');
    // Item 14 — say plainly what this decision could NOT see, so an offline
    // answer is never read as the live one. `explain` has no session: a
    // continuation's routing text and the session's failed-provider set exist
    // only at runtime, and both change the pick.
    logger.info(
      `Runtime inputs: context ${runtime.contextTokens !== undefined ? `~${runtime.contextTokens} tokens` : '(estimated from the task)'} · ` +
        `excluded providers: ${runtime.excludeProviders?.length ? runtime.excludeProviders.join(', ') : 'none'}`,
    );
    logger.info(
      'A live session also carries its own failed-provider set; pass --exclude-provider to reproduce it, and --context-tokens to match a large history.',
    );
    console.log('');

    if (task) {
      logger.info(`Task: "${task}"  ·  Agent: ${agentType}`);
      console.log('');
      try {
        // P3-M3.3: `--since <ref>` renders a before → after diff against a
        // previous explain snapshot instead of the full decision view.
        if (opts.since) {
          this.renderRoutingDecisionDiff(router, agentType, task, opts.since, runtime);
        } else {
          this.renderRoutingDecision(router, agentType, task, false, runtime);
        }
      } catch (err) {
        // A PII/governance policy block renders cleanly (with the audit trail)
        // instead of crashing `nuvira model explain` with a raw stack trace.
        if (err instanceof PIIPolicyError || err instanceof GovernancePolicyError) {
          this.renderPolicyBlock(err);
        } else {
          throw err;
        }
      }
      return;
    }

    // `--since` requires a task to diff.
    if (opts.since) {
      logger.error('`--since` requires a task — diff two decisions for the SAME task, e.g. `nuvira model explain "add auth" --since @1`');
      return;
    }

    // No task given — walk through sample tasks across all complexity levels
    for (const s of EXPLAIN_SAMPLES) {
      logger.highlight(`  ${s.label} — "${s.task}"`);
      try {
        this.renderRoutingDecision(router, agentType, s.task, true, runtime);
      } catch (err) {
        // A single sample that violates a PII/governance policy renders the
        // block inline and keeps walking the remaining samples.
        if (err instanceof PIIPolicyError || err instanceof GovernancePolicyError) {
          this.renderPolicyBlock(err);
        } else {
          throw err;
        }
      }
      console.log('');
    }

    console.log('');
    logger.info('Pass a task for a single detailed decision: `nuvira model explain "your task"`');
    logger.info('Route for a specific agent: `nuvira model explain --agent writer "your task"`');
    logger.info('JSON for scripting/CI: `nuvira model explain "your task" --json`');
    console.log('');
  }

  /**
   * Render a PII/governance policy block cleanly (M2.4 auditability): the
   * message plus, for governance, the full eliminated-provider audit trail.
   */
  private renderPolicyBlock(err: PIIPolicyError | GovernancePolicyError): void {
    console.log('');
    logger.error(`  ⛔ ${err.message}`);
    if (err instanceof GovernancePolicyError) {
      for (const b of err.blocked) {
        console.log(`     • ${b.provider} — ${b.reason}`);
      }
    }
    console.log('');
  }

  /**
   * Build a machine-readable explanation payload.
   * Single task → one decision object; no task → all 5 sample complexities.
   * Includes effective per-provider pricing (with override flags).
   */
  private buildExplainJSON(
    router: AutoModelRouter,
    agentType: string,
    task: string | undefined,
    since?: string,
    runtime: ExplainRuntimeInputs = {},
  ): Record<string, unknown> {
    const toJSON = (t: string, agent: string): Record<string, unknown> => {
      const d = this.resolveExplainDecision(router, agent, t, runtime);
      const snapshot = this.buildSnapshot(d);
      // Record the explain snapshot for the dashboard audit trail + usage stats
      // (JSON mode returns early in showExplain, so this is the only hook here)
      recordRoutingDecision({
        source: 'explain',
        agentType: agent,
        task: t,
        complexity: d.complexity,
        provider: d.provider,
        model: d.model,
        score: d.score,
        snapshot,
      });
      // P3-M3.3: structured diff against a previous decision when --since.
      const diff = since
        ? this.buildDecisionDiffJSON(this.resolveExplainRef(since), snapshot)
        : undefined;
      const pricingOverrides = this.configManager.getAll().pricing || {};
      const pricing: Record<string, { inputPer1K: number; outputPer1K: number; overridden: boolean }> = {};
      for (const r of d.ranked) {
        const p = router.getProviderPricing(r.provider, this.configManager);
        pricing[r.provider] = {
          inputPer1K: p.inputPer1K,
          outputPer1K: p.outputPer1K,
          overridden: !!pricingOverrides[r.provider],
        };
      }
      return {
        task: t,
        agentType: agent,
        complexity: d.complexity,
        taskType: d.taskType,
        weights: d.weights,
        winner: {
          provider: d.provider,
          model: d.model,
          score: Math.round(d.score * 1000) / 1000,
        },
        ranked: d.ranked.map((r) => ({
          provider: r.provider,
          score: Math.round(r.score * 1000) / 1000,
          inCooldown: r.inCooldown,
          reason: r.reason,
          dimensions: r.dimensions,
          capabilityFit: r.capabilityFit !== undefined ? Math.round(r.capabilityFit * 100) : undefined,
          // M2.2: measured vs estimated cost basis for this provider.
          costSource: r.costSource || 'estimated',
          costBasis: r.costBasis ? { inputTokens: r.costBasis.inputTokens, outputTokens: r.costBasis.outputTokens } : undefined,
        })),
        fallbackChain: d.fallbackChain.map((c) => ({
          provider: c.provider,
          model: c.model,
          qualityScore: Math.round(c.qualityScore * 1000) / 1000,
          reason: c.reason,
        })),
        // M2.4: providers eliminated by the governance policy (with reason) —
        // empty array when no policy blocks.
        governanceBlocked: (d.governanceBlocked || []).map((b) => ({ provider: b.provider, reason: b.reason })),
        // M2.5: context preflight snapshot — estimated prompt size, its basis
        // (task text vs caller-provided payload), and per-provider utilization
        // against the nominal input window. Present only when the context-fit
        // signal is enabled (routing.contextFit, default ON).
        context: d.contextPreflight
          ? {
              estimatedPromptTokens: d.contextPreflight.estimatedPromptTokens,
              basis: d.contextPreflight.basis,
              providers: d.contextPreflight.providers.map((p) => ({
                provider: p.provider,
                contextWindowTokens: p.contextWindowTokens,
                utilization: p.utilization !== undefined ? Math.round(p.utilization * 100) / 100 : undefined,
                fit: p.fit !== undefined ? Math.round(p.fit * 100) / 100 : undefined,
              })),
            }
          : undefined,
        pricing,
        explanation: d.explanation,
        // Item 14 — the runtime inputs this decision was reproduced with, so a
        // script can tell a hypothetical from a reproduced live decision.
        runtimeInputs: {
          contextTokens: runtime.contextTokens,
          excludedProviders: runtime.excludeProviders ?? [],
        },
        ...(diff ? { diff } : {}),
      };
    };

    if (task) return toJSON(task, agentType);

    return {
      agentType,
      decisions: EXPLAIN_SAMPLES.map((s) => toJSON(s.task, agentType)),
    };
  }

  /**
   * D4 — resolve an explain decision through the SAME options the RUNTIME uses.
   *
   * `chat.ts` layers two things on top of the shared resolve-options assembly
   * before calling the router, and `explain` passed neither:
   *
   * - `circuitBreakerStatus`, which is what SUNKS a provider sitting in a
   *   cooling-down circuit breaker. Without it every row looked healthy and
   *   `explain` could name a provider the runtime would never serve.
   * - the NLU `taskIntentHint`, which the runtime derives from the same task
   *   string via `parseRequestSync`/`resolveDispatch` and which overrides the
   *   profile's intent (e.g. a creative ask), so the two could classify one
   *   task differently.
   *
   * Sharing the assembly is the only way the two can agree: both divergences
   * were options the explain path never passed. The NLU derivation is
   * deterministic in the task text, so seeding it here is reproducing the
   * runtime's assembly, not guessing.
   */
  private resolveExplainDecision(
    router: AutoModelRouter,
    agentType: string,
    task: string,
    runtime: ExplainRuntimeInputs = {},
  ) {
    let circuitBreakerStatus: Array<{ provider: string; cooldownRemaining: number }> = [];
    try {
      circuitBreakerStatus = getProviderFallback(this.configManager).getCircuitBreakerStatus();
    } catch {
      // Best-effort — a breaker read must never break `explain`.
    }
    // Item 14 — the session's failed-provider set exists only at runtime, so
    // `explain` could not see it and could name a provider the session had
    // already parked. Fold each caller-named exclusion in as an active cooldown:
    // the router sinks it by scoring, exactly as it sinks a live failure.
    if (runtime.excludeProviders?.length) {
      const byProvider = new Map(circuitBreakerStatus.map((c) => [c.provider, c.cooldownRemaining]));
      for (const p of runtime.excludeProviders) {
        byProvider.set(p, Math.max(byProvider.get(p) ?? 0, SESSION_EXCLUDE_COOLDOWN_MS));
      }
      circuitBreakerStatus = [...byProvider].map(([provider, cooldownRemaining]) => ({ provider, cooldownRemaining }));
    }
    // Same NLU seed as the runtime: one parser call on the same text, so an
    // intent the runtime honours is never invisible to `explain`.
    let taskIntentHint: ReturnType<typeof resolveDispatch>['taskIntentHint'];
    try {
      taskIntentHint = resolveDispatch(parseRequestSync(task)).taskIntentHint;
    } catch {
      // Best-effort — a parse failure must never break `explain`.
    }
    return router.resolve(
      agentType,
      task,
      {
        // Item 14 — the context preflight is part of the pickup, so the token
        // count the runtime saw must reach it; otherwise `explain` estimates
        // from the task and can name a different provider under a large history.
        ...buildAutoResolveOptions(this.configManager, { contextHintTokens: runtime.contextTokens }),
        circuitBreakerStatus,
        ...(taskIntentHint ? { taskIntentHint } : {}),
      },
      this.configManager,
    );
  }

  /**
   * Build a RoutingSnapshot from a live decision — the ranked breakdown with
   * dimensions and governance context, persisted with explain decisions so
   * `--since` can diff two snapshots (P3-M3.3).
   */
  private buildSnapshot(decision: {
    complexity: string;
    taskType?: string;
    weights: Record<string, number>;
    provider: string;
    model: string;
    score: number;
    ranked: Array<{
      provider: string;
      score: number;
      reason: string;
      capabilityFit?: number;
      costSource?: 'measured' | 'estimated';
      contextFit?: number;
    }>;
    fallbackChain: Array<{ provider: string; model: string; reason: string }>;
    governanceBlocked?: Array<{ provider: string; reason: string }>;
  }): RoutingSnapshot {
    return {
      complexity: decision.complexity,
      taskType: decision.taskType,
      weights: decision.weights,
      winner: { provider: decision.provider, model: decision.model, score: decision.score },
      ranked: decision.ranked.map((r) => ({
        provider: r.provider,
        score: r.score,
        reason: r.reason,
        capabilityFit: r.capabilityFit,
        costSource: r.costSource || 'estimated',
        contextFit: r.contextFit,
      })),
      fallbackChain: decision.fallbackChain.map((c) => ({ provider: c.provider, model: c.model, reason: c.reason })),
      governanceBlocked: (decision.governanceBlocked || []).map((b) => ({ provider: b.provider, reason: b.reason })),
    };
  }

  /**
   * Resolve a `--since` ref: an explain entry id, `@n` (nth most recent
   * explain with a snapshot), or an epoch-ms timestamp (closest at-or-before).
   */
  private resolveExplainRef(ref: string): RoutingHistoryEntry | null {
    const snaps = getExplainSnapshots(500);
    if (/^@\d+$/.test(ref)) {
      const idx = parseInt(ref.slice(1), 10);
      return snaps[idx - 1] ?? null;
    }
    const byId = snaps.find((e) => e.id === ref);
    if (byId) return byId;
    if (/^\d+$/.test(ref)) {
      const ts = parseInt(ref, 10);
      return snaps.find((e) => e.timestamp <= ts) ?? null;
    }
    return null;
  }

  /** Structured diff payload for --json mode (null when no prior snapshot). */
  private buildDecisionDiffJSON(
    prev: RoutingHistoryEntry | null,
    cur: RoutingSnapshot,
  ): Record<string, unknown> | undefined {
    if (!prev?.snapshot) return undefined;
    const diff = diffRoutingDecisions(prev.snapshot, cur);
    return {
      against: { id: prev.id, timestamp: prev.timestamp, task: prev.task },
      winnerChanged: diff.winnerChanged,
      prevWinner: diff.prevWinner,
      curWinner: diff.curWinner,
      candidates: diff.candidates,
      weightDeltas: diff.weightDeltas,
      governance: diff.governance,
      gates: diff.gates,
    };
  }

  /**
   * P3-M3.3: resolve the previous explain decision and render the before →
   * after diff for the current decision (which is also recorded).
   */
  private renderRoutingDecisionDiff(
    router: AutoModelRouter,
    agentType: string,
    task: string,
    ref: string,
    runtime: ExplainRuntimeInputs = {},
  ): void {
    const prev = this.resolveExplainRef(ref);
    const decision = this.resolveExplainDecision(router, agentType, task, runtime);
    const snapshot = this.buildSnapshot(decision);
    recordRoutingDecision({
      source: 'explain',
      agentType,
      task,
      complexity: decision.complexity,
      provider: decision.provider,
      model: decision.model,
      score: decision.score,
      snapshot,
    });

    console.log('');
    logger.highlight('═══  Auto Model Routing — Decision Diff (P3-M3.3)  ═══');
    console.log('');
    if (!prev?.snapshot) {
      logger.warn(`  No prior explain snapshot found for ref "${ref}" (${getExplainSnapshots(1).length === 0 ? 'no explain history yet — run a plain `nuvira model explain "task"` first' : 'that ref does not match an explain decision'}).`);
      console.log('');
      return;
    }
    const diff = diffRoutingDecisions(prev.snapshot, snapshot);
    console.log(formatDecisionDiff(diff, {
      task,
      refLabel: `${prev.id} · ${new Date(prev.timestamp).toLocaleString()} · "${prev.task.slice(0, 60)}"`,
    }));
    console.log('');
    logger.info('Refs: an explain id · @n (nth most recent) · epoch ms. Run `nuvira model explain "task"` to record a new snapshot.');
    console.log('');
  }

  /** Render a single routing decision (compact or detailed). */
  private renderRoutingDecision(
    router: AutoModelRouter,
    agentType: string,
    task: string,
    compact = false,
    runtime: ExplainRuntimeInputs = {},
  ): void {
    const decision = this.resolveExplainDecision(router, agentType, task, runtime);
    // Record the explain snapshot for the dashboard audit trail + usage stats
    recordRoutingDecision({
      source: 'explain',
      agentType,
      task,
      complexity: decision.complexity,
      provider: decision.provider,
      model: decision.model,
      score: decision.score,
      snapshot: this.buildSnapshot(decision),
    });

    if (compact) {
      console.log(`  → ${decision.provider}/${decision.model}  (score ${decision.score.toFixed(2)}, ${decision.complexity})`);
      return;
    }

    console.log(`  Complexity: ${decision.complexity}  ·  Task type: ${decision.taskType}`);
    console.log('');

    logger.highlight('  ── Dimension weights ──');
    for (const dim of Object.keys(decision.weights) as RoutingDimension[]) {
      const pct = Math.round(decision.weights[dim] * 100);
      const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '░');
      console.log(`   ${dim.padEnd(12)} ${bar} ${pct}%`);
    }
    console.log('');

    logger.highlight('  ── Ranked providers ──');
    // D5 — the list is ordered by AVAILABILITY FIRST (a cooling-down provider
    // sinks, then a quota-parked one, and only then by score within each group),
    // because that IS the routing precedence. But only `score` was printed, so a
    // lower-scored healthy row sitting above a higher-scored cooling one read as
    // an unsorted list (measured: 0.351, 0.465, 0.397, 0.396). The ranking was
    // never wrong — the header was silent about the key. State it, so the display
    // can never appear to contradict the numbers it prints.
    console.log('   (ordered availability-first — cooling-down, then quota-parked, then score within each group)');
    decision.ranked.forEach((r, i) => {
      const mark = r.provider === decision.provider ? '✅' : '  ';
      const cd = r.inCooldown ? '  (circuit-breaker cooldown)' : r.quotaParked ? '  (quota-parked)' : '';
      const fit = r.capabilityFit !== undefined ? ` 🎯 fit ${Math.round(r.capabilityFit * 100)}%` : '';
      // M2.2/visibility: cost source on EVERY ranked row — 📏 measured (with
      // the real wire-token basis) or 📐 estimated (length-based default).
      const costTag =
        r.costSource === 'measured' && r.costBasis
          ? ` 📏 measured ${r.costBasis.inputTokens}→${r.costBasis.outputTokens} tok`
          : ' 📐 estimated';
      // M2.5: context-utilization chip on every ranked row when the preflight
      // signal is on (⏳ % of the provider's nominal input window).
      const ctxTag =
        r.contextFit !== undefined && r.contextWindowTokens !== undefined
          ? ` ⏳ ctx ${Math.round((r.contextUtilization ?? 0) * 100)}% (${formatCount(r.contextWindowTokens)} tok)`
          : '';
      // P4 M4.4: mid-stream flakiness chip — the reliability penalty applied
      // to providers that keep starting streams that die before completion.
      const flakyTag = r.flakiness !== undefined && r.flakiness > 0
        ? ` ⏸ flaky ${Math.round(r.flakiness * 100)}%`
        : '';
      console.log(`   ${mark} ${i + 1}. ${r.provider.padEnd(12)} score ${r.score.toFixed(3)}  ${r.reason}${fit}${costTag}${ctxTag}${flakyTag}${cd}`);
    });
    console.log('');

    logger.success(`  Decision: ${decision.provider}/${decision.model}`);
    console.log(`  ${decision.explanation}`);

    // D7 — PAIR ENTITLEMENT (2026-10-07). Rank said WHICH model; it never said
    // whether this ACCOUNT may call it. The reported case was four providers
    // offering one model where only one key had access — identical ranks, so the
    // decision was not explainable from the ranking at all. Print the verdict for
    // the chosen pair, and every same-model twin on another provider with ITS
    // OWN verdict, so "why this provider and not that one" is answerable from the
    // output instead of from the registry file. Twins are grouped by the honest
    // exact/bare-id rule (`areTwins`), and each verdict is read from its own row —
    // never inherited from a sibling.
    try {
      const registry = getModelRegistry();
      const chosenEntry = registry.getEntry(decision.provider, decision.model);
      const chosen = classifyPairEntitlement(chosenEntry);
      const twins = registry
        .getTrackedProviders()
        .flatMap((p) => registry.getAllModelsForProvider(p))
        .filter((e) => e.provider !== decision.provider && areTwins(e.model, decision.model));
      if (chosen !== 'funded' || twins.length > 0) {
        console.log('');
        logger.highlight('  ── Pair entitlement ──');
        console.log(
          `   ${ENTITLEMENT_LABEL[chosen]} ${decision.provider}/${decision.model} — ${entitlementNote(chosen, chosenEntry)}`,
        );
        if (twins.length > 0) {
          // WHERE the grouping came from: a declared alias is an assertion, the
          // bare-id rule is a derivation, and a reader must be able to tell them
          // apart (`learning/model-identity.ts`).
          const provenance = identityProvenance(decision.model);
          console.log(
            `   (grouped as the same model${provenance ? ` — ${provenance}` : ' — exact/bare id rule'})`,
          );
        }
        for (const t of twins) {
          const e = classifyPairEntitlement(t);
          console.log(`   ${ENTITLEMENT_LABEL[e]} ${t.provider}/${t.model} — ${entitlementNote(e, t)}`);
        }
      }
    } catch {
      // Best-effort — an audit section must never break `model explain`.
    }

    // Bundle 3b — CAPABILITY BY MEASUREMENT. The scorecard the decision was made
    // from, in the terms the user asked for: five named parameters, each with its
    // SAMPLE COUNT, so a number can be weighed instead of trusted. A parameter on
    // 0 samples is the declared prior by definition (`capability-evidence.ts`),
    // which is why it is labelled rather than hidden — a bare number with no
    // basis was the defect, and the same number printed as "prior" is honest.
    try {
      const router = getAutoRouter();
      const registry = getModelRegistry();
      const base = router.getCapabilities(decision.provider);
      const record = registry.getCapability(decision.provider, decision.model);
      // §6 — the external catalogue supplies `cost`/`ecosystem` PRIORS only (never measurements), and
      // only while the feed is switched on; `externalPriorsFor` enforces that gate itself. Each one
      // carries the source it came from, so the scorecard can print a borrowed number AS borrowed.
      const external = externalPriorsFor(decision.provider, decision.model);
      const externalPriors: Partial<Record<CapabilityParameter, number>> = {};
      const priorLabels: Partial<
        Record<CapabilityParameter, { source: string; fetchedAt: number }>
      > = {};
      for (const p of external) {
        externalPriors[p.parameter] = p.value;
        priorLabels[p.parameter] = { source: p.source, fetchedAt: p.fetchedAt };
      }
      const priors: Partial<Record<CapabilityParameter, number>> = {
        accuracy: base.reasoning,
        performance: base.speed,
        ...externalPriors,
      };
      // `accuracy`'s prior is the provider's own declared baseline (the same one
      // the router's floor uses); anything the feed supplied beats the declared default, so the TIER
      // below is derived from the same value the line above prints — they cannot disagree.
      const view = (parameter: CapabilityParameter) =>
        parameter === 'accuracy'
          ? effectiveParameter(record, 'accuracy', base.reasoning)
          : effectiveParameter(record, parameter, priors[parameter] ?? DEFAULT_PRIORS[parameter] ?? 0);
      console.log('');
      logger.highlight('  ── Capability scorecard (measured) ──');
      console.log(`   ${decision.provider}/${decision.model}`);
      for (const line of capabilityLines(record, priors, priorLabels)) console.log(`     ${line}`);
      console.log(`     tier ${deriveTier({ accuracy: view('accuracy'), robustness: view('robustness'), ecosystem: view('ecosystem') })}`);
      console.log('     (0 samples = the declared prior; values fold in real turns, calls and latencies — never from the model id)');
    } catch {
      // Best-effort — an audit section must never break `model explain`.
    }

    // M2.4: governance transparency — show policy-eliminated providers so the
    // user sees WHY a provider is absent from the ranking (not just that it
    // is). Renders only when the admin policy actually blocked something.
    const gBlocked = decision.governanceBlocked || [];
    if (gBlocked.length > 0) {
      console.log('');
      logger.highlight('  ── Governance policy — eliminated providers ──');
      for (const b of gBlocked) {
        console.log(`   ⛔ ${b.provider}: ${b.reason}`);
      }
    }

    // M2.5: context preflight — the estimated prompt size and each provider's
    // utilization against its nominal input window, so the soft context-fit
    // nudge is visible and auditable. Renders only when the signal is enabled
    // (routing.contextFit, default ON). Estimation only — never a hard block.
    const pre = decision.contextPreflight;
    if (pre) {
      console.log('');
      logger.highlight('  ── Context preflight (M2.5, estimation only) ──');
      console.log(`   Estimated prompt: ${formatCount(pre.estimatedPromptTokens)} tokens (basis: ${pre.basis === 'hint' ? 'caller-provided payload' : 'task text'})`);
      for (const p of pre.providers) {
        // n/a when no context data was computed for a candidate (e.g. quota-
        // parked — its scored entry omits the context fields by design); a
        // literal 0% would read as "fits easily", which is misleading.
        const utilTag = p.utilization !== undefined ? `${Math.round(p.utilization * 100)}%` : 'n/a';
        const fit = p.fit !== undefined ? ` · context-fit ${Math.round(p.fit * 100)}%` : '';
        // Guard against a missing window (defensive — the preflight builder
        // resolves one even for parked candidates, but renderers must never
        // crash a CLI command).
        const windowTag = p.contextWindowTokens !== undefined
          ? formatCount(p.contextWindowTokens)
          : 'unknown';
        console.log(`   ${p.provider.padEnd(12)} window ${windowTag} tok · utilization ${utilTag}${fit}`);
      }
      console.log('   (estimation only — models may exceed nominal windows; never a hard block)');
    }
    console.log('');

    logger.highlight('  ── Fallback chain ──');
    for (const c of decision.fallbackChain) {
      console.log(`   → ${c.provider}/${c.model}  (${c.reason})`);
    }
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

    // Agent→capability rows; the recommended model is DISCOVERED at runtime
    // from the user's keys + verified availability (never hardcoded names).
    const defaultMapping: Array<{ agent: string; icon: string }> = [
      { agent: 'planner', icon: '📋' },
      { agent: 'context-gatherer', icon: '📂' },
      { agent: 'writer', icon: '✏️' },
      { agent: 'reviewer', icon: '👁️' },
      { agent: 'tester', icon: '🧪' },
      { agent: 'debugger', icon: '🐛' },
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
    logger.highlight('  ── Runtime Recommendations (from your keys + availability) ──');
    console.log('');

    for (const { agent, icon } of defaultMapping) {
      const rec = recommendModel(agent, this.configManager);
      const label =
        rec.model && rec.model !== 'default' ? `${rec.provider}/${rec.model}` : `${rec.provider} (auto-resolved)`;
      console.log(`  ${icon} ${agent.padEnd(20)} → ${label}`);
    }

    console.log('');
    logger.info('To use routing: add `--auto-route` to `nuvira execute` commands.');
    logger.info('To set a specific model per agent: `nuvira execute --planner-model <model>`');
    console.log('');
  }

  // ── Subcommand: health ─────────────────────────────────────────────────

  private async checkHealth(opts: { provider?: string; verbose?: boolean }): Promise<void> {
    const targetProvider = opts.provider || readActiveModelState()?.provider || this.configManager.getProviderConfig().type;
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
        logger.warn('⚠️  No API key configured. Run `nuvira doctor` for setup help.');
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
      logger.info('Run `nuvira doctor` for a full system health check.');
      console.log('');

    } catch (err) {
      logger.error(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log('');
    }
  }

  // ── Subcommand: quota ─────────────────────────────────────────────────

  private showQuota(
    action: string | undefined,
    provider: string | undefined,
    opts: { json?: boolean; tokens?: number; requests?: number; windowMs?: number; costUsd?: number },
  ): void {
    if (action === 'reset') {
      getQuotaLedger().reset();
      console.log('');
      logger.success('🧹 Quota ledger cleared.');
      console.log('');
      return;
    }

    // Session 36 — user-declared budget: `nuvira model quota set <provider>`.
    // Writes the SAME config the dashboard editor writes (routing.quota + the
    // governance cost cap) so the user's number is enforced by the ledger /
    // auto-router before requests go out.
    if (action === 'set' || action === 'clear') {
      if (!provider) {
        logger.error(`\`nuvira model quota ${action}\` needs a provider: nuvira model quota ${action} <provider> [options].`);
        return;
      }
      if (action === 'clear') {
        // ConfigManager.save shallow-merges `routing` — save the FULL merged
        // quota map so sibling providers' limits are never wiped.
        const all = this.configManager.getAll();
        const quota = { ...(all.routing?.quota || {}) };
        if (!quota[provider]) {
          logger.info(`No quota limits configured for ${provider} — nothing to clear.`);
          return;
        }
        delete quota[provider];
        this.configManager.save({ routing: { quota } });
        logger.success(`🗑️  Cleared quota limits for ${provider}.`);
        return;
      }

      const { tokens, requests, windowMs, costUsd } = opts;
      if (tokens === undefined && requests === undefined && windowMs === undefined && costUsd === undefined) {
        logger.error('Nothing to set — provide at least one of --tokens / --requests / --window-ms / --cost-usd.');
        logger.info('  Example: nuvira model quota set groq --tokens 12000 --requests 14400 --cost-usd 0.10');
        return;
      }
      if ((tokens !== undefined && (isNaN(tokens) || tokens < 0)) ||
          (requests !== undefined && (isNaN(requests) || requests < 0)) ||
          (windowMs !== undefined && (isNaN(windowMs) || windowMs < 0)) ||
          (costUsd !== undefined && (isNaN(costUsd) || costUsd < 0))) {
        logger.error('Invalid limit — all values must be non-negative numbers.');
        return;
      }

      // routing.quota.<provider> — the ledger's configured-limit source.
      // ConfigManager.save shallow-merges `routing`, so save the FULL merged
      // quota map (sibling providers survive) + governance in one patch.
      const all = this.configManager.getAll();
      const quota = { ...(all.routing?.quota || {}) };
      quota[provider] = {
        ...(quota[provider] || {}),
        ...(tokens !== undefined ? { tokensPerWindow: tokens } : {}),
        ...(requests !== undefined ? { requestsPerWindow: requests } : {}),
        ...(windowMs !== undefined ? { windowMs } : {}),
      };
      const patch: Partial<BuffConfig> = { routing: { quota } };
      // Cost cap rides on the existing admin governance surface.
      if (costUsd !== undefined) {
        patch.routing!.governance = {
          ...(all.routing?.governance || {}),
          maxCostUsd: costUsd,
        };
      }
      this.configManager.save(patch);
      console.log('');
      logger.success(`✅ Budget set for ${provider}:`);
      console.log(`     tokens/window: ${tokens !== undefined ? formatCount(tokens) : (quota[provider]?.tokensPerWindow ?? 'unset')}`);
      console.log(`     requests/window: ${requests !== undefined ? formatCount(requests) : (quota[provider]?.requestsPerWindow ?? 'unset')}`);
      console.log(`     window ms: ${windowMs !== undefined ? formatCount(windowMs) : (quota[provider]?.windowMs ?? '24h default')}`);
      console.log(`     max cost/call: $${costUsd !== undefined ? costUsd : (this.configManager.getAll().routing?.governance?.maxCostUsd ?? 'unset')}`);
      console.log('');
      logger.info('The quota ledger + auto-router enforce this before requests go out; the dashboard');
      logger.info('Admin → Budget panel edits the same config. `nuvira model quota reset` clears usage.');
      return;
    }

    if (action && action !== 'reset' && action !== 'set' && action !== 'clear') {
      logger.error(`Unknown quota action: ${action}. Use \`nuvira model quota\` to view, \`nuvira model quota reset\` to reset, or \`nuvira model quota set <provider> [options]\` to declare a budget.`);
      return;
    }

    const ledger = getQuotaLedger();
    const statuses = ledger.getStatus(this.configManager);
    const summary = ledger.getCostSummary();
    const events = ledger.listEvents(20);

    if (opts.json) {
      console.log(JSON.stringify({
        enabled: statuses.length > 0,
        entries: statuses,
        costSummary: {
          freeTokens: summary.freeTokens,
          freeRequests: summary.freeRequests,
          paidTokens: summary.paidTokens,
          paidRequests: summary.paidRequests,
          estimatedSavedUsd: summary.estimatedSavedUsd,
        },
        events,
        updatedAt: Date.now(),
      }, null, 2));
      return;
    }

    console.log('');
    logger.highlight('═══  Quota Ledger  ═══');
    console.log('');
    if (statuses.length === 0) {
      logger.info('  No quota usage recorded yet.');
      console.log('');
      logger.info('  The ledger write-throughs every Auto-routed call; declare a budget to enforce:');
      logger.info('  `nuvira model quota set groq --tokens 12000 --requests 14400 --cost-usd 0.10`');
      logger.info('  (or `nuvira config set routing.quota.gemini.requestsPerWindow 1500`)');
      console.log('');
      // Still show the failover timeline — events (parked/failover) can exist
      // even before any usage is recorded.
      if (events.length > 0) {
        this.renderQuotaEvents(events);
      }
      return;
    }
    console.log(ledger.formatStatus(this.configManager));

    // ── Cost transparency (assessment #7) ────────────────────────────────
    // Free/local-first split + "what the free tokens would have cost" savings
    // estimate — mirrors the dashboard's Quota card.
    console.log('');
    logger.highlight('  ── Cost Summary (free/local-first) ──');
    console.log('');
    console.log(`   🆓 Free tokens:  ${formatCount(summary.freeTokens)}  (${formatCount(summary.freeRequests)} req)`);
    console.log(`   💳 Paid tokens:  ${formatCount(summary.paidTokens)}  (${formatCount(summary.paidRequests)} req)`);
    if (summary.estimatedSavedUsd > 0) {
      console.log(`   💰 Estimated saved: $${summary.estimatedSavedUsd.toFixed(4)}  (free-tier usage at a typical paid rate)`);
    }

    // ── Failover timeline (assessment #7) ────────────────────────────────
    this.renderQuotaEvents(events);
  }

  /** Render the quota failover timeline in the human CLI output. */
  private renderQuotaEvents(events: Array<{ type: string; provider: string; reason?: string; timestamp: number }>): void {
    if (events.length === 0) return;
    console.log('');
    logger.highlight(`  ── Failover Timeline (last ${events.length}) ──`);
    console.log('');
    for (const ev of events) {
      const icon = ev.type === 'parked' ? '⏸' : ev.type === 're-enabled' ? '🔁' : ev.type === 'released' ? '✅' : '⚡';
      const ts = new Date(ev.timestamp).toLocaleString();
      const reason = ev.reason ? `  (${ev.reason})` : '';
      console.log(`   ${icon} ${ev.type.padEnd(11)} ${ev.provider.padEnd(12)} ${reason}  ${ts}`);
    }
    console.log('');
  }

  // ── Subcommand: bandit ────────────────────────────────────────────────

  private showBandit(action: string | undefined, opts: { json?: boolean }): void {
    if (action === 'reset') {
      // Call .reset() on the INSTANCE (persists an empty state to disk), not the
      // module-level resetRouterBandit() which only drops the in-memory singleton.
      getRouterBandit().reset();
      getRouterPromotion().reset();
      console.log('');
      logger.success('✅ Bandit state reset — all Beta(α, β) priors back to Beta(1,1), promotion trajectory cleared');
      console.log('');
      return;
    }

    if (action && action !== 'reset') {
      logger.error(`Unknown bandit action: ${action}. Use \`nuvira model bandit\` to view or \`nuvira model bandit reset\` to reset.`);
      return;
    }

    const state = getRouterBandit().getState();

    if (opts.json) {
      console.log(JSON.stringify(this.buildBanditJSON(state), null, 2));
      return;
    }

    console.log('');
    logger.highlight('═══  Learning Router — Bandit State  ═══');
    console.log('');

    this.renderPromotionGate();
    console.log('');

    // v3 — bucket keys are either plain complexity ('moderate') for legacy
    // data or intent-scoped ('coding:moderate') for intent-aware learning.
    // Collect every key that actually holds data so intent buckets render.
    const allBuckets = (): string[] => {
      const keys = new Set<string>();
      for (const b of COMPLEXITY_BUCKETS) keys.add(b);
      for (const k of Object.keys(state.priors)) keys.add(k);
      return [...keys];
    };

    // Collect all providers that have any learning data
    const providers = new Set<string>();
    for (const bucket of allBuckets()) {
      for (const provider of Object.keys(state.priors[bucket] || {})) {
        providers.add(provider);
      }
    }

    if (providers.size === 0) {
      logger.info('  No bandit learning data yet.');
      console.log('');
      logger.info('  Learning is ON by default — run tasks under Auto routing (`nuvira model switch auto` / `-m auto`).');
      logger.info('  Each auto-routed task updates the Beta prior for its complexity bucket.');
      logger.info('  Disable: `nuvira config set routing.bandit false`');
      console.log('');
      return;
    }

    const sortedProviders = [...providers].sort();

    // Table: rows = providers, columns = buckets (plain first, then intent)
    const buckets = allBuckets();
    const colWidth = 15;
    const header = `  ${'Provider'.padEnd(12)}${buckets.map((b) => b.padStart(colWidth)).join('')}`;
    console.log(header);
    console.log(`  ${'-'.repeat(header.length - 2)}`);

    for (const provider of sortedProviders) {
      const cells = buckets.map((bucket) => {
        const prior = state.priors[bucket]?.[provider];
        if (!prior) return ''.padStart(colWidth);
        const mean = prior.alpha / (prior.alpha + prior.beta);
        const cell = `${prior.alpha}/${prior.beta} (${(mean * 100).toFixed(0)}%)`;
        return cell.padStart(colWidth).slice(0, colWidth);
      }).join('');
      console.log(`  ${provider.padEnd(12)}${cells}`);
    }

    console.log('');
    console.log('  Cell format: α/β (expected win %)  ·  columns are complexity buckets; intent-scoped buckets (e.g. coding:moderate) learn per task intent');
    console.log('  Higher α = more successful outcomes; higher β = more failures.');
    console.log('');

    // ── Per-modelId priors (ruflo ADR-149 mirror) ────────────────────────
    const modelPriors = state.modelPriors || {};
    const modelBuckets = (): string[] => {
      const keys = new Set<string>();
      for (const b of COMPLEXITY_BUCKETS) keys.add(b);
      for (const k of Object.keys(modelPriors)) keys.add(k);
      return [...keys];
    };
    const modelProviders = new Set<string>();
    for (const bucket of modelBuckets()) {
      for (const model of Object.keys(modelPriors[bucket] || {})) {
        modelProviders.add(model);
      }
    }
    if (modelProviders.size > 0) {
      logger.highlight(`  ── Per-model priors (${modelProviders.size} learned model(s)) ──`);
      console.log('');
      for (const model of [...modelProviders].sort().slice(0, 12)) {
        const cells = modelBuckets().map((bucket) => {
          const prior = modelPriors[bucket]?.[model];
          if (!prior) return ''.padStart(colWidth);
          const mean = prior.alpha / (prior.alpha + prior.beta);
          return `${prior.alpha}/${prior.beta} (${(mean * 100).toFixed(0)}%)`.padStart(colWidth).slice(0, colWidth);
        }).join('');
        console.log(`  ${model.padEnd(22).slice(0, 22)}${cells}`);
      }
      console.log('');
      logger.info(`  Model cells: α/β (expected win %) per bucket — higher α = more successful outcomes for that model.`);
      console.log('');
    }

    // Learning history
    const history = state.learningHistory;
    if (history.length > 0) {
      logger.highlight(`  ── Recent learning history (last ${Math.min(history.length, 15)} of ${history.length}) ──`);
      console.log('');
      for (const h of history.slice(-15)) {
        const icon = h.outcome === 'success' ? '✅' : h.outcome === 'escalated' ? '🔄' : '❌';
        // Model-level history entries carry the concrete model id (provider is
        // the same string) — render just the model to avoid 'x (x)' noise.
        const label = h.model ?? h.provider;
        const ts = new Date(h.timestamp).toLocaleTimeString();
        const intentTag = h.taskIntent ? ` [${h.taskIntent}]` : '';
        console.log(`   ${icon} ${label.padEnd(24).slice(0, 24)} ${h.complexity.padEnd(10)}${intentTag} reward ${h.reward.toFixed(2)}  ${ts}`);
      }
      console.log('');
    }

    logger.info('Reset: `nuvira model bandit reset` · JSON: `nuvira model bandit --json`');
    console.log('');
  }

  /** Show the ML task-similarity router state (`nuvira model ml`). */
  private showMl(action: string | undefined, opts: { json?: boolean }): void {
    if (action === 'reset') {
      getMlRouter().reset();
      console.log('');
      logger.success('✅ ML router state reset — all learned task outcomes cleared');
      console.log('');
      return;
    }
    if (action && action !== 'reset') {
      logger.error(`Unknown ml action: ${action}. Use \`nuvira model ml\` to view or \`nuvira model ml reset\` to reset.`);
      return;
    }

    const ml = getMlRouter();
    const records = ml.all();
    const enabled = this.configManager.getAll().routing?.mlRouter === true;
    const enforce = this.configManager.getAll().routing?.promotionEnforce === true;

    if (opts.json) {
      console.log(JSON.stringify({
        enabled,
        promotionEnforce: enforce,
        recordCount: ml.size(),
        records: records.slice(-50).map((r) => ({
          provider: r.provider,
          model: r.model,
          outcome: r.outcome,
          agentType: r.agentType,
          complexity: r.complexity,
          intent: r.intent,
          ts: r.ts,
        })),
      }, null, 2));
      return;
    }

    console.log('');
    logger.highlight('═══  ML Task-Similarity Router  ═══');
    console.log('');
    logger.info(`  Enabled: ${enabled ? '✅ yes (routing.mlRouter)' : '⏸ no (default — enable with \`nuvira config set routing.mlRouter true\`)'}`);
    logger.info(`  Promotion enforcement: ${enforce ? '✅ on (routing.promotionEnforce)' : '⏸ off (bandit always allowed — default)'}`);
    logger.info(`  Learned outcomes: ${ml.size()} task(s) recorded`);
    console.log('');

    if (records.length === 0) {
      logger.info('  No ML learning data yet. Every auto-routed task outcome is recorded as a feature vector');
      logger.info('  once enabled; the kNN layer then nudges routing toward providers that succeeded on similar tasks.');
      console.log('');
      return;
    }

    // Per-provider outcome summary (all time).
    const byProvider = new Map<string, { wins: number; fails: number; total: number }>();
    for (const r of records) {
      const cur = byProvider.get(r.provider) || { wins: 0, fails: 0, total: 0 };
      cur.total += 1;
      if (r.outcome === 'success') cur.wins += 1;
      else if (r.outcome === 'failure') cur.fails += 1;
      byProvider.set(r.provider, cur);
    }
    logger.highlight('  ── Learned outcomes by provider ──');
    console.log('');
    for (const [provider, s] of [...byProvider.entries()].sort((a, b) => b[1].total - a[1].total)) {
      const pct = s.total > 0 ? ((s.wins / s.total) * 100).toFixed(0) : '0';
      console.log(`   ${provider.padEnd(14)} ${s.total.toString().padStart(3)} outcomes · ✅ ${s.wins} · ❌ ${s.fails} · win ${pct}%`);
    }
    console.log('');
    logger.info('Reset: `nuvira model ml reset` · JSON: `nuvira model ml --json`');
    console.log('');
  }

  /** Render the promotion gate (bandit-vs-heuristic A/B verdict). */
  private renderPromotionGate(): void {
    const minDecisions = this.configManager.getAll().routing?.promotionMinDecisions ?? DEFAULT_MIN_PROMOTION_DECISIONS;
    const status = getRouterPromotion().evaluate(minDecisions);
    logger.highlight('  ── Promotion Gate (bandit vs. heuristic) ──');
    console.log('');
    if (status.decisionCount === 0) {
      logger.info('  No A/B trajectory yet. Enable `routing.bandit` and run auto-routed tasks to populate it.');
      console.log('');
      return;
    }
    const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
    const pass = (ok: boolean) => (ok ? '✅ PASS' : '❌ FAIL');
    console.log(`   Decisions recorded: ${status.decisionCount}  ·  Diverged (A/B signal): ${status.divergedCount} / required ${status.minDecisions}`);
    console.log('');
    console.log(`   (a) Quality  Δ ${pct(status.qualityDelta)}   (need > +2%)            ${pass(status.criteria.quality)}`);
    console.log(`   (b) Cost     Δ ${pct(status.costDelta)}   (need < +1%)            ${pass(status.criteria.cost)}`);
    const latencyDisplay = status.latencyMeasured ? pct(status.latencyDelta) : 'n/a';
    const latencyBadge = status.latencyMeasured ? pass(status.criteria.latency) : 'n/a';
    console.log(`   (c) Latency  Δ ${latencyDisplay}   (p95, need < +5%)       ${latencyBadge}`);
    console.log('');
    if (!status.sufficient) {
      logger.info(`  ⏳ Not enough diverged decisions yet (${status.divergedCount}/${status.minDecisions}) — keep the bandit on; more real tasks will settle the verdict.`);
    } else if (status.promoted) {
      logger.success('  🏆 PROMOTED — the bandit measurably beats the deterministic heuristic (quality up, no cost/latency regression).');
    } else {
      logger.warn('  ⚠️  NOT promoted — the bandit does not yet beat the deterministic heuristic on real trajectories.');
      logger.info('     Consider `nuvira config set routing.bandit false` or `nuvira model bandit reset` to restart learning.');
    }
    console.log('');
  }

  /** Build a machine-readable bandit snapshot for scripting/CI. */
  private buildBanditJSON(state: RouterBanditState): Record<string, unknown> {
    // v3 — include every bucket key (plain complexity + intent-scoped) so
    // scripting consumers see intent-aware learning, not just the legacy grid.
    const bucketKeys = (map: Record<string, Record<string, { alpha: number; beta: number }>>): string[] => {
      const keys = new Set<string>(COMPLEXITY_BUCKETS);
      for (const k of Object.keys(map)) keys.add(k);
      return [...keys];
    };

    const providers = new Set<string>();
    for (const bucket of bucketKeys(state.priors)) {
      for (const provider of Object.keys(state.priors[bucket] || {})) {
        providers.add(provider);
      }
    }

    const priors: Record<string, Record<string, { alpha: number; beta: number; expectedWinRate: number }>> = {};
    for (const provider of providers) {
      priors[provider] = {};
      for (const bucket of bucketKeys(state.priors)) {
        const prior = state.priors[bucket]?.[provider];
        priors[provider][bucket] = prior
          ? {
              alpha: Math.round(prior.alpha * 1000) / 1000,
              beta: Math.round(prior.beta * 1000) / 1000,
              expectedWinRate: Math.round((prior.alpha / (prior.alpha + prior.beta)) * 1000) / 1000,
            }
          : { alpha: 0, beta: 0, expectedWinRate: 0 };
      }
    }

    // Per-model priors (ruflo ADR-149 mirror)
    const modelPriorsMap = state.modelPriors || {};
    const modelPriors: Record<string, Record<string, { alpha: number; beta: number; expectedWinRate: number }>> = {};
    for (const bucket of bucketKeys(modelPriorsMap)) {
      const bucketPriors = modelPriorsMap[bucket] || {};
      for (const model of Object.keys(bucketPriors)) {
        modelPriors[model] ??= {};
        const prior = bucketPriors[model];
        modelPriors[model][bucket] = {
          alpha: Math.round(prior.alpha * 1000) / 1000,
          beta: Math.round(prior.beta * 1000) / 1000,
          expectedWinRate: Math.round((prior.alpha / (prior.alpha + prior.beta)) * 1000) / 1000,
        };
      }
    }

    // Promotion gate
    const minDecisions = this.configManager.getAll().routing?.promotionMinDecisions ?? DEFAULT_MIN_PROMOTION_DECISIONS;
    const promotion = this.toPromotionJSON(getRouterPromotion().evaluate(minDecisions));

    return {
      version: state.version,
      enabled: this.configManager.getAll().routing?.bandit === true,
      priors,
      modelPriors,
      promotion,
      learningHistory: state.learningHistory.slice(-50).map((h) => ({
        provider: h.provider,
        model: h.model,
        complexity: h.complexity,
        taskIntent: h.taskIntent,
        outcome: h.outcome,
        reward: h.reward,
        timestamp: h.timestamp,
      })),
      updatedAt: Date.now(),
    };
  }

  /** Machine-readable promotion-gate snapshot. */
  private toPromotionJSON(status: PromotionStatus): Record<string, unknown> {
    return {
      decisionCount: status.decisionCount,
      divergedCount: status.divergedCount,
      minDecisions: status.minDecisions,
      qualityDelta: Math.round(status.qualityDelta * 10000) / 10000,
      costDelta: Math.round(status.costDelta * 10000) / 10000,
      latencyDelta: Math.round(status.latencyDelta * 10000) / 10000,
      latencyMeasured: status.latencyMeasured,
      criteria: status.criteria,
      sufficient: status.sufficient,
      promoted: status.promoted,
    };
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
