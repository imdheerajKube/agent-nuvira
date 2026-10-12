/**
 * MCP CLI Command — Manage MCP (Model Context Protocol) server connections.
 *
 * Usage:
 *   nuvira mcp list              — List all discovered MCP servers and their tools
 *   nuvira mcp connect <name>    — Connect to a specific MCP server
 *   nuvira mcp connect --all     — Connect to all discovered MCP servers
 *   nuvira mcp call <tool>       — Call a tool with arguments
 *   nuvira mcp call <tool> --server <name>
 *   nuvira mcp call <tool> --args '{"key":"value"}'
 *   nuvira mcp info <name>       — Show detailed info for an MCP server
 *   nuvira mcp refresh           — Re-discover and reconnect to MCP servers
 *   nuvira mcp serve             — Expose agent tools as an MCP server (stdio)
 *   nuvira mcp catalog           — Capability slots, their variants, what each needs
 *   nuvira mcp install <name>    — Install the best variant this machine can run
 *   nuvira mcp add <name>        — Configure ANY server (not in the catalog) by hand
 *   nuvira mcp settings          — Show the resolved `mcp.*` configuration
 *
 * 2026-10-12: `catalog`/`install` show and honour PREREQUISITES. A capability
 * that cannot run here is reported with the missing dependency and how to get it,
 * instead of writing a config that silently never starts (assessment §2).
 */

import { readFileSync } from 'node:fs';

import { Command } from 'commander';
import { BaseCommand, getCliName } from './commands.js';
import { MCPClient } from '../mcp/client.js';
import { getMCPManager } from '../mcp/manager.js';
import { type MCPServerConfig, MCP_CONFIG_DIR } from '../mcp/types.js';
import {
  MCP_CATALOG,
  searchCatalog,
  getCatalogEntry,
  installCatalogServer,
  uninstallCatalogServer,
  isCatalogServerInstalled,
  catalogConfigPath,
  chooseVariant,
  effectiveProbeEnv,
  evaluateVariants,
  npmSpecsForVariant,
  type MCPCatalogEntry,
  type MCPVariantChoice,
  type PinVerdict,
} from '../mcp/catalog.js';
import {
  commandExists,
  describeMissingPrereqs,
  describePrereqProblems,
  resolveCommandPath,
} from '../mcp/prereqs.js';
import { serverOrigin, validateServerSpec, writeServerConfig } from '../mcp/custom-server.js';
import { parseRuntimeSpec } from '../mcp/runtime.js';
import { verifyNpmSpec } from '../mcp/pin-verifier.js';
import { loadMcpSettings } from '../mcp/settings.js';
import { logger } from '../utils/logger.js';

