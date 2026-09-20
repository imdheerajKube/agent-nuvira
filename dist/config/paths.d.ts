export declare function resolveNuviraConfigDir(explicitDir?: string): string;
/** Resolve the config dir. Named `resolveBuffConfigDir` for backward compat. */
export declare const resolveBuffConfigDir: typeof resolveNuviraConfigDir;
/** Resolve the config file path — checks nuviraconfig.json first, then buffconfig.json. */
export declare function resolveNuviraConfigPath(explicitDir?: string): string;
/** Backward compat alias. */
export declare const resolveBuffConfigPath: typeof resolveNuviraConfigPath;
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
export declare function resolveNuviraHome(): string;
/**
 * Resolve a path INSIDE the active Nuvira data dir.
 *
 * Honours `$NUVIRA_CONFIG_DIR` / `$BUFF_CONFIG_DIR` exactly like
 * {@link resolveNuviraConfigDir}, so a process pointed at an isolated config
 * dir never reads or writes the real `~/.nuvira`. Every state file the agent
 * persists (env, routing failures, audit logs, …) must resolve through here.
 */
export declare function resolveNuviraDataPath(...segments: string[]): string;
/**
 * Resolve the `.env` file that supplies provider credentials.
 *
 * Precedence: explicit `$NUVIRA_ENV_FILE` / `$BUFF_ENV_FILE`, then
 * `<config dir>/.env`. The config dir — NOT `~/.nuvira` — is authoritative, so
 * an isolated profile cannot pick up the real profile's API keys.
 */
export declare function resolveNuviraEnvFile(configDir?: string): string;
/**
 * Dual-read env var helper.
 *
 * Reads `NUVIRA_<name>` first; if unset, falls back to legacy `BUFF_<name>`
 * for backward compatibility. Returns `undefined` if neither is set.
 */
export declare function envBuff(name: string): string | undefined;
//# sourceMappingURL=paths.d.ts.map