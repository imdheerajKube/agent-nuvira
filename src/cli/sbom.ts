/**
 * SBOM command — P6 M6.6 software bill of materials (supply chain).
 *
 * Usage:
 *   buff sbom                       — Print the CycloneDX 1.5 SBOM (stdout)
 *   buff sbom --out <path>          — Write the SBOM to a file
 *   buff sbom --reproducible        — Pin the serial (SHA-256 of lockfile) +
 *                                     timestamp for byte-identical rebuilds
 *   buff sbom verify [--sbom <p>]   — Compare a stored SBOM against the current
 *                                     package-lock.json: drift + tamper + license
 *                                     audit (exit 0 = clean, 1 = drift/tamper)
 *   buff sbom licenses              — License audit table (copyleft/unknown)
 *
 * The SBOM is generated from package-lock.json — the deterministic source of
 * truth for exactly-what-is-installed (resolved versions + integrity hashes) —
 * so no network is needed and the output is reproducible.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import {
  buildSbom,
  serializeSbom,
  verifySbom,
  parseSbom,
  readLockfile,
} from '../enterprise/sbom.js';
import type { SbomComponent, SbomVerifyResult } from '../enterprise/sbom.js';

/** The directory that holds package.json + package-lock.json. */
function projectRoot(): string {
  // The CLI ships inside the package: dist/cli/ → ../../ = package root.
  return resolve(process.cwd());
}

function renderVerifyResult(r: SbomVerifyResult): string {
  const lines: string[] = [];
  if (r.ok && r.flaggedLicenses.length === 0) {
    lines.push('✅ SBOM matches package-lock.json — no drift, no tamper, no flagged licenses.');
  } else {
    lines.push(r.ok ? '⚠️  SBOM matches lockfile, but licenses need review:' : '❌ SBOM does NOT match package-lock.json:');
    if (r.added.length) lines.push(`   Added since SBOM:  ${r.added.join(', ')}`);
    if (r.removed.length) lines.push(`   Removed since SBOM: ${r.removed.join(', ')}`);
    for (const c of r.changed) {
      lines.push(`   Changed: ${c.name}  SBOM ${c.sbom} → lock ${c.lock}`);
    }
  }
  if (r.flaggedLicenses.length) {
    lines.push(`   ⚠️  ${r.flaggedLicenses.length} license(s) flagged for review (copyleft/unknown):`);
    for (const f of r.flaggedLicenses.slice(0, 12)) {
      lines.push(`      ${f.name} — ${f.license}`);
    }
    if (r.flaggedLicenses.length > 12) lines.push(`      … and ${r.flaggedLicenses.length - 12} more`);
  }
  lines.push(`   Components: ${r.totalComponents}`);
  return lines.join('\n');
}

export class SbomCommand extends BaseCommand {
  create(): Command {
    return new Command('sbom')
      .description('Generate and verify the CycloneDX software bill of materials (P6 M6.6)')
      .option('-o, --out <path>', 'Write the SBOM JSON to a file (default: stdout)')
      .option('--reproducible', 'Pin the serial + timestamp for byte-identical rebuilds')
      .option('--json', 'Machine-readable JSON output for verify')
      .option('--verify', 'Verify a stored SBOM against package-lock.json')
      .option('--sbom <path>', 'SBOM file to verify (default: sbom.json in project root)')
      .option('--licenses', 'License audit only (copyleft/unknown flagging)')
      .action((options?: {
        out?: string;
        reproducible?: boolean;
        json?: boolean;
        verify?: boolean;
        sbom?: string;
        licenses?: boolean;
      }) => {
        const root = projectRoot();
        const lock = readLockfile(root);
        if (!lock) {
          logger.error(`No package-lock.json found in ${root} — nothing deterministic to bill-of-material.`);
          process.exitCode = 1;
          return;
        }
        const bom = buildSbom(root, {
          pinSerial: options?.reproducible ? true : false,
          pinTimestamp: options?.reproducible ? '1970-01-01T00:00:00.000Z' : undefined,
        });

        // ── License audit only ─────────────────────────────────────────────
        if (options?.licenses) {
          const result = verifySbom(bom.components, lock, { flagLicenses: true });
          logger.highlight('\n  ── SBOM License Audit (P6 M6.6) ──\n');
          console.log(renderVerifyResult(result));
          console.log('');
          process.exitCode = result.flaggedLicenses.length > 0 ? 1 : 0;
          return;
        }

        // ── Verify mode ────────────────────────────────────────────────────
        if (options?.verify || options?.sbom) {
          const sbomPath = options?.sbom || resolve(root, 'sbom.json');
          if (!existsSync(sbomPath)) {
            logger.error(`SBOM file not found: ${sbomPath} — run \`buff sbom --out sbom.json\` first.`);
            process.exitCode = 1;
            return;
          }
          let components: SbomComponent[];
          try {
            components = parseSbom(readFileSync(sbomPath, 'utf-8')).components;
          } catch (err) {
            logger.error(`Could not parse SBOM ${sbomPath}: ${err instanceof Error ? err.message : String(err)}`);
            process.exitCode = 1;
            return;
          }
          const result = verifySbom(components, lock, { flagLicenses: true });
          if (options?.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            logger.highlight('\n  ── SBOM Verification (P6 M6.6) ──\n');
            console.log(renderVerifyResult(result));
            console.log('');
          }
          process.exitCode = result.ok && result.flaggedLicenses.length === 0 ? 0 : 1;
          return;
        }

        // ── Generate mode ──────────────────────────────────────────────────
        const json = serializeSbom(bom);
        if (options?.out) {
          writeFileSync(options.out, json + '\n', 'utf-8');
          logger.success(`Wrote SBOM (${bom.components.length} components) to ${options.out}`);
        } else {
          console.log(json);
        }
        // License note: surface the count even on plain generate so the
        // supply-chain posture is visible without a separate command.
        const flags = verifySbom(bom.components, lock, { flagLicenses: true }).flaggedLicenses;
        if (flags.length > 0) {
          console.log(`\n⚠️  ${flags.length} copyleft/unknown license(s) — run \`buff sbom licenses\` for details.`);
        }
      });
  }
}

