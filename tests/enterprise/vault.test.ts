import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Vault,
  isVaultRef,
  VAULT_REF_PREFIX,
  VAULT_SERVICE,
  VaultTier,
  probeKeyringReachable,
  createOsCliBackend,
  buildWindowsCredScript,
} from '../../src/enterprise/vault.js';
import { ConfigManager } from '../../src/config/manager.js';
import { CATALOG_ENV_VARS } from '../../src/inference/provider-catalog.js';

/**
 * Isolate the config manager from the developer's real environment: shell
 * env vars AND the real ~/.buff/.env (which may hold real keys after the
 * M7.4 secrets migration). BUFF_ENV_FILE is pointed at a nonexistent path so
 * loadEnv() finds nothing.
 */
function isolateEnvVars(testDir: string): void {
  for (const envVar of Object.values(CATALOG_ENV_VARS)) {
    if (envVar) delete process.env[envVar];
  }
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.BUFF_CONFIG_DIR;
  delete process.env.BUFF_ENV_FILE;
  process.env.BUFF_ENV_FILE = join(testDir, 'home-env-does-not-exist.env');
}

describe('Vault (Phase A1)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'buff-vault-test-'));
    delete process.env.BUFF_VAULT_PASSPHRASE;
    isolateEnvVars(testDir);
  });

  afterEach(() => {
    delete process.env.BUFF_VAULT_PASSPHRASE;
    delete process.env.BUFF_CONFIG_DIR;
    delete process.env.BUFF_ENV_FILE;
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Tier selection', () => {
    it('forced aes-file tier is usable with an injected passphrase', () => {
      const vault = Vault.open({ configDir: testDir, tier: 'aes-file', masterPassphrase: 'test-pass' });
      expect(vault.activeTier).toBe('aes-file');
    });

    it('falls back to none when aes-file is forced without a passphrase', () => {
      const vault = Vault.open({ configDir: testDir, tier: 'aes-file' });
      expect(vault.activeTier).toBe('none');
    });

    it('exposes a status snapshot', () => {
      const vault = Vault.open({ configDir: testDir, tier: 'aes-file', masterPassphrase: 'p' });
      const st = vault.status();
      expect(st.tier).toBe('aes-file');
      expect(typeof st.keyringAvailable).toBe('boolean');
      expect(st.fileEntryCount).toBe(0);
    });
  });

  describe('AES-file tier round-trip', () => {
    it('set → get → delete survives a fresh open (stable salt/derivation)', async () => {
      // First vault instance writes.
      const v1 = Vault.open({ configDir: testDir, tier: 'aes-file', masterPassphrase: 'pass-1' });
      await v1.setPassword('groq.apiKey', 'gsk_secret-123');
      await v1.setPassword('gemini.apiKey', 'AIza-long-gemini-key');

      // A brand-new instance (simulates a new process) reads the same file.
      const v2 = Vault.open({ configDir: testDir, tier: 'aes-file', masterPassphrase: 'pass-1' });
      expect(await v2.getPassword('groq.apiKey')).toBe('gsk_secret-123');
      expect(await v2.getPassword('gemini.apiKey')).toBe('AIza-long-gemini-key');

      expect(await v2.deletePassword('groq.apiKey')).toBe(true);
      expect(await v2.getPassword('groq.apiKey')).toBeNull();

      // The encrypted file exists and is 0600-shaped (exists check only — perms
      // may vary on some CI filesystems).
      const encPath = join(testDir, 'vault.enc');
      expect(existsSync(encPath)).toBe(true);
      // The file must NOT contain the plaintext secret.
      const raw = readFileSync(encPath, 'utf-8');
      expect(raw).not.toContain('gsk_secret-123');
      expect(raw).not.toContain('AIza-long-gemini-key');
    });

    it('missing entries return null', async () => {
      const vault = Vault.open({ configDir: testDir, tier: 'aes-file', masterPassphrase: 'p' });
      expect(await vault.getPassword('nope')).toBeNull();
    });

    it('a different passphrase cannot decrypt the same file (no crash) and refuses writes', async () => {
      const v1 = Vault.open({ configDir: testDir, tier: 'aes-file', masterPassphrase: 'right' });
      await v1.setPassword('k', 'secret-value');
      // Wrong passphrase: GCM auth-tag fails → reads return null, never crashes.
      const v2 = Vault.open({ configDir: testDir, tier: 'aes-file', masterPassphrase: 'wrong' });
      expect(await v2.getPassword('k')).toBeNull();
      // And a write is REFUSED so the original encrypted data is never destroyed.
      const write = await v2.setPassword('k2', 'new-secret');
      expect(write.ok).toBe(false);
      // The original secret is still readable with the right passphrase.
      const v3 = Vault.open({ configDir: testDir, tier: 'aes-file', masterPassphrase: 'right' });
      expect(await v3.getPassword('k')).toBe('secret-value');
    });

    it('forced none stays none even when a passphrase is present', () => {
      process.env.BUFF_VAULT_PASSPHRASE = 'env-passphrase-should-be-ignored';
      const vault = Vault.open({ configDir: testDir, tier: 'none' });
      expect(vault.activeTier).toBe('none');
      expect(vault.status().tier).toBe('none');
    });
  });

  describe('vault ref helpers', () => {
    it('isVaultRef matches only vault: prefixed values', () => {
      expect(isVaultRef('vault:groq.apiKey')).toBe(true);
      expect(isVaultRef('gsk_real-key')).toBe(false);
      expect(isVaultRef(undefined)).toBe(false);
      expect(isVaultRef(null)).toBe(false);
    });

    it('refFor / accountFor compose correctly', () => {
      expect(Vault.refFor('groq.apiKey')).toBe(`${VAULT_REF_PREFIX}groq.apiKey`);
      expect(Vault.accountFor('groq', 'apiKey')).toBe('groq.apiKey');
      expect(Vault.accountFor('groq', 'apiKeys', 2)).toBe('groq.apiKeys.2');
    });

    it('resolveRef returns real secrets for refs and passes values through', async () => {
      const vault = Vault.open({ configDir: testDir, tier: 'aes-file', masterPassphrase: 'p' });
      await vault.setPassword('groq.apiKey', 'gsk_real');
      expect(await vault.resolveRef(`${VAULT_REF_PREFIX}groq.apiKey`)).toBe('gsk_real');
      expect(await vault.resolveRef('gsk_plaintext')).toBe('gsk_plaintext');
      expect(await vault.resolveRef(undefined)).toBeUndefined();
    });
  });

  describe('ConfigManager integration', () => {
    it('migrateKeysToVault moves plaintext keys to refs and hydrateVaultRefs restores them', async () => {
      const configDir = join(testDir, 'cfg');
      const cm = new ConfigManager(configDir);
      cm.save({
        providers: {
          groq: { model: 'default', apiKey: 'gsk_plaintext-123' },
          gemini: { model: 'default', apiKey: 'AIza-long-key', apiKeys: ['AIza-rot-1', 'AIza-rot-2'] },
        },
      });

      const vault = Vault.open({ configDir, tier: 'aes-file', masterPassphrase: 'migrate-pass' });
      cm.attachVault(vault);
      const result = await cm.migrateKeysToVault();

      expect(result.migrated).toBe(4); // groq.apiKey + gemini.apiKey + 2 rotation keys
      expect(result.providers.sort()).toEqual(['gemini', 'groq']);

      // The config file now holds vault refs, not plaintext.
      const raw = readFileSync(join(configDir, 'buffconfig.json'), 'utf-8');
      expect(raw).not.toContain('gsk_plaintext-123');
      expect(raw).not.toContain('AIza-long-key');
      expect(raw).not.toContain('AIza-rot-1');
      expect(raw).toContain('vault:groq.apiKey');

      // hydrateVaultRefs restores real keys into the in-memory config.
      const cm2 = new ConfigManager(configDir);
      cm2.attachVault(Vault.open({ configDir, tier: 'aes-file', masterPassphrase: 'migrate-pass' }));
      const hydrated = await cm2.hydrateVaultRefs();
      expect(hydrated).toBe(4);
      const cfg = cm2.getAll();
      expect(cfg.providers.groq?.apiKey).toBe('gsk_plaintext-123');
      expect(cfg.providers.gemini?.apiKey).toBe('AIza-long-key');
      expect(cfg.providers.gemini?.apiKeys).toEqual(['AIza-rot-1', 'AIza-rot-2']);
    });

    it('hydrateVaultRefs REMOVES refs that cannot resolve (never leaves literal refs)', async () => {
      const configDir = join(testDir, 'cfg-missing');
      mkdirSync(configDir, { recursive: true });
      // Config has a vault ref but the vault was never written / can't decrypt.
      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify({
          defaultProvider: 'auto',
          providers: {
            groq: { model: 'default', apiKey: 'vault:groq.apiKey' },
            gemini: {
              model: 'default',
              apiKey: 'vault:gemini.apiKey',
              apiKeys: ['vault:gemini.apiKeys.0', 'AIza-still-plain'],
            },
          },
        }),
      );
      // Wrong passphrase → vault can't decrypt → refs must be dropped.
      const cm = new ConfigManager(configDir);
      cm.attachVault(Vault.open({ configDir, tier: 'aes-file', masterPassphrase: 'nothing-written' }));
      const hydrated = await cm.hydrateVaultRefs();
      expect(hydrated).toBe(0);
      const cfg = cm.getAll();
      // Literal refs are gone; plaintext survives; provider reads unconfigured.
      expect(cfg.providers.groq?.apiKey).toBeUndefined();
      expect(cfg.providers.gemini?.apiKey).toBeUndefined();
      expect(cfg.providers.gemini?.apiKeys).toEqual(['AIza-still-plain']);
      expect(cm.hasRequiredCredentials('groq')).toBe(false);
    });

    it('fresh ConfigManager resolves refs at read time (no explicit attach needed)', async () => {
      // Simulate the REAL runtime flow: keys were migrated to the vault, then a
      // NEW process (fresh ConfigManager, like BaseCommand/Orchestrator do)
      // reads provider config. The refs must resolve synchronously — the
      // boot-time hydration in index.ts only touches a throwaway instance, so
      // read-time resolution is the mechanism that makes vaulted keys work in
      // chat / execute / router / doctor.
      //
      // The auto-open backend must MATCH between write and read, so both go
      // through the same Vault.open({ configDir }) auto-selection (keychain on
      // dev, AES-file on CI). Unique accounts avoid clashing with any real
      // keychain entries; the config file holds refs exactly like a migration
      // leaves them.
      const configDir = join(testDir, 'cfg-runtime');
      process.env.BUFF_VAULT_PASSPHRASE = 'ci-pass'; // AES tier on keyring-less CI
      const writer = Vault.open({ configDir });
      // With the passphrase set, the tier is always keyring or aes-file — never
      // 'none' — so the resolution contract is always exercised.
      expect(writer.status().tier).not.toBe('none');
      const ACC = 'runtime-test-groq';
      await writer.setPassword(ACC, 'gsk_vaulted-secret');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify({
          defaultProvider: 'auto',
          providers: { groq: { model: 'default', apiKey: `vault:${ACC}` } },
        }),
      );

      // A brand-new ConfigManager WITHOUT attachVault/hydrateVaultRefs — the
      // runtime scenario. The constructor auto-opens the vault itself.
      const cm2 = new ConfigManager(configDir);
      expect(cm2.getProviderConfig('groq').config.apiKey).toBe('gsk_vaulted-secret');
      expect(cm2.hasRequiredCredentials('groq')).toBe(true);
      // The FILE still holds refs — a later save() never writes plaintext back.
      const raw = readFileSync(join(configDir, 'buffconfig.json'), 'utf-8');
      expect(raw).toContain(`vault:${ACC}`);
      expect(raw).not.toContain('gsk_vaulted-secret');
      // Cleanup the keychain entry (AES tier is temp-dir scoped; no-op there).
      await writer.deletePassword(ACC);
    });

    it('save() after a resolved read still writes vault refs, never resolved plaintext', async () => {
      // THE clone guarantee: getProviderConfig resolves refs on a copy — so a
      // subsequent save() (e.g. `buff config set routing.bandit true` mid-run)
      // must persist `vault:` refs, NOT the resolved secret it once saw.
      const configDir = join(testDir, 'cfg-writeback');
      process.env.BUFF_VAULT_PASSPHRASE = 'wb-pass';
      const writer = Vault.open({ configDir });
      const ACC = 'writeback-test-groq';
      await writer.setPassword(ACC, 'gsk_should-never-hit-disk');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify({
          defaultProvider: 'auto',
          providers: { groq: { model: 'default', apiKey: `vault:${ACC}` } },
        }),
      );

      const cm = new ConfigManager(configDir);
      expect(cm.getProviderConfig('groq').config.apiKey).toBe('gsk_should-never-hit-disk');
      // Any save — even one that does not touch the provider — must not leak.
      cm.save({ defaultProvider: 'groq' });
      const raw = readFileSync(join(configDir, 'buffconfig.json'), 'utf-8');
      expect(raw).toContain(`vault:${ACC}`);
      expect(raw).not.toContain('gsk_should-never-hit-disk');
      await writer.deletePassword(ACC);
    });

    it('fresh ConfigManager: unresolved ref reads as not-configured (never a literal ref)', async () => {
      // The vault entry is MISSING (key deleted from the keychain / wrong
      // passphrase on the AES tier / never migrated). A fresh ConfigManager
      // must treat the provider as UNCONFIGURED — the ref must never leak to
      // an adapter as a literal API key.
      const configDir = join(testDir, 'cfg-deadref');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify({
          defaultProvider: 'auto',
          providers: { groq: { model: 'default', apiKey: 'vault:never-written-account' } },
        }),
      );

      const cm2 = new ConfigManager(configDir);
      expect(cm2.hasRequiredCredentials('groq')).toBe(false);
      // getProviderConfig must NOT return a literal 'vault:...' as the key.
      const cfg = cm2.getProviderConfig('groq').config;
      expect(cfg.apiKey).toBeUndefined();
    });

    it('migrateKeysToVault throws when no vault is attached', async () => {
      // The constructor auto-attaches a vault, so detach it explicitly to
      // exercise the null-vault guard.
      const cm = new ConfigManager(join(testDir, 'cfg-novault'));
      cm.attachVault(null);
      await expect(cm.migrateKeysToVault()).rejects.toThrow(/No vault attached/);
    });

    it('migrateKeysToVault throws when the vault tier is none', async () => {
      const cm = new ConfigManager(join(testDir, 'cfg-none'));
      cm.save({ providers: { groq: { model: 'default', apiKey: 'gsk_x' } } });
      // Force an unusable vault (no keyring on CI, no passphrase).
      const vault = Vault.open({ configDir: join(testDir, 'cfg-none'), tier: 'none' });
      cm.attachVault(vault);
      await expect(cm.migrateKeysToVault()).rejects.toThrow(/Vault unavailable/);
    });

    it('clearProviderApiKey also purges the vault entry for a vault-ref key', async () => {
      const configDir = join(testDir, 'cfg-clear');
      const cm = new ConfigManager(configDir);
      const vault = Vault.open({ configDir, tier: 'aes-file', masterPassphrase: 'p' });
      await vault.setPassword('groq.apiKey', 'gsk_dead-key');
      cm.attachVault(vault);
      cm.save({ providers: { groq: { model: 'default', apiKey: 'vault:groq.apiKey' } } });

      const result = cm.clearProviderApiKey('groq');
      expect(result.cleared).toBe(true);
      // The vault entry is gone too.
      expect(await vault.getPassword('groq.apiKey')).toBeNull();
      const raw = readFileSync(join(configDir, 'buffconfig.json'), 'utf-8');
      expect(raw).not.toContain('vault:groq.apiKey');
    });
  });

  describe('keyring tier (skipped gracefully when unavailable)', () => {
    it('auto-open never throws and reports a valid tier + platform backend', () => {
      // On developer Macs this resolves to 'keyring'; on CI without the native
      // module it degrades to 'os-cli' / 'none' (or aes-file with env passphrase).
      // Either is a valid outcome — the contract is: never throw, never expose
      // secrets, and always report WHICH OS store is in use.
      const vault = Vault.open({ configDir: testDir });
      const st = vault.status();
      expect(['keyring', 'os-cli', 'aes-file', 'none']).toContain<VaultTier>(st.tier);
      expect(st.platform).toBe(process.platform);
      expect(st.backend.length).toBeGreaterThan(0);
      expect(VAULT_SERVICE.length).toBeGreaterThan(0);
    });
  });

  describe('OS-aware backend selection (platform-independent)', () => {
    it('probeKeyringReachable never throws', () => {
      // The probe is a non-destructive sync read; it must never throw on any
      // platform — it returns boolean.
      expect(typeof probeKeyringReachable()).toBe('boolean');
    });

    it('createOsCliBackend maps every platform to its native OS tool', () => {
      const darwin = createOsCliBackend('darwin');
      expect(darwin?.label).toContain('security');

      const linux = createOsCliBackend('linux');
      expect(linux?.label).toContain('secret-tool');

      const win32 = createOsCliBackend('win32');
      expect(win32?.label).toContain('Credential Manager');

      // Unsupported platforms get no OS-CLI backend (AES fallback covers them).
      expect(createOsCliBackend('freebsd')).toBeNull();
      expect(createOsCliBackend('sunos')).toBeNull();
    });

    it('forced os-cli tier is deterministic via the platform override', () => {
      // The platform override makes the tier selection testable on ANY machine
      // without depending on which OS the test runner is on.
      const mac = Vault.open({ configDir: testDir, tier: 'os-cli', platform: 'darwin' });
      const macSt = mac.status();
      expect(macSt.platform).toBe('darwin');
      // security exists on macOS (and 'security' was verified at /usr/bin/security
      // on dev machines) — but in a docker/CI mac-less run the binary check may
      // fail, so accept os-cli OR the graceful none degrade.
      expect(['os-cli', 'none']).toContain(macSt.tier);
      if (macSt.tier === 'os-cli') expect(macSt.backend).toContain('security');

      // Forced os-cli on an unsupported platform has no OS-CLI backend → none.
      const freebsd = Vault.open({ configDir: testDir, tier: 'os-cli', platform: 'freebsd' });
      expect(freebsd.status().tier).toBe('none');
    });

    it('getPassword falls through the candidate stack (symmetric with setPassword)', async () => {
      // Contract: a secret written by ANY backend must be readable — the read
      // path walks keyring → os-cli → aes-file, not just the active tier.
      // Here we prove os-cli reads work on macOS (security CLI live); on other
      // platforms the os-cli backend is absent so this degrades to the existing
      // aes round-trip tests. The fall-through itself is exercised by the
      // degraded-store logic in getPassword (returns first non-null).
      if (process.platform === 'darwin') {
        const vault = Vault.open({ configDir: testDir, tier: 'os-cli', platform: 'darwin' });
        expect(vault.status().tier).toBe('os-cli');
        await vault.setPassword('fallthrough-acc', 'secret-via-security-cli');
        // The write landed in os-cli; read must find it through the stack.
        expect(await vault.getPassword('fallthrough-acc')).toBe('secret-via-security-cli');
        expect(vault.getPasswordSync('fallthrough-acc')).toBe('secret-via-security-cli');
        await vault.deletePassword('fallthrough-acc');
      }
      // Missing entries still read null through the whole stack.
      const v2 = Vault.open({ configDir: testDir, tier: 'os-cli', platform: 'darwin' });
      expect(await v2.getPassword('never-written')).toBeNull();
    });

    it('buildWindowsCredScript emits a correct, quote-safe Credential Manager script', () => {
      const target = `${VAULT_SERVICE}/groq.apiKey`;
      const get = buildWindowsCredScript('get', target, 'groq.apiKey');
      // P/Invoke + constants: CRED_TYPE_GENERIC=1, CRED_PERSIST_LOCAL_MACHINE=2.
      expect(get).toContain('CredRead(string target, int type, int flags');
      expect(get).toContain(`CredRead(${JSON.stringify(target)}, 1, 0`);
      expect(get).toContain('CREDENTIAL');
      expect(get).toContain('CharSet = CharSet.Unicode');
      // Secret encoded/decoded as UTF-16 on both sides.
      expect(get).toContain('[System.Text.Encoding]::Unicode.GetString($blob)');

      const set = buildWindowsCredScript('set', target, 'groq.apiKey');
      expect(set).toContain('CredWrite([ref]$cred, 0)');
      expect(set).toContain('$cred.Type = 1');
      expect(set).toContain('$cred.Persist = 2');
      // The secret travels via env base64 — never in argv.
      expect(set).toContain('$env:BUFF_VAULT_VALUE');
      expect(set).toContain('[System.Text.Encoding]::Unicode.GetBytes($value)');
      expect(set).not.toContain('gsk_some-secret');

      const del = buildWindowsCredScript('delete', target, 'groq.apiKey');
      expect(del).toContain('CredDelete');

      // Quote-safety: an account with quotes must be JSON-escaped, not injected.
      // The injected 'exit 1' must live INSIDE the JSON string literal (as the
      // escaped \" form) — a real injection would terminate the string and
      // emit a second standalone `exit 1` statement (the script's only other
      // 'exit 1' is the legitimate CredRead-failure branch).
      const evilTarget = `${VAULT_SERVICE}/"; exit 1; "`;
      const evil = buildWindowsCredScript('get', evilTarget, '"');
      expect(evil).toContain(JSON.stringify(evilTarget)); // target JSON-escaped
      const escapedInLiteral = evil.split('\\"; exit 1').length - 1; // inside the quoted literal
      expect(escapedInLiteral).toBe(1);
      const rawStatement = evil.split('\n""; exit 1;').length - 1; // a broken-out statement
      expect(rawStatement).toBe(0);
    });

    it('forced aes-file still reports whether the OS keyring is reachable', () => {
      const vault = Vault.open({ configDir: testDir, tier: 'aes-file', masterPassphrase: 'p' });
      const st = vault.status();
      expect(st.tier).toBe('aes-file');
      // keyringAvailable reflects the OS store state, not the forced tier.
      expect(typeof st.keyringAvailable).toBe('boolean');
    });

    it('forced keyring degrades gracefully to none when the OS store is unreachable', () => {
      // Force keyring even though the probe may fail on headless CI. The vault
      // must never throw — it reports whatever tier actually became active.
      const vault = Vault.open({ configDir: testDir, tier: 'keyring' });
      const st = vault.status();
      expect(['keyring', 'none']).toContain(st.tier);
      expect(st.keyringAvailable).toBe(st.tier === 'keyring');
    });
  });
});
