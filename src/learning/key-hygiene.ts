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
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';

/** Consecutive auth (401/403) failures before the key is auto-cleared. */
export const AUTH_CLEAR_THRESHOLD = 3;

const DEFAULT_MEMORY_DIR = join(homedir(), '.buff', 'memory');
const STORE_FILENAME = 'key-hygiene.json';

interface KeyHygieneData {
  version: number;
  updatedAt: number;
  /** provider → consecutive auth-failure count (reset on any success). */
  consecutiveAuthFailures: Record<string, number>;
}

/** Outcome of recording an auth failure. */
export interface AuthFailureOutcome {
  consecutive: number;
  threshold: number;
  /** True when this failure crossed the threshold and the key was cleared. */
  cleared: boolean;
  /** True when the key could NOT be cleared because it came from an env var. */
  envSourced: boolean;
  /** The env var name when envSourced (so the user can fix the right thing). */
  envVar?: string;
}

function memoryDir(): string {
  return process.env.BUFF_MEMORY_DIR || DEFAULT_MEMORY_DIR;
}

function storePath(): string {
  return join(memoryDir(), STORE_FILENAME);
}

function emptyState(): KeyHygieneData {
  return { version: 1, updatedAt: Date.now(), consecutiveAuthFailures: {} };
}

/**
 * ISSUE-004 key-hygiene store. Lives in the learning layer because BOTH the
 * failure bookkeeping (learning) and CLI surfaces consume it, and it only
 * depends on config/logger.
 */
export class KeyHygiene {
  private data: KeyHygieneData;

  constructor() {
    this.data = this.load();
  }

  private load(): KeyHygieneData {
    try {
      if (!existsSync(storePath())) return emptyState();
      const raw = JSON.parse(readFileSync(storePath(), 'utf-8')) as KeyHygieneData;
      if (!raw || typeof raw !== 'object' || !raw.consecutiveAuthFailures) return emptyState();
      return { ...emptyState(), ...raw };
    } catch {
      return emptyState();
    }
  }

  private persist(): void {
    this.data.updatedAt = Date.now();
    try {
      const dir = memoryDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(storePath(), JSON.stringify(this.data, null, 2), 'utf-8');
    } catch {
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
  recordAuthFailure(
    provider: string,
    configManager: ConfigManager,
    apiKey?: string,
  ): AuthFailureOutcome {
    const consecutive = (this.data.consecutiveAuthFailures[provider] || 0) + 1;
    this.data.consecutiveAuthFailures[provider] = consecutive;
    this.persist();

    if (consecutive < AUTH_CLEAR_THRESHOLD) {
      // Not yet at the threshold. The failover walk already logs the per-call
      // auth failure, so keep this DEBUG-only to avoid stacking noise on the
      // hot path — the actionable "clear it" guidance lands at the threshold.
      logger.debug(
        `${provider}: ${consecutive}/${AUTH_CLEAR_THRESHOLD} consecutive auth failures (key may be invalid — ` +
        `buff config set providers.${provider}.apiKey <real-key>)`,
      );
      return { consecutive, threshold: AUTH_CLEAR_THRESHOLD, cleared: false, envSourced: false };
    }

    let cleared = false;
    let envSourced = false;
    let envVar: string | undefined;
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
        logger.error(
          `   🚫 ${provider} returned ${consecutive} consecutive auth errors (401/403) — the invalid API key ` +
          `has been CLEARED from your config. Set a valid key to re-enable it: ` +
          `buff config set providers.${provider}.apiKey <real-key>`,
        );
      } else if (envSourced) {
        logger.error(
          `   🚫 ${provider} returned ${consecutive} consecutive auth errors (401/403) — its key comes from ` +
          `env var ${envVar} and could not be cleared from the config file. ` +
          `Unset/fix ${envVar} to re-enable ${provider}.`,
        );
      } else {
        // cleared=false AND envSourced=false → the key is already gone from
        // the config (cleared earlier / rotation list already filtered). The
        // counter was reset above — nothing left to clear, no further noise.
        logger.warn(
          `   ⚠️ ${provider} returned ${consecutive} consecutive auth errors (401/403) — no configured key ` +
          `to clear. Add a valid one to re-enable it: buff config set providers.${provider}.apiKey <real-key>`,
        );
      }
    } catch {
      // Best-effort — never break a live call over key hygiene. The counter
      // was NOT reset, so the next auth failure retries the clear.
      logger.warn(
        `   ⚠️ ${provider} returned ${consecutive} consecutive auth errors (401/403) — its key could not be ` +
        `cleared automatically. Run: buff config set providers.${provider}.apiKey <real-key>`,
      );
    }
    return { consecutive, threshold: AUTH_CLEAR_THRESHOLD, cleared, envSourced, envVar };
  }

  /**
   * A real success on a provider proves its key works — reset the consecutive
   * auth-failure counter so one blip can never clear a valid key. Best-effort.
   */
  recordAuthSuccess(provider: string): void {
    if (!(provider in this.data.consecutiveAuthFailures)) return;
    delete this.data.consecutiveAuthFailures[provider];
    this.persist();
  }

  /** Snapshot for tests / CLI (counters keyed by provider). */
  getState(): Record<string, number> {
    return { ...this.data.consecutiveAuthFailures };
  }

  reset(): void {
    this.data = emptyState();
    this.persist();
  }
}

let instance: KeyHygiene | null = null;

export function getKeyHygiene(): KeyHygiene {
  if (!instance) instance = new KeyHygiene();
  return instance;
}

export function resetKeyHygiene(): void {
  instance = null;
}
