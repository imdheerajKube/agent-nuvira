/**
 * Resolve the Agent-Nuvira config directory / file path.
 *
 * Single source of truth for "where does buffconfig.json live?" — shared by
 * the ConfigManager, the dashboard server readers, and the vector store's
 * backend picker so every reader agrees on the SAME file.
 *
 * Precedence (highest first):
 *   1. An explicitly passed directory (caller-provided, e.g. tests).
 *   2. `$BUFF_CONFIG_DIR` — the hermetic/alternate-config override. The RBAC
 *      role file (~/.buff/rbac.json) already honors this, so a smoke test or
 *      sandbox pointed at BUFF_CONFIG_DIR must NEVER leak writes into the
 *      real ~/.buff config. Making the config manager honor it too closes
 *      that gap.
 *   3. `~/.buff` (the default).
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

export function resolveBuffConfigDir(explicitDir?: string): string {
  return explicitDir || process.env.BUFF_CONFIG_DIR || join(homedir(), '.buff');
}

export function resolveBuffConfigPath(explicitDir?: string): string {
  return join(resolveBuffConfigDir(explicitDir), 'buffconfig.json');
}