export class MCPCommand extends BaseCommand {
  create(): Command {
    const command = new Command('mcp')
      .description('Manage MCP (Model Context Protocol) server connections')
      .addHelpText('after', `
Examples:
  nuvira mcp list                          # List servers and tools
  nuvira mcp connect filesystem            # Connect to a server by name
  nuvira mcp connect --all                 # Connect to all discovered servers
  nuvira mcp call get_weather              # Call a tool (uses first connected server)
  nuvira mcp call read_file --server fs    # Call a tool on a specific server
  nuvira mcp call read_file --args '{"path":"/tmp/test.txt"}'
  nuvira mcp info filesystem               # Show server details
  nuvira mcp refresh                       # Re-discover and reconnect

Configured via JSON files in: ~/${MCP_CONFIG_DIR}/
  `);

    // ── list ──────────────────────────────────────────────────────────────
    command
      .command('list')
      .description('List all discovered MCP servers and their tools')
      .action(async () => {
        await this.listServers();
      });

    // ── connect ───────────────────────────────────────────────────────────
    command
      .command('connect')
      .description('Connect to an MCP server')
      .argument('[name]', 'Server name (omit with --all)')
      .option('--all', 'Connect to all discovered servers')
      .action(async (name?: string, options?: { all?: boolean }) => {
        await this.connectServer(name, options || {});
      });

    // ── call ──────────────────────────────────────────────────────────────
    command
      .command('call')
      .description('Call a tool on an MCP server')
      .argument('<tool-name>', 'Name of the tool to call')
      .option('-s, --server <name>', 'Server name (uses first found if omitted)')
      .option('-a, --args <json>', 'Tool arguments as JSON string')
      .action(async (toolName: string, options?: { server?: string; args?: string }) => {
        await this.callTool(toolName, options || {});
      });

    // ── info ──────────────────────────────────────────────────────────────
    command
      .command('info')
      .description('Show detailed information for an MCP server')
      .argument('<name>', 'Server name')
      .action(async (name: string) => {
        await this.showInfo(name);
      });

    // ── refresh ───────────────────────────────────────────────────────────
    command
      .command('refresh')
      .description('Re-discover and reconnect to all MCP servers')
      .action(async () => {
        await this.refreshServers();
      });

    // ── catalog (I7 P2; slots + variants + prerequisites) ─────────────────
    command
      .command('catalog')
      .description('List MCP capability slots, their variants, and what each one needs on this machine')
      .option('--search <q>', 'Filter the catalog by keyword')
      .action((opts?: { search?: string }) => {
        this.showCatalog(opts?.search);
      });

    // ── install (I7 P2; prerequisite + resolvability gated) ───────────────
    command
      .command('install <name>')
      .description('Install a catalog capability, choosing the best variant this machine can actually run')
      .option('--env <key=value>', 'Provide a prompt-secret env var (repeatable: --env KEY=VAL)', collectEnv, {})
      .option('--variant <id>', 'Force a variant id (see `mcp catalog`) — the only way to pick an opt-in one')
      .option(
        '--runtime <command>',
        'Run this server under its own interpreter, e.g. --runtime "/opt/node20/bin/node /usr/local/bin/npx"',
      )
      .option('--command <path>', 'Use an explicit executable path (a binary installed outside PATH)')
      .option('--force', 'Install even when a prerequisite is missing or a pin does not resolve')
      .option('--no-verify', 'Skip the npm resolvability check (offline; the result is reported as unverified)')
      .action(
        async (
          name: string,
          opts?: {
            env?: Record<string, string>;
            variant?: string;
            runtime?: string;
            command?: string;
            force?: boolean;
            verify?: boolean;
          },
        ) => {
          await this.installServer(name, opts ?? {});
        },
      );

    // ── add (custom server: configuration, not code) ──────────────────────
    command
      .command('add <name>')
      .description('Add a server that is NOT in the catalog — any stdio command or remote URL, like a config file')
      .option('--transport <kind>', "stdio | sse (inferred from --command / --url when omitted)")
      .option('--command <path>', 'stdio: the executable to run (npx, node, an absolute path, …)')
      .option('--arg <value>', 'stdio: one argument, in order (repeatable: --arg -y --arg @scope/pkg)', collectArg, [])
      .option('--env <key=value>', 'environment variable for the server (repeatable: --env TOKEN=abc)', collectEnv, {})
      .option('--url <url>', 'sse: the remote Streamable HTTP endpoint')
      .option('--header <name:value>', 'sse: one HTTP header, e.g. --header "Authorization: Bearer …" (repeatable)', collectHeader, {})
      .option('--json <spec>', 'a raw config object to start from — inline JSON, @file, or @- for stdin')
      .option('--force', 'replace an existing config file for this name')
      .option('--no-verify', 'skip the check that the stdio command exists on PATH')
      .action(
        async (
          name: string,
          opts?: {
            transport?: string;
            command?: string;
            arg?: string[];
            env?: Record<string, string>;
            url?: string;
            header?: Record<string, string>;
            json?: string;
            force?: boolean;
            verify?: boolean;
          },
        ) => {
          await this.addServer(name, opts ?? {});
        },
      );

    // ── settings (the `mcp.*` config surface, resolved) ───────────────────
    command
      .command('settings')
      .description('Show the resolved mcp.* configuration (caps, auto-connect, subagent inheritance)')
      .action(() => {
        this.showSettings();
      });

    // ── uninstall (I7 P2) ─────────────────────────────────────────────────
    command
      .command('authorize <name>')
      .description('Authorize an OAuth MCP server (opens the consent page, captures the loopback redirect, stores the token)')
      .option('--redirect-uri <uri>', 'Override the loopback redirect URI (must be registered on the OAuth client)')
      .option('--no-browser', 'Do not try to open the consent page — print the URL instead')
      .action(async (name: string, options?: { redirectUri?: string; browser?: boolean }) => {
        await this.authorizeServer(name, options || {});
      });

    command
      .command('uninstall <name>')
      .description('Remove an installed MCP server config')
      .action((name: string) => {
        const result = uninstallCatalogServer(name);
        if (!result.ok) {
          logger.error(`❌ ${result.reason}`);
          return;
        }
        logger.success(`✅ Removed '${name}' (${catalogConfigPath(name)}).`);
      });

    // ── serve (F2 follow-up: expose agent tools as an MCP server) ─────────
    command
      .command('serve')
      .description('Expose the agent\'s H1 tools as an MCP server over stdio (MCP clients / IDEs / other agents can connect)')
      .option('--with <tools>', 'Comma-separated extra tools to expose beyond the safe surface (e.g. publish)', '')
      .option(
        '--memory',
        'Also expose the MEMORY surface (search/add/replace/delete/list memories + stats) so the client can recall from the SAME store the agent writes to',
        false,
      )
      .action(async (options?: { with?: string; memory?: boolean }) => {
        await this.serveTools(options || {});
      });

    return command;
  }

  // ── Action Handlers ──────────────────────────────────────────────────────

