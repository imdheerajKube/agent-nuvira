import { Command } from 'commander';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { resolveProvider } from './router.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';
import { ProviderType } from '../config/types.js';
import { getModelRegistry } from '../learning/model-registry.js';
import { getQuotaLedger } from '../learning/quota-ledger.js';
import { refreshModelRegistry, startRegistryWatcher, PROBE_PROVIDERS } from '../inference/model-probe.js';

/**
 * Models command — list available models from providers
 * agent-baba-d models [--provider nim]
 *
 * Subcommands:
 *   buff models refresh [provider]  — probe + spot-check, update the registry
 *   buff models status [--json]     — show the Model Availability Registry
 *   buff models unblock <provider>  — manual escape hatch: release a blocked provider + re-probe
 *   buff models watch [--interval N]— background daemon keeping the registry fresh
 */
export class ModelsCommand extends BaseCommand {
  create(): Command {
    const command = new Command('models')
      .description('List available models from inference providers')
      .option('-p, --provider <provider>', 'Only show models from this provider (nim, gemini, openrouter, groq, local)')
      .option('-s, --search <keyword>', 'Search/filter models by keyword')
      .option('--all', 'Show all models (including unconfigured providers)', false)
      .option('--verify', 'Verify API keys and show configuration status for all providers', false)
      .option('-j, --json', 'Output as JSON (for scripting and IDE integration)', false)
      .action(async (options?: { provider?: string; search?: string; all?: boolean; verify?: boolean; json?: boolean }) => {
        await this.execute(options || {});
      });

    // ── Subcommand: models refresh — probe + spot-check the registry ──────
    command
      .command('refresh')
      .description('Probe providers and spot-check models, updating the Model Availability Registry')
      .argument('[provider]', 'Only refresh this provider')
      .option('--no-spot-check', 'Only run listModels probes (skip 1-token spot-checks)')
      .option('-j, --json', 'Output as JSON', false)
      .action(async (provider: string | undefined, opts?: { spotCheck?: boolean; json?: boolean }, cmd?: Command) => {
        const providers = provider ? [provider] : PROBE_PROVIDERS;
        const json = this.isJsonMode(opts, cmd);
        logger.highlight('\n📡 Refreshing Model Registry…\n');
        const result = await refreshModelRegistry(this.configManager, {
          providers,
          spotCheck: opts?.spotCheck !== false,
          onProgress: (label, detail) => console.log(`  ${label} — ${detail}`),
        });
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log('');
        logger.success(
          `Registry refreshed — ${result.providersProbed.length} provider(s), ${result.modelsListed} models listed, ` +
          `${result.verified} verified, ${result.unavailable} unavailable, ${result.skipped} skipped`,
        );
        console.log('');
        console.log(await getModelRegistry().formatStatus());
      });

    // ── Subcommand: models status — show the registry ────────────────────
    command
      .command('status')
      .description('Show the Model Availability Registry (verified / unavailable / quota-parked models)')
      .option('-j, --json', 'Output as JSON', false)
      .option('-v, --verbose', 'Also show registry-blocked providers (predictive skips) + per-action telemetry', false)
      .action(async (opts?: { json?: boolean; verbose?: boolean }, cmd?: Command) => {
        if (this.isJsonMode(opts, cmd)) {
          console.log(JSON.stringify(await getModelRegistry().getStatus(), null, 2));
          return;
        }
        console.log('');
        console.log(await getModelRegistry().formatStatus());
        if (opts?.verbose) {
          console.log('');
          await this.printVerboseStatus();
        }
        console.log('');
        logger.info('  Registry updates automatically from real usage. Run `buff models refresh` to probe now,');
        logger.info('  `buff models watch` for a background daemon, or `buff models unblock <provider>` to');
        logger.info('  manually release a provider that was learned blocked (escape hatch + re-probe).');
      });

    // ── Subcommand: models unblock — manual escape hatch ──────────────────
    // Routing skips registry-blocked providers predictively (every tracked
    // model unavailable/parked → no failing first call). Sometimes that
    // learning is wrong (a provider recovered, a key was fixed, a model came
    // back) and the user needs a manual override: release the block AND
    // re-probe against the live API so the registry re-learns the truth.
    command
      .command('unblock')
      .description('Manually release a registry-blocked provider (escape hatch) and re-probe it against the live API')
      .argument('<provider>', 'Provider to unblock (e.g. gemini, nim)')
      .option('--no-spot-check', 'Only re-probe the model list (skip 1-token spot-checks)')
      .option('-j, --json', 'Output as JSON', false)
      .action(async (provider: string, opts?: { spotCheck?: boolean; json?: boolean }, cmd?: Command) => {
        const registry = getModelRegistry();
        const wasBlocked = registry.getBlockedProviders().includes(provider);
        const { demoted, unparked } = registry.unblockProvider(provider);
        // Clear the CENTRAL ledger cooldown too — otherwise syncQuota() would
        // re-park the provider on the very next routing read, instantly
        // undoing the manual release. (unblockProvider only clears REGISTRY
        // state; the ledger is the cooldown writer.)
        try {
          getQuotaLedger().releaseProvider(provider);
        } catch {
          // Best-effort — ledger bookkeeping must never break the escape hatch.
        }
        const json = this.isJsonMode(opts, cmd);

        if (!json) {
          logger.highlight(`\n🔓 Unblocking ${provider}…`);
          console.log(`  ${wasBlocked ? 'was registry-blocked' : 'not currently blocked'}` +
            ` · ${demoted} unavailable demoted` +
            ` · ${unparked} quota parks cleared`);
          console.log('  Re-probing against the live API…\n');
        }

        // Re-probe: the registry re-learns the truth from the live API. If the
        // provider genuinely recovered it becomes verified again; if it is
        // still dead the probe flips it back to unavailable (one honest probe,
        // not a permanent skip).
        const result = await refreshModelRegistry(this.configManager, {
          providers: [provider],
          spotCheck: opts?.spotCheck !== false,
          onProgress: json ? undefined : (label, detail) => console.log(`  ${label} — ${detail}`),
        });
        const stillBlocked = registry.getBlockedProviders().includes(provider);

        if (json) {
          console.log(JSON.stringify(
            {
              provider,
              wasBlocked,
              demoted,
              unparked,
              probe: result,
              stillBlocked,
            },
            null,
            2,
          ));
          return;
        }

        console.log('');
        if (stillBlocked) {
          logger.warn(`⛔ ${provider} is STILL blocked after re-probe — the live API still can't serve a model.`);
          logger.info('   Fix the underlying issue (key / billing / model availability), then unblock again.');
        } else if (result.verified > 0) {
          logger.success(`✅ ${provider} unblocked and verified — routing will use it again.`);
        } else {
          logger.success(`✅ ${provider} unblocked — routing will try it again.`);
        }
        console.log('');
        console.log(await registry.formatStatus());
      });

    // ── Subcommand: models watch — background maintenance daemon ──────────
    command
      .command('watch')
      .description('Run the model-registry maintenance daemon: probe + spot-check on a schedule')
      .option('--interval <seconds>', 'Refresh interval in seconds (default: 600)', '600')
      // NOTE: no third arg — commander's negated option must default `spotCheck`
      // to true (passing `--no-spot-check` flips it false). A `false` third arg
      // would permanently disable spot-checks (the same bug `unblock` had).
      .option('--no-spot-check', 'Only run listModels probes (skip spot-checks)')
      .action(async (opts?: { interval?: string; spotCheck?: boolean }) => {
        const intervalMs = Math.max(60, parseInt(opts?.interval || '600', 10) || 600) * 1000;
        logger.highlight('\n👁️  Model Registry Watch started — keeping availability fresh…');
        logger.info(`  Interval: ${Math.round(intervalMs / 1000)}s · Ctrl+C to stop\n`);
        startRegistryWatcher(this.configManager, {
          spotCheck: opts?.spotCheck !== false,
          intervalMs,
          onProgress: (label, detail) => console.log(`  ${label} — ${detail}`),
        });
        // Hold until the user stops the daemon.
        await new Promise<void>((resolve) => {
          const stop = () => {
            console.log('\nWatch stopped.');
            resolve();
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
      });

    return command;
  }

  /**
   * Resolve the effective `--json` flag for a subcommand.
   *
   * BUG WORKAROUND: the parent `models` command also defines `-j, --json`, and
   * commander's option parser scans the WHOLE arg list against the CURRENT
   * command's options — so a `--json` token typed after a subcommand name
   * (e.g. `models status --json`) is consumed by the PARENT's option, and the
   * subcommand's own `opts.json` stays at its default. Without this, every
   * subcommand `--json` silently fell back to human output (a pre-existing
   * production bug). The token does land in `parent.opts()`, so read it from
   * there when the child's own opts didn't see it.
   */
  private isJsonMode(opts: { json?: boolean } | undefined, cmd?: Command): boolean {
    // optsWithGlobals() merges this command's options with every parent's — the
    // framework's own answer to reading a token consumed higher in the chain.
    return !!(opts?.json || cmd?.optsWithGlobals().json);
  }

  /**
   * Verbose `models status` — the two things routing learns from real usage:
   *  1. REGISTRY-BLOCKED providers — every tracked model unavailable/parked, so
   *     the auto router and fallback chain skip them predictively (sub-ms, no
   *     network). Shows WHY (the learned reason for each blocked model).
   *  2. PER-ACTION telemetry — which action verified/killed which provider ×
   *     model, the exact feed powering the dashboard's "learned from real
   *     usage" panel. A provider killed by ANY action is skipped by all others.
   */
  private async printVerboseStatus(): Promise<void> {
    const registry = getModelRegistry();
    const status = await registry.getStatus();
    const blocked = new Set(registry.getBlockedProviders());

    // ── 1. Registry-blocked providers (predictive skips) ───────────────────
    logger.highlight('⛔ Registry-blocked providers (skipped predictively by routing)\n');
    const blockedProviders = status.providers.filter((p) => blocked.has(p.provider));
    if (blockedProviders.length === 0) {
      logger.success('  None — every tracked provider has a usable model. ✔');
    } else {
      const now = Date.now();
      for (const p of blockedProviders) {
        console.log(`  ⛔ ${p.provider}`);
        for (const m of p.models.filter((m) => m.status === 'unavailable' || m.quotaParkedUntil > now).slice(0, 5)) {
          const reason = m.lastError ? ` — ${m.lastError}` : '';
          const parked = m.quotaParkedUntil > now ? ' (quota-parked)' : '';
          console.log(`     ✗ ${m.model}${reason}${parked}`);
        }
        console.log('     └ skipped before scoring — no failing first call');
      }
    }

    // ── 2. Per-action "learned from real usage" telemetry ──────────────────
    logger.highlight('\n🎓 Learned from real usage — per action\n');
    const tele = registry.getActionTelemetry();
    if (!tele.enabled) {
      logger.info('  No per-action telemetry yet — use chat / execute / plan / edit and this fills in.');
    } else {
      for (const a of tele.actions) {
        const chips: string[] = [];
        if (a.verified > 0) chips.push(`${a.verified} verified`);
        if (a.killed > 0) chips.push(`${a.killed} killed`);
        if (a.transient > 0) chips.push(`${a.transient} transient`);
        console.log(`  ${a.action}: ${chips.join(' · ')}`);
        for (const k of a.killedModels.slice(0, 4)) {
          console.log(`     ✗ ${k.provider}/${k.model}${k.reason ? ` — ${k.reason}` : ''}`);
        }
        for (const v of a.verifiedModels.slice(0, 4)) {
          console.log(`     ✓ ${v.provider}/${v.model}`);
        }
      }
      console.log(`\n  ${tele.total} events total · a provider killed by any action is skipped by all`);
    }
  }

  private async execute(options?: { provider?: string; search?: string; all?: boolean; verify?: boolean; json?: boolean }): Promise<void> {
    const providersToCheck: string[] = options?.provider
      ? [options.provider]
      : (() => {
          const builtin: ProviderType[] = ['nim', 'gemini', 'openrouter', 'groq', 'local'];
          const registry = getPluginRegistry();
          const pluginTypes = registry.getAllPlugins().map((p) => p.getProviderType());
          return Array.from(new Set([...builtin, ...pluginTypes]));
        })();

    // If --verify, show API key/configuration status and then list models
    if (options?.verify && !options?.json) {
      console.log();
      logger.highlight('🔑 Provider Configuration Status\n');
      for (const providerType of providersToCheck) {
        const { provider } = resolveProvider(this.configManager, providerType);
        const available = await provider.isAvailable();
        const config = this.configManager.getProviderConfig(providerType).config;
        const hasKey = !!config.apiKey;
        const keyPreview = hasKey
          ? `${config.apiKey!.slice(0, 8)}...${config.apiKey!.slice(-4)}`
          : 'Not set';

        if (available) {
          logger.success(`  ✅ ${provider.name}`);
        } else {
          logger.info(`  ⛔ ${provider.name}`);
        }
        console.log(`       API Key: ${keyPreview}`);
        console.log(`       Model: ${config.model || 'default'}`);
        console.log();
      }
    }

    const allResults: Array<{
      provider: string;
      /** Provider type used for switching (e.g. 'groq', 'openrouter') */
      providerType: string;
      name: string;
      id: string;
      owner?: string;
      description?: string;
    }> = [];

    for (const providerType of providersToCheck) {
      const resolved = resolveProvider(this.configManager, providerType);
      const provider = resolved.provider;
      const available = await provider.isAvailable();

      if (!available && !options?.all) {
        logger.debug(`${provider.name} not configured — skipping`);
        continue;
      }

      const s = options?.json ? null : ora(`Fetching models from ${provider.name}...`).start();

      try {
        const models = await provider.listModels();
        s?.stop();

        if (models.length === 0) {
          if (!options?.json) {
            if (available) {
              logger.info(`${provider.name}: No models found or API not reachable`);
            } else {
              logger.info(`${provider.name}: Not configured`);
            }
          }
          continue;
        }

        for (const model of models) {
          allResults.push({
            provider: provider.name,
            providerType: resolved.type,
            name: model.name,
            id: model.id,
            owner: model.owner,
            description: model.description,
          });
        }

        if (!options?.json) {
          logger.success(`${provider.name}: ${models.length} models found`);
        }
      } catch (err) {
        s?.stop();
        if (!options?.json) {
          logger.error(`${provider.name}: Failed to fetch models — ${String(err)}`);
        }
      }
    }

    // Filter by search keyword if provided
    const filtered = options?.search
      ? allResults.filter((m) =>
          m.name.toLowerCase().includes(options.search!.toLowerCase()) ||
          m.id.toLowerCase().includes(options.search!.toLowerCase()) ||
          (m.owner || '').toLowerCase().includes(options.search!.toLowerCase())
        )
      : allResults;

    // ── JSON output (for scripting / IDE integration) ───────────────
    if (options?.json) {
      console.log(JSON.stringify({ models: filtered }, null, 2));
      return;
    }

    if (filtered.length === 0) {
      if (options?.search) {
        logger.info(`No models found matching "${options.search}"`);
      } else {
        logger.info('No models found. Configure a provider first with: agent-baba-d config set');
      }
      return;
    }

    // Display results
    console.log(`\n${'='.repeat(60)}`);
    logger.highlight(`📋 Available Models (${filtered.length})`);
    console.log(`${'='.repeat(60)}`);

    const grouped: Record<string, typeof filtered> = {};
    for (const m of filtered) {
      if (!grouped[m.provider]) grouped[m.provider] = [];
      grouped[m.provider].push(m);
    }

    for (const [providerName, models] of Object.entries(grouped)) {
      console.log(`\n${providerName}:`);
      console.log('-'.repeat(40));
      for (const m of models.slice(0, 30)) { // show max 30 per provider
        const owner = m.owner ? ` [${m.owner}]` : '';
        const desc = m.description ? ` — ${m.description.slice(0, 60)}` : '';
        console.log(`  ${m.name}${owner}${desc}`);
      }
      if (models.length > 30) {
        console.log(`  ... and ${models.length - 30} more`);
      }
    }
    console.log(`\n${'='.repeat(60)}`);

    if (allResults.length > 0) {
      logger.info('\nUse a model by specifying it with --model:');
      console.log('  agent-baba-d chat --provider nim --model <model-id>');
      console.log('  agent-baba-d edit file.js --provider openrouter --model <model-id>');
    }
  }
}
