/**
 * Resolve the Agent-Nuvira config directory / file path.
 *
 * Single source of truth for "where does nuviraconfig.json live?" — shared by
 * the ConfigManager, the dashboard server readers, and the vector store's
 * backend picker so every reader agrees on the SAME file.
 *
 * Phase 1 (current): supports both `~/.nuvira` and `~/.buff` for backward
 * compatibility. If `~/.nuvira` exists it takes priority; otherwise `~/.buff`
 * is used.
 *
 * Precedence (highest first):
 *   1. An explicitly passed directory (caller-provided, e.g. tests).
 *   2. `$NUVIRA_CONFIG_DIR` — the new override.
 *   3. `$BUFF_CONFIG_DIR` — legacy override (backward compat).
 *   4. `~/.nuvira` if it exists on disk.
 *   5. `~/.buff` (the legacy default).
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
  // Check if ~/.nuvira exists → use it; otherwise fall back to ~/.buff
  const nuviraHome = join(homedir(), NUVRIRA_HOME);
  const buffHome = join(homedir(), LEGACY_HOME);
  if (existsSync(nuviraHome)) return nuviraHome;
  return buffHome;
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
 * Resolve the Nuvira home directory (~/.nuvira preferred, ~/.buff legacy).
 * Use this everywhere instead of hardcoded `join(homedir(), '.buff')`.
 */
export function resolveNuviraHome(): string {
  const nuviraHome = join(homedir(), NUVRIRA_HOME);
  const buffHome = join(homedir(), LEGACY_HOME);
  if (existsSync(nuviraHome)) return nuviraHome;
  return buffHome;
}
