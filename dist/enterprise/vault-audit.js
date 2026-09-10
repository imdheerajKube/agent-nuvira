/**
 * vault-audit.ts — K3: tamper-evident ACCESS LOGGING for the secret vault.
 *
 * Phase K3 closes the gap that the vault has ZERO access logging: every
 * get/set/delete on the Vault primitives appends a hash-chained, secret-
 * scrubbed record to `~/.nuvira/memory/vault-access.jsonl` (SHA-256 chain via
 * the shared audit-chain core — the SAME tamper-evidence as quota-events /
 * model-registry-actions).
 *
 * NEVER logs secret VALUES — only the operation, the ACCOUNT NAME (a config
 * key name like `openai.apiKey`, never its value), the outcome, the active
 * tier, and the access path (sync/async). Surfaced via `nuvira config vault
 * log`, verified via `nuvira audit verify` and `nuvira doctor --enterprise`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
import { appendChainedRecordFast, rechainRecords, headOfLines, writeHeadState, } from './audit-chain.js';
// ─── Constants ─────────────────────────────────────────────────────────────
/** Chain id + filename for the vault access store (matches builtin audit chains). */
export const VAULT_AUDIT_CHAIN_ID = 'vault-access';
export const VAULT_AUDIT_FILENAME = 'vault-access.jsonl';
/**
 * Cap on retained log lines. Rotation triggers at 2× this cap (amortized O(1)
 * per write) and trims back to the cap — so the store holds between cap and
 * 2×cap lines at any moment, with the surviving slice re-chained from genesis.
 */
export const MAX_VAULT_AUDIT_ENTRIES = 5000;
function memoryDir() {
    return envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
}
/** Absolute path of the vault access store. */
export function vaultAuditPath() {
    return join(memoryDir(), VAULT_AUDIT_FILENAME);
}
// ─── Append (with amortized rotation) ──────────────────────────────────────
/** In-memory append counter (avoids a file read on every write). */
let appendCount = 0;
/** Test helper: reset the rotation counter. */
export function resetVaultAuditCounter() {
    appendCount = 0;
}
/**
 * Record one vault access. Best-effort and VITEST-guarded (test suites never
 * pollute the real store) — an audit failure must NEVER break a vault op.
 * Rotation mirrors model-registry: when the log doubles past the cap, the
 * oldest half is dropped and the surviving slice is re-chained from genesis
 * (the store holds between cap and 2×cap lines between rotations).
 */
export function recordVaultAccess(op, account, ok, tier, via, maxLines = MAX_VAULT_AUDIT_ENTRIES) {
    if (process.env.VITEST)
        return;
    if (!account)
        return;
    try {
        const path = vaultAuditPath();
        appendChainedRecordFast(path, VAULT_AUDIT_CHAIN_ID, {
            ts: Date.now(),
            op,
            account,
            ok,
            tier,
            via,
        });
        appendCount += 1;
        if (appendCount > maxLines * 2) {
            const raw = existsSync(path) ? readFileSync(path, 'utf-8') : '';
            const lines = raw.split('\n').filter((l) => l.trim()).slice(-maxLines);
            const rechained = rechainRecords(lines);
            writeFileSync(path, rechained.length > 0 ? `${rechained.join('\n')}\n` : '', 'utf-8');
            writeHeadState(path, VAULT_AUDIT_CHAIN_ID, headOfLines(rechained), rechained.length);
            appendCount = rechained.length;
        }
    }
    catch {
        // Audit must never break a vault operation.
    }
}
/**
 * Read the most recent vault-access records (newest first). Never throws —
 * corrupt lines are skipped so the reader survives partial tampering.
 */
export function readVaultAccessLog(limit = 20) {
    try {
        const path = vaultAuditPath();
        if (!existsSync(path))
            return [];
        // Clamp: negatives/NaN/0 would flip slice direction or return nothing.
        const safeLimit = Math.max(1, Math.floor(Number(limit)) || 20);
        const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim());
        return lines
            .slice(-safeLimit)
            .map((line) => {
            try {
                const rec = JSON.parse(line);
                if (!rec.op || !rec.account)
                    return null;
                return {
                    ts: rec.ts ?? 0,
                    op: rec.op,
                    account: rec.account,
                    ok: rec.ok === true,
                    tier: rec.tier ?? 'unknown',
                    via: rec.via === 'sync' ? 'sync' : 'async',
                };
            }
            catch {
                return null;
            }
        })
            .filter((r) => r !== null)
            .reverse();
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=vault-audit.js.map