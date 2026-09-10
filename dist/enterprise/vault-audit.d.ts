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
/** A vault operation that is audited. */
export type VaultAccessOp = 'get' | 'set' | 'delete';
/** One audited vault access (chain wrapper stripped on read). */
export interface VaultAccessRecord {
    /** Epoch ms when the access happened. */
    ts: number;
    op: VaultAccessOp;
    /** The ACCOUNT NAME (config key like `openai.apiKey`) — never the value. */
    account: string;
    /** Whether the operation succeeded (found / persisted / removed). */
    ok: boolean;
    /** Active vault tier at access time (keyring / os-cli / aes-file / none). */
    tier: string;
    /** Access path — sync (ConfigManager read-time) or async. */
    via: 'async' | 'sync';
}
/** Chain id + filename for the vault access store (matches builtin audit chains). */
export declare const VAULT_AUDIT_CHAIN_ID = "vault-access";
export declare const VAULT_AUDIT_FILENAME = "vault-access.jsonl";
/**
 * Cap on retained log lines. Rotation triggers at 2× this cap (amortized O(1)
 * per write) and trims back to the cap — so the store holds between cap and
 * 2×cap lines at any moment, with the surviving slice re-chained from genesis.
 */
export declare const MAX_VAULT_AUDIT_ENTRIES = 5000;
/** Absolute path of the vault access store. */
export declare function vaultAuditPath(): string;
/** Test helper: reset the rotation counter. */
export declare function resetVaultAuditCounter(): void;
/**
 * Record one vault access. Best-effort and VITEST-guarded (test suites never
 * pollute the real store) — an audit failure must NEVER break a vault op.
 * Rotation mirrors model-registry: when the log doubles past the cap, the
 * oldest half is dropped and the surviving slice is re-chained from genesis
 * (the store holds between cap and 2×cap lines between rotations).
 */
export declare function recordVaultAccess(op: VaultAccessOp, account: string, ok: boolean, tier: string, via: 'async' | 'sync', maxLines?: number): void;
/**
 * Read the most recent vault-access records (newest first). Never throws —
 * corrupt lines are skipped so the reader survives partial tampering.
 */
export declare function readVaultAccessLog(limit?: number): VaultAccessRecord[];
//# sourceMappingURL=vault-audit.d.ts.map