/**
 * SBOM command — P6 M6.6 software bill of materials (supply chain).
 *
 * Usage:
 *   nuvira sbom                       — Print the CycloneDX 1.5 SBOM (stdout)
 *   nuvira sbom --out <path>          — Write the SBOM to a file
 *   nuvira sbom --reproducible        — Pin the serial (SHA-256 of lockfile) +
 *                                     timestamp for byte-identical rebuilds
 *   nuvira sbom verify [--sbom <p>]   — Compare a stored SBOM against the current
 *                                     package-lock.json: drift + tamper + license
 *                                     audit (exit 0 = clean, 1 = drift/tamper)
 *   nuvira sbom licenses              — License audit table (copyleft/unknown)
 *
 * The SBOM is generated from package-lock.json — the deterministic source of
 * truth for exactly-what-is-installed (resolved versions + integrity hashes) —
 * so no network is needed and the output is reproducible.
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class SbomCommand extends BaseCommand {
    create(): Command;
}
//# sourceMappingURL=sbom.d.ts.map