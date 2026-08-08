/**
 * Shared Model Picker — standalone categorized model picker for CLI and orchestrator.
 *
 * Extracted from chat.ts so the orchestrator's rate-limit "switch model" flow
 * shows the same nice categorized picker instead of asking the user to type a
 * raw model name.
 */
import inquirer from 'inquirer';
import ora from 'ora';
import { resolveProvider } from './router.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { CATALOG_PROVIDER_IDS, getCatalogProvider, catalogEnvVar, isCatalogKeyless } from '../inference/provider-catalog.js';
import { CATEGORY_INFO, categorizeModel, getModelBadge, formatModelName, } from '../inference/model-catalog.js';
import { logger } from '../utils/logger.js';
import { AUTO_MODEL, AUTO_PROVIDER } from '../learning/auto-router.js';
// ─── Timeouts ───────────────────────────────────────────────────────────────
// First-run / provider availability checks and model-list fetches can hang
// (e.g. the local/Ollama probe, a stalled network). Time out per provider so
// the picker never blocks silently on a single hung provider.
const AVAILABILITY_TIMEOUT_MS = 10_000;
const LIST_MODELS_TIMEOUT_MS = 20_000;
/** Resolve a promise, rejecting with a clear timeout error after `ms`. */
function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
        promise.then((value) => { clearTimeout(timer); resolve(value); }, (err) => { clearTimeout(timer); reject(err); });
    });
}
// ─── Category Display Order ─────────────────────────────────────────────────
const CATEGORY_ORDER = {
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
// Provider icons + eligibility hints derived from the catalog (Issue 001) so
// the picker covers all 17+ onboardable providers without hardcoding.
const PROVIDER_ICONS = {};
for (const id of CATALOG_PROVIDER_IDS) {
    const entry = getCatalogProvider(id);
    if (entry)
        PROVIDER_ICONS[id] = entry.icon;
}
const PROVIDER_ELIGIBILITY = {};
for (const id of CATALOG_PROVIDER_IDS) {
    const entry = getCatalogProvider(id);
    if (!entry)
        continue;
    const env = catalogEnvVar(id);
    const base = entry.baseUrl ? ` (default ${entry.baseUrl})` : '';
    PROVIDER_ELIGIBILITY[id] = isCatalogKeyless(id)
        ? `No API key needed — runs locally${base}`
        : `${entry.label} cloud service — set ${env || `${id.toUpperCase()}_API_KEY`}`;
}
// ─── Shared picker ──────────────────────────────────────────────────────────
/**
 * Show a categorized model picker that groups models by capability.
 * Returns the selected provider and model, or null if cancelled.
 */
export async function showModelPicker(configManager) {
    logger.highlight('\n🔍 Checking available providers...\n');
    const registry = getPluginRegistry();
    const pluginTypes = registry.getAllPlugins().map((plugin) => plugin.getProviderType());
    // Issue 001: the full catalog — every onboardable provider participates.
    const providerTypes = Array.from(new Set([
        ...CATALOG_PROVIDER_IDS,
        ...pluginTypes,
    ]));
    // Availability checks can hang (e.g. the local/Ollama probe, stalled network)
    // — show a live spinner and time out per-provider so first run never sits
    // silently on a single provider.
    const checkSpinner = ora({ text: '🔍 Checking provider availability…', spinner: 'dots' }).start();
    const checkResults = await Promise.all(providerTypes.map(async (pt) => {
        const resolved = resolveProvider(configManager, pt);
        // Fast-skip: a provider with no configured key (and not keyless) can't be
        // available — skip the network probe so the picker never waits on 16
        // dead endpoints (Issue 001 review feedback). Keyless local runners ARE
        // probed — they may be running without any key.
        const configured = (() => {
            try {
                return configManager.hasRequiredCredentials?.(pt) ?? true;
            }
            catch {
                return false;
            }
        })();
        if (!configured && !isCatalogKeyless(pt)) {
            return { pt, resolved, available: false };
        }
        let available = false;
        try {
            available = await withTimeout(resolved.provider.isAvailable(), AVAILABILITY_TIMEOUT_MS, `${resolved.provider.name} availability`);
        }
        catch {
            logger.warn(`    ⏱️  ${resolved.provider.name} availability check timed out — treating as unavailable`);
        }
        return { pt, resolved, available };
    }));
    checkSpinner.stop();
    const availableProviders = [];
    for (const { pt, resolved, available } of checkResults) {
        const icon = PROVIDER_ICONS[pt] || '🔹';
        const eligibility = PROVIDER_ELIGIBILITY[pt] || '';
        if (available) {
            availableProviders.push({ type: pt, provider: resolved.provider, name: resolved.provider.name });
            logger.success(`  ${icon} ${resolved.provider.name} — ${pt === 'local' ? '✅ Running' : '✅ API key configured'}`);
        }
        else {
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
    const loadingSpinner = ora({ text: '📡 Loading models…', spinner: 'dots' }).start();
    // Collect ALL models from all providers — show live per-provider progress
    // and time out individually so one slow provider can't block the picker.
    const allModels = [];
    let fetchedCount = 0;
    const totalProviders = availableProviders.length;
    const modelResults = await Promise.all(availableProviders.map(async ({ type, provider: prov, name }) => {
        try {
            const models = await withTimeout(prov.listModels(), LIST_MODELS_TIMEOUT_MS, `${name} model list`);
            loadingSpinner.text = `📡 Loaded models from ${name} (${++fetchedCount}/${totalProviders})…`;
            return { type, name, models, error: null };
        }
        catch (err) {
            loadingSpinner.text = `📡 Skipped ${name} — timed out (${++fetchedCount}/${totalProviders})…`;
            return { type, name, models: null, error: err };
        }
    }));
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
    const modelProviderMap = new Map();
    for (const m of allModels) {
        modelProviderMap.set(m.id, m._providerType || m.provider);
    }
    // Build categorized array and group by category
    const grouped = new Map();
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
        if (!grouped.has(category))
            grouped.set(category, []);
        grouped.get(category).push(entry);
    }
    // Sort categories by display order
    const sortedCategories = Array.from(grouped.keys()).sort((a, b) => (CATEGORY_ORDER[a] ?? 99) - (CATEGORY_ORDER[b] ?? 99));
    // Build the display list in render order (category-grouped) so selection indices match
    const displayList = [];
    // ── Render the picker ──────────────────────────────────────────────────
    console.log();
    logger.highlight('🎯  Available Models');
    console.log('');
    // ── Auto option — Agent decides ────────────────────────────────────────
    console.log('   1. 🤖  Auto — Agent decides (smart routing)');
    console.log('      Routes each task to the best provider/model by complexity, cost, latency, privacy, reliability');
    console.log('');
    for (const cat of sortedCategories) {
        const models = grouped.get(cat);
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
                .filter((t) => t !== choice.category)
                .slice(0, 2)
                .map((t) => {
                const ci = CATEGORY_INFO[t];
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
    const answer = await inquirer.prompt([
        {
            type: 'input',
            name: 'selected',
            message: `Enter a number (0-${selectableTotal}):`,
            prefix: '🔢',
            validate: (input) => {
                const trimmed = input.trim();
                if (trimmed === '')
                    return 'Please enter a number';
                const num = Number(trimmed);
                if (isNaN(num) || !Number.isInteger(num))
                    return 'Please enter a valid whole number';
                if (num < 0 || num > selectableTotal)
                    return `Please enter a number between 0 and ${selectableTotal}`;
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
async function browseProviderModels(configManager, availableProviders) {
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
        const providerAnswer = await inquirer.prompt([
            {
                type: 'input',
                name: 'selected',
                message: `Enter a provider number (1-${availableProviders.length}, 0 to cancel):`,
                prefix: '🔢',
                validate: (input) => {
                    const trimmed = input.trim();
                    if (trimmed === '')
                        return 'Please enter a number';
                    const num = Number(trimmed);
                    if (isNaN(num) || !Number.isInteger(num))
                        return 'Please enter a valid whole number';
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
        if (!chosen)
            return null;
        // ── Step 2: Fetch the provider's FULL model list (no cap) ────────────
        console.log('');
        const spinner = ora(`Loading models from ${chosen.name}...`).start();
        let models = [];
        try {
            models = await withTimeout(chosen.provider.listModels(), LIST_MODELS_TIMEOUT_MS, `${chosen.name} model list`);
        }
        catch {
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
        const modelAnswer = await inquirer.prompt([
            {
                type: 'input',
                name: 'selected',
                message: `Enter a model number (0-${selectableTotal}):`,
                prefix: '🔢',
                validate: (input) => {
                    const trimmed = input.trim();
                    if (trimmed === '')
                        return 'Please enter a number';
                    const num = Number(trimmed);
                    if (isNaN(num) || !Number.isInteger(num))
                        return 'Please enter a valid whole number';
                    if (num < 0 || num > selectableTotal) {
                        return `Please enter a number between 0 and ${selectableTotal}`;
                    }
                    return true;
                },
            },
        ]);
        const modelIdx = parseInt(modelAnswer.selected.trim(), 10);
        if (modelIdx === 0)
            continue; // back to the provider list
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
        if (!model)
            continue;
        console.log('\n'.repeat(2));
        logger.success(`🎯  Selected: ${model.id}`);
        logger.info(`   Provider: ${chosen.name}`);
        console.log('');
        return { provider: chosen.type, model: model.id };
    }
}
//# sourceMappingURL=model-picker.js.map