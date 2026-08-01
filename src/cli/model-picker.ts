/**
 * Shared Model Picker — standalone categorized model picker for CLI and orchestrator.
 *
 * Extracted from chat.ts so the orchestrator's rate-limit "switch model" flow
 * shows the same nice categorized picker instead of asking the user to type a
 * raw model name.
 */

import inquirer from 'inquirer';
import ora from 'ora';

import { ConfigManager } from '../config/manager.js';
import { resolveProvider } from './router.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { ProviderType } from '../config/types.js';
import { InferenceProvider, ModelDescriptor } from '../inference/interface.js';
import {
  ModelCategory,
  CATEGORY_INFO,
  categorizeModel,
  getModelBadge,
  formatModelName,
} from '../inference/model-catalog.js';
import { logger } from '../utils/logger.js';
import { AUTO_MODEL, AUTO_PROVIDER } from '../learning/auto-router.js';

// ─── Category Display Order ─────────────────────────────────────────────────

const CATEGORY_ORDER: Record<ModelCategory, number> = {
  chat: 0,
  code: 1,
  reasoning: 2,
  fast: 3,
  creative: 4,
  vision: 5,
  instruct: 6,
  agentic: 7,
  preview: 8,
  other: 9,
  speech: 10,
};

// ─── Provider Metadata ──────────────────────────────────────────────────────

const PROVIDER_ICONS: Record<string, string> = {
  local: '💻',
  nim: '🔶',
  gemini: '🔷',
  openrouter: '🟣',
  groq: '🟢',
};

const PROVIDER_ELIGIBILITY: Record<string, string> = {
  local: 'Works offline — no API key needed',
  nim: 'NVIDIA NIM cloud service — set NVIDIA_NIM_API_KEY',
  gemini: 'Google Gemini cloud service — set GEMINI_API_KEY',
  openrouter: 'OpenRouter unified API service — set OPENROUTER_API_KEY',
  groq: 'Groq LPU cloud inference — set GROQ_API_KEY',
};

// ─── Picker Result ──────────────────────────────────────────────────────────

export interface PickerResult {
  provider: string;
  model: string;
}

// ─── Shared picker ──────────────────────────────────────────────────────────

/**
 * Show a categorized model picker that groups models by capability.
 * Returns the selected provider and model, or null if cancelled.
 */
