import { Command } from 'commander';
import { BaseCommand } from './commands.js';
import { PipelineBoard } from './pipeline-board.js';
import { resolveProvider } from './router.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';
import { ProviderType } from '../config/types.js';
import { getModelRegistry } from '../learning/model-registry.js';
import { getQuotaLedger } from '../learning/quota-ledger.js';
import { refreshModelRegistry, startRegistryWatcher, defaultProbeProviders } from '../inference/model-probe.js';
import { CATALOG_PROVIDER_IDS, isCatalogKeyless } from '../inference/provider-catalog.js';
import { describeRoutingExclusions, formatRoutingExclusion } from '../learning/resilient-call.js';
import { governanceVerdict } from '../learning/auto-router.js';

/**
 * Models command — list available models from providers
 * agent-baba-d models [--provider nim]
 *
 * Subcommands:
 *   nuvira models refresh [provider]  — probe + spot-check, update the registry
 *   nuvira models status [--json]     — show the Model Availability Registry
 *   nuvira models unblock <provider>  — manual escape hatch: release a blocked provider + re-probe
 *   nuvira models watch [--interval N]— background daemon keeping the registry fresh
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
        // Issue 001: refresh ALL configured providers dynamically (every catalog
        // provider with a real key or keyless), not just the 5 built-ins.
        const providers = provider ? [provider] : defaultProbeProviders(this.configManager);
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
        const pruneNote = result.prunedLocal > 0
          ? `, ${result.prunedLocal} stale local model(s) removed (deleted from system)`
          : '';
        logger.success(
          `Registry refreshed — ${result.providersProbed.length} provider(s), ${result.modelsListed} models listed, ` +
          `${result.verified} verified, ${result.unavailable} unavailable, ${result.skipped} skipped${pruneNote}`,
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
        logger.info('  Registry updates automatically from real usage. Run `nuvira models refresh` to probe now,');
        logger.info('  `nuvira models watch` for a background daemon, or `nuvira models unblock <provider>` to');
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
        // M2.4 admin gate: `routing.governance.allowUnblock: false` makes the
        // registry's learned blocks admin-HARD — the escape hatch refuses so
        // a policy-set block can't be silently released by an operator. (The
        // governance allow/deny LISTS are always admin-hard regardless; this
        // only governs the registry-telemetry blocks.)
        let allowUnblock = true;
        try {
          allowUnblock = (this.configManager.getAll()?.routing?.governance?.allowUnblock ?? true) !== false;
        } catch {
          // Best-effort — policy read must never break the command.
        }
        if (!allowUnblock) {
          const json = this.isJsonMode(opts, cmd);
          if (json) {
            console.log(JSON.stringify({ provider, refused: true, reason: 'routing.governance.allowUnblock is false — admin-hard block' }, null, 2));
          } else {
            logger.error(`⛔ Cannot unblock ${provider} — admin policy (routing.governance.allowUnblock: false) makes registry blocks admin-hard.`);
            logger.info('   Override in .nuviraconfig.json (set routing.governance.allowUnblock true) if this was intentional.');
          }
          return;
        }
        // M2.4 advisory: even when the REGISTRY block is released, an admin
        // governance deny list may still eliminate this provider at routing
        // time (the deny gate is a hard elimination that runs after the
        // registry fast-path). Surface that honestly instead of implying the
        // unblock fully restored the provider.
        let governanceListed = false;
        try {
          const g = this.configManager.getAll()?.routing?.governance;
          if (g) {
            if (g.denyProviders?.includes(provider)) governanceListed = true;
            // Model deny check against the CONFIGURED pin (the model that
            // would actually be served) — same served-model semantics as the
            // router's governanceModelReason gate.
            if (!governanceListed && g.denyModels?.length) {
              try {
                const pin = this.configManager.getProviderConfig(provider)?.config?.model;
                if (pin && g.denyModels.includes(pin)) governanceListed = true;
              } catch {
                // Best-effort — pin lookup must never break the escape hatch.
              }
            }
          }
        } catch {
          // Best-effort — policy read must never break the escape hatch.
        }
        const registry = getModelRegistry();
        const wasBlocked = registry.getBlockedProviders().includes(provider);
        const { demoted, unparked } = registry.unblockProvider(provider);
        if (governanceListed && !this.isJsonMode(opts, cmd)) {
          logger.warn(
            `   ⚠️ ${provider} is on an admin governance deny list (routing.governance.denyProviders/denyModels) — routing will STILL eliminate it even after this unblock. Edit routing.governance in .nuviraconfig.json to fully restore it.`,
          );
        }
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

    // ── Subcommand: models excluded — WHY a provider is not being tried ──
    command
      .command('excluded')
      .description('Show which providers routing is currently skipping, and why (failure cooldowns, registry blocks, governance policy)')
      .option('-j, --json', 'Output as JSON', false)
      .action(async (opts?: { json?: boolean }, cmd?: Command) => {
        const json = this.isJsonMode(opts, cmd);
        const reports = describeRoutingExclusions(this.configManager);

        /**
         * Governance is the other reason a provider never gets tried, and it
         * leaves no record on disk — it is derived from `routing.governance`.
         * Reported through the SAME `governanceVerdict` the pinned paths and the
         * router use, so this view cannot disagree with enforcement. No task
         * text is passed: only the static allow/deny rules apply without one.
         */
        const governanceBlocked: Array<{ provider: string; reason: string }> = [];
        try {
          const configured = Object.keys(
            (this.configManager.getAll() as { providers?: Record<string, unknown> }).providers ?? {},
          );
          for (const provider of configured) {
            const verdict = governanceVerdict(this.configManager, provider);
            if (!verdict.allowed) {
              governanceBlocked.push({ provider, reason: verdict.reason ?? 'blocked by policy' });
            }
          }
        } catch {
          // Best-effort — a policy read must never break the command.
        }

        if (json) {
          console.log(JSON.stringify({ exclusions: reports, governanceBlocked }, null, 2));
          return;
        }

        console.log('');
        if (reports.length === 0 && governanceBlocked.length === 0) {
          logger.success('✅ Nothing is being skipped — no failure cooldowns, registry blocks or governance rules are in force.');
          console.log('');
          return;
        }

        const active = reports.filter((r) => r.active);
        const healed = reports.filter((r) => !r.active);
        console.log(`🔍 Routing exclusions — ${active.length + governanceBlocked.length} active:\n`);
        for (const r of active) console.log(`  ${formatRoutingExclusion(r)}`);
        for (const g of governanceBlocked) {
          console.log(`  🔒 ${g.provider} — skipped by admin governance policy: ${g.reason}`);
        }
        if (healed.length > 0) {
          console.log('\n♻️  Recovered (no longer skipped):\n');
          for (const r of healed) console.log(`  ${formatRoutingExclusion(r)}`);
        }
        console.log('\n👀 A provider that stays skipped with a working key is a bug — `nuvira models unblock <provider>` forces a re-probe.');
        // The two SELECTION-only filters are deliberately absent: they never
        // hard-block, they reorder the AUTO path's candidates. A pin is an
        // explicit user choice, so it is not silently overridden by a cost or
        // speed preference — say so, because "why was the cost cap ignored?"
        // is exactly the question this command exists to answer.
        console.log('ℹ️  Not listed here (SELECTION-only, never a hard block): the admin max-cost cap and minSpeed/minReasoning.');
        console.log('   They reorder candidates on the auto path only; an explicit --provider pin is respected as your choice.');
        console.log('');
      });

    // ── Subcommand: models staleness — show model freshness status ────────
    command
      .command('staleness')
      .description('Show model staleness: last probe time, days since verification, and removal risk')
      .option('-j, --json', 'Output as JSON', false)
      .action(async (opts?: { json?: boolean }) => {
        const registry = getModelRegistry();
        const now = Date.now();
        const rawEntries: Record<string, any> = (registry as any).data?.entries ?? {};
        const entries = Object.values(rawEntries);

        if (opts?.json) {
          const jsonEntries = entries.map((e: any) => ({
            provider: e.provider,
            model: e.model,
            status: e.status,
            lastVerifiedAt: e.lastVerifiedAt,
            lastProbedAt: e.lastProbedAt,
            lastUsedAt: e.lastUsedAt,
            errorRate: e.errorRate,
            daysSinceVerified: e.lastVerifiedAt ? Math.floor((now - e.lastVerifiedAt) / 86400000) : null,
            daysSinceProbed: e.lastProbedAt ? Math.floor((now - e.lastProbedAt) / 86400000) : null,
            stale: e.lastProbedAt ? (now - e.lastProbedAt) > 7 * 86400000 : false,
            probablyRemoved: e.lastProbedAt ? ((now - e.lastProbedAt) > 30 * 86400000 && e.errorRate > 0.5) : false,
          }));
          console.log(JSON.stringify(jsonEntries, null, 2));
          return;
        }

        console.log('');
        console.log('🔍 Model Staleness Report');
        console.log('─'.repeat(80));

        // Group by provider
        const byProvider = new Map<string, Array<{
          provider: string;
          model: string;
          status: string;
          lastVerifiedAt: number;
          lastProbedAt: number;
          lastUsedAt: number;
          errorRate: number;
        }>>();
        for (const e of entries) {
          if (!byProvider.has(e.provider)) byProvider.set(e.provider, []);
          byProvider.get(e.provider)!.push(e);
        }

        const STALE_DAYS = 7;
        const REMOVED_DAYS = 30;
        let totalStale = 0;
        let totalRemoved = 0;
        let totalFresh = 0;

        for (const [provider, models] of byProvider) {
          models.sort((a: any, b: any) => (b.lastProbedAt || 0) - (a.lastProbedAt || 0));
          const staleModels = models.filter((m: any) => m.lastProbedAt && (now - m.lastProbedAt) > STALE_DAYS * 86400000);
          const removedModels = models.filter((m: any) => m.lastProbedAt && (now - m.lastProbedAt) > REMOVED_DAYS * 86400000 && m.errorRate > 0.5);
          const freshModels = models.filter((m: any) => !m.lastProbedAt || (now - m.lastProbedAt) <= STALE_DAYS * 86400000);

          totalStale += staleModels.length;
          totalRemoved += removedModels.length;
          totalFresh += freshModels.length;

          const hasIssues = staleModels.length > 0 || removedModels.length > 0;
          const icon = hasIssues ? '⚠️' : '✅';
          console.log(`\n${icon} ${provider} (${models.length} models, ${freshModels.length} fresh, ${staleModels.length} stale, ${removedModels.length} likely removed)`);

          // Show stale/removed models first
          for (const m of removedModels) {
            const daysSince = m.lastProbedAt ? Math.floor((now - m.lastProbedAt) / 86400000) : '?';
            console.log(`   🔴 ${m.model} — LIKELY REMOVED (${daysSince} days since probe, ${(m.errorRate * 100).toFixed(0)}% error rate)`);
          }
          for (const m of staleModels) {
            if (removedModels.includes(m)) continue;
            const daysSince = m.lastProbedAt ? Math.floor((now - m.lastProbedAt) / 86400000) : '?';
            console.log(`   🟡 ${m.model} — STALE (${daysSince} days since probe)`);
          }

          // Show fresh models (abbreviated)
          if (freshModels.length > 0 && freshModels.length <= 5) {
            for (const m of freshModels) {
              const daysSince = m.lastProbedAt ? Math.floor((now - m.lastProbedAt) / 86400000) : '?';
              const verified = m.status === 'verified' ? '✅' : '⬜';
              console.log(`   ${verified} ${m.model} — fresh (${daysSince}d ago)`);
            }
          } else if (freshModels.length > 5) {
            console.log(`   ✅ ${freshModels.length} models fresh (< ${STALE_DAYS} days)`);
          }
        }

        console.log('');
        console.log('─'.repeat(80));
        console.log(`📊 Summary: ${totalFresh} fresh · ${totalStale} stale · ${totalRemoved} likely removed`);
        if (totalStale > 0 || totalRemoved > 0) {
          console.log('');
          console.log('💡 Run `nuvira models refresh` to re-probe all providers and update staleness data.');
          console.log('   Run `nuvira models watch` to keep the registry fresh automatically.');
        }
        console.log('');
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
          // Issue 001: the full catalog — every onboardable provider is listed.
          const builtin: ProviderType[] = [...CATALOG_PROVIDER_IDS];
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
      // Fast-skip unconfigured providers (no key, not keyless): a dead endpoint
      // probe on 16 unused providers would make `nuvira models` noticeably slow
      // (Issue 001 review feedback). Keyless local runners ARE probed. When no
      // credential check is available (mocks/plugins), never skip — probe as
      // before.
      const configured = typeof this.configManager.hasRequiredCredentials === 'function'
        ? (() => {
            try {
              return this.configManager.hasRequiredCredentials(providerType);
            } catch {
              return false;
            }
          })()
        : true;
      if (!configured && !isCatalogKeyless(providerType)) {
        logger.debug(`${providerType} not configured — skipping`);
        continue;
      }

      const resolved = resolveProvider(this.configManager, providerType);
      const provider = resolved.provider;
      const available = await provider.isAvailable();

      if (!available && !options?.all) {
        logger.debug(`${provider.name} not configured — skipping`);
        continue;
      }

      // E2: live board for the fetch when not in --json mode (standing rule).
      // Stderr stream: `nuvira models` output is user-facing/pipeable — the board
      // must never pollute stdout (non-TTY would print orphaned completion
      // lines into the model list).
      const board = options?.json ? null : new PipelineBoard({ stream: process.stderr });
      board?.start(`Fetching models from ${provider.name}...`);

      try {
        const models = await provider.listModels();
        board?.finish(true);

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
        board?.finish(false);
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
