/**
 * MCP settings — the `mcp.*` section of `buffconfig.json`, resolved.
 *
 * Assessment §8.6 found the config-only levers were: a file's presence, its own
 * `enabled` flag, the `mcp` toolset toggle and `tools.loopExposure` — and that
 * `enableMcp` existed only as a programmatic option with no config home. This
 * module is that home, and it is deliberately SMALL: one section, all keys
 * optional, every default reproducing today's behaviour so an existing install
 * that never touches it is byte-identical.
 *
 * ```jsonc
 * "mcp": {
 *   "enabled": true,            // master switch
 *   "autoConnect": true,        // connect at turn start (existence-gated)
 *   "connectTimeoutMs": 2000,   // wall-clock budget; exceeding it proceeds without MCP
 *   "maxToolsPerServer": 15,    // eager-schema cap per server
 *   "maxToolsTotal": 60,        // eager-schema cap across all servers
 *   "subagent": { "inherit": "conservative" },  // 'conservative' | 'full'
 *   "servers": {
 *     "context7": { "runtime": { "command": "/opt/node20/bin/node", "args": ["/usr/local/bin/npx"] } },
 *     "filesystem": { "args": ["/Users/me/project"], "enabled": false }
 *   }
 * }
 * ```
 *
 * WHY IT READS THE FILE DIRECTLY instead of going through `ConfigManager`:
 * the MCP layer is used by tests, the parity harness and (from Phase 2) every
 * chat surface, and it must not drag the config manager's vault/env bootstrap
 * into a discovery call. The keys here are non-secret scalars, and the pure
 * resolver (`resolveMcpSettings`) is exported so a caller that ALREADY holds the
 * config object (the dashboard, the CLI) resolves the exact same values.
 */

import { readFileSync } from 'node:fs';

import { resolveNuviraConfigDir, resolveNuviraConfigReadPaths } from '../config/paths.js';
import { logger } from '../utils/logger.js';
import type { MCPServerConfig } from './types.js';

/**
 * How much MCP a SUBAGENT inherits from its parent.
 *
 * - `conservative` (DEFAULT) — plan §7.7: the child inherits MCP only when the
 *   parent already had it AND the child's allowance covers it. A subagent never
 *   silently gains reach.
 * - `full` — explicit opt-in for Claude-style power: the child receives the
 *   parent's whole discovered MCP set (still cap-bound, still governed by
 *   effectClass/hooks/grants — the override widens REACH, never APPROVAL).
 *
 * Default is deliberately the safe one; turning it on is a decision a user makes
 * once, in config, and can undo the same way.
 */
export type MCPSubagentInheritance = 'conservative' | 'full';

/** Per-server overrides, merged over the server's own config file. */
export interface MCPServerOverride {
  /** Disable a configured server without deleting its file. */
  enabled?: boolean;
  /** Pin which catalog variant this server is (reported by `mcp list`). */
  variant?: string;
  /**
   * Replace the stdio COMMAND — the path to a binary that is installed but NOT
   * on PATH (e.g. `~/.local/bin/github-mcp-server`). Without this, a locally
   * installed server is invisible to the probe and un-installable through the
   * catalog, which is a reach gap rather than a missing capability.
   */
  command?: string;
  /** Per-server runtime override (see `runtime.ts`). */
  runtime?: { command: string; args?: string[] };
  /** Replace the stdio args (e.g. the allowed roots for `filesystem`). */
  args?: string[];
  /** Per-server eager-schema cap, overriding `maxToolsPerServer`. */
  maxTools?: number;
}

export interface MCPConfigSection {
  enabled?: boolean;
  autoConnect?: boolean;
  connectTimeoutMs?: number;
  maxToolsPerServer?: number;
  maxToolsTotal?: number;
  subagent?: { inherit?: MCPSubagentInheritance | string };
  servers?: Record<string, MCPServerOverride>;
}

