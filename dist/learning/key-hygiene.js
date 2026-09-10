/**
 * KeyHygiene — ISSUE-004 (4b/4d): delete invalid API keys + show clear errors.
 *
 * A provider whose key returns 401/403 once might be transient; a provider
 * that returns 401/403 N consecutive times has a DEAD key. After the
 * threshold, the invalid key is removed from the config file and the user is
 * told exactly what happened and how to fix it — instead of the registry
 * re-learning the failure reactively on every call (the "why is it checking a
 * deleted model every time" feedback).
 *
 * Persisted JSON (memory dir) so the consecutive counter survives restarts —
 * a provider doesn't get a fresh slate just because the process restarted.
 * Best-effort everywhere: key hygiene must never break a live LLM call.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
/** Consecutive auth (401/403) failures before the key is auto-cleared. */
export const AUTH_CLEAR_THRESHOLD = 3;
const DEFAULT_MEMORY_DIR = join(resolveNuviraHome(), 'memory');
const STORE_FILENAME = 'key-hygiene.json';
function memoryDir() {
    return envBuff('MEMORY_DIR') || DEFAULT_MEMORY_DIR;
}
function storePath() {
    return join(memoryDir(), STORE_FILENAME);
}
function emptyState() {
    return { version: 1, updatedAt: Date.now(), consecutiveAuthFailures: {} };
}
/**
 * ISSUE-004 key-hygiene store. Lives in the learning layer because BOTH the
 * failure bookkeeping (learning) and CLI surfaces consume it, and it only
 * depends on config/logger.
 */
export class KeyHygiene {
    data;
    constructor() {
        this.data = this.load();
    }
    load() {
        try {
            if (!existsSync(storePath()))
                return emptyState();
            const raw = JSON.parse(readFileSync(storePath(), 'utf-8'));
            if (!raw || typeof raw !== 'object' || !raw.consecutiveAuthFailures)
                return emptyState();
            return { ...emptyState(), ...raw };
        }
        catch {
            return emptyState();
        }
    }
    persist() {
        this.data.updatedAt = Date.now();
        try {
            const dir = memoryDir();
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
            writeFileSync(storePath(), JSON.stringify(this.data, null, 2), 'utf-8');
        }
        catch {
            // Best-effort — never break a call over key hygiene.
        }
    }
    /**
     * Record a 401/403 auth failure for a provider. When the provider reaches
     * AUTH_CLEAR_THRESHOLD consecutive auth failures, the invalid key is cleared
     * from the config (or the user is told which env var to fix) and a clear
     * error is surfaced. Best-effort — never throws.
     *
     * `apiKey` is the SPECIFIC key that failed (undefined = the primary). It is
     * forwarded to `clearProviderApiKey` so the exact dead credential is removed
     * — the primary, or a matching rotation key in `apiKeys[]`.
     */
    recordAuthFailure(provider, configManager, apiKey) {
        const consecutive = (this.data.consecutiveAuthFailures[provider] || 0) + 1;
        this.data.consecutiveAuthFailures[provider] = consecutive;
        this.persist();
        if (consecutive < AUTH_CLEAR_THRESHOLD) {
            // Not yet at the threshold. The failover walk already logs the per-call
            // auth failure, so keep this DEBUG-only to avoid stacking noise on the
            // hot path — the actionable "clear it" guidance lands at the threshold.
            logger.debug(`${provider}: ${consecutive}/${AUTH_CLEAR_THRESHOLD} consecutive auth failures (key may be invalid — ` +
                `nuvira config set providers.${provider}.apiKey <real-key>)`);
            return { consecutive, threshold: AUTH_CLEAR_THRESHOLD, cleared: false, envSourced: false };
        }
        let cleared = false;
        let envSourced = false;
        let envVar;
        try {
            const result = configManager.clearProviderApiKey(provider, apiKey);
            cleared = result.cleared;
            envSourced = result.envSourced;
            envVar = result.envVar;
            // Counter resets once the clear was actually HANDLED (cleared,
            // reported as env-sourced, or already absent — nothing left to clear).
            // If the clear THROWS (caught below), the counter stays at the threshold
            // so the next auth failure retries the clear immediately instead of
            // waiting another 3 failures.
            this.data.consecutiveAuthFailures[provider] = 0;
            this.persist();
            if (cleared) {
                logger.error(`   🚫 ${provider} returned ${consecutive} consecutive auth errors (401/403) — the invalid API key ` +
                    `has been CLEARED from your config. Set a valid key to re-enable it: ` +
                    `nuvira config set providers.${provider}.apiKey <real-key>`);
            }
            else if (envSourced) {
                logger.error(`   🚫 ${provider} returned ${consecutive} consecutive auth errors (401/403) — its key comes from ` +
                    `env var ${envVar} and could not be cleared from the config file. ` +
                    `Unset/fix ${envVar} to re-enable ${provider}.`);
            }
            else {
                // cleared=false AND envSourced=false → the key is already gone from
                // the config (cleared earlier / rotation list already filtered). The
                // counter was reset above — nothing left to clear, no further noise.
                logger.warn(`   ⚠️ ${provider} returned ${consecutive} consecutive auth errors (401/403) — no configured key ` +
                    `to clear. Add a valid one to re-enable it: nuvira config set providers.${provider}.apiKey <real-key>`);
            }
        }
        catch {
            // Best-effort — never break a live call over key hygiene. The counter
            // was NOT reset, so the next auth failure retries the clear.
            logger.warn(`   ⚠️ ${provider} returned ${consecutive} consecutive auth errors (401/403) — its key could not be ` +
                `cleared automatically. Run: nuvira config set providers.${provider}.apiKey <real-key>`);
        }
        return { consecutive, threshold: AUTH_CLEAR_THRESHOLD, cleared, envSourced, envVar };
    }
    /**
     * A real success on a provider proves its key works — reset the consecutive
     * auth-failure counter so one blip can never clear a valid key. Best-effort.
     */
    recordAuthSuccess(provider) {
        if (!(provider in this.data.consecutiveAuthFailures))
            return;
        delete this.data.consecutiveAuthFailures[provider];
        this.persist();
    }
    /** Snapshot for tests / CLI (counters keyed by provider). */
    getState() {
        return { ...this.data.consecutiveAuthFailures };
    }
    reset() {
        this.data = emptyState();
        this.persist();
    }
}
let instance = null;
export function getKeyHygiene() {
    if (!instance)
        instance = new KeyHygiene();
    return instance;
}
export function resetKeyHygiene() {
    instance = null;
}
//# sourceMappingURL=key-hygiene.js.map