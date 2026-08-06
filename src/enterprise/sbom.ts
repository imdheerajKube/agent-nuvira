/**
 * sbom.ts — P6 M6.6 software-bill-of-materials (supply chain).
 *
 * Generates a CycloneDX 1.5 SBOM from the package-lock.json (deterministic:
 * npm records the exact resolved version, license and integrity hash for every
 * installed package), so `buff sbom` produces a procurement-ready inventory
 * without a network round-trip. `verifySbom` re-reads the lockfile and
 * compares it against a stored SBOM — detecting drift (deps changed since the
 * BOM was written) and tampering (a hand-edited SBOM). The license audit
 * flags copyleft/unknown licenses for the compliance review.
 *
 * Guarantees:
 * - Pure + deterministic for a given lockfile (same input → same BOM shape;
 *   the serial number + timestamp are the only non-deterministic fields and
 *   can be pinned for reproducible builds).
 * - Never reads network state; the lockfile IS the source of truth.
 *
 * @see NUVIRA_ROUTER_ROADMAP.md §P6 M6.6
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

/** One package as recorded in package-lock.json (lockfileVersion 3). */
export interface LockedPackage {
  /** Resolved version (exact — no ranges in a lockfile). */
  version: string;
  /** SRI integrity hash (e.g. sha512-…), when npm recorded it. */
  integrity?: string;
  /** SPDX license expression when the package declares one. */
  license?: string | Record<string, unknown>;
  /** Registry tarball URL when available. */
  resolved?: string;
}

/** A CycloneDX component (dependency). */
export interface SbomComponent {
  type: 'library';
  name: string;
  version: string;
  purl: string;
  hashes?: Array<{ alg: 'SHA-512' | 'SHA-256'; content: string }>;
  licenses?: Array<{ license?: { id?: string; name?: string }; expression?: string }>;
  supplier?: { name: string };
  externalReferences?: Array<{ type: string; url: string }>;
}

/** The CycloneDX 1.5 document shape we emit. */
export interface SbomDocument {
  bomFormat: 'CycloneDX';
  specVersion: '1.5';
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    tools: Array<{ vendor: string; name: string; version: string }>;
    component: { type: 'application'; name: string; version: string; purl: string };
  };
  components: SbomComponent[];
  dependencies: Array<{ ref: string; dependsOn: string[] }>;
}

/** Outcome of comparing a stored SBOM against the current lockfile. */
export interface SbomVerifyResult {
  ok: boolean;
  totalComponents: number;
  /** Packages in the lockfile that are missing from the stored SBOM. */
  added: string[];
  /** Packages in the stored SBOM that are no longer in the lockfile. */
  removed: string[];
  /** Packages whose version/integrity differs between SBOM and lockfile. */
  changed: Array<{ name: string; sbom: string; lock: string }>;
  /** License expressions flagged for review (copyleft or unknown). */
  flaggedLicenses: Array<{ name: string; license: string }>;
}

// ─── Core helpers ───────────────────────────────────────────────────────────

/** Path of the root package-lock.json (override for hermetic tests). */
export function lockfilePath(rootDir: string): string {
  return join(rootDir, 'package-lock.json');
}

/** Path of the root package.json (root component metadata). */
export function rootPackagePath(rootDir: string): string {
  return join(rootDir, 'package.json');
}

/**
 * Read + parse package-lock.json. Returns null when absent (no lockfile →
 * nothing deterministic to bill-of-material). Throws on malformed JSON.
 */
export function readLockfile(rootDir: string): Record<string, LockedPackage> | null {
  const path = lockfilePath(rootDir);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
    packages?: Record<string, LockedPackage>;
  };
  return raw.packages ?? null;
}

/** Read the root package.json name/version (falls back to safe defaults). */
export function readRootPackage(rootDir: string): { name: string; version: string } {
  const path = rootPackagePath(rootDir);
  if (existsSync(path)) {
    const p = JSON.parse(readFileSync(path, 'utf-8')) as { name?: string; version?: string };
    return { name: p.name || 'agent-nuvira', version: p.version || '0.0.0' };
  }
  return { name: 'agent-nuvira', version: '0.0.0' };
}