/**
 * Merge a validated patch into the stored section.
 *
 * WHY THIS EXISTS rather than a plain spread: `runtime` is a nested object, so a
 * patch that sets only `runtime.command` would otherwise DROP a previously
 * configured `runtime.args` (and vice versa). It also has to preserve an
 * explicit `undefined` as a CLEAR — a plain `{...old, ...new}` cannot tell
 * "not mentioned" from "cleared".
 */
export function mergeMcpSetting(
  existing: MCPConfigSection | null | undefined,
  patch: MCPConfigSection,
): MCPConfigSection {
  const base = existing ?? {};
  const servers: Record<string, MCPServerOverride> = { ...(base.servers ?? {}) };
  for (const [name, override] of Object.entries(patch.servers ?? {})) {
    const previous = base.servers?.[name] ?? {};
    const next = override as MCPServerOverride & { runtime?: MCPServerOverride['runtime'] };
    const { runtime: patchedRuntime, ...rest } = next;

    let runtime: MCPServerOverride['runtime'] | undefined;
    if (!('runtime' in next)) {
      runtime = previous.runtime; // not mentioned — leave it alone
    } else if (!patchedRuntime) {
      runtime = undefined; // explicit clear (`runtime.command` set to empty)
    } else if (!patchedRuntime.command && previous.runtime?.command) {
      // `runtime.args` on its own must not erase the command it applies to: the
      // parser emits an empty command because it cannot see the stored one.
      runtime = {
        command: previous.runtime.command,
        ...(patchedRuntime.args !== undefined ? { args: patchedRuntime.args } : {}),
      };
    } else {
      // Setting the command must not drop args that were configured earlier
      // (and vice versa) — `runtime` is one object, set in two commands.
      runtime = {
        ...patchedRuntime,
        ...(patchedRuntime.args === undefined && previous.runtime?.args
          ? { args: previous.runtime.args }
          : {}),
      };
    }

    const merged: MCPServerOverride = { ...previous, ...rest };
    if (runtime) merged.runtime = runtime;
    else delete merged.runtime;
    servers[name] = merged;
  }
  return {
    ...base,
    ...patch,
    ...(base.subagent || patch.subagent
      ? { subagent: { ...(base.subagent ?? {}), ...(patch.subagent ?? {}) } }
      : {}),
    ...(Object.keys(servers).length > 0 ? { servers } : {}),
  };
}

export interface ResolvedMCPSettings {
  enabled: boolean;
  autoConnect: boolean;
  connectTimeoutMs: number;
  maxToolsPerServer: number;
  maxToolsTotal: number;
  subagentInheritance: MCPSubagentInheritance;
  servers: Record<string, MCPServerOverride>;
  /** Config values that were ignored/coerced, so a caller can report them once. */
  warnings: string[];
}

export const MCP_SETTING_DEFAULTS = {
  enabled: true,
  autoConnect: true,
  connectTimeoutMs: 2000,
  maxToolsPerServer: 15,
  maxToolsTotal: 60,
  subagentInheritance: 'conservative' as MCPSubagentInheritance,
} as const;

/** Clamp bounds — a typo must not disable the budget or hang a turn for a minute. */
const CONNECT_TIMEOUT_MIN_MS = 250;
const CONNECT_TIMEOUT_MAX_MS = 15_000;
const MAX_TOOLS_PER_SERVER_CEILING = 200;
const MAX_TOOLS_TOTAL_CEILING = 1000;

function positiveInt(value: unknown, fallback: number, min: number, max: number, key: string, warnings: string[]): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    warnings.push(`mcp.${key} must be a positive integer — using ${fallback}`);
    return fallback;
  }
  if (n < min || n > max) {
    const clamped = Math.min(Math.max(n, min), max);
    warnings.push(`mcp.${key} ${n} is outside ${min}–${max} — using ${clamped}`);
    return clamped;
  }
  return n;
}

function booleanSetting(value: unknown, fallback: boolean, key: string, warnings: string[]): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(lower)) return true;
    if (['false', '0', 'no', 'off'].includes(lower)) return false;
  }
  warnings.push(`mcp.${key} must be true or false — using ${fallback}`);
  return fallback;
}

/**
 * Resolve the raw `mcp` section into settings with defaults + bounds applied.
 * Pure: no I/O, so the dashboard, the CLI and tests all agree on the values.
 */
export function resolveMcpSettings(raw?: MCPConfigSection | null): ResolvedMCPSettings {
  const warnings: string[] = [];
  const section = raw ?? {};

  const inheritRaw = section.subagent?.inherit;
  let subagentInheritance: MCPSubagentInheritance = MCP_SETTING_DEFAULTS.subagentInheritance;
  if (inheritRaw !== undefined) {
    if (inheritRaw === 'conservative' || inheritRaw === 'full') {
      subagentInheritance = inheritRaw;
    } else {
      warnings.push(
        `mcp.subagent.inherit must be 'conservative' or 'full' (got '${String(inheritRaw)}') — using 'conservative'`,
      );
    }
  }

  return {
    enabled: booleanSetting(section.enabled, MCP_SETTING_DEFAULTS.enabled, 'enabled', warnings),
    autoConnect: booleanSetting(section.autoConnect, MCP_SETTING_DEFAULTS.autoConnect, 'autoConnect', warnings),
    connectTimeoutMs: positiveInt(
      section.connectTimeoutMs,
      MCP_SETTING_DEFAULTS.connectTimeoutMs,
      CONNECT_TIMEOUT_MIN_MS,
      CONNECT_TIMEOUT_MAX_MS,
      'connectTimeoutMs',
      warnings,
    ),
    maxToolsPerServer: positiveInt(
      section.maxToolsPerServer,
      MCP_SETTING_DEFAULTS.maxToolsPerServer,
      1,
      MAX_TOOLS_PER_SERVER_CEILING,
      'maxToolsPerServer',
      warnings,
    ),
    maxToolsTotal: positiveInt(
      section.maxToolsTotal,
      MCP_SETTING_DEFAULTS.maxToolsTotal,
      1,
      MAX_TOOLS_TOTAL_CEILING,
      'maxToolsTotal',
      warnings,
    ),
    subagentInheritance,
    servers: { ...(section.servers ?? {}) },
    warnings,
  };
}

/** Parse outcome for one `mcp.*` setting. */
export type McpSettingParse =
  | { ok: true; mcp: MCPConfigSection }
  | { ok: false; error: string };

/** Human list of the keys the parser accepts (shared by every error message). */
export const MCP_SETTING_KEYS = [
  'mcp.enabled',
  'mcp.autoConnect',
  'mcp.connectTimeoutMs',
  'mcp.maxToolsPerServer',
  'mcp.maxToolsTotal',
  'mcp.subagent.inherit',
  'mcp.servers.<name>.enabled',
  'mcp.servers.<name>.command',
  'mcp.servers.<name>.variant',
  'mcp.servers.<name>.maxTools',
  'mcp.servers.<name>.args',
  'mcp.servers.<name>.runtime.command',
  'mcp.servers.<name>.runtime.args',
] as const;

/**
 * Validate ONE `mcp.*` setting from its dotted path and string value.
 *
 * SHARED BY DESIGN. `nuvira config set mcp.*` and the dashboard's MCP page both
 * call this, so the same key cannot be accepted in one surface and rejected —
 * or coerced differently — in the other, and both write the same
 * `buffconfig.json` section. A setting that "saves" in the dashboard and is
 * ignored by the CLI would be a silent lie on one of the two surfaces.
 *
 * Pure: no writes, no filesystem, no environment. Booleans accept
 * true/false, 1/0, yes/no, on/off; numbers are integers; `args` split on commas;
 * an empty value CLEARS a string/list.
 */
export function parseMcpSetting(key: string, value: string): McpSettingParse {
  const parts = String(key).trim().split('.');
  const raw = String(value ?? '');
  const trimmed = raw.trim();

  const bool = (): boolean | null => {
    const lower = trimmed.toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(lower)) return true;
    if (['false', '0', 'no', 'off'].includes(lower)) return false;
    return null;
  };
  const int = (min: number, max: number, label: string): number | { error: string } => {
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < min || n > max) {
      return { error: `${key} must be an integer between ${min} and ${max} (got '${raw}')` };
    }
    return n;
  };
  const list = (): string[] | undefined => {
    const items = raw.split(',').map((v) => v.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  };

  if (parts[0] !== 'mcp') {
    return { ok: false, error: `Not an MCP setting: ${key}. Expected one of: ${MCP_SETTING_KEYS.join(', ')}` };
  }

  if (parts.length === 2) {
    const field = parts[1];
    if (field === 'enabled' || field === 'autoConnect') {
      const typed = bool();
      if (typed === null) return { ok: false, error: `${key} must be true or false (got '${raw}')` };
      return { ok: true, mcp: { [field]: typed } };
    }
    if (field === 'connectTimeoutMs' || field === 'maxToolsPerServer' || field === 'maxToolsTotal') {
      const parsed = int(1, field === 'connectTimeoutMs' ? 60_000 : 10_000, field);
      if (typeof parsed !== 'number') return { ok: false, error: parsed.error };
      return { ok: true, mcp: { [field]: parsed } };
    }
    return {
      ok: false,
      error: `Unknown MCP setting '${field}'. Expected one of: ${MCP_SETTING_KEYS.slice(0, 6).join(', ')}`,
    };
  }

  if (parts.length === 3 && parts[1] === 'subagent' && parts[2] === 'inherit') {
    const mode = trimmed.toLowerCase();
    if (mode !== 'conservative' && mode !== 'full') {
      return {
        ok: false,
        error: `mcp.subagent.inherit must be 'conservative' (default) or 'full' (got '${raw}')`,
      };
    }
    return { ok: true, mcp: { subagent: { inherit: mode } } };
  }

  if (parts.length >= 4 && parts[1] === 'servers') {
    const server = parts[2];
    if (!server) return { ok: false, error: `mcp.servers needs a server name, e.g. ${MCP_SETTING_KEYS[6]}` };
    const field = parts[3];
    const rest = parts.slice(4).join('.');

    if (parts.length === 4 && field === 'enabled') {
      const typed = bool();
      if (typed === null) return { ok: false, error: `${key} must be true or false (got '${raw}')` };
      return { ok: true, mcp: { servers: { [server]: { enabled: typed } } } };
    }
    if (parts.length === 4 && field === 'variant') {
      return { ok: true, mcp: { servers: { [server]: { variant: trimmed || undefined } } } };
    }
    if (parts.length === 4 && field === 'command') {
      // The path to a binary that is installed but not on PATH.
      return { ok: true, mcp: { servers: { [server]: { command: trimmed || undefined } } } };
    }
    if (parts.length === 4 && field === 'maxTools') {
      const parsed = int(1, 10_000, field);
      if (typeof parsed !== 'number') return { ok: false, error: parsed.error };
      return { ok: true, mcp: { servers: { [server]: { maxTools: parsed } } } };
    }
    if (parts.length === 4 && field === 'args') {
      return { ok: true, mcp: { servers: { [server]: { args: list() } } } };
    }
    if (parts.length === 5 && field === 'runtime' && rest === 'command') {
      // An empty command CLEARS the whole runtime override (a half-configured
      // override that prefixes nothing is worse than none).
      return {
        ok: true,
        mcp: { servers: { [server]: { runtime: trimmed ? { command: trimmed } : undefined } } },
      };
    }
    if (parts.length === 5 && field === 'runtime' && rest === 'args') {
      return { ok: true, mcp: { servers: { [server]: { runtime: { command: '', args: list() } } } } };
    }
    return {
      ok: false,
      error: `Unknown mcp.servers setting '${parts.slice(3).join('.')}'. Expected: enabled, command, variant, maxTools, args, runtime.command, runtime.args`,
    };
  }

  return { ok: false, error: `Unknown MCP setting '${key}'. Expected one of: ${MCP_SETTING_KEYS.join(', ')}` };
}