export async function showModelPicker(configManager: ConfigManager): Promise<PickerResult | null> {
  logger.highlight('\n🔍 Checking available providers...\n');

  const registry = getPluginRegistry();
  const pluginTypes = registry.getAllPlugins().map((plugin) => plugin.getProviderType());
  const providerTypes: string[] = Array.from(new Set([
    'local',
    'nim',
    'gemini',
    'openrouter',
    'groq',
    ...pluginTypes,
  ]));

  const checkResults = await Promise.all(
    providerTypes.map(async (pt) => {
      const resolved = resolveProvider(configManager, pt);
      const available = await resolved.provider.isAvailable();
      return { pt, resolved, available };
    })
  );

  const availableProviders: Array<{ type: string; provider: InferenceProvider; name: string }> = [];

  for (const { pt, resolved, available } of checkResults) {
    const icon = PROVIDER_ICONS[pt] || '🔹';
    const eligibility = PROVIDER_ELIGIBILITY[pt] || '';

    if (available) {
      availableProviders.push({ type: pt, provider: resolved.provider, name: resolved.provider.name });
      logger.success(`  ${icon} ${resolved.provider.name} — ${pt === 'local' ? '✅ Running' : '✅ API key configured'}`);
    } else {
      logger.info(`  ${icon} ${resolved.provider.name} — ⛔ Not available (${eligibility})`);
    }
  }

  if (availableProviders.length === 0) {
    logger.error('\n⚠️  No providers available.');
    logger.info('\nOptions to get started:');
    logger.info('  1. Install Ollama:  brew install ollama && ollama pull deepseek-coder');
    logger.info('  2. Set Groq key:    set GROQ_API_KEY=gsk_...   https://console.groq.com');
    logger.info('  3. Set NIM key:     set NVIDIA_NIM_API_KEY=...  https://build.nvidia.com');
    logger.info('  4. Set Gemini key:  set GEMINI_API_KEY=...      https://aistudio.google.com/apikey');
    logger.info('  5. Set OpenRouter:  set OPENROUTER_API_KEY=...  https://openrouter.ai/keys');
    return null;
  }

  logger.highlight('\n📡 Fetching available models...');
  console.log('');

  const loadingSpinner = ora('  Loading models...').start();

  // Collect ALL models from all providers
  const allModels: ModelDescriptor[] = [];

  const modelResults = await Promise.all(
    availableProviders.map(async ({ type, provider: prov, name }) => {
      try {
        const models = await prov.listModels();
        return { type, name, models, error: null as Error | null };
      } catch (err) {
        return { type, name, models: null as null, error: err as Error };
      }
    })
  );

  loadingSpinner.stop();

  for (const { type, name, models, error } of modelResults) {
    if (error) {
      logger.warn(`    ⚠️  Failed to load models from ${name}`);
      continue;
    }

    if (!models || models.length === 0) {
      logger.warn(`    ⚠️  No models found for ${name}`);
      continue;
    }

    logger.success(`  ✅ ${name}: ${models.length} model${models.length !== 1 ? 's' : ''} available`);

    const MAX_MODELS_PER_PROVIDER = 20;
    const modelsToShow = models.slice(0, MAX_MODELS_PER_PROVIDER).map((m) => ({
      ...m,
      _providerType: type,
    }));
    allModels.push(...modelsToShow);

    if (models.length > MAX_MODELS_PER_PROVIDER) {
      logger.info(`    📋 ... and ${models.length - MAX_MODELS_PER_PROVIDER} more (use: buff models --provider ${type})`);
    }
  }

  if (allModels.length === 0) {
    logger.error('\n⚠️  No models found from any available provider.');
    return null;
  }

  // ── Categorize & group models ──────────────────────────────────────────
  const modelProviderMap = new Map<string, string>();
  for (const m of allModels) {
    modelProviderMap.set(m.id, (m as any)._providerType || m.provider);
  }

  // Build categorized array and group by category
  const grouped = new Map<ModelCategory, Array<{
    model: string;
    provider: string;
    name: string;
    category: ModelCategory;
    tags: string[];
    badge?: string;
    providerIcon: string;
  }>>();

  for (const m of allModels) {
    const category = categorizeModel(m.id, m.owner);
    const badge = getModelBadge(m.id);
    const providerType = modelProviderMap.get(m.id) || m.provider;
    const providerIcon = PROVIDER_ICONS[providerType] || '🔹';

    const entry = {
      model: m.id,
      provider: providerType,
      name: m.name,
      category,
      tags: m.tags || [],
      badge,
      providerIcon,
    };

    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category)!.push(entry);
  }

  // Sort categories by display order
  const sortedCategories = Array.from(grouped.keys()).sort(
    (a, b) => (CATEGORY_ORDER[a] ?? 99) - (CATEGORY_ORDER[b] ?? 99)
  );

  // Build the display list in render order (category-grouped) so selection indices match
  const displayList: Array<{
    model: string;
    provider: string;
    category: ModelCategory;
    badge?: string;
  }> = [];

  // ── Render the picker ──────────────────────────────────────────────────
  console.log();
  logger.highlight('🎯  Available Models');
  console.log('');

  // ── Auto option — Agent decides ────────────────────────────────────────
  console.log('   1. 🤖  Auto — Agent decides (smart routing)');
  console.log('      Routes each task to the best provider/model by complexity, cost, latency, privacy, reliability');
  console.log('');

  for (const cat of sortedCategories) {
    const models = grouped.get(cat)!;
    const info = CATEGORY_INFO[cat];

    // Category header
    console.log(`  ${info.icon}  ${info.label}  — ${info.description}`);

    for (const choice of models) {
      displayList.push({
        model: choice.model,
        provider: choice.provider,
        category: choice.category,
        badge: choice.badge,
      });
      // +1 offset because Auto occupies index 1
      const num = String(displayList.length + 1).padStart(2, ' ');
      const modelId = choice.model;
      const readableName = formatModelName(modelId);

      // Show secondary category tags (except the primary one)
      const secondaryTags = (choice.tags || [])
        .filter((t: string) => t !== choice.category)
        .slice(0, 2)
        .map((t: string) => {
          const ci = CATEGORY_INFO[t as ModelCategory];
          return ci ? ci.icon : t;
        })
        .join(' ');

      const tagsStr = secondaryTags ? `  ${secondaryTags}` : '';
      const readableStr = readableName !== modelId ? `  (${readableName})` : '';

      // Show badge inline if available
      const badgeStr = choice.badge ? `  ⭐ ${choice.badge}` : '';

      console.log(`  ${num}. ${choice.providerIcon}  ${modelId}${readableStr}${tagsStr}${badgeStr}`);
    }
    console.log('');
  }

  // ── Browse-by-provider drill-down option ───────────────────────────────
  // Appended AFTER the model list so the numbered model indices above stay
  // stable: 1 = Auto, 2..len+1 = models, len+2 = browse, 0 = Cancel.
  const browseIndex = displayList.length + 2;
  console.log(`  ${String(browseIndex).padStart(2, ' ')}. 🗂️  Browse by provider — pick a provider, then a specific model`);
  console.log('');

  console.log(`   0. ❌  Cancel`);
  console.log();

  // +1 for the Auto option at index 1, +1 for the browse option
  const selectableTotal = displayList.length + 2;

  const answer = await inquirer.prompt<{ selected: string }>([
    {
      type: 'input',
      name: 'selected',
      message: `Enter a number (0-${selectableTotal}):`,
      prefix: '🔢',
      validate: (input: string) => {
        const trimmed = input.trim();
        if (trimmed === '') return 'Please enter a number';
        const num = Number(trimmed);
        if (isNaN(num) || !Number.isInteger(num)) return 'Please enter a valid whole number';
        if (num < 0 || num > selectableTotal) return `Please enter a number between 0 and ${selectableTotal}`;
        return true;
      },
    },
  ]);

  const selectedIndex = parseInt(answer.selected.trim(), 10);

  if (selectedIndex === 0) {
    logger.info('\nModel selection cancelled.');
    return null;
  }

  // ── Auto option selected ────────────────────────────────────────────────
  if (selectedIndex === 1) {
    console.log('\n'.repeat(2));
    logger.success('🤖  Auto routing enabled');
    logger.info('   Agent-Nuvira will pick the best provider/model for each task');
    logger.info('   based on complexity, cost, latency, privacy, and reliability.');
    console.log('');
    return { provider: AUTO_PROVIDER, model: AUTO_MODEL };
  }

  // ── Browse by provider drill-down ──────────────────────────────────────
  if (selectedIndex === browseIndex) {
    return browseProviderModels(configManager, availableProviders);
  }

  const selected = displayList[selectedIndex - 2];
  console.log('\n'.repeat(2));
  const providerName = availableProviders.find(p => p.type === selected.provider)?.name || selected.provider;
  logger.success(`🎯  Selected: ${selected.model}`);
  logger.info(`   Provider: ${providerName}`);
  logger.info(`   Category: ${CATEGORY_INFO[selected.category].icon} ${CATEGORY_INFO[selected.category].label}`);
  if (selected.badge) {
    logger.info(`   ${selected.badge}`);
  }
  // Warn if user selected a speech/audio model that doesn't support chat
  if (selected.category === 'speech') {
    logger.warn('\n   ⚠️  This is a speech/audio model — it does NOT support text chat.');
    logger.info('   Use it for TTS, STT, or voice tasks via the appropriate API.');
  }
  console.log('');

  return { provider: selected.provider, model: selected.model };
}

