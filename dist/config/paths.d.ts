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
 */
export declare function resolveNuviraHome(): string;
/**
 * Dual-read env var helper.
 *
 * Reads `NUVIRA_<name>` first; if unset, falls back to legacy `BUFF_<name>`
 * for backward compatibility. Returns `undefined` if neither is set.
 */
export declare function envBuff(name: string): string | undefined;
//# sourceMappingURL=paths.d.ts.map