  /**
   * `nuvira mcp catalog` — every capability slot with its ranked variants and
   * the prerequisite status of each. This is the "know what it offers and what
   * you must have before you enable it" surface: nothing is installed, nothing
   * is spawned, and a variant this machine cannot run says exactly why.
   */
  private showCatalog(search?: string): void {
    const entries = search ? searchCatalog(search) : MCP_CATALOG;
    // A `service` prerequisite (docker's daemon) can only be established by
    // actually asking it, so the CATALOG command runs those checks; unit tests
    // and any non-interactive caller leave `deep` off.
    const probe = { deep: true };
    if (entries.length === 0) {
      logger.info(`No catalog entries match '${search}'.`);
      return;
    }
    const cli = getCliName();
    console.log(`\n📦 ${entries.length} MCP capabilit${entries.length === 1 ? 'y' : 'ies'} (${entries.length === MCP_CATALOG.length ? 'full catalog' : 'filtered'}):\n`);
    for (const entry of entries) {
      const installed = isCatalogServerInstalled(entry.name) ? '  ✅ installed' : '';
      console.log(`  • ${entry.name}${installed}`);
      console.log(`    ${entry.description}`);
      console.log(`    offers:`);
      for (const offer of entry.offers) console.log(`      - ${offer}`);
      console.log(`    ways to run it (${entry.variants.length}):`);
      for (const choice of evaluateVariants(entry, { probe })) {
        this.printVariantLine(choice);
      }
      if (entry.supersedes) {
        console.log(`    supersedes: ${entry.supersedes}`);
      }
      console.log(`    install: ${cli} mcp install ${entry.name}`);
      console.log('');
    }
    console.log('Every variant is configuration, not code — the install writes');
    console.log('~/.nuvira/mcp/<name>.json and the caps/runtime come from `mcp.*` in');
    console.log('buffconfig.json (`' + getCliName() + ' mcp settings`).');
  }

  /** One variant: runnable or not, what it needs, its trust level and any caveat. */
  private printVariantLine(choice: MCPVariantChoice): void {
    const { variant, status } = choice;
    const mark = status.ok ? '✅' : '⛔';
    const optIn = variant.optIn ? ' [opt-in: --variant ' + variant.id + ']' : '';
    console.log(`      ${mark} ${variant.id} — ${variant.label}${optIn}  (${variant.trust})`);
    console.log(`         ${variant.command ? `${variant.command} ${(variant.args ?? []).join(' ')}` : variant.url}`);
    // "needs" = absent, "blocked" = present but not working. They are different
    // fixes, so they are different lines (the docker-daemon case).
    for (const line of describePrereqProblems(status)) {
      console.log(`         ${status.blocked.some((b) => line.startsWith(b.reason)) ? 'blocked:' : 'needs:'} ${line}`);
    }
    // Where a satisfied prerequisite actually IS — so "it says not installed" is
    // falsifiable in one `ls`, and a found binary is visibly found. Deduped: a
    // `command` and a `service` on the same binary is one fact, not two lines.
    const reported = new Set<string>();
    for (const prereq of variant.requires) {
      if (prereq.kind !== 'command' && prereq.kind !== 'service') continue;
      if (status.missing.includes(prereq) || reported.has(prereq.name)) continue;
      const path = resolveCommandPath(prereq.name, process.env);
      if (path) {
        reported.add(prereq.name);
        console.log(`         found: ${prereq.name} → ${path}`);
      }
    }
    for (const note of status.unverified) {
      console.log(`         note: ${note}`);
    }
    if (variant.note) console.log(`         caveat: ${variant.note}`);
  }

