/**
 * Audit command — P6 M6.3 tamper-evident audit trail.
 *
 * Usage:
 *   buff audit verify                      — Verify the hash chain of the built-in
 *                                            audit stores (quota-events + model-
 *                                            registry-actions) in ~/.buff/memory
 *   buff audit verify --file <path>        — Verify a specific JSONL audit file
 *   buff audit verify --json               — Machine-readable verdict (exit 0/1/2)
 *   buff audit export [--file <path>]      — SIEM-friendly CEF export of a store
 *                                            (defaults to quota-events)
 *   buff audit export --out <path>         — Write export to a file
 *
 * The stores are hash-chained (SHA-256) and secret-scrubbed: every record's
 * `chain.hash = sha256(prevHash ‖ canonical(record))`, and the chain head is
 * persisted in a sidecar `<file>.chain.json`, so tampering — even a single
 * flipped byte — is detected on verify.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import {
  verifyAuditFile,
  exportCefLines,
  auditFilePath,
  type ChainVerifyResult,
} from '../enterprise/audit-chain.js';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const BUILTIN_CHAINS: Array<{ id: string; label: string }> = [
  { id: 'quota-events', label: 'quota-events.jsonl (quota failover timeline)' },
  { id: 'model-registry-actions', label: 'model-registry-actions.jsonl (registry action telemetry)' },
];

function memoryDir(): string {
  return process.env.BUFF_MEMORY_DIR || join(homedir(), '.buff', 'memory');
}

/** Resolve a --file path or fall back to a builtin store id. */
function resolvePath(chainIdOrFile: string | undefined, builtin: string): string {
  if (chainIdOrFile) {
    if (chainIdOrFile.endsWith('.jsonl') || chainIdOrFile.includes('/')) {
      return chainIdOrFile;
    }
    return auditFilePath(chainIdOrFile);
  }
  return join(memoryDir(), builtin);
}

function renderVerifyResult(r: ChainVerifyResult): string {
  const icon = r.verdict === 'ok' ? '✅' : r.verdict === 'tampered' ? '❌' : r.verdict === 'corrupt' ? '❌' : '⚠️';
  const lines: string[] = [];
  lines.push(`${icon} ${r.chainId}`);
  lines.push(`   Records: ${r.totalLines} (${r.legacyLines} legacy pre-chain, ${r.corruptLines} corrupt)`);
  if (r.verdict === 'ok') {
    lines.push(`   Chain intact — head ${r.recomputedHead?.slice(0, 12)}…${r.recomputedHead ? ' matches stored sidecar' : ''}`);
  } else if (r.verdict === 'tampered') {
    lines.push(`   ⚠️  TAMPER DETECTED — first broken record at line ${r.tamperLine}`);
    lines.push(`   Stored head ${r.storedHead?.slice(0, 12) ?? '(none)'} ≠ recomputed ${r.recomputedHead?.slice(0, 12) ?? '(none)'}`);
  } else if (r.verdict === 'legacy') {
    lines.push('   ⚠️  Legacy un-chained store (pre-M6.3) — records readable, chain starts on next write.');
  } else {
    lines.push(`   ⚠️  Corrupt lines detected (${r.corruptLines}). Restore from backup — audit trails are append-only.`);
  }
  return lines.join('\n');
}

export class AuditCommand extends BaseCommand {
  create(): Command {
    const command = new Command('audit')
      .description('Verify and export the tamper-evident (hash-chained) audit trail (P6 M6.3)')
      .addCommand(this.createVerifyCommand())
      .addCommand(this.createExportCommand());
    return command;
  }

  private createVerifyCommand(): Command {
    return new Command('verify')
      .description('Verify hash-chain integrity of audit stores (tamper detection)')
      .option('-f, --file <path>', 'Verify a specific JSONL audit file (default: built-in stores)')
      .option('--json', 'Machine-readable JSON verdict (exit 0 = ok, 1 = tampered/corrupt, 2 = legacy)')
      .action((options?: { file?: string; json?: boolean }) => {
        const chains = options?.file
          ? [{ id: options.file, label: options.file }]
          : BUILTIN_CHAINS;

        const results: ChainVerifyResult[] = [];
        for (const chain of chains) {
          // The sidecar chain id is the STORE name (basename sans .jsonl) —
          // not the full path — so readHeadState's chainId match succeeds.
          const id = basename(chain.id).replace(/\.jsonl$/, '');
          const path = resolvePath(options?.file, chain.id);
          if (!existsSync(path)) {
            results.push({
              chainId: id,
              totalLines: 0,
              legacyLines: 0,
              corruptLines: 0,
              tamperLine: 0,
              recomputedHead: null,
              storedHead: null,
              headMatches: false,
              verdict: 'legacy',
            });
            if (!options?.json) logger.warn(`${id}: store not found (${path}) — nothing to verify yet`);
            continue;
          }
          results.push(verifyAuditFile(path, id));
        }

        if (options?.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          logger.highlight('\n  ── Audit Chain Verification (P6 M6.3) ──\n');
          for (const r of results) console.log(renderVerifyResult(r));
          console.log('');
          const worst = results.reduce<number>((w, r) => Math.max(w, r.verdict === 'ok' ? 0 : r.verdict === 'legacy' ? 2 : 1), 0);
          process.exitCode = worst;
        }
      });
  }

  private createExportCommand(): Command {
    return new Command('export')
      .description('Export an audit store as SIEM-friendly CEF lines')
      .option('-f, --file <path>', 'Audit file to export (default: quota-events)')
      .option('--out <path>', 'Write the export to a file (default: stdout)')
      .action((options?: { file?: string; out?: string }) => {
        const path = resolvePath(options?.file, 'quota-events.jsonl');
        if (!existsSync(path)) {
          logger.error(`Store not found: ${path}`);
          process.exitCode = 1;
          return;
        }
        const raw = readFileSync(path, 'utf-8');
        const lines = exportCefLines(raw.split('\n').filter((l) => l.trim()));
        if (options?.out) {
          writeFileSync(options.out, `${lines.join('\n')}\n`, 'utf-8');
          logger.success(`Exported ${lines.length} record(s) to ${options.out}`);
        } else {
          console.log(lines.join('\n'));
        }
      });
  }
}
