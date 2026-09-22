/**
 * Credential Fingerprint — notice when the user's keys change, and re-probe.
 *
 * WHY THIS EXISTS. The routing pool can only contain models a probe has
 * VERIFIED, and a probe only ever ran on a cold start or a maintenance command.
 * So a purchase made mid-session — the exact case where a user expects the new
 * models to appear — changed nothing: the credential was fine, the catalog was
 * stale, and the next run would have picked the models up only if it happened to
 * cold-start. There is no per-model entitlement API to ask ("may I buy
 * `meta-llama/...`?" is not a question OpenRouter answers); the only honest
 * signal is *"we sent one token with this key and it answered"*. But it is
 * genuinely cheap to notice that the KEY SET changed and force that probe
 * instead of waiting for an accident.
 *
 * WHAT IS STORED: a SHA-256 digest of the credential SHAPE — which providers are
 * configured, a digest of each key, each base URL, each env-var presence. Never
 * a key, not even truncated, and the digest is one-way, so the file is safe to
 * read, copy or commit by accident. Its only job is equality.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { CATALOG_PROVIDER_IDS, catalogEnvVar, getCatalogProvider } from '../inference/provider-catalog.js';
import type { ConfigManager } from '../config/manager.js';

/** Sidecar file (under the memory dir) holding the last-seen credential shape. */
export const CREDENTIAL_FINGERPRINT_FILENAME = 'credential-fingerprint.json';

const DEFAULT_MEMORY_DIR = join(resolveNuviraHome(), 'memory');

function memoryDir(): string {
  return envBuff('MEMORY_DIR') || DEFAULT_MEMORY_DIR;
}

/** Path of the fingerprint sidecar (exported so tests can redirect it). */
export function credentialFingerprintPath(): string {
  return join(memoryDir(), CREDENTIAL_FINGERPRINT_FILENAME);
}

/** One-way digest of a secret — never the secret itself. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * The credential SHAPE, as a list of comparable lines.
 *
 * Exported (and separate from the hashing) so a test — or a support call — can
 * see exactly which inputs are considered without needing to reverse a digest.
 * The lines carry digests, never keys.
 */
export function credentialShapeInputs(configManager: ConfigManager): string[] {
  const lines: string[] = [];
  for (const provider of [...CATALOG_PROVIDER_IDS].sort()) {
    const parts: string[] = [provider];

    // 1. Config-resolved key (vault refs resolved by getProviderConfig, so a
    //    key that moved from plaintext into the vault is NOT a change).
    let configKey: string | undefined;
    let baseUrl: string | undefined;
    try {
      const { config } = configManager.getProviderConfig(provider as never);
      configKey = typeof config?.apiKey === 'string' ? config.apiKey : undefined;
      baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl : undefined;
    } catch {
      // A provider the manager cannot describe contributes only its env state.
    }
    if (configKey) parts.push(`cfg:${digest(configKey)}`);
    if (baseUrl) parts.push(`url:${baseUrl}`);

    // 2. The standard env var — presence AND digest, so replacing a key in the
    //    environment is a change while an unrelated env tweak is not.
    const envVar = catalogEnvVar(provider);
    if (envVar) {
      const fromEnv = process.env[envVar];
      if (fromEnv) parts.push(`env:${digest(fromEnv)}`);
    }

    // 3. Reachability class: keyless runners appear/disappear from the probe
    //    set when their catalog entry changes, not when a key changes.
    const entry = getCatalogProvider(provider);
    if (entry?.keyless) parts.push('keyless');

    lines.push(parts.join('|'));
  }
  return lines;
}

/** SHA-256 digest of the credential shape. Safe to log. */
export function credentialFingerprint(configManager: ConfigManager): string {
  return digest(credentialShapeInputs(configManager).join('\n'));
}

export interface CredentialChange {
  /** True when the shape differs from the last one recorded. */
  changed: boolean;
  /** True when nothing had been recorded yet (no comparison was possible). */
  firstRun: boolean;
  /** The shape as of this call — already recorded by the time this returns. */
  fingerprint: string;
  /** The previously recorded shape, when there was one. */
  previous?: string;
}

/**
 * Compare the current credential shape against the last one recorded and RECORD
 * the new one.
 *
 * Recording on every call is what makes this fire once per change rather than
 * once per cycle: the caller sees `changed: true` a single time and can force a
 * probe, and every later call in the same process is a no-op. `firstRun` is
 * reported separately because "no previous record" is not evidence of a change —
 * a fresh machine must not be treated as though a purchase just landed.
 */
export function detectCredentialChange(
  configManager: ConfigManager,
  options: { path?: string } = {},
): CredentialChange {
  const path = options.path ?? credentialFingerprintPath();
  const fingerprint = credentialFingerprint(configManager);

  let previous: string | undefined;
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { fingerprint?: string };
      if (typeof raw?.fingerprint === 'string') previous = raw.fingerprint;
    }
  } catch {
    // A corrupt sidecar is treated as absent — the worst case is one extra
    // catalog probe, which is cheap and idempotent.
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ fingerprint, at: Date.now() }), 'utf-8');
  } catch {
    // Best-effort: failing to record must never break a run.
  }

  return {
    changed: previous !== undefined && previous !== fingerprint,
    firstRun: previous === undefined,
    fingerprint,
    previous,
  };
}