  /**
   * `nuvira mcp install` — probe, verify, then write.
   *
   * Order matters: choose a variant this machine can run, verify the pinned npm
   * spec exists (unless offline), and only then write the config. Each refusal
   * names the exact dependency, so a failed install teaches the user what to
   * install rather than leaving a dead server behind.
   */
  private async installServer(
    name: string,
    opts: {
      env?: Record<string, string>;
      variant?: string;
      runtime?: string;
      command?: string;
      force?: boolean;
      verify?: boolean;
    },
  ): Promise<void> {
    const entry = getCatalogEntry(name);
    if (!entry) {
      logger.error(`'${name}' is not in the catalog. Run \`${getCliName()} mcp catalog\` to see the capabilities.`);
      return;
    }

    const runtime = parseRuntimeSpec(opts.runtime);
    if (opts.runtime && !runtime) {
      logger.error(`--runtime '${opts.runtime}' is empty. Pass a command, e.g. --runtime "/opt/node20/bin/node /usr/local/bin/npx".`);
      return;
    }

    // Identify the target variant (for the resolvability check). Whether it can
    // actually run is decided in ONE place — `installCatalogServer` below — so a
    // flag like `--command` can satisfy a prerequisite without the CLI having its
    // own, differently-informed opinion.
    const chosen = chooseVariant(entry, {
      ...(opts.variant ? { variantId: opts.variant } : {}),
      ...(runtime ? { runtime } : {}),
      // Probe against the environment the install will actually use — including
      // secrets being supplied on this command line.
      probe: { env: effectiveProbeEnv(undefined, opts.env), deep: true },
    });
    const choice = chosen.ok
      ? chosen.choice
      : opts.variant
        ? chosen.choices.find((c) => c.variant.id === opts.variant)
        : undefined;

    // npm resolvability (network). A miss refuses; unreachable proceeds unverified.
    const pinSpecs = choice ? npmSpecsForVariant(choice.variant) : [];
    let pinVerdict: PinVerdict | undefined;
    if (pinSpecs.length > 0 && opts.verify !== false) {
      const verdicts = await Promise.all(pinSpecs.map((spec) => verifyNpmSpec(spec)));
      const failed = verdicts.find((v) => v.checked && !v.ok);
      const unreachable = verdicts.find((v) => !v.checked);
      const deprecated = verdicts.find((v) => v.deprecated);
      if (failed) {
        pinVerdict = failed;
      } else if (unreachable) {
        pinVerdict = unreachable;
        logger.warn(`  ⚠️  Could not verify ${pinSpecs.join(', ')} — ${unreachable.reason}. Saved unverified.`);
      } else {
        pinVerdict = { checked: true, ok: true };
      }
      if (deprecated?.deprecated) {
        logger.warn(`  ⚠️  npm marks this package deprecated: ${deprecated.deprecated}`);
      }
    }

    const result = installCatalogServer(entry, opts.env ?? {}, undefined, {
      ...(opts.variant ? { variantId: opts.variant } : {}),
      ...(opts.command ? { command: opts.command } : {}),
      ...(runtime ? { runtime } : {}),
      ...(pinVerdict ? { pinVerdict } : {}),
      ...(opts.force ? { force: true } : {}),
      probe: { env: effectiveProbeEnv(undefined, opts.env), deep: true },
    });
    if (!result.ok) {
      logger.error(`❌ ${result.reason}`);
      if (result.missing?.some((line) => line.includes('not found on PATH'))) {
        logger.info('  Already installed but not on PATH? Point at it: --command /path/to/binary');
      }
      if (result.missing?.length) {
        logger.info(`  All variants: ${getCliName()} mcp catalog --search ${name}`);
      }
      return;
    }

    const variant = choice?.variant ?? entry.variants.find((v) => v.id === result.variantId)!;
    logger.success(`✅ Installed '${name}' (${result.variantId}) → ${result.path}`);
    console.log(`  ${entry.description}`);
    console.log(`  what you get:`);
    for (const offer of entry.offers) console.log(`    - ${offer}`);
    if (opts.command) console.log(`  command: ${opts.command}`);
    if (runtime || variant.runtime) {
      const rt = runtime ?? variant.runtime!;
      console.log(`  runtime override: ${[rt.command, ...(rt.args ?? [])].join(' ')}`);
    }
    if (variant.transport === 'sse') {
      console.log('  remote server — nothing is installed locally.');
    }
    if (variant.note) console.log(`  caveat: ${variant.note}`);
    if (result.unverifiedPins) console.log('  note: the pinned npm version was NOT verified against the registry.');
    console.log(`  verify: ${getCliName()} mcp connect ${name}`);
    console.log(`  tune:   ${getCliName()} mcp settings   (caps, auto-connect, per-server overrides)`);
  }

  /** `nuvira mcp settings` — the resolved `mcp.*` section, and how to change it. */
  private showSettings(): void {
    const settings = loadMcpSettings();
    console.log('\n  MCP settings (buffconfig.json → "mcp"):\n');
    console.log(`    enabled             ${settings.enabled ? 'true' : 'false'}   (master switch)`);
    console.log(`    autoConnect         ${settings.autoConnect ? 'true' : 'false'}   (connect at turn start)`);
    console.log(`    connectTimeoutMs    ${settings.connectTimeoutMs}   (wall-clock budget for the connect step)`);
    // NOTE: these two are parsed, stored and reported, but NOT yet enforced —
    // no code path truncates MCP tool exposure by them (`effectiveToolCap` in
    // mcp/settings.ts has no callers). Saying "eager tool schemas per server"
    // would describe a limit that does not bite.
    console.log(`    maxToolsPerServer   ${settings.maxToolsPerServer}   (per-server cap — stored, NOT enforced yet)`);
    console.log(`    maxToolsTotal       ${settings.maxToolsTotal}   (cross-server cap — stored, NOT enforced yet)`);
    console.log(`    subagent.inherit    ${settings.subagentInheritance}   (call by a subagent)`);
    console.log('');
    console.log('    subagent.inherit: "conservative" = a subagent only gets MCP when the parent had it');
    console.log('    AND its own allowance covers it. "full" = the parent\'s whole MCP set is passed down');
    console.log('    (still cap-bound and still governed by effect classes, hooks and grants).');
    console.log('');

    const servers = Object.entries(settings.servers);
    if (servers.length > 0) {
      console.log('    per-server overrides:');
      for (const [name, override] of servers) {
        const parts = [
          override.enabled === false ? 'disabled' : undefined,
          override.variant ? `variant=${override.variant}` : undefined,
          override.command ? `command=${override.command}` : undefined,
          override.runtime ? `runtime=${override.runtime.command}` : undefined,
          override.args ? `args=${override.args.join(' ')}` : undefined,
          override.maxTools !== undefined ? `maxTools=${override.maxTools}` : undefined,
        ].filter(Boolean);
        console.log(`      ${name}: ${parts.join(', ') || '(no recognized keys)'}`);
      }
      console.log('');
    }

    for (const warning of settings.warnings) logger.warn(`  ⚠️  ${warning}`);
    console.log('  Change one with, e.g.:');
    console.log(`    ${getCliName()} config set mcp.subagent.inherit full`);
    console.log(`    ${getCliName()} config set mcp.servers.context7.runtime.command /opt/node20/bin/node`);
    console.log('');
  }