/**
 * Per-provider model drill-down (mirrors the VS Code extension's flow):
 * 1. Pick an available provider
 * 2. Pick a specific model from that provider's FULL list (no 20-model cap —
 *    so long lists like OpenRouter's 100+ models are fully browsable)
 *
 * Returns the selected provider/model, or null when cancelled.
 */
async function browseProviderModels(
  configManager: ConfigManager,
  availableProviders: Array<{ type: string; provider: InferenceProvider; name: string }>,
): Promise<PickerResult | null> {
  // Loop so "back" from the model list returns to the provider list
  while (true) {
    // ── Step 1: Pick a provider ──────────────────────────────────────────
    console.log();
    logger.highlight('🗂️  Pick a provider');
    console.log('');

    availableProviders.forEach((p, i) => {
      const icon = PROVIDER_ICONS[p.type] || '🔹';
      console.log(`  ${i + 1}. ${icon}  ${p.name}`);
    });
    console.log('   0. ❌  Cancel');
    console.log();

    const providerAnswer = await inquirer.prompt<{ selected: string }>([
      {
        type: 'input',
        name: 'selected',
        message: `Enter a provider number (1-${availableProviders.length}, 0 to cancel):`,
        prefix: '🔢',
        validate: (input: string) => {
          const trimmed = input.trim();
          if (trimmed === '') return 'Please enter a number';
          const num = Number(trimmed);
          if (isNaN(num) || !Number.isInteger(num)) return 'Please enter a valid whole number';
          if (num < 0 || num > availableProviders.length) {
            return `Please enter a number between 0 and ${availableProviders.length}`;
          }
          return true;
        },
      },
    ]);

    const providerIdx = parseInt(providerAnswer.selected.trim(), 10);
    if (providerIdx === 0) {
      logger.info('\nModel selection cancelled.');
      return null;
    }

    const chosen = availableProviders[providerIdx - 1];
    if (!chosen) return null;

    // ── Step 2: Fetch the provider's FULL model list (no cap) ────────────
    console.log('');
    const spinner = ora(`Loading models from ${chosen.name}...`).start();
    let models: ModelDescriptor[] = [];
    try {
      models = await chosen.provider.listModels();
    } catch {
      models = [];
    }
    spinner.stop();

    if (models.length === 0) {
      logger.warn(`⚠️  No models found for ${chosen.name}.`);
      continue; // back to the provider list
    }

    // Resolve the provider's configured default model. Only shown as option 1
    // when it actually exists — otherwise the model list starts at option 1.
    const defaultModel = configManager.getProviderConfig?.(chosen.type)?.config?.model;

    // ── Step 3: Pick a model ─────────────────────────────────────────────
    console.log();
    logger.highlight(`🎯  Models for ${chosen.name} (${models.length})`);
    console.log('');

    const icon = PROVIDER_ICONS[chosen.type] || '🔹';
    const optionOffset = defaultModel ? 2 : 1;
    if (defaultModel) {
      console.log(`   1. ✅  Use default model (${defaultModel})`);
    }
    models.forEach((m, i) => {
      const badge = getModelBadge(m.id);
      const badgeStr = badge ? `  ⭐ ${badge}` : '';
      console.log(`  ${i + optionOffset}. ${icon}  ${m.id}${badgeStr}`);
    });
    console.log('   0. ❌  Back to provider list');
    console.log();

    const selectableTotal = models.length + (defaultModel ? 1 : 0);
    const modelAnswer = await inquirer.prompt<{ selected: string }>([
      {
        type: 'input',
        name: 'selected',
        message: `Enter a model number (0-${selectableTotal}):`,
        prefix: '🔢',
        validate: (input: string) => {
          const trimmed = input.trim();
          if (trimmed === '') return 'Please enter a number';
          const num = Number(trimmed);
          if (isNaN(num) || !Number.isInteger(num)) return 'Please enter a valid whole number';
          if (num < 0 || num > selectableTotal) {
            return `Please enter a number between 0 and ${selectableTotal}`;
          }
          return true;
        },
      },
    ]);

    const modelIdx = parseInt(modelAnswer.selected.trim(), 10);
    if (modelIdx === 0) continue; // back to the provider list

    // Option 1 is only "Use default model" when a configured default exists;
    // otherwise models start at index 1, so guard this branch accordingly.
    if (defaultModel && modelIdx === 1) {
      console.log('\n'.repeat(2));
      logger.success(`🎯  Selected: ${defaultModel}`);
      logger.info(`   Provider: ${chosen.name}`);
      console.log('');
      return { provider: chosen.type, model: defaultModel };
    }

    // Models render at `optionOffset` (2 with a default, 1 without)
    const model = models[modelIdx - optionOffset];
    if (!model) continue;

    console.log('\n'.repeat(2));
    logger.success(`🎯  Selected: ${model.id}`);
    logger.info(`   Provider: ${chosen.name}`);
    console.log('');
    return { provider: chosen.type, model: model.id };
  }
}