/**
 * Read `mcp` from the resolved config dir — EVERY config file that exists,
 * lowest precedence first, so the new name wins key by key.
 *
 * WHY THIS READS BOTH NAMES. It used to open `buffconfig.json` alone, which made
 * it a second source of truth beside `ConfigManager`: `mcp.*` written into a
 * `nuviraconfig.json` profile (the name `resolveNuviraConfigPath()` resolves and
 * `nuvira config get mcp.…` reports) was silently ignored HERE, so the value was
 * in the file, readable, and not applied — the class of bug this module's own
 * header warns about. The two sections are combined with
 * {@link mergeMcpSetting}, the same merge `nuvira config set mcp.*` uses, so a
 * server whose `runtime.command` lives in one file and whose `args` live in the
 * other is still one server.
 *
 * Never throws: an absent or malformed file yields the defaults, because MCP
 * configuration must not be able to break a chat turn.
 */
export function loadMcpSettings(configDir?: string): ResolvedMCPSettings {
  const dir = configDir ?? resolveNuviraConfigDir();
  const files = resolveNuviraConfigReadPaths(dir).reverse();
  if (files.length === 0) return resolveMcpSettings(null);
  let section: MCPConfigSection | null = null;
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { mcp?: MCPConfigSection };
      if (parsed.mcp) section = mergeMcpSetting(section, parsed.mcp);
    } catch (err) {
      logger.debug(`MCP: could not read settings from ${file}: ${err}`);
    }
  }
  return resolveMcpSettings(section);
}

/**
 * Merge the per-server overrides over the discovered configs.
 *
 * This is the "nothing requires code, just configuration" seam: `context7`
 * needing an older Node is fixed with
 * `mcp.servers.context7.runtime.command`, and disabling a server is a boolean in
 * config — no edit to a server file, no CLI flag, no release.
 */
export function applyServerOverrides(
  configs: MCPServerConfig[],
  settings: Pick<ResolvedMCPSettings, 'servers' | 'enabled'>,
): MCPServerConfig[] {
  if (!settings.enabled) return [];
  const out: MCPServerConfig[] = [];
  for (const config of configs) {
    const override = settings.servers[config.name];
    if (!override) {
      out.push(config);
      continue;
    }
    if (override.enabled === false) continue;
    out.push({
      ...config,
      ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
      ...(override.variant !== undefined ? { variant: override.variant } : {}),
      ...(override.command !== undefined ? { command: override.command } : {}),
      ...(override.runtime !== undefined ? { runtime: override.runtime } : {}),
      ...(override.args !== undefined ? { args: override.args } : {}),
    });
  }
  return out;
}

/**
 * The eager-schema cap that applies to one server, per plan §6:
 * `min(perServerOverride ?? maxToolsPerServer, maxToolsTotal − alreadyExposed)`.
 *
 * Caps limit EXPOSURE, not access: an over-cap tool stays callable through
 * `tool_search` results. Consumed by the Phase 3 exposure work; defined here so
 * the number has one home.
 */
export function effectiveToolCap(
  server: string,
  settings: Pick<ResolvedMCPSettings, 'servers' | 'maxToolsPerServer' | 'maxToolsTotal'>,
  alreadyExposed: number,
): number {
  const perServer = settings.servers[server]?.maxTools ?? settings.maxToolsPerServer;
  const remainingTotal = Math.max(settings.maxToolsTotal - alreadyExposed, 0);
  return Math.max(Math.min(perServer, remainingTotal), 0);
}