  /**
   * `nuvira mcp add <name>` — configure a server we have never heard of.
   *
   * This is the parity path with Claude Desktop / Hermes: the CATALOG is a
   * convenience (curated variants, prerequisites probed, pins verified), not a
   * gate on what may be connected. Discovery has always read `*.json` from the
   * config dir, so this command writes exactly that file — no code, no release,
   * for anything the user names.
   *
   * Gates that DO apply, because a config that cannot connect is worse than a
   * refusal: the name must be usable as a filename and a settings key, stdio
   * and sse fields cannot be mixed, and the stdio command must exist on PATH
   * (`--no-verify` overrides, for a command that only exists in the server's own
   * environment).
   */
  private async addServer(
    name: string,
    opts: {
      transport?: string;
      command?: string;
      arg?: string[];
      env?: Record<string, string>;
      url?: string;
      header?: Record<string, string>;
      json?: string;
      force?: boolean;
      verify?: boolean;
    },
  ): Promise<void> {
    const fail = (message: string): void => {
      logger.error(`❌ ${message}`);
      process.exitCode = 1;
    };

    // A pasted vendor snippet is a first-class input (that is how every MCP
    // README documents its server), so `--json` seeds the spec and explicit
    // flags override individual fields.
    let base: Record<string, unknown> = {};
    if (opts.json) {
      try {
        let text = opts.json;
        if (opts.json.startsWith('@')) {
          const target = opts.json === '@-' ? 0 : opts.json.slice(1);
          text = readFileSync(target, 'utf-8');
        }
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return fail('--json must be a JSON object, e.g. { "command": "npx", "args": ["-y", "pkg"] }.');
        }
        base = parsed as Record<string, unknown>;
      } catch (err) {
        return fail(`Could not read --json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const baseEnv = (base.env ?? {}) as Record<string, string>;
    const baseHeaders = (base.headers ?? {}) as Record<string, string>;
    const spec: Record<string, unknown> = {
      ...base,
      name,
      ...(opts.transport ? { transport: opts.transport } : {}),
      ...(opts.command ? { command: opts.command } : {}),
      ...(opts.arg && opts.arg.length > 0 ? { args: opts.arg } : {}),
      ...(opts.url ? { url: opts.url } : {}),
      ...(Object.keys(opts.env ?? {}).length > 0 ? { env: { ...baseEnv, ...opts.env } } : {}),
      ...(Object.keys(opts.header ?? {}).length > 0 ? { headers: { ...baseHeaders, ...opts.header } } : {}),
    };
    if (base.name !== undefined && base.name !== name) {
      logger.warn(`  note: the JSON named this server '${String(base.name)}' — using '${name}'.`);
    }

    const validated = validateServerSpec(spec);
    if (!validated.ok) return fail(validated.error);
    const { config, warnings } = validated;

    // The `install` gate, applied to a hand-written command: name the missing
    // dependency instead of writing a server that will fail at connect time.
    if (config.transport === 'stdio' && config.command && opts.verify !== false) {
      if (!commandExists(config.command)) {
        return fail(
          `'${config.command}' was not found on PATH, so this server could not start.\n` +
            `  Install it, point at it with --command /absolute/path, or pass --no-verify ` +
            `to configure it anyway.`,
        );
      }
    }

    const result = writeServerConfig(config, {
      ...(opts.force ? { force: true } : {}),
      warnings,
    });
    if (!result.ok) return fail(result.reason ?? 'Could not write the config.');

    const cli = getCliName();
    logger.success(`✅ ${result.overwrote ? 'Updated' : 'Added'} '${config.name}' → ${result.path}`);
    console.log(
      `  ${config.transport === 'stdio' ? `${config.command} ${(config.args ?? []).join(' ')}`.trim() : config.url}`,
    );
    const envKeys = Object.keys(config.env ?? {});
    if (envKeys.length > 0) {
      console.log(`  credentials: ${envKeys.join(', ')} (written to the config file, never printed)`);
    }
    for (const warning of result.warnings ?? []) console.log(`  note: ${warning}`);
    if (result.droppedEnvKeys && result.droppedEnvKeys.length > 0) {
      logger.warn(
        `  ⚠️  the replaced config had credentials this one does not: ${result.droppedEnvKeys.join(', ')}`,
      );
    }
    console.log(`  verify: ${cli} mcp connect ${config.name}`);
    console.log(`  call:   ${cli} mcp call <tool-name> --server ${config.name}`);
    console.log(`  manage: ${cli} mcp settings   (enable/disable, runtime override, caps)`);
  }

  private async listServers(): Promise<void> {
    const manager = getMCPManager();
    const states = manager.getAllStates();
    const allTools = manager.getAllTools();

    logger.highlight('═'.repeat(60));
    logger.highlight('  🔌  MCP Server Connections');
    logger.highlight('═'.repeat(60));
    console.log('');

    if (states.length === 0) {
      logger.info(`No MCP servers configured. Add config files to ~/${MCP_CONFIG_DIR}/`);
      console.log('');
      console.log('  Example config (filesystem.json):');
      console.log('  {');
      console.log('    "name": "filesystem",');
      console.log('    "transport": "stdio",');
      console.log('    "command": "npx",');
      console.log('    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"],');
      console.log('    "enabled": true');
      console.log('  }');
      console.log('');
      return;
    }

    for (const state of states) {
      const statusIcon = state.status === 'connected' ? '🟢' : state.status === 'error' ? '🔴' : '⚪';
      const toolCount = state.tools.length;
      const resourceCount = state.resources.length;

      console.log(`  ${statusIcon} ${state.name} (${state.transport}, ${state.status})`);
      console.log(`     Server: ${state.serverInfo ? `${state.serverInfo.name} v${state.serverInfo.version}` : 'N/A'}`);
      console.log(`     Tools: ${toolCount}  |  Resources: ${resourceCount}  |  Prompts: ${state.prompts.length}`);
      console.log('');
    }

    if (allTools.length > 0) {
      logger.highlight(`  🛠️  All Available Tools (${allTools.length})`);
      console.log('');

      // Group tools by server
      const byServer = new Map<string, typeof allTools>();
      for (const entry of allTools) {
        const list = byServer.get(entry.server) || [];
        list.push(entry);
        byServer.set(entry.server, list);
      }

      for (const [server, tools] of byServer) {
        console.log(`  ${server}:`);
        for (const { tool } of tools) {
          const desc = tool.description ? ` — ${tool.description.slice(0, 60)}` : '';
          console.log(`    • ${tool.name}${desc}`);
        }
        console.log('');
      }

      logger.info('Run `${getCliName()} mcp call <tool-name>` to invoke a tool.');
    }

    console.log('');
  }

  private async connectServer(
    name: string | undefined,
    options: { all?: boolean },
  ): Promise<void> {
    const manager = getMCPManager();

    if (options.all) {
      logger.info('Connecting to all discovered MCP servers...');
      console.log('');

      const connected = await manager.connectAll();

      if (connected.length === 0) {
        logger.info('No MCP servers found or connected.');
        console.log('');
        return;
      }

      logger.success(`Connected to ${connected.length} MCP server(s)`);
      for (const client of connected) {
        const toolCount = client.tools.length;
        const serverVersion = client.serverInfo ? `${client.serverInfo.name} v${client.serverInfo.version}` : 'unknown';
        console.log(`  🟢 ${client.name} — ${serverVersion} (${toolCount} tools)`);
      }
      console.log('');
      // One-shot: release every stdio child so the command exits (see above).
      manager.disconnectAll();
      return;
    }

    if (!name) {
      logger.error('Specify a server name or use --all to connect to all.');
      console.log('');
      return;
    }

    try {
      logger.info(`Connecting to MCP server '${name}'...`);
      const client = await manager.connect(name);
      logger.success(`Connected to '${name}' (${client.serverInfo?.name || 'unknown'} v${client.serverInfo?.version || '?'})`);
      console.log(`  Tools: ${client.tools.length}`);
      console.log(`  Resources: ${client.resources.length}`);
      console.log(`  Prompts: ${client.prompts.length}`);
      console.log('');
      // A one-shot command must not hold the session open: a stdio server keeps
      // its child alive, so without this `nuvira mcp connect <name>` (the step
      // `mcp install` prints as "verify") never returned to the shell.
      manager.disconnect(name);
    } catch (err) {
      logger.error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
      console.log('');
      // `mcp install` prints this command as the "verify" step, so a failed
      // verification must be a non-zero exit — otherwise a script (or CI) reads
      // a dead server as a working one.
      process.exitCode = 1;
    }
  }

  private async callTool(
    toolName: string,
    options: { server?: string; args?: string },
  ): Promise<void> {
    const manager = getMCPManager();

    let args: Record<string, unknown> | undefined;
    if (options.args) {
      try {
        args = JSON.parse(options.args) as Record<string, unknown>;
      } catch {
        logger.error('Invalid JSON in --args. Use valid JSON like: --args \'{"key":"value"}\'');
        console.log('');
        return;
      }
    }

    // WHY THE CLI CONNECTS FIRST. A `call` used to require a connection that
    // only existed inside a long-lived process, so `nuvira mcp call <tool>`
    // could never work from a shell — the one thing a user wants right after
    // adding a server. Connecting here (and releasing it again) makes `call`
    // the shortest honest way to prove a config works.
    if (options.server) {
      // Call on a specific server
      let client = manager.getClient(options.server);
      const openedHere = !client;
      if (!client) {
        try {
          client = await manager.connect(options.server);
        } catch (err) {
          logger.error(
            `Server '${options.server}' is not connected and could not be reached: ${err instanceof Error ? err.message : String(err)}`,
          );
          logger.info(`Check the config with \`${getCliName()} mcp info ${options.server}\`.`);
          console.log('');
          process.exitCode = 1;
          return;
        }
      }

