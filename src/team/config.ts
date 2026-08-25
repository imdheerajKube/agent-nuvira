/**
 * Team Config — Project-level configuration with config priority chain.
 *
 * Config priority (highest to lowest):
 *   1. Project-level `.nuviraconfig.json` in working directory
 *   2. User-level config at `~/.nuvira/buffconfig.json`
 *   3. Built-in defaults
 *
 * This enables teams to commit a `.nuviraconfig.json` to their repo that
 * defines shared provider defaults, team repository URL, and other
 * project-wide settings while allowing individual overrides.
 *
 * The project-level config is read-only by default — CLI commands write
 * to the user-level config. The `nuvira config init` command can generate
 * a project-level config.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveNuviraHome } from '../config/paths.js';

import type { BuffConfig, TeamConfig } from '../config/types.js';
import { ConfigManager } from '../config/manager.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default team config values */
export const DEFAULT_TEAM_CONFIG: TeamConfig = {
  branch: 'main',
  autoSyncMinutes: 0,
  shareTrajectories: true,
};

/** Priority config search paths (relative to working directory) */
const PROJECT_CONFIG_FILENAMES = [
  '.nuviraconfig.json',
  'buffconfig.json',
  '.nuvira/config.json',
];

// ─── Config Priority Chain ──────────────────────────────────────────────────

/**
 * Find and load the project-level `.nuviraconfig.json`.
 * Searches from the working directory upward for common filenames.
 *
 * @param cwd — Working directory to search from (default: process.cwd())
 * @returns The parsed project config, or null if none found
 */
export function findProjectConfig(cwd?: string): BuffConfig | null {
  const dir = resolve(cwd || process.cwd());

  for (const filename of PROJECT_CONFIG_FILENAMES) {
    const filePath = join(dir, filename);
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const config = JSON.parse(raw) as BuffConfig;
        return config;
      } catch {
        // Try next filename
        continue;
      }
    }
  }

  return null;
}

/**
 * Get the team config from the project-level config.
 * Falls back to user-level config if project config doesn't have team settings.
 *
 * @param cwd — Optional working directory
 * @returns The resolved team config
 */
export function getTeamConfig(cwd?: string): TeamConfig {
  // Check project-level config first
  const projectConfig = findProjectConfig(cwd);
  if (projectConfig?.team) {
    return { ...DEFAULT_TEAM_CONFIG, ...projectConfig.team } as TeamConfig;
  }

  // Fall back to user-level config
  try {
    const configManager = new ConfigManager();
    const userConfig = configManager.getAll();
    if (userConfig.team) {
      return { ...DEFAULT_TEAM_CONFIG, ...userConfig.team } as TeamConfig;
    }
  } catch {
    // Fall through to defaults
  }

  return { ...DEFAULT_TEAM_CONFIG } as TeamConfig;
}

/**
 * Check if a project-level `.nuviraconfig.json` exists.
 */
export function hasProjectConfig(cwd?: string): boolean {
  return findProjectConfig(cwd) !== null;
}

/**
 * Get the path to the team data directory.
 * Uses project-level config path, falling back to ~/.nuvira/team/.
 *
 * The team directory is a git repository that contains:
 *   - trajectories/ — Shared agent execution trajectories
 *   - patterns/ — Project-level coding patterns
 *   - templates/ — Team workflow templates
 */
export function getTeamDataDir(cwd?: string): string {
  const teamConfig = getTeamConfig(cwd);
  if (teamConfig.localPath) return resolve(teamConfig.localPath);

  // Default: ~/.nuvira/team/
  return join(resolveNuviraHome(), 'team');
}
