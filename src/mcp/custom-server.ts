/**
 * Custom MCP servers — the "configuration, not code" half of MCP.
 *
 * WHY THIS EXISTS. Discovery has always been data-driven: `discoverConfigs()`
 * reads `*.json` from `~/.nuvira/mcp/`, so a hand-written file for a server we
 * have never heard of connects with no code change. What was missing was an
 * AUTHORING path — a user had to hand-write JSON to add anything outside the
 * catalog, and the dashboard could not add it at all. This module is the one
 * validator/writer both surfaces call, so a config accepted in the terminal
 * cannot be refused in the dashboard, and vice versa.
 *
 * It is deliberately SEPARATE from `catalog.ts`: the catalog decides which
 * curated variant this machine can run (probes, pins, prerequisite gates). A
 * custom server has none of that — the user names the command, and the only
 * gate is that the result must be a config `discoverConfigs()` can connect to.
 * A name in the catalog is NOT reserved: configuring `github` by hand is a
 * supported choice, not a conflict (we just say which one is in play).
 *
 * SECRETS. `env` values and auth headers are written to disk, so a config that
 * carries any is chmod 0600 (best-effort — Windows has no mode bits) and is
 * NEVER read back over the API: the dashboard reports env KEY NAMES only.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveMcpConfigDir } from '../config/paths.js';
import { logger } from '../utils/logger.js';
import { getCatalogEntry } from './catalog.js';
import type { MCPServerConfig } from './types.js';

/**
 * What a name may contain.
 *
 * A name becomes BOTH a config filename (`<name>.json`) and a settings key
 * (`mcp.servers.<name>.enabled`), and the settings grammar is dot-separated —
 * so a dot in a name would produce a server that can never be enabled or
 * disabled from either surface, and a `/` or `..` would escape the config dir.
 * Restricting the character set is what makes "any name" safe, so the refusal
 * says exactly that rather than failing later at connect time.
 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const SERVER_NAME_MAX = 64;
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

/** Bounds that stop a typo from writing an absurd file (`--arg` in a loop). */
const MAX_ARGS = 64;
const MAX_ENTRIES = 64;

/** Where a config came from, for reporting. */
export type ServerOrigin = 'catalog' | 'custom';

export interface CustomServerSpec {
  name: string;
  transport: 'stdio' | 'sse';
  /** stdio only. */
  command?: string;
  /** stdio only. */
  args?: string[];
  /** sse only. */
  url?: string;
  /** sse only. */
  headers?: Record<string, string>;
  /** Both transports (stdio: the child's environment). */
  env?: Record<string, string>;
  enabled?: boolean;
}

export type ValidateResult =
  | { ok: true; config: MCPServerConfig; warnings: string[] }
  | { ok: false; error: string };

export type WriteResult = {
  ok: boolean;
  path?: string;
  reason?: string;
  /** The write replaced an existing config file (only possible with `force`). */
  overwrote?: boolean;
  warnings?: string[];
  /** Env KEY names that the replaced file had and the new one does not. */
  droppedEnvKeys?: string[];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A string with no control characters — a newline in a command is never intentional. */
function cleanString(value: unknown, field: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function stringRecord(
  value: unknown,
  field: string,
  keyPattern: RegExp,
  keyLabel: string,
): { ok: true; record: Record<string, string> } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, record: {} };
  if (!isPlainObject(value)) return { ok: false, error: `${field} must be an object of string values` };
  const entries = Object.entries(value);
  if (entries.length > MAX_ENTRIES) {
    return { ok: false, error: `${field} has ${entries.length} entries — the limit is ${MAX_ENTRIES}` };
  }
  const record: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!keyPattern.test(key)) {
      return { ok: false, error: `${field} key '${key}' is not a valid ${keyLabel}` };
    }
    if (typeof raw !== 'string') return { ok: false, error: `${field}.${key} must be a string` };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, error: `${field}.${key} contains a control character` };
    record[key] = raw;
  }
  return { ok: true, record };
}

/**
 * Validate a user-supplied server into the exact shape `discoverConfigs()`
 * consumes. Pure: no I/O, so the CLI can validate before prompting and the
 * dashboard can validate before gating on a role.
 */
export function validateServerSpec(input: unknown): ValidateResult {
  if (!isPlainObject(input)) return { ok: false, error: 'Expected a config object.' };
  const warnings: string[] = [];

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return { ok: false, error: 'A server name is required.' };
  if (name.length > SERVER_NAME_MAX) {
    return { ok: false, error: `The name is ${name.length} characters — the limit is ${SERVER_NAME_MAX}.` };
  }
  if (!SERVER_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error:
        `'${name}' is not a usable server name. Use letters, digits, '_' and '-' (no dots, spaces, or slashes): ` +
        `the name is the config filename and the 'mcp.servers.<name>' settings key, so '.' or '/' would make ` +
        `the server unmanageable from the CLI and the dashboard.`,
    };
  }

  const transportRaw = input.transport;
  if (transportRaw !== undefined && transportRaw !== 'stdio' && transportRaw !== 'sse') {
    return { ok: false, error: `transport must be 'stdio' or 'sse' (got '${String(transportRaw)}').` };
  }
  const command = cleanString(input.command, 'command');
  const url = cleanString(input.url, 'url');
  if (input.command !== undefined && command === null) {
    return { ok: false, error: 'command must be a non-empty string with no control characters.' };
  }
  if (input.url !== undefined && url === null) {
    return { ok: false, error: 'url must be a non-empty string with no control characters.' };
  }

  // Transport: explicit when given, else inferred — and refused when the two
  // shapes are mixed, because a config with both a command and a url has no
  // single obvious meaning and `discoverConfigs` would have to guess.
  let transport: 'stdio' | 'sse';
  if (transportRaw === 'stdio' || transportRaw === 'sse') transport = transportRaw;
  else if (url && !command) transport = 'sse';
  else if (command && !url) transport = 'stdio';
  else if (command && url) {
    return { ok: false, error: 'Pass either a command (stdio) or a url (sse), not both.' };
  } else {
    return { ok: false, error: 'Nothing to run: pass --command <path> (stdio) or --url <url> (sse).' };
  }

  if (transport === 'stdio') {
    if (!command) return { ok: false, error: 'stdio needs a command, e.g. --command npx.' };
    if (url) return { ok: false, error: 'stdio takes no url — drop it or use --transport sse.' };
  } else {
    if (!url) return { ok: false, error: 'sse needs a url, e.g. --url https://example.com/mcp.' };
    if (command) return { ok: false, error: 'sse takes no command — drop it or use --transport stdio.' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: `'${url}' is not a valid URL.` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: `The url must be http(s) (got '${parsed.protocol}').` };
    }
    if (parsed.protocol === 'http:') {
      warnings.push('This endpoint is plain http — credentials and tool results travel unencrypted.');
    }
  }

  const argsRaw = input.args;
  let args: string[] | undefined;
  if (argsRaw !== undefined && argsRaw !== null) {
    if (!Array.isArray(argsRaw)) return { ok: false, error: 'args must be an array of strings.' };
    if (argsRaw.length > MAX_ARGS) {
      return { ok: false, error: `args has ${argsRaw.length} entries — the limit is ${MAX_ARGS}.` };
    }
    args = [];
    for (const arg of argsRaw) {
      if (typeof arg !== 'string') return { ok: false, error: 'Every args entry must be a string.' };
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(arg)) return { ok: false, error: 'An args entry contains a control character.' };
      args.push(arg);
    }
    if (transport === 'sse' && args.length > 0) {
      return { ok: false, error: 'sse takes no args — they only apply to a stdio command.' };
    }
    if (args.length === 0) args = undefined;
  }

  const envResult = stringRecord(input.env, 'env', ENV_KEY_PATTERN, 'environment variable name');
  if (!envResult.ok) return { ok: false, error: envResult.error };
  const headerResult = stringRecord(input.headers, 'headers', HEADER_NAME_PATTERN, 'HTTP header name');
  if (!headerResult.ok) return { ok: false, error: headerResult.error };
  if (transport === 'stdio' && Object.keys(headerResult.record).length > 0) {
    return { ok: false, error: 'headers only apply to a remote (sse) server — for stdio, put credentials in --env.' };
  }

  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be true or false.' };
  }

  // Reported, never silent: a catalog name configured by hand is legitimate,
  // but the user should know which one will be used.
  if (getCatalogEntry(name)) {
    warnings.push(
      `'${name}' is also a catalog capability — this config is what will be used; ` +
        `\`mcp install\` would write the same file.`,
    );
  }

  const config: MCPServerConfig = {
    name,
    transport,
    enabled: input.enabled ?? true,
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(url ? { url } : {}),
    ...(Object.keys(headerResult.record).length > 0 ? { headers: headerResult.record } : {}),
    ...(Object.keys(envResult.record).length > 0 ? { env: envResult.record } : {}),
  };
  return { ok: true, config, warnings };
}

/** Does this config carry a credential? Decides the file mode. */
export function carriesSecret(config: Pick<MCPServerConfig, 'env' | 'headers'>): boolean {
  if (config.env && Object.keys(config.env).length > 0) return true;
  return Object.entries(config.headers ?? {}).some(([key]) =>
    ['authorization', 'cookie', 'x-api-key', 'api-key', 'x-auth-token'].includes(key.toLowerCase()),
  );
}

export interface WriteServerOptions {
  configDir?: string;
  /** Replace an existing `<name>.json`. Without it, an existing file is a refusal. */
  force?: boolean;
  /** Warnings from validation, carried into the result so a caller reports them once. */
  warnings?: string[];
  /**
   * EDIT mode: keep what the existing file has and this write does not supply.
   *
   * The dashboard needs this. It can see env/header KEY NAMES only (values are
   * never sent back), so an edit that omitted them would silently delete a
   * working token — and it cannot represent `oauth`, `variant` or `runtime` at
   * all, so an edit of a catalog config would otherwise turn a working OAuth
   * server into a config that can never authorize. The CLI leaves it off: an
   * explicit `--force` rewrites the file, and everything it drops is reported.
   */
  mergeEnv?: boolean;
}

/**
 * Write one server config, refusing to clobber an existing file unless asked.
 *
 * The refusal matters: `<name>.json` may be a catalog install with a verified
 * pin, and silently replacing it would turn "I typed the wrong name" into a
 * broken server.
 */
export function writeServerConfig(config: MCPServerConfig, options: WriteServerOptions = {}): WriteResult {
  const dir = resolveMcpConfigDir(options.configDir);
  const target = join(dir, `${config.name}.json`);
  const exists = existsSync(target);

  if (exists && !options.force) {
    return { ok: false, reason: `'${config.name}' is already configured at ${target} (pass force to replace it).` };
  }

  let next: MCPServerConfig = config;
  const warnings = [...(options.warnings ?? [])];
  let droppedEnvKeys: string[] = [];
  if (exists && options.mergeEnv) {
    const previous = readServerConfig(config.name, options.configDir);
    if (previous) {
      // Existing fields survive unless this write sets them: credentials (whose
      // values the page is never shown), plus the fields a page has no control
      // for — `oauth`, `variant`, `runtime`.
      const env = { ...(previous.env ?? {}), ...(config.env ?? {}) };
      const headers = { ...(previous.headers ?? {}), ...(config.headers ?? {}) };
      next = {
        ...previous,
        ...config,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
      // A transport switch must not leave the OTHER transport's fields behind:
      // `...previous` would happily keep a stdio `command` on a remote server
      // (or a `url` on a local one), and discovery would see a config that means
      // two things at once.
      if (next.transport === 'sse') {
        delete next.command;
        delete next.args;
      } else {
        delete next.url;
        delete next.headers;
      }
      warnings.push(
        'Kept the credentials and settings the existing config had — an edit never deletes what it cannot show.',
      );
    }
  } else if (exists) {
    // Exact rewrite (CLI `--force`): name what this replaced, so a dropped token
    // or an orphaned OAuth block is a reported fact rather than a server that
    // fails later in a turn.
    const previous = readServerConfig(config.name, options.configDir);
    droppedEnvKeys = Object.keys(previous?.env ?? {}).filter((key) => !(key in (config.env ?? {})));
    if (previous?.oauth && !config.oauth) {
      warnings.push('the replaced config had an OAuth block — authorize again before relying on it.');
    }
    if (previous?.variant && !config.variant) {
      warnings.push(`the replaced config was the '${previous.variant}' variant of a catalog capability.`);
    }
    if (previous?.runtime && !config.runtime) {
      warnings.push('the replaced config had a runtime override; re-apply it or set mcp.servers.<name>.runtime.command.');
    }
  }

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, JSON.stringify(next, null, 2), 'utf-8');
    // §7.8 hygiene, matching the catalog installer: a file that carries a
    // credential is not world-readable. Best-effort (Windows has no mode bits).
    try {
      chmodSync(target, carriesSecret(next) ? 0o600 : 0o644);
    } catch {
      /* best-effort */
    }
    logger.debug(`MCP custom server: wrote '${config.name}' → ${target}`);
    return {
      ok: true,
      path: target,
      ...(exists ? { overwrote: true } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(droppedEnvKeys.length > 0 ? { droppedEnvKeys } : {}),
    };
  } catch (err) {
    return { ok: false, reason: `write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Read a stored config by name. Returns null for an absent or malformed file —
 * a broken file is discovery's problem, not an exception for the caller.
 */
export function readServerConfig(name: string, configDir?: string): MCPServerConfig | null {
  if (!SERVER_NAME_PATTERN.test(name)) return null;
  const target = join(resolveMcpConfigDir(configDir), `${name}.json`);
  try {
    if (!existsSync(target)) return null;
    return JSON.parse(readFileSync(target, 'utf-8')) as MCPServerConfig;
  } catch {
    return null;
  }
}

/**
 * Is this name a catalog capability or a custom config? Reporting only — the
 * connect path does not care where a config came from.
 */
export function serverOrigin(name: string, configDir?: string): { origin: ServerOrigin; variant: string | null } {
  const config = readServerConfig(name, configDir);
  const entry = getCatalogEntry(name);
  if (config?.variant) return { origin: 'catalog', variant: config.variant };
  return entry ? { origin: 'catalog', variant: null } : { origin: 'custom', variant: null };
}
