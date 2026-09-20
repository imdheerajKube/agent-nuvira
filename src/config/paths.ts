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
const LEGACY_CONFIG_FILE = 'buffconfig.json';
const NUVRIRA_CONFIG_FILE = 'nuviraconfig.json';

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

/** Resolve the config file path — checks nuviraconfig.json first, then buffconfig.json. */
export function resolveNuviraConfigPath(explicitDir?: string): string {
  const dir = resolveNuviraConfigDir(explicitDir);
  const nuviraPath = join(dir, NUVRIRA_CONFIG_FILE);
  const buffPath = join(dir, LEGACY_CONFIG_FILE);
  // Return whichever exists; if neither, return the new name for future writes
  if (existsSync(nuviraPath)) return nuviraPath;
  return buffPath;
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