/** Canonical package name for a node_modules path key (`node_modules/a/b` → `a/b`). */
function keyToName(key: string): string {
  return key.replace(/^node_modules\//, '');
}

/** Normalize the license field to a single SPDX string or 'unknown'. */
export function licenseToString(license?: string | Record<string, unknown>): string {
  if (!license) return 'unknown';
  if (typeof license === 'string') return license;
  if (typeof license === 'object' && typeof license.type === 'string') {
    return license.type as string;
  }
  return 'unknown';
}

/** Escape a name for a pURL (pkg:npm/<name>@<version>). */
export function purlFor(name: string, version: string): string {
  // pURL spec: pkg:npm/<percent-encoded name>@<version>
  const enc = name.replace(/%/g, '%25').replace(/\//g, '%2F').replace(/@/g, '%40');
  return `pkg:npm/${enc}@${version}`;
}

/** Extract the algorithm from an SRI integrity string (`sha512-…` → `SHA-512`). */
function sriAlg(integrity: string): 'SHA-512' | 'SHA-256' {
  if (integrity.startsWith('sha256-')) return 'SHA-256';
  return 'SHA-512';
}

/** The SRI digest content (after the `algo-` prefix). */
function sriDigest(integrity: string): string {
  const dash = integrity.indexOf('-');
  return dash >= 0 ? integrity.slice(dash + 1) : integrity;
}

/** Split an SPDX expression on `OR`/`AND`/parentheses to the first license id. */
export function spdxFirstId(expr: string): string {
  const m = expr.match(/[A-Za-z0-9.\-+]+/);
  return m ? m[0] : expr;
}

// ─── Build ──────────────────────────────────────────────────────────────────

/**
 * Build a CycloneDX 1.5 SBOM from the lockfile. Every `node_modules/<pkg>`
 * entry becomes a component with its resolved version, integrity hash, purl,
 * license and (when resolvable) registry supplier + tarball reference. The
 * root package.json becomes the metadata component.
 *
 * @param options.pinSerial  Deterministic serial (reproducible builds) — a
 *   SHA-256 of the lockfile content when provided as `true`, or a literal
 *   string. Default: random uuid (spec-compliant, non-reproducible).
 * @param options.pinTimestamp  Fixed ISO timestamp for reproducible builds.
 */
export function buildSbom(
  rootDir: string,
  options: { pinSerial?: boolean | string; pinTimestamp?: string } = {},
): SbomDocument {
  const lock = readLockfile(rootDir);
  const root = readRootPackage(rootDir);
  const components: SbomComponent[] = [];
  const dependencyRefs: string[] = [];

  if (lock) {
    for (const [key, pkg] of Object.entries(lock)) {
      if (!key.startsWith('node_modules/') || !pkg || typeof pkg.version !== 'string') continue;
      if (key === 'node_modules') continue; // the root project itself
      const name = keyToName(key);
      const version = pkg.version;
      const component: SbomComponent = {
        type: 'library',
        name,
        version,
        purl: purlFor(name, version),
      };
      if (pkg.integrity) {
        component.hashes = [{ alg: sriAlg(pkg.integrity), content: sriDigest(pkg.integrity) }];
      }
      const license = licenseToString(pkg.license);
      if (license !== 'unknown') {
        component.licenses = [{ expression: license }];
      } else if (pkg.license) {
        component.licenses = [{ license: { name: license } }];
      }
      if (typeof pkg.resolved === 'string' && pkg.resolved.startsWith('https://')) {
        const host = new URL(pkg.resolved).host;
        component.supplier = { name: host.replace(/^www\./, '') };
        component.externalReferences = [
          { type: 'distribution', url: pkg.resolved },
          { type: 'vcs', url: pkg.resolved.replace(/\/-\/[^/]+$/, '') },
        ];
      }
      components.push(component);
      dependencyRefs.push(component.purl);
    }
  }

  // Deterministic order (lockfile keys are not guaranteed sorted) so the same
  // lockfile always yields the same component list — diffable BOMs.
  components.sort((a, b) => a.name.localeCompare(b.name));

  const serialNumber = options.pinSerial === true
    ? `urn:uuid:${createHash('sha256').update(JSON.stringify(lock ?? {})).digest('hex').slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')}`
    : typeof options.pinSerial === 'string'
      ? options.pinSerial
      : `urn:uuid:${randomUUID()}`;

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber,
    version: 1,
    metadata: {
      timestamp: options.pinTimestamp ?? new Date().toISOString(),
      tools: [{ vendor: 'Agent-Nuvira', name: 'agent-nuvira', version: root.version }],
      component: {
        type: 'application',
        name: root.name,
        version: root.version,
        purl: purlFor(root.name, root.version),
      },
    },
    components,
    dependencies: [{ ref: purlFor(root.name, root.version), dependsOn: dependencyRefs }],
  };
}

/** Pretty-print the SBOM as JSON (deterministic field order). */
export function serializeSbom(bom: SbomDocument): string {
  return JSON.stringify(bom, null, 2);
}

// ─── Verify (drift / tamper detection) ──────────────────────────────────────

/** A name@version → integrity map for a lockfile (the ground truth). */
function lockSnapshot(lock: Record<string, LockedPackage>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, pkg] of Object.entries(lock)) {
    if (!key.startsWith('node_modules/') || key === 'node_modules' || !pkg?.version) continue;
    map.set(`${keyToName(key)}@${pkg.version}`, pkg.integrity ? sriDigest(pkg.integrity) : 'no-integrity');
  }
  return map;
}

