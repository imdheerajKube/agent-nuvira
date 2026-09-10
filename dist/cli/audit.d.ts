/**
 * Audit command — P6 M6.3 tamper-evident audit trail.
 *
 * Usage:
 *   nuvira audit verify                      — Verify the hash chain of the built-in
 *                                            audit stores (quota-events + model-
 *                                            registry-actions) in ~/.nuvira/memory
 *   nuvira audit verify --file <path>        — Verify a specific JSONL audit file
 *   nuvira audit verify --json               — Machine-readable verdict (exit 0/1/2)
 *   nuvira audit export [--file <path>]      — SIEM-friendly CEF export of a store
 *                                            (defaults to quota-events)
 *   nuvira audit export --out <path>         — Write export to a file
 *
 * The stores are hash-chained (SHA-256) and secret-scrubbed: every record's
 * `chain.hash = sha256(prevHash ‖ canonical(record))`, and the chain head is
 * persisted in a sidecar `<file>.chain.json`, so tampering — even a single
 * flipped byte — is detected on verify.
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class AuditCommand extends BaseCommand {
    create(): Command;
    private createVerifyCommand;
    private createExportCommand;
}
//# sourceMappingURL=audit.d.ts.map