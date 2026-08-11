/**
 * vault.ts — Secret Vault (revamp Phase A1). OS-aware, platform-independent.
 *
 * The vault is a STACK of OS-native credential backends selected at open time
 * (mirrors Hermes `agent/credential_persistence.py` / `credential_sources/`
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
 *   Tier 2   — AES-256-GCM encrypted file (`~/.buff/vault.enc`, 0600) as the
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
 *   callers use — backend selection is internal (Hermes `CredentialSource`
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
 * - `buff config migrate-keys` moves plaintext keys from `buffconfig.json`.
 * - `buff doctor` reports the active vault tier + platform backend.
 *
 * @see AGENT_NUVIRA_MAJOR_REVAMP_PLAN.md — Phase A1 (Implementation reference:
 *      Hermes `credential_persistence.py` + `credential_sources/`, provider-
 *      swappable storage). Cross-platform requirement: the agent must run
 *      identically on macOS / Windows / Linux / containers.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { resolveBuffConfigDir } from '../config/paths.js';
import { recordVaultAccess } from './vault-audit.js';

/** CJS require, available in ESM (the package is CJS). */
const require = createRequire(import.meta.url);

// ─── Constants ─────────────────────────────────────────────────────────────

/** Service name used for all credential entries (namespace, mirrors keytar conventions). */
export const VAULT_SERVICE = 'agent-nuvira';

/** Env var that supplies the Tier-2 master passphrase (no file needed when set). */
export const VAULT_PASSPHRASE_ENV = 'BUFF_VAULT_PASSPHRASE';

/** Tier-2 encrypted vault file name (inside the buff config dir). */
const VAULT_FILE = 'vault.enc';

/** Salt length for scrypt key derivation (Tier 2). */
const SCRYPT_SALT_LEN = 16;
/** IV length for AES-256-GCM. */
const GCM_IV_LEN = 12;
/** Derived key length for AES-256-GCM. */
const KEY_LEN = 32;

/** Marker stored in `buffconfig.json` when a key lives in the vault instead of the file. */
export const VAULT_REF_PREFIX = 'vault:';

// ─── Types ─────────────────────────────────────────────────────────────────

export type VaultTier = 'keyring' | 'os-cli' | 'aes-file' | 'none';

/** Options for opening a vault (mostly test injection). */
export interface VaultOptions {
  /** Config dir override (defaults to the standard buff config dir). */
  configDir?: string;
  /** Force a specific tier (default: auto-detect with OS-awareness). */
  tier?: VaultTier;
  /** Tier-2 master passphrase (default: `BUFF_VAULT_PASSPHRASE` env). */
  masterPassphrase?: string;
  /** Override the detected platform (test injection; default process.platform). */
  platform?: NodeJS.Platform;
}

/** Status snapshot surfaced by `buff doctor` / `buff config vault status`. */
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

// ─── Backend interface ─────────────────────────────────────────────────────

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

// ─── Dynamic keyring import (graceful when native module missing) ──────────

/**
 * The keytar-compatible async shim exported by @napi-rs/keyring.
 * @see https://www.npmjs.com/package/@napi-rs/keyring
 */
interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials?(service: string): Promise<Array<{ account: string; password: string }>>;
}

let cachedKeytar: KeytarLike | null | undefined;
/**
 * Load the keytar-compatible shim once. Returns null (never throws) when the
 * native module can't load — the caller falls through to the OS CLI tier.
 */
function loadKeytar(): KeytarLike | null {
  if (cachedKeytar !== undefined) return cachedKeytar;
  try {
    // Dynamic require (ESM-safe via createRequire): the package is CJS; we
    // only touch it when needed and never fail hard when the native binding
    // is missing.
    const mod = require('@napi-rs/keyring/keytar.js') as KeytarLike;
    cachedKeytar =
      mod && typeof mod.getPassword === 'function' && typeof mod.setPassword === 'function'
        ? mod
        : null;
  } catch {
    cachedKeytar = null;
  }
  return cachedKeytar;
}

/**
 * The synchronous `Entry` class exposed by @napi-rs/keyring (`new Entry(service,
 * account)` with sync `getPassword`/`setPassword`/`deletePassword`). Used for
 * the keyring REACHABILITY PROBE (non-destructive sync read at open) and for
 * ConfigManager's sync read-time ref resolution.
 */
interface SyncEntryLike {
  getPassword(): string | undefined;
}
interface SyncEntryCtor {
  new (service: string, account: string): SyncEntryLike;
}
let cachedEntryCtor: SyncEntryCtor | null | undefined;
function loadEntryCtor(): SyncEntryCtor | null {
  if (cachedEntryCtor !== undefined) return cachedEntryCtor;
  try {
    const mod = require('@napi-rs/keyring') as { Entry?: unknown };
    cachedEntryCtor =
      typeof mod?.Entry === 'function' ? (mod.Entry as SyncEntryCtor) : null;
  } catch {
    cachedEntryCtor = null;
  }
  return cachedEntryCtor;
}

let cachedProbeResult: boolean | undefined;
/**
 * REACHABILITY PROBE — the binding can load while its OS store is dead
 * (headless Linux with no Secret Service daemon). One non-destructive sync
 * read of a non-existent account: the OS store answers `null` when healthy and
 * THROWS when unreachable. Returns true only when the store actually answers.
 * MEMOIZED: the OS store state cannot change mid-process, and this runs on
 * every Vault.open (every ConfigManager construction) — probing once is enough
 * and avoids repeated dbus/keychain round-trips on headless hosts.
 */
export function probeKeyringReachable(): boolean {
  if (cachedProbeResult !== undefined) return cachedProbeResult;
  const ctor = loadEntryCtor();
  if (!ctor) {
    cachedProbeResult = false;
    return false;
  }
  try {
    const entry = new ctor(VAULT_SERVICE, '__agent_nuvira_probe__');
    entry.getPassword();
    cachedProbeResult = true;
    return true;
  } catch {
    cachedProbeResult = false;
    return false;
  }
}

// ─── Tier 1b: OS-native CLI backends ───────────────────────────────────────

/**
 * True when an executable exists on PATH (never throws). MEMOIZED — OS tool
 * presence cannot change mid-process, and this runs on every Vault.open (which
 * every ConfigManager construction triggers), so spawning `which`/`where` once
 * per tool per process is enough.
 */
const binaryOnPathCache = new Map<string, boolean>();
function binaryOnPath(name: string): boolean {
  const cached = binaryOnPathCache.get(name);
  if (cached !== undefined) return cached;
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    binaryOnPathCache.set(name, true);
    return true;
  } catch {
    binaryOnPathCache.set(name, false);
    return false;
  }
}

/**
 * macOS `security` CLI backend — the same Keychain the keyring binding uses,
 * via /usr/bin/security. Label: 'macOS Keychain (security)'.
 */
class SecurityCliBackend implements VaultBackend {
  readonly kind = 'os-cli' as const;
  readonly label = 'macOS Keychain (security)';
  private readonly available: boolean;

  constructor(platform: NodeJS.Platform) {
    // Only present (and only sane) on macOS.
    this.available = platform === 'darwin' && binaryOnPath('security');
  }

  writable(): boolean {
    return this.available;
  }

  private rawGet(account: string): string | null {
    if (!this.available) return null;
    try {
      const out = execFileSync(
        'security',
        ['find-generic-password', '-s', VAULT_SERVICE, '-a', account, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      // Strip ONLY the trailing newline — a secret with real leading/trailing
      // whitespace must survive intact.
      return out.replace(/\r?\n$/, '') || null;
    } catch {
      return null; // item not found (errSecItemNotFound) → null, like keytar
    }
  }

  async get(account: string): Promise<string | null> {
    return this.rawGet(account);
  }

  getSync(account: string): string | null {
    return this.rawGet(account);
  }

  // NOTE: `security add-generic-password -w <value>` places the secret in argv
  // (visible in `ps` for a moment). Acceptable for a fallback tier — the
  // keyring binding (preferred) and secret-tool (stdin) never do this.

  async set(account: string, value: string): Promise<boolean> {
    if (!this.available) return false;
    try {
      execFileSync(
        'security',
        ['add-generic-password', '-U', '-s', VAULT_SERVICE, '-a', account, '-w', value],
        { stdio: 'ignore' },
      );
      return true;
    } catch {
      return false;
    }
  }

  async delete(account: string): Promise<boolean> {
    if (!this.available) return false;
    try {
      execFileSync('security', ['delete-generic-password', '-s', VAULT_SERVICE, '-a', account], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Linux `secret-tool` backend — the Secret Service (libsecret) store, same one
 * the keyring binding targets, via the standard CLI. Label:
 * 'Linux Secret Service (secret-tool)'. `secret-tool` reads the value from
 * stdin on store.
 */
class SecretToolBackend implements VaultBackend {
  readonly kind = 'os-cli' as const;
  readonly label = 'Linux Secret Service (secret-tool)';
  private readonly available: boolean;

  constructor(platform: NodeJS.Platform) {
    this.available = platform === 'linux' && binaryOnPath('secret-tool');
  }

  writable(): boolean {
    return this.available;
  }

  private rawGet(account: string): string | null {
    // execFileSync can't feed stdin, but lookup needs none — value comes on stdout.
    const out = execFileSync(
      'secret-tool',
      ['lookup', 'service', VAULT_SERVICE, 'account', account],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    // Strip ONLY the trailing newline (secret-tool prints the value + newline).
    const clean = out.replace(/\r?\n$/, '');
    return clean.length > 0 ? clean : null;
  }

  async get(account: string): Promise<string | null> {
    if (!this.available) return null;
    try {
      return await this.rawGet(account);
    } catch {
      return null;
    }
  }

  getSync(account: string): string | null {
    if (!this.available) return null;
    try {
      return this.rawGet(account);
    } catch {
      return null;
    }
  }

  async set(account: string, value: string): Promise<boolean> {
    if (!this.available) return false;
    try {
      // secret-tool reads the value from STDIN (it refuses a value arg) — the
      // secret never appears in argv/ps. execFileSync's `input` feeds stdin
      // without a shell, so the value is never shell-interpreted (injection-
      // safe for any key content).
      execFileSync(
        'secret-tool',
        ['store', '--label', `${VAULT_SERVICE} ${account}`, 'service', VAULT_SERVICE, 'account', account],
        { input: value, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] },
      );
      return true;
    } catch {
      return false;
    }
  }

  async delete(account: string): Promise<boolean> {
    if (!this.available) return false;
    try {
      execFileSync('secret-tool', ['clear', 'service', VAULT_SERVICE, 'account', account], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }
}

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
export function buildWindowsCredScript(
  operation: WindowsCredOp,
  target: string,
  account: string,
): string {
  const addType = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class NuviraCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public int Type;
    [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] public string TargetName;
    [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] public string TargetAlias;
    [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite([In] ref CREDENTIAL cred, uint flags);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr buffer);
}
"@
`;
  const targetLit = JSON.stringify(target);
  const accountLit = JSON.stringify(account);

  const getBody = `
$ptr = [IntPtr]::Zero
if ([NuviraCred]::CredRead(${targetLit}, 1, 0, [ref]$ptr)) {
  $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][NuviraCred+CREDENTIAL])
  $size = [int]$cred.CredentialBlobSize
  if ($size -gt 0) {
    $blob = New-Object byte[] $size
    [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $blob, 0, $size)
    [System.Text.Encoding]::Unicode.GetString($blob)
  }
  [NuviraCred]::CredFree($ptr) | Out-Null
} else {
  exit 1
}
`;
  const setBody = `
$value = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:BUFF_VAULT_VALUE))
$bytes = [System.Text.Encoding]::Unicode.GetBytes($value)
$cred = New-Object NuviraCred+CREDENTIAL
$cred.Type = 1
$cred.TargetName = ${targetLit}
$cred.UserName = ${accountLit}
$cred.CredentialBlobSize = $bytes.Length
$cred.CredentialBlob = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $cred.CredentialBlob, $bytes.Length)
$cred.Persist = 2
# NOTE: the AllocHGlobal buffer is intentionally NOT freed — the PowerShell
# process exits right after this run, so the OS reclaims it. Do not 'fix' this.
$ok = [NuviraCred]::CredWrite([ref]$cred, 0)
if ($ok) { exit 0 } else { exit 1 }
`;
  const deleteBody = `
if ([NuviraCred]::CredDelete(${targetLit}, 1, 0)) { exit 0 } else { exit 1 }
`;
  return addType + (operation === 'get' ? getBody : operation === 'set' ? setBody : deleteBody);
}

/**
 * Windows Credential Manager backend via PowerShell P/Invoke (CredWrite /
 * CredRead / CredDelete, CRED_TYPE_GENERIC, CRED_PERSIST_LOCAL_MACHINE). The
 * target name is `<service>/<account>`, matching cmdkey-visible generic
 * credentials. PowerShell is always present on supported Windows.
 */
class WindowsCredManagerBackend implements VaultBackend {
  readonly kind = 'os-cli' as const;
  readonly label = 'Windows Credential Manager (PowerShell)';
  private readonly available: boolean;

  constructor(platform: NodeJS.Platform) {
    this.available = platform === 'win32';
  }

  writable(): boolean {
    return this.available;
  }

  /** Shared P/Invoke preamble + the given operation body. */
  private script(operation: 'get' | 'set' | 'delete', target: string, account: string): string {
    return buildWindowsCredScript(operation, target, account);
  }

  private run(operation: 'get' | 'set' | 'delete', account: string, value?: string): string | null {
    if (!this.available) return null;
    const target = `${VAULT_SERVICE}/${account}`;
    const script = this.script(operation, target, account);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (operation === 'set' && value !== undefined) {
      env.BUFF_VAULT_VALUE = Buffer.from(value, 'utf-8').toString('base64');
    }
    try {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env, windowsHide: true },
      );
      return out;
    } catch {
      return null;
    }
  }

  private cleanGetOut(out: string | null): string | null {
    if (out === null) return null;
    const clean = out.replace(/\r?\n$/, '');
    return clean.length > 0 ? clean : null;
  }

  async get(account: string): Promise<string | null> {
    if (!this.available) return null;
    return this.cleanGetOut(this.run('get', account));
  }

  getSync(account: string): string | null {
    if (!this.available) return null;
    return this.cleanGetOut(this.run('get', account));
  }

  async set(account: string, value: string): Promise<boolean> {
    if (!this.available) return false;
    return this.run('set', account, value) !== null;
  }

  async delete(account: string): Promise<boolean> {
    if (!this.available) return false;
    return this.run('delete', account) !== null;
  }
}

/**
 * Build the OS-native CLI backend for a platform (pure, testable). Returns
 * null on unsupported platforms (or when the OS tool is absent — the backend
 * reports availability lazily via writable()/get()).
 */
export function createOsCliBackend(platform: NodeJS.Platform): VaultBackend | null {
  switch (platform) {
    case 'darwin':
      return new SecurityCliBackend(platform);
    case 'linux':
      return new SecretToolBackend(platform);
    case 'win32':
      return new WindowsCredManagerBackend(platform);
    default:
      return null;
  }
}

// ─── Tier 2: AES-256-GCM encrypted file ────────────────────────────────────

/**
 * Tier-2 encrypted-file backend. File layout is a JSON envelope:
 * `{ v: 1, salt: <b64>, iv: <b64>, ct: <b64>, tag: <b64> }` where `ct` is the
 * AES-256-GCM ciphertext of the JSON-serialized account→secret map.
 *
 * Key derivation is STABLE across opens: the salt is read from the envelope on
 * load (or generated once on first create) and fed to scrypt BEFORE any decrypt.
 * GCM auth-tag makes tampered/corrupt files fail loudly.
 */
class AesFileBackend implements VaultBackend {
  readonly kind = 'aes-file' as const;
  readonly label = 'AES-256-GCM encrypted file';
  private readonly filePath: string;
  private readonly key: Buffer;
  private readonly salt: Buffer;
  private cache: Map<string, string>;
  /** True only when the existing file (if any) decrypted successfully. */
  private readonly loadedOk: boolean;

  constructor(configDir: string, masterPassphrase: string) {
    this.filePath = join(configDir, VAULT_FILE);
    let existingRaw: string | null = null;
    if (existsSync(this.filePath)) {
      existingRaw = readFileSync(this.filePath, 'utf-8');
      try {
        const env = JSON.parse(existingRaw) as { salt?: string };
        this.salt = Buffer.from(env.salt ?? '', 'base64');
      } catch {
        this.salt = randomBytes(SCRYPT_SALT_LEN);
      }
    } else {
      this.salt = randomBytes(SCRYPT_SALT_LEN);
    }
    this.key = scryptSync(masterPassphrase, this.salt, KEY_LEN);
    this.cache = new Map();
    this.loadedOk = this.load(existingRaw);
    if (existingRaw === null) this.persist();
  }

  private load(existingRaw: string | null): boolean {
    if (existingRaw === null) {
      this.cache = new Map();
      return true;
    }
    try {
      const decrypted = this.decrypt(existingRaw);
      this.cache = new Map(Object.entries(JSON.parse(decrypted) as Record<string, string>));
      return true;
    } catch {
      this.cache = new Map();
      return false;
    }
  }

  writable(): boolean {
    return this.loadedOk;
  }

  private decrypt(raw: string): string {
    const env = JSON.parse(raw) as { iv: string; ct: string; tag: string };
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(env.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(env.ct, 'base64')),
      decipher.final(),
    ]).toString('utf-8');
  }

  private persist(): void {
    const plaintext = JSON.stringify(Object.fromEntries(this.cache));
    const iv = randomBytes(GCM_IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const envelope = {
      v: 1,
      salt: this.salt.toString('base64'),
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
    } catch {
      // best-effort — the write below will surface a real error if unwritable
    }
    writeFileSync(this.filePath, JSON.stringify(envelope), { encoding: 'utf-8', mode: 0o600 });
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // best-effort — perms may be unsupported on some filesystems (e.g. Windows)
    }
  }

  async get(account: string): Promise<string | null> {
    return this.cache.get(account) ?? null;
  }

  getSync(account: string): string | null {
    return this.cache.get(account) ?? null;
  }

  async set(account: string, value: string): Promise<boolean> {
    if (!this.loadedOk) return false;
    this.cache.set(account, value);
    this.persist();
    return true;
  }

  async delete(account: string): Promise<boolean> {
    if (!this.loadedOk) return false;
    const had = this.cache.delete(account);
    if (had) this.persist();
    return had;
  }

  get size(): number {
    return this.cache.size;
  }
}

// ─── Vault ─────────────────────────────────────────────────────────────────

/**
 * The secret vault. `getPassword` / `setPassword` / `deletePassword` are the
 * whole public surface — backend selection is internal and OS-aware.
 */
export class Vault {
  private readonly configDir: string;
  private readonly platform: NodeJS.Platform;
  /** Whether the OS keyring binding loaded AND its store answered the probe. */
  private readonly keyringReachable: boolean;
  /** Ordered candidate backends, best-first (keyring → os-cli → aes-file). */
  private readonly candidates: VaultBackend[];
  /** The ACTIVE backend — the first usable candidate (or the forced one). */
  private readonly active: VaultBackend | null;

  private constructor(opts: VaultOptions) {
    this.configDir = resolveBuffConfigDir(opts.configDir);
    this.platform = opts.platform ?? process.platform;
    const forced = opts.tier;
    this.keyringReachable = loadKeytar() !== null && probeKeyringReachable();
    const osCli = createOsCliBackend(this.platform);
    const passphrase =
      opts.masterPassphrase ?? (process.env[VAULT_PASSPHRASE_ENV] ?? '').trim();

    // Candidate stack — always OS-native first, AES last resort.
    const candidates: VaultBackend[] = [];
    if (this.keyringReachable) candidates.push(this.keytarBackend());
    if (osCli && osCli.writable()) candidates.push(osCli);
    if (passphrase) candidates.push(new AesFileBackend(this.configDir, passphrase));

    // Forced tier filtering:
    //   none     → drop everything
    //   keyring  → keep only the keyring candidate (first), drop the rest
    //   os-cli   → keep only the os-cli candidate
    //   aes-file → keep only the aes candidate
    if (forced === 'none') {
      this.candidates = [];
    } else if (forced === 'keyring') {
      this.candidates = candidates.filter((c) => c.kind === 'keyring');
    } else if (forced === 'os-cli') {
      this.candidates = candidates.filter((c) => c.kind === 'os-cli');
    } else if (forced === 'aes-file') {
      this.candidates = candidates.filter((c) => c.kind === 'aes-file');
    } else {
      this.candidates = candidates;
    }
    this.active = this.candidates[0] ?? null;
  }

  /** Wrap the loaded keyring shim as a backend (async ops + sync Entry reads). */
  private keytarBackend(): VaultBackend {
    const keytar = loadKeytar()!;
    const entryCtor = loadEntryCtor();
    return {
      kind: 'keyring',
      label:
        this.platform === 'darwin'
          ? 'macOS Keychain (keyring)'
          : this.platform === 'win32'
            ? 'Windows Credential Manager (keyring)'
            : this.platform === 'linux'
              ? 'Linux Secret Service (keyring)'
              : 'OS keychain (keyring)',
      writable: () => true,
      get: async (account) => {
        try {
          return await keytar.getPassword(VAULT_SERVICE, account);
        } catch {
          return null;
        }
      },
      getSync: (account) => {
        if (!entryCtor) return null;
        try {
          return new entryCtor(VAULT_SERVICE, account).getPassword() ?? null;
        } catch {
          return null;
        }
      },
      set: async (account, value) => {
        try {
          await keytar.setPassword(VAULT_SERVICE, account, value);
          return true;
        } catch {
          return false;
        }
      },
      delete: async (account) => {
        try {
          return await keytar.deletePassword(VAULT_SERVICE, account);
        } catch {
          return false;
        }
      },
    };
  }

  /**
   * Open the vault. OS-aware tier selection: keyring (binding + reachable OS
   * store) → OS-native CLI (security / secret-tool / Credential Manager) →
   * AES file (requires BUFF_VAULT_PASSPHRASE) → none.
   */
  static open(opts: VaultOptions = {}): Vault {
    return new Vault(opts);
  }

  /** The active tier — surfaced by `buff doctor` and `buff config vault status`. */
  get activeTier(): VaultTier {
    return this.active?.kind ?? 'none';
  }

  /** Status snapshot for CLI/dashboard surfacing (never reveals secret values). */
  status(): VaultStatus {
    const aes = this.candidates.find((c) => c.kind === 'aes-file') as AesFileBackend | undefined;
    return {
      tier: this.activeTier,
      platform: this.platform,
      backend: this.active?.label ?? 'none',
      // The OS keyring store is reachable REGARDLESS of which tier is active
      // (a forced aes-file config doesn't make the keychain unreachable).
      keyringAvailable: this.keyringReachable,
      fileEntryCount: aes ? aes.size : 0,
    };
  }

  /**
   * Read a secret. FALLS THROUGH the candidate stack (keyring → os-cli →
   * aes-file) and returns the FIRST non-null value — symmetric with
   * setPassword, which also writes to the first backend that accepts. This
   * guarantees round-trip consistency in the degraded-store case: if a keyring
   * write failed and the value landed in the os-cli/aes fallback, a subsequent
   * read still finds it instead of returning null from the dead first backend.
   */
  async getPassword(account: string): Promise<string | null> {
    let value: string | null = null;
    for (const backend of this.candidates) {
      try {
        value = await backend.get(account);
        if (value !== null) break;
      } catch {
        // try the next backend
      }
    }
    // K3: audit the access (account NAME only — never the value).
    recordVaultAccess('get', account, value !== null, this.activeTier, 'async');
    return value;
  }

  /**
   * SYNCHRONOUS read — powers ConfigManager's read-time ref resolution (every
   * runtime command constructs its OWN fresh ConfigManager, so refs must
   * resolve at the moment a key is read, not only at CLI boot). Never throws.
   * Falls through candidates like the async twin.
   */
  getPasswordSync(account: string): string | null {
    let value: string | null = null;
    for (const backend of this.candidates) {
      try {
        value = backend.getSync(account);
        if (value !== null) break;
      } catch {
        // try the next backend
      }
    }
    // K3: audit the access (account NAME only — never the value).
    recordVaultAccess('get', account, value !== null, this.activeTier, 'sync');
    return value;
  }

  /**
   * Store a secret. Writes to the ACTIVE backend; when that backend refuses,
   * falls through the candidate stack (e.g. keyring write failed → os-cli →
   * aes-file) so a transient store failure never silently loses the key.
   * Returns `{ ok: false, reason }` only when EVERY backend refused — so
   * migration callers can detect silent key loss instead of writing a ref that
   * points at nothing.
   */
  async setPassword(account: string, value: string): Promise<VaultWriteResult> {
    if (this.candidates.length === 0) {
      recordVaultAccess('set', account, false, this.activeTier, 'async');
      return { ok: false, reason: 'no vault backend available (tier: none)' };
    }
    for (const backend of this.candidates) {
      if (!backend.writable()) continue;
      try {
        if (await backend.set(account, value)) {
          recordVaultAccess('set', account, true, this.activeTier, 'async');
          return { ok: true };
        }
      } catch {
        // try the next backend
      }
    }
    const result = {
      ok: false,
      reason: `all vault backends refused the write (${this.candidates.map((c) => c.label).join(', ')})`,
    };
    recordVaultAccess('set', account, false, this.activeTier, 'async');
    return result;
  }

  /** Delete a secret. Returns true when an entry was removed. */
  async deletePassword(account: string): Promise<boolean> {
    if (!this.active) {
      recordVaultAccess('delete', account, false, this.activeTier, 'async');
      return false;
    }
    try {
      const removed = await this.active.delete(account);
      recordVaultAccess('delete', account, removed, this.activeTier, 'async');
      return removed;
    } catch {
      recordVaultAccess('delete', account, false, this.activeTier, 'async');
      return false;
    }
  }

  /**
   * Resolve a config value that may be a vault reference (`vault:<account>`) into
   * the real secret. Non-ref values pass through untouched.
   */
  async resolveRef(value: string | undefined): Promise<string | undefined> {
    if (!value || !value.startsWith(VAULT_REF_PREFIX)) return value;
    const account = value.slice(VAULT_REF_PREFIX.length);
    const secret = await this.getPassword(account);
    return secret ?? undefined;
  }

  /** Sync twin of `resolveRef` — for ConfigManager's read-time resolution. */
  resolveRefSync(value: string | undefined): string | undefined {
    if (!value || !value.startsWith(VAULT_REF_PREFIX)) return value;
    const account = value.slice(VAULT_REF_PREFIX.length);
    const secret = this.getPasswordSync(account);
    return secret ?? undefined;
  }

  /** Build the vault-ref string for an account (`vault:<account>`). */
  static refFor(account: string): string {
    return `${VAULT_REF_PREFIX}${account}`;
  }

  /** Convenience account name for a provider key: `<provider>.apiKey` or `<provider>.apiKeys.<i>`. */
  static accountFor(provider: string, slot: 'apiKey' | 'apiKeys', index?: number): string {
    return index === undefined ? `${provider}.apiKey` : `${provider}.apiKeys.${index}`;
  }
}

// ─── Ref helpers for ConfigManager ─────────────────────────────────────────

/** True when a stored provider key value is a vault reference. */
export function isVaultRef(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(VAULT_REF_PREFIX);
}