/** Parse a stored SBOM document (accepts our serialized JSON). */
export function parseSbom(json: string): SbomDocument {
  const parsed = JSON.parse(json) as SbomDocument;
  if (parsed.bomFormat !== 'CycloneDX' || !Array.isArray(parsed.components)) {
    throw new Error('Not a CycloneDX SBOM document');
  }
  return parsed;
}

/**
 * Compare a stored SBOM against the CURRENT lockfile. Reports packages added
 * since the BOM was written, removed, and changed (version or integrity
 * drift) — the supply-chain equivalent of the audit chain's tamper check.
 * Also flags licenses that warrant compliance review (copyleft/unknown).
 *
 * Pure: takes the lock snapshot + SBOM components, no file I/O.
 */
export function verifySbom(
  bomComponents: SbomComponent[],
  lock: Record<string, LockedPackage> | null,
  options: { flagLicenses?: boolean } = {},
): SbomVerifyResult {
  const flagLicenses = options.flagLicenses ?? true;
  const lockMap = lock ? lockSnapshot(lock) : new Map<string, string>();
  const bomMap = new Map<string, string>();
  for (const c of bomComponents) {
    const digest = c.hashes?.find((h) => h.alg === 'SHA-512')?.content ?? c.hashes?.[0]?.content ?? 'no-integrity';
    bomMap.set(`${c.name}@${c.version}`, digest);
  }

  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ name: string; sbom: string; lock: string }> = [];

  for (const [key, digest] of lockMap) {
    if (!bomMap.has(key)) {
      // A lock entry missing from the BOM: either a version bump of a known
      // package (→ changed) or a genuinely new dependency (→ added).
      const name = splitNameVersion(key)[0];
      const existing = bomMap.get(`${name}@${bomVersionOf(bomComponents, name)}`);
      if (existing && existing !== digest) {
        changed.push({ name, sbom: existing === 'no-integrity' ? '(none)' : 'sha512-' + existing.slice(0, 12) + '…', lock: 'sha512-' + digest.slice(0, 12) + '…' });
      } else {
        added.push(key);
      }
    } else if (bomMap.get(key) !== digest) {
      const [name] = splitNameVersion(key);
      changed.push({ name, sbom: (bomMap.get(key) ?? '').slice(0, 12) + '…', lock: digest.slice(0, 12) + '…' });
    }
  }
  for (const key of bomMap.keys()) {
    if (!lockMap.has(key)) removed.push(key);
  }

  const flaggedLicenses: Array<{ name: string; license: string }> = [];
  if (flagLicenses) {
    const copyleft = /(^|\s)(GPL|AGPL|LGPL|MPL|EPL|CC-BY-SA|SSPL)/i;
    for (const c of bomComponents) {
      const expr = c.licenses?.[0]?.expression ?? c.licenses?.[0]?.license?.name;
      if (!expr || expr === 'unknown') {
        flaggedLicenses.push({ name: `${c.name}@${c.version}`, license: 'unknown' });
      } else if (copyleft.test(expr)) {
        flaggedLicenses.push({ name: `${c.name}@${c.version}`, license: expr });
      }
    }
  }

  return {
    ok: added.length === 0 && removed.length === 0 && changed.length === 0,
    totalComponents: bomComponents.length,
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort((a, b) => a.name.localeCompare(b.name)),
    flaggedLicenses: flaggedLicenses.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function splitNameVersion(key: string): [string, string] {
  const at = key.lastIndexOf('@');
  return [key.slice(0, at), key.slice(at + 1)];
}

function bomVersionOf(components: SbomComponent[], name: string): string | undefined {
  return components.find((c) => c.name === name)?.version;
}