      logger.info(`Calling ${options.server}.${toolName}...`);
      console.log('');

      try {
        const result = await client.callTool(toolName, args);
        this.renderToolResult(result);
      } catch (err) {
        logger.error(`Tool call failed: ${err instanceof Error ? err.message : String(err)}`);
        console.log('');
        process.exitCode = 1;
      } finally {
        // One-shot: release the child we opened, or the process never exits.
        if (openedHere) manager.disconnect(options.server);
      }
    } else {
      // Search across all connected servers — connecting them first when this
      // process has nothing, so a bare `mcp call <tool>` is a real lookup.
      const openedHere = manager.getAllTools().length === 0;
      if (openedHere) {
        logger.info('Discovering MCP servers...');
        await manager.connectAll();
      }
      logger.info(`Searching for tool '${toolName}' across all connected servers...`);
      console.log('');

      try {
        const result = await manager.callTool(toolName, args);
        if (!result) {
          logger.error(`Tool '${toolName}' not found on any connected server.`);
          logger.info(`Use \`${getCliName()} mcp list\` to see available tools.`);
          console.log('');
          process.exitCode = 1;
          return;
        }

        logger.success(`Found tool on server '${result.server}'`);
        console.log('');
        this.renderToolResult(result.result);
      } finally {
        if (openedHere) manager.disconnectAll();
      }
    }
  }

  private async showInfo(name: string): Promise<void> {
    const manager = getMCPManager();
    const states = manager.getAllStates();
    const state = states.find((s) => s.name === name);

    if (!state) {
      logger.error(`MCP server '${name}' not found.`);
      logger.info(`Add a config file to ~/${MCP_CONFIG_DIR}/ or use a different name.`);
      console.log('');
      return;
    }

    const statusIcon = state.status === 'connected' ? '🟢' : state.status === 'error' ? '🔴' : '⚪';
    logger.highlight(`  ${statusIcon}  ${state.name}`);
    console.log('');
    console.log(`  Transport: ${state.transport}`);
    // Where the config came from — a curated install and a hand-written file are
    // both fine, and knowing which one is in play is what makes debugging one of
    // them possible.
    const origin = serverOrigin(name);
    console.log(
      `  Source: ${
        origin.origin === 'catalog'
          ? `catalog${origin.variant ? ` (variant ${origin.variant})` : ' (config written by `mcp install`)'}`
          : 'custom (hand-written, or written by `mcp add`)'
      }`,
    );
    console.log(`  Status: ${state.status}`);
    if (state.serverInfo) {
      console.log(`  Server: ${state.serverInfo.name} v${state.serverInfo.version}`);
    }
    if (state.error) {
      console.log(`  Error: ${state.error}`);
    }
    console.log('');

    if (state.tools.length > 0) {
      logger.highlight(`  🛠️  Tools (${state.tools.length})`);
      console.log('');
      for (const tool of state.tools) {
        console.log(`  ${tool.name}`);
        if (tool.description) {
          console.log(`    ${tool.description}`);
        }
        if (tool.inputSchema) {
          const props = (tool.inputSchema as any).properties;
          if (props) {
            const paramNames = Object.keys(props).join(', ');
            console.log(`    Params: ${paramNames}`);
          }
        }
        console.log('');
      }
    }

    if (state.resources.length > 0) {
      logger.highlight(`  📄 Resources (${state.resources.length})`);
      console.log('');
      for (const resource of state.resources) {
        console.log(`  ${resource.uri}`);
        console.log(`    ${resource.name}`);
        console.log('');
      }
    }
  }

  private async refreshServers(): Promise<void> {
    const manager = getMCPManager();

    logger.info('Refreshing MCP server connections...');

    // Disconnect all
    manager.disconnectAll();

    // Re-discover and connect
    const connected = await manager.connectAll();

    if (connected.length === 0) {
      logger.info('No MCP servers found to connect.');
      console.log('');
      return;
    }

    logger.success(`Refreshed: ${connected.length} MCP server(s) connected`);
    for (const client of connected) {
      const toolCount = client.tools.length;
      console.log(`  🟢 ${client.name} — ${toolCount} tools`);
    }
    console.log('');
  }

  // ── MCP server (F2 follow-up) ─────────────────────────────────────────

  /**
   * `nuvira mcp authorize <name>` — complete an OAuth authorization-code flow
   * for a configured remote server and store the token. The token is then
   * refreshed silently on every connect (see `oauth-connect.ts`).
   */
  private async authorizeServer(name: string, options: { redirectUri?: string; browser?: boolean }): Promise<void> {
    const { getMCPManager } = await import('../mcp/manager.js');
    const { runAuthorizeFlow } = await import('../mcp/oauth-authorize.js');
    const config = getMCPManager().discoverConfigs().find((c) => c.name === name);
    if (!config) {
      logger.error(`No configured MCP server named '${name}'.`);
      const oauthServers = getMCPManager().discoverConfigs().filter((c) => c.oauth).map((c) => c.name);
      if (oauthServers.length > 0) logger.info(`OAuth servers you can authorize: ${oauthServers.join(', ')}`);
      else logger.info('Install one first, e.g. `nuvira mcp install gmail --env GOOGLE_MCP_CLIENT_ID=… --env GOOGLE_MCP_CLIENT_SECRET=…`.');
      process.exitCode = 1;
      return;
    }
    if (!config.oauth) {
      logger.error(`'${name}' is not an OAuth server — it authenticates with ${config.headers ? 'a static header' : 'its own transport credentials'}.`);
      logger.info('Nothing to authorize. OAuth servers are the ones with an `oauth` block (gmail, gdrive, gcalendar).');
      process.exitCode = 1;
      return;
    }
    const clientId = config.oauth.clientId;
    if (!clientId) {
      logger.error(`'${name}' has no oauth.clientId — reinstall with --env GOOGLE_MCP_CLIENT_ID=… .`);
      process.exitCode = 1;
      return;
    }

    const { toOAuthConfig } = await import('../mcp/oauth-connect.js');
    const result = await runAuthorizeFlow(name, toOAuthConfig(config.oauth), {
      ...(options.redirectUri ? { redirectUri: options.redirectUri } : {}),
      ...(options.browser === false ? { openBrowser: false } : {}),
    });
    if (!result.ok) {
      logger.error(result.reason);
      process.exitCode = 1;
      return;
    }
    const expiresIn = Math.max(0, Math.round((result.tokens.expiresAt - Date.now()) / 1000));
    logger.success(`Authorized '${name}' — access token valid ~${expiresIn}s, refresh token ${result.tokens.refreshToken ? 'stored' : 'NOT issued (a new authorization will be needed when it expires)'}.`);
    logger.info('Connect with `nuvira mcp list`; the token is refreshed automatically from now on.');
  }

  private async serveTools(options: { with?: string; memory?: boolean }): Promise<void> {
    try {
      const { serveStdio, AGENT_MCP_TOOL_NAMES, MEMORY_MCP_TOOL_NAMES } = await import('../mcp/server.js');
      const extraTools = (options.with || '').split(',').map((t) => t.trim()).filter(Boolean);
      const includeMemory = options.memory === true;
      const exposed = [...AGENT_MCP_TOOL_NAMES, ...(includeMemory ? MEMORY_MCP_TOOL_NAMES : []), ...extraTools];

      // CRITICAL: the MCP stdio protocol owns stdout — every byte written
      // there must be a protocol frame, or clients (MCP hosts, IDEs)
      // fail their initialize handshake. Route ALL human output to stderr.
      const banner = (s: string): void => { process.stderr.write(s + '\n'); };
      banner('═'.repeat(60));
      banner('  🖥️  Agent-Nuvira MCP Server (stdio)');
      banner('═'.repeat(60));
      banner('');
      banner(`  Exposing ${exposed.length} tool(s)${includeMemory ? ' (memory surface ON — the client can read and write this agent\'s memory)' : ''}:`);
      for (const name of exposed) {
        banner(`    • ${name}`);
      }
      banner('');
      banner('  Waiting for MCP client on stdin/stdout... (Ctrl+C to stop)');
      banner('');
      await serveStdio({ extraTools, ...(includeMemory ? { includeMemory: true } : {}) });
    } catch (err) {
      // logger.error goes to stderr — safe here.
      logger.error(`MCP server failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  private renderToolResult(result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }): void {
    if (result.isError) {
      logger.error('Tool returned an error:');
    } else {
      logger.success('Tool executed successfully:');
    }
    console.log('');

    for (const content of result.content) {
      if (content.type === 'text' && content.text) {
        // Limit output to avoid flooding the terminal
        const maxLength = 2000;
        const text = content.text.length > maxLength
          ? content.text.slice(0, maxLength) + `\n... [truncated, ${content.text.length} total chars]`
          : content.text;
        console.log(text);
        console.log('');
      } else if (content.type === 'image') {
        console.log(`  [Image: ${content.mimeType || 'unknown type'}, ${(content.data?.length || 0)} bytes]`);
        console.log('');
      }
    }
  }
}

/** Collect repeatable `--env KEY=VAL` options into a map (I7 P2 secrets). */
function collectEnv(value: string, previous: Record<string, string>): Record<string, string> {
  const idx = value.indexOf('=');
  if (idx <= 0) {
    logger.warn(`Ignoring malformed --env '${value}' (expected KEY=value).`);
    return previous;
  }
  return { ...previous, [value.slice(0, idx)]: value.slice(idx + 1) };
}

/** Collect repeatable `--arg` options in the order they were written. */
function collectArg(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Collect repeatable `--header "Name: value"` options into a map.
 *
 * The first colon splits name from value (a URL value contains colons of its
 * own), and a value may be empty — `--header "X-Empty:"` is a valid header.
 */
function collectHeader(value: string, previous: Record<string, string>): Record<string, string> {
  const idx = value.indexOf(':');
  if (idx <= 0) {
    logger.warn(`Ignoring malformed --header '${value}' (expected "Name: value").`);
    return previous;
  }
  const name = value.slice(0, idx).trim();
  if (!name) {
    logger.warn(`Ignoring malformed --header '${value}' (empty header name).`);
    return previous;
  }
  return { ...previous, [name]: value.slice(idx + 1).trim() };
}
