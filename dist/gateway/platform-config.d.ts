/**
 * Platform transport configuration — the `nuvira config gateway` surface.
 *
 * Gateway platform tokens live in env vars (the `config.py` map, see
 * channel-directory.ts). This module adds a GUIDED way to manage them: a
 * `~/.nuvira/.env` file (NUVIRA_ENV_FILE overrides it — same path `loadEnv()` in
 * src/utils/env.ts already reads at CLI + dashboard startup) that both the CLI
 * wizard and the dashboard Channels tab write to, with a line-preserving merge
 * so comments and unrelated keys survive.
 *
 * `whatsapp` (the personal Baileys bridge) is deliberately excluded: its
 * transport is a PAIRED SESSION on disk, configured through `nuvira whatsapp
 * pair` / the WhatsApp panel — not an env token.
 */
import { type Platform } from './channel-directory.js';
/** Per-var metadata for guided setup (prompt + whether the value is a secret). */
export interface PlatformEnvVarMeta {
    varName: string;
    /** Short prompt shown in the wizard / form label. */
    prompt: string;
    /** Secrets (tokens, passwords, keys) are prompted masked + displayed redacted. */
    secret: boolean;
}
export declare function platformEnvVarMeta(platform: Platform): PlatformEnvVarMeta[];
/** Platforms manageable through the config surface (excludes whatsapp/mock). */
export declare function configurablePlatforms(): Platform[];
export declare function envFilePath(): string;
export interface EnvVarState {
    varName: string;
    /** True when a value is currently effective (env file or process env). */
    set: boolean;
    /** Current effective value (empty when unset). */
    value: string;
}
/** Per-var current state — env file first, then process.env (file wins like loadEnv). */
export declare function envVarState(varName: string): EnvVarState;
/** Platform status with per-var values (for the CLI table + dashboard form). */
export interface PlatformConfigStatus {
    platform: Platform;
    label: string;
    configured: boolean;
    envVars: EnvVarState[];
}
export declare function platformConfigStatus(platform: Platform): PlatformConfigStatus;
/**
 * Merge `updates` into the env file (in-place line replacement for existing
 * keys, appended at the end for new ones) and drop any `removes` keys.
 * Preserves comments, ordering, and unrelated keys. Never throws.
 */
export declare function writeEnvFile(updates: Record<string, string>, removes?: string[]): {
    wrote: string[];
    removed: string[];
};
/** Apply written values to the running process (dashboard hot-pickup). */
export declare function applyEnvToProcess(updates: Record<string, string>, removes?: string[]): void;
/** Redact a value for display: show first 4 chars + '…' (or '<unset>'). */
export declare function redactValue(value: string): string;
//# sourceMappingURL=platform-config.d.ts.map