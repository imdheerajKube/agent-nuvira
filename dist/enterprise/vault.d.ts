/**
 * vault.ts — Secret Vault (revamp Phase A1). OS-aware, platform-independent.
 *
 * The vault is a STACK of OS-native credential backends selected at open time
 * (
 * where keychain, file, and env sources are swappable behind one persistence
 * layer). Priority, always leveraging the OS credential store rather than a
 * bespoke hardened format:
 *
 *   Tier 1   — OS keychain via `@napi-rs/keyring` (prebuilt binaries for every
 *              major platform): macOS Keychain, Windows Credential Manager,
 *              Linux Secret Service (libsecret), FreeBSD. The binding is a thin
 *              wrapper over the OS store — the SAME native store the user sees
 *              in Keychain Access / Credential Manager / Seahorse.
 *   Tier 1b  — OS-native CLI credential tools, used when the keyring binding
 *              cannot load OR its OS store is unreachable (e.g. headless Linux
 *              without a Secret Service daemon):
 *                macOS   → /usr/bin/security (Keychain)
 *                Linux   → secret-tool        (Secret Service via libsecret)
 *                Windows → PowerShell CredWrite/CredRead/CredDelete
 *                          (Credential Manager P/Invoke)
 *   Tier 2   — AES-256-GCM encrypted file (`~/.nuvira/vault.enc`, 0600) as the
 *              last-resort fallback when NO OS store is available at all
 *              (minimal containers). Key derived via scrypt from a master
 *              passphrase (injected / env `BUFF_VAULT_PASSPHRASE`); Node
 *              built-in `crypto` only — zero native deps.
 *
 * Keyring REACHABILITY PROBE: the binding can load on a machine whose OS store
 * is not actually running (headless Linux Secret Service). Without a probe the
 * vault would report tier `keyring` and every operation would silently fail.
 * `probeKeyringReachable()` performs one non-destructive sync read at open;
 * when it throws, the stack drops to Tier 1b (or Tier 2), never fake-keyring.
 *
 * Guarantees:
 * - `getPassword`/`setPassword`/`deletePassword` are the ONLY operations
 *   callers use — backend selection is internal (`CredentialSource`
 *   shape). A sync read path exists for ConfigManager's read-time ref
 *   resolution (every runtime ConfigManager is a fresh instance).
 * - Testable without touching the real keychain: `Vault.open` accepts an
 *   injected tier + config dir; Tier 2 is fully file-based; backend selection
 *   helpers (`createOsCliBackend`, `probeKeyringReachable`) are pure.
 * - Never logs secret material: status reports tier + platform + backend
 *   labels, never values.
 *
 * Integration points:
 * - `ConfigManager` routes key read/write through `Vault` (Phase A1 wiring).
 * - `nuvira config migrate-keys` moves plaintext keys from `buffconfig.json`.
 * - `nuvira doctor` reports the active vault tier + platform backend.
 *
 * @see AGENT_NUVIRA_MAJOR_REVAMP_PLAN.md — Phase A1 (Implementation reference:
 *      `credential_persistence.py` + `credential_sources/`, provider-
 *      swappable storage). Cross-platform requirement: the agent must run
 *      identically on macOS / Windows / Linux / containers.
 */
/** Service name used for all credential entries (namespace, mirrors keytar conventions). */
export declare const VAULT_SERVICE = "agent-nuvira";
/** Env var that supplies the Tier-2 master passphrase (no file needed when set). */
export declare const VAULT_PASSPHRASE_ENV = "BUFF_VAULT_PASSPHRASE";
/** Marker stored in `buffconfig.json` when a key lives in the vault instead of the file. */
export declare const VAULT_REF_PREFIX = "vault:";
export type VaultTier = 'keyring' | 'os-cli' | 'aes-file' | 'none';
/** Options for opening a vault (mostly test injection). */
export interface VaultOptions {
    /** Config dir override (defaults to the standard nuvira config dir). */
    configDir?: string;
    /** Force a specific tier (default: auto-detect with OS-awareness). */
    tier?: VaultTier;
    /** Tier-2 master passphrase (default: `BUFF_VAULT_PASSPHRASE` env). */
    masterPassphrase?: string;
    /** Override the detected platform (test injection; default process.platform). */
    platform?: NodeJS.Platform;
}
/** Status snapshot surfaced by `nuvira doctor` / `nuvira config vault status`. */
export interface VaultStatus {
    tier: VaultTier;
    /** Detected platform (darwin / win32 / linux / ...). */
    platform: NodeJS.Platform;
    /** Human-readable label of the ACTIVE backend, e.g. 'macOS Keychain (keyring)'. */
    backend: string;
    /** Whether the OS keyring binding loaded AND its store is reachable. */
    keyringAvailable: boolean;
    /** Number of entries currently held (Tier 2 only; native stores can't enumerate cheaply). */
    fileEntryCount: number;
}
/** Result of a vault write — lets callers detect silent key loss (see setPassword). */
export interface VaultWriteResult {
    /** True when the secret was actually persisted somewhere. */
    ok: boolean;
    /** Human-readable reason when ok is false. */
    reason?: string;
}
/**
 * A single credential backend. `kind` identifies the tier; `label` is the
 * human-readable OS store name surfaced in doctor/status.
 */
interface VaultBackend {
    readonly kind: 'keyring' | 'os-cli' | 'aes-file';
    readonly label: string;
    /** Whether writes are permitted (false → e.g. undecryptable AES file). */
    writable(): boolean;
    get(account: string): Promise<string | null>;
    /** Sync twin for ConfigManager read-time ref resolution. */
    getSync(account: string): string | null;
    set(account: string, value: string): Promise<boolean>;
    delete(account: string): Promise<boolean>;
}
/**
 * REACHABILITY PROBE — the binding can load while its OS store is dead
 * (headless Linux with no Secret Service daemon). One non-destructive sync
 * read of a non-existent account: the OS store answers `null` when healthy and
 * THROWS when unreachable. Returns true only when the store actually answers.
 * MEMOIZED: the OS store state cannot change mid-process, and this runs on
 * every Vault.open (every ConfigManager construction) — probing once is enough
 * and avoids repeated dbus/keychain round-trips on headless hosts.
 */
export declare function probeKeyringReachable(): boolean;
export type WindowsCredOp = 'get' | 'set' | 'delete';
/**
 * Build the PowerShell Credential Manager script for one operation. PURE and
 * exported so the generated script can be golden-snapshot tested on any
 * platform (the P/Invoke round-trip itself needs a Windows runner, but script
 * generation regressions are caught everywhere).
 *
 * - CRED_TYPE_GENERIC = 1, CRED_PERSIST_LOCAL_MACHINE = 2.
 * - Target name `<service>/<account>` matches cmdkey-visible generic creds.
 * - The secret is stored/read as a UTF-16 (Unicode) blob on both sides.
 * - For `set`, the value arrives via the `BUFF_VAULT_VALUE` env var as base64
 *   (kept out of argv/ps). `target`/`account` are JSON-embedded (quote-safe).
 */
export declare function buildWindowsCredScript(operation: WindowsCredOp, target: string, account: string): string;
/**
 * Build the OS-native CLI backend for a platform (pure, testable). Returns
 * null on unsupported platforms (or when the OS tool is absent — the backend
 * reports availability lazily via writable()/get()).
 */
export declare function createOsCliBackend(platform: NodeJS.Platform): VaultBackend | null;
/**
 * The secret vault. `getPassword` / `setPassword` / `deletePassword` are the
 * whole public surface — backend selection is internal and OS-aware.
 */
export declare class Vault {
    private readonly configDir;
    private readonly platform;
    /** Whether the OS keyring binding loaded AND its store answered the probe. */
    private readonly keyringReachable;
    /** Ordered candidate backends, best-first (keyring → os-cli → aes-file). */
    private readonly candidates;
    /** The ACTIVE backend — the first usable candidate (or the forced one). */
    private readonly active;
    private constructor();
    /** Wrap the loaded keyring shim as a backend (async ops + sync Entry reads). */
    private keytarBackend;
    /**
     * Open the vault. OS-aware tier selection: keyring (binding + reachable OS
     * store) → OS-native CLI (security / secret-tool / Credential Manager) →
     * AES file (requires BUFF_VAULT_PASSPHRASE) → none.
     */
    static open(opts?: VaultOptions): Vault;
    /** The active tier — surfaced by `nuvira doctor` and `nuvira config vault status`. */
    get activeTier(): VaultTier;
    /** Status snapshot for CLI/dashboard surfacing (never reveals secret values). */
    status(): VaultStatus;
    /**
     * Read a secret. FALLS THROUGH the candidate stack (keyring → os-cli →
     * aes-file) and returns the FIRST non-null value — symmetric with
     * setPassword, which also writes to the first backend that accepts. This
     * guarantees round-trip consistency in the degraded-store case: if a keyring
     * write failed and the value landed in the os-cli/aes fallback, a subsequent
     * read still finds it instead of returning null from the dead first backend.
     */
    getPassword(account: string): Promise<string | null>;
    /**
     * SYNCHRONOUS read — powers ConfigManager's read-time ref resolution (every
     * runtime command constructs its OWN fresh ConfigManager, so refs must
     * resolve at the moment a key is read, not only at CLI boot). Never throws.
     * Falls through candidates like the async twin.
     */
    getPasswordSync(account: string): string | null;
    /**
     * Store a secret. Writes to the ACTIVE backend; when that backend refuses,
     * falls through the candidate stack (e.g. keyring write failed → os-cli →
     * aes-file) so a transient store failure never silently loses the key.
     * Returns `{ ok: false, reason }` only when EVERY backend refused — so
     * migration callers can detect silent key loss instead of writing a ref that
     * points at nothing.
     */
    setPassword(account: string, value: string): Promise<VaultWriteResult>;
    /** Delete a secret. Returns true when an entry was removed. */
    deletePassword(account: string): Promise<boolean>;
    /**
     * Resolve a config value that may be a vault reference (`vault:<account>`) into
     * the real secret. Non-ref values pass through untouched.
     */
    resolveRef(value: string | undefined): Promise<string | undefined>;
    /** Sync twin of `resolveRef` — for ConfigManager's read-time resolution. */
    resolveRefSync(value: string | undefined): string | undefined;
    /** Build the vault-ref string for an account (`vault:<account>`). */
    static refFor(account: string): string;
    /** Convenience account name for a provider key: `<provider>.apiKey` or `<provider>.apiKeys.<i>`. */
    static accountFor(provider: string, slot: 'apiKey' | 'apiKeys', index?: number): string;
}
/** True when a stored provider key value is a vault reference. */
export declare function isVaultRef(value: string | undefined | null): boolean;
export {};
//# sourceMappingURL=vault.d.ts.map