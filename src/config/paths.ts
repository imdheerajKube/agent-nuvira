/**
 * Resolve the Agent-Nuvira config directory / file path.
 *
 * Single source of truth for "where does nuviraconfig.json live?" — shared by
 * the ConfigManager, the dashboard server readers, and the vector store's
 * backend picker so every reader agrees on the SAME file.
 *
 * Precedence (highest first):
 *   1. An explicitly passed directory (caller-provided, e.g. tests).
 *   2. `$NUVIRA_CONFIG_DIR` — the override.
 *   3. `$BUFF_CONFIG_DIR` — legacy override (backward compat).
 *   4. `~/.nuvira` (the canonical default).
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

const LEGACY_HOME = '.buff';
const NUVRIRA_HOME = '.nuvira';

/** Config file name — nuviraconfig.json for new installs, buffconfig.json for legacy. */
export const LEGACY_CONFIG_FILE = 'buffconfig.json';
export const NUVRIRA_CONFIG_FILE = 'nuviraconfig.json';

/**
 * The config file names, in READ precedence order: the new name wins.
 *
 * ONE list, because the bug this closes was two of them: `ConfigManager`
 * hardcoded `buffconfig.json` while this module resolved `nuviraconfig.json`
 * first, so a profile written under the NEW name was read by
 * `resolveNuviraConfigPath()` and ignored by every runtime reader that went
 * through the manager (the CLI, the router, chat/execute) — silently, and with
 * no error, because both files are valid and only one was ever opened.
 */
export const CONFIG_FILE_NAMES = [NUVRIRA_CONFIG_FILE, LEGACY_CONFIG_FILE] as const;

export function resolveNuviraConfigDir(explicitDir?: string): string {
  if (explicitDir) return explicitDir;
  // Explicit env var overrides
  if (process.env.NUVIRA_CONFIG_DIR) return process.env.NUVIRA_CONFIG_DIR;
  if (process.env.BUFF_CONFIG_DIR) return process.env.BUFF_CONFIG_DIR;
  // Use the same data-aware resolution as resolveNuviraHome
  return resolveNuviraHome();
}

/** Resolve the config dir. Named `resolveBuffConfigDir` for backward compat. */
export const resolveBuffConfigDir = resolveNuviraConfigDir;

/**
 * The config file a WRITE goes to — the authoritative one.
 *
 * Precedence: `nuviraconfig.json` if it exists, else `buffconfig.json`, else the
 * legacy name when neither exists.
 *
 * WHY THE LEGACY NAME IS STILL THE WRITE TARGET FOR A FRESH INSTALL. Writing the
 * new name into an empty config dir would SPLIT an install in two the moment any
 * other tool — a rollback, an older CLI, a script that names the file — reads
 * `buffconfig.json`: the values would be in the file and still read back as
 * absent. Flipping the default is a migration with a version, not a side effect
 * of reading the new name, which is what this function exists to fix.
 * Callers that WRITE (and the mtime they poll) use this; callers that only read
 * should take {@link resolveNuviraConfigReadPaths} so no existing file is skipped.
 */
export function resolveNuviraConfigPath(explicitDir?: string): string {
  const dir = resolveNuviraConfigDir(explicitDir);
  for (const name of CONFIG_FILE_NAMES) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return join(dir, LEGACY_CONFIG_FILE);
}

/**
 * Every config file that EXISTS in the config dir, highest precedence first.
 *
 * Read BOTH names, in this order, and let each later file override the earlier
 * one: that is what makes "prefer the new name" true without making the other
 * file disappear. Reads are lowest-precedence-first in practice, so a caller
 * applies `[...readPaths].reverse()` — the mirror image of the order here, and
 * the reason this returns precedence rather than application order.
 *
 * An empty array means there is no config file at all, which is a valid state
 * (defaults + environment variables), not an error.
 */
export function resolveNuviraConfigReadPaths(explicitDir?: string): string[] {
  const dir = resolveNuviraConfigDir(explicitDir);
  return CONFIG_FILE_NAMES.map((name) => join(dir, name)).filter((path) => existsSync(path));
}

/**
 * The paths a read MUST watch for a live re-read (Session 36 "update as and
 * when"): both names, whether or not they exist yet, so a file created by
 * another process is noticed instead of being invisible until a restart.
 */
export function resolveNuviraConfigCandidatePaths(explicitDir?: string): string[] {
  const dir = resolveNuviraConfigDir(explicitDir);
  return CONFIG_FILE_NAMES.map((name) => join(dir, name));
}

/** Backward compat alias. */
export const resolveBuffConfigPath = resolveNuviraConfigPath;

/**
 * Resolve the Nuvira home directory.
 *
 * Always returns `~/.nuvira`. The `LEGACY_HOME` constant exists solely
 * for migration tooling — runtime code never reads from `~/.buff`.
 *
 * NOTE: this is the RAW default only — it ignores `$NUVIRA_CONFIG_DIR`. Use
 * {@link resolveNuviraConfigDir} for anything that must honour the override
 * (config, credentials, state). Reaching for `join(homedir(), '.nuvira', …)`
 * directly is the bug this helper exists to prevent: it silently reads the
 * developer's real profile from an isolated (test/CI/sandbox) process.
 */
export function resolveNuviraHome(): string {
  return join(homedir(), NUVRIRA_HOME);
}

/**
 * Resolve a path INSIDE the active Nuvira data dir.
 *
 * Honours `$NUVIRA_CONFIG_DIR` / `$BUFF_CONFIG_DIR` exactly like
 * {@link resolveNuviraConfigDir}, so a process pointed at an isolated config
 * dir never reads or writes the real `~/.nuvira`. Every state file the agent
 * persists (env, routing failures, audit logs, …) must resolve through here.
 */
export function resolveNuviraDataPath(...segments: string[]): string {
  return join(resolveNuviraConfigDir(), ...segments);
}

/**
 * Resolve the directory that holds MCP server configs.
 *
 * Precedence: an explicit directory, `$NUVIRA_MCP_DIR` / `$BUFF_MCP_DIR`, then
 * `<config dir>/mcp` — so `$NUVIRA_CONFIG_DIR` isolates this too — then
 * `~/.nuvira/mcp`.
 *
 * WHY THIS EXISTS. Both call sites used to be a bare
 * `join(homedir(), '.nuvira', 'mcp')`, which is the reach the note on
 * {@link resolveNuviraHome} warns about. The cost was measured rather than
 * assumed: the orchestrator calls `discoverConfigs()` on every run, so the test
 * suite found the developer's REAL `github` / `exa` / `firecrawl` configs and
 * spawned those servers mid-run. That is outbound network traffic from a test
 * process, MCP responses arriving for clients the test had already torn down
 * (`Received a response for an unknown message ID`), and a fully mocked test
 * timing out at 15s. A test run must not be able to reach a live MCP server.
 */
export function resolveMcpConfigDir(explicitDir?: string): string {
  if (explicitDir) return explicitDir;
  const override = envBuff('MCP_DIR');
  if (override) return override;
  return join(resolveNuviraConfigDir(), 'mcp');
}

/**
 * Resolve the `.env` file that supplies provider credentials.
 *
 * Precedence: explicit `$NUVIRA_ENV_FILE` / `$BUFF_ENV_FILE`, then
 * `<config dir>/.env`. The config dir — NOT `~/.nuvira` — is authoritative, so
 * an isolated profile cannot pick up the real profile's API keys.
 */
export function resolveNuviraEnvFile(configDir?: string): string {
  const explicit = process.env.NUVIRA_ENV_FILE?.trim() || process.env.BUFF_ENV_FILE?.trim();
  if (explicit) return explicit;
  return join(resolveNuviraConfigDir(configDir), '.env');
}

/**
 * Dual-read env var helper.
 *
 * Reads `NUVIRA_<name>` first; if unset, falls back to legacy `BUFF_<name>`
 * for backward compatibility. Returns `undefined` if neither is set.
 */
export function envBuff(name: string): string | undefined {
  return process.env[`NUVIRA_${name}`] ?? process.env[`BUFF_${name}`];
}
