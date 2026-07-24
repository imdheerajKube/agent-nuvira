/**
 * Team Config — Project-level configuration with config priority chain.
 *
 * Config priority (highest to lowest):
 *   1. Project-level `.buffconfig.json` in working directory
 *   2. User-level config at `~/.buff/buffconfig.json`
 *   3. Built-in defaults
 *
 * This enables teams to commit a `.buffconfig.json` to their repo that
 * defines shared provider defaults, team repository URL, and other
 * project-wide settings while allowing individual overrides.
 *
 * The project-level config is read-only by default — CLI commands write
 * to the user-level config. The `buff config init` command can generate
 * a project-level config.
 */
import type { BuffConfig, TeamConfig } from '../config/types.js';
/** Default team config values */
export declare const DEFAULT_TEAM_CONFIG: TeamConfig;
/**
 * Find and load the project-level `.buffconfig.json`.
 * Searches from the working directory upward for common filenames.
 *
 * @param cwd — Working directory to search from (default: process.cwd())
 * @returns The parsed project config, or null if none found
 */
export declare function findProjectConfig(cwd?: string): BuffConfig | null;
/**
 * Get the team config from the project-level config.
 * Falls back to user-level config if project config doesn't have team settings.
 *
 * @param cwd — Optional working directory
 * @returns The resolved team config
 */
export declare function getTeamConfig(cwd?: string): TeamConfig;
/**
 * Check if a project-level `.buffconfig.json` exists.
 */
export declare function hasProjectConfig(cwd?: string): boolean;
/**
 * Get the path to the team data directory.
 * Uses project-level config path, falling back to ~/.buff/team/.
 *
 * The team directory is a git repository that contains:
 *   - trajectories/ — Shared agent execution trajectories
 *   - patterns/ — Project-level coding patterns
 *   - templates/ — Team workflow templates
 */
export declare function getTeamDataDir(cwd?: string): string;
//# sourceMappingURL=config.d.ts.map