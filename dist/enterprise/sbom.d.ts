/**
 * sbom.ts — P6 M6.6 software-bill-of-materials (supply chain).
 *
 * Generates a CycloneDX 1.5 SBOM from the package-lock.json (deterministic:
 * npm records the exact resolved version, license and integrity hash for every
 * installed package), so `nuvira sbom` produces a procurement-ready inventory
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
    hashes?: Array<{
        alg: 'SHA-512' | 'SHA-256';
        content: string;
    }>;
    licenses?: Array<{
        license?: {
            id?: string;
            name?: string;
        };
        expression?: string;
    }>;
    supplier?: {
        name: string;
    };
    externalReferences?: Array<{
        type: string;
        url: string;
    }>;
}
/** The CycloneDX 1.5 document shape we emit. */
export interface SbomDocument {
    bomFormat: 'CycloneDX';
    specVersion: '1.5';
    serialNumber: string;
    version: number;
    metadata: {
        timestamp: string;
        tools: Array<{
            vendor: string;
            name: string;
            version: string;
        }>;
        component: {
            type: 'application';
            name: string;
            version: string;
            purl: string;
        };
    };
    components: SbomComponent[];
    dependencies: Array<{
        ref: string;
        dependsOn: string[];
    }>;
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
    changed: Array<{
        name: string;
        sbom: string;
        lock: string;
    }>;
    /** License expressions flagged for review (copyleft or unknown). */
    flaggedLicenses: Array<{
        name: string;
        license: string;
    }>;
}
/** Path of the root package-lock.json (override for hermetic tests). */
export declare function lockfilePath(rootDir: string): string;
/** Path of the root package.json (root component metadata). */
export declare function rootPackagePath(rootDir: string): string;
/**
 * Read + parse package-lock.json. Returns null when absent (no lockfile →
 * nothing deterministic to bill-of-material). Throws on malformed JSON.
 */
export declare function readLockfile(rootDir: string): Record<string, LockedPackage> | null;
/** Read the root package.json name/version (falls back to safe defaults). */
export declare function readRootPackage(rootDir: string): {
    name: string;
    version: string;
};
/** Normalize the license field to a single SPDX string or 'unknown'. */
export declare function licenseToString(license?: string | Record<string, unknown>): string;
/** Escape a name for a pURL (pkg:npm/<name>@<version>). */
export declare function purlFor(name: string, version: string): string;
/** Split an SPDX expression on `OR`/`AND`/parentheses to the first license id. */
export declare function spdxFirstId(expr: string): string;
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
export declare function buildSbom(rootDir: string, options?: {
    pinSerial?: boolean | string;
    pinTimestamp?: string;
}): SbomDocument;
/** Pretty-print the SBOM as JSON (deterministic field order). */
export declare function serializeSbom(bom: SbomDocument): string;
/** Parse a stored SBOM document (accepts our serialized JSON). */
export declare function parseSbom(json: string): SbomDocument;
/**
 * Compare a stored SBOM against the CURRENT lockfile. Reports packages added
 * since the BOM was written, removed, and changed (version or integrity
 * drift) — the supply-chain equivalent of the audit chain's tamper check.
 * Also flags licenses that warrant compliance review (copyleft/unknown).
 *
 * Pure: takes the lock snapshot + SBOM components, no file I/O.
 */
export declare function verifySbom(bomComponents: SbomComponent[], lock: Record<string, LockedPackage> | null, options?: {
    flagLicenses?: boolean;
}): SbomVerifyResult;
//# sourceMappingURL=sbom.d.ts.map