/**
 * MCP pin verifier — does a catalog's exact npm spec actually exist?
 *
 * Assessment §2 is the reason this exists: four of six shipped pins resolved to
 * nothing (`@modelcontextprotocol/server-fetch` is not on npm at all;
 * `context7@1.5.2`, `server-memory@0.3.6` and
 * `server-sequential-thinking@0.4.2` never existed). Exact-version pinning is
 * the right policy — it makes a stale pin visible — but nothing CHECKED it, so
 * the failure surfaced as a stdio child that never spawns, deep in a chat turn.
 *
 * The check lives at the install boundary (Phase 1), not in a hot path, and it
 * is deliberately tolerant: no network ⇒ `checked: false`, the install proceeds
 * and REPORTS that the pin is unverified. An offline user can still configure
 * MCP; they are simply told that verification did not happen instead of being
 * handed a silent claim that it did.
 *
 * Also surfaced: npm's own `deprecated` flag for the exact version. A deprecated
 * package that still resolves (like `@modelcontextprotocol/server-github@0.6.2`,
 * "no longer supported") is reported, because "it installs" and "it is
 * maintained" are different facts.
 */

import type { PinVerdict } from './catalog.js';

/** Default registry lookup budget — short, because install is interactive. */
export const DEFAULT_PIN_TIMEOUT_MS = 5000;

export interface PinVerifyOptions {
  /** Injectable fetch (tests never touch the network). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Registry base URL (defaults to the public npm registry). */
  registry?: string;
}

/** Split `@scope/name@1.2.3` → `{ name: '@scope/name', version: '1.2.3' }`. */
export function parseNpmSpec(spec: string): { name: string; version: string } | null {
  const trimmed = String(spec ?? '').trim();
  if (!trimmed) return null;
  // The version separator is the LAST '@' — the first may open a scope.
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return null;
  const name = trimmed.slice(0, at);
  const version = trimmed.slice(at + 1);
  if (!name || !version) return null;
  return { name, version };
}

/** Verify one exact npm spec. Never throws. */
export async function verifyNpmSpec(spec: string, options: PinVerifyOptions = {}): Promise<PinVerdict> {
  const parsed = parseNpmSpec(spec);
  if (!parsed) {
    return { checked: false, ok: false, reason: `'${spec}' is not an exact npm spec (expected pkg@1.2.3)` };
  }
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { checked: false, ok: false, reason: 'no fetch implementation available' };
  }

  const registry = (options.registry ?? 'https://registry.npmjs.org').replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_PIN_TIMEOUT_MS;
  try {
    const response = await doFetch(`${registry}/${encodeURIComponent(parsed.name).replace('%40', '@')}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (response.status === 404) {
      return { checked: true, ok: false, reason: `npm has no package '${parsed.name}'` };
    }
    if (!response.ok) {
      return { checked: false, ok: false, reason: `registry returned HTTP ${response.status}` };
    }
    const body = (await response.json()) as {
      versions?: Record<string, { deprecated?: string }>;
    };
    const versions = body.versions ?? {};
    const entry = versions[parsed.version];
    if (!entry) {
      return {
        checked: true,
        ok: false,
        reason: `npm has no '${parsed.name}@${parsed.version}' (published: ${summarizeVersions(versions)})`,
      };
    }
    const deprecated = entry.deprecated;
    return {
      checked: true,
      ok: true,
      ...(deprecated ? { deprecated: typeof deprecated === 'string' ? deprecated : 'deprecated' } : {}),
    };
  } catch (err) {
    return {
      checked: false,
      ok: false,
      reason: `registry unreachable (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/** A short "…1.0.34, 2.0.0" tail so a refusal says what DOES exist. */
function summarizeVersions(versions: Record<string, unknown>, keep = 4): string {
  const keys = Object.keys(versions);
  if (keys.length === 0) return 'no versions published';
  return keys.slice(-keep).join(', ');
}

/**
 * Verify several specs in parallel (best-effort). Returns a map keyed by spec so
 * a caller can attribute a refusal to the exact pin it came from.
 */
export async function verifyNpmSpecs(
  specs: string[],
  options: PinVerifyOptions = {},
): Promise<Map<string, PinVerdict>> {
  const results = await Promise.all(specs.map(async (spec) => [spec, await verifyNpmSpec(spec, options)] as const));
  return new Map(results);
}
