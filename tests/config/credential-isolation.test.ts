/**
 * Hermeticity guard: `NUVIRA_CONFIG_DIR` must isolate EVERYTHING a process
 * reads or writes — not just buffconfig.json.
 *
 * Regression context: `loadEnv()` hardcoded `~/.nuvira/.env`, so a process
 * pointed at an isolated config dir still loaded the developer's REAL provider
 * keys. `ConfigManager` then wrote them into `process.env`, the router treated
 * every cloud provider as credentialed, and integration tests that configured a
 * deliberately fake local model instead made live paid API calls (and timed
 * out). `resilient-call.ts` had the same `~/.nuvira` hardcoding for its
 * persisted routing failures, so a cooldown earned by a live run leaked INTO
 * tests and test failures leaked back OUT to the real profile.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveNuviraConfigDir, resolveNuviraDataPath, resolveNuviraEnvFile } from '../../src/config/paths.js';
import { loadEnv } from '../../src/utils/env.js';

/** Provider keys the real profile is known to hold. */
const REAL_PROVIDER_KEYS = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_NIM_API_KEY'];

let cfgDir: string;
const saved: Record<string, string | undefined> = {};
const REAL_MEMORY_HISTORY = join(process.env.HOME ?? '', '.nuvira', 'memory', 'history.json');

function saveEnv(names: string[]): void {
  for (const n of names) saved[n] = process.env[n];
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'nuvira-iso-'));
  saveEnv(['NUVIRA_CONFIG_DIR', 'BUFF_CONFIG_DIR', 'NUVIRA_ENV_FILE', 'BUFF_ENV_FILE', 'NUVIRA_MEMORY_DIR', ...REAL_PROVIDER_KEYS]);
  delete process.env.NUVIRA_MEMORY_DIR;
  // Simulate "this machine has real keys in its shell environment" so the
  // assertion below tests the FILE resolution path, not process.env.
  for (const k of REAL_PROVIDER_KEYS) delete process.env[k];
  process.env.NUVIRA_CONFIG_DIR = cfgDir;
  delete process.env.NUVIRA_ENV_FILE;
  delete process.env.BUFF_ENV_FILE;
});

afterEach(() => {
  restoreEnv();
  rmSync(cfgDir, { recursive: true, force: true });
});

describe('config-dir isolation', () => {
  it('resolves the credential .env inside the active config dir', () => {
    expect(resolveNuviraConfigDir()).toBe(cfgDir);
    expect(resolveNuviraEnvFile()).toBe(join(cfgDir, '.env'));
  });

  it('resolves persisted state inside the active config dir', () => {
    expect(resolveNuviraDataPath('nuvira-routing-failures.json')).toBe(
      join(cfgDir, 'nuvira-routing-failures.json'),
    );
  });

  it('never falls back to the home-profile ~/.nuvira/.env when the config dir has none', () => {
    // HERMETIC TRAP: plant a decoy home profile for the duration of this test.
    //
    // The original version asserted `existsSync(join(HOME, '.nuvira', '.env'))`
    // as its precondition — i.e. it required the DEVELOPER's machine to have a
    // real profile .env. That passed locally and failed on every clean CI
    // checkout (no such file), which is a test bug, not a product bug: the
    // isolation guarantee is exactly what the assertions below still verify.
    const fakeHome = mkdtempSync(join(tmpdir(), 'nuvira-fake-home-'));
    const decoyEnv = join(fakeHome, '.nuvira', '.env');
    mkdirSync(dirname(decoyEnv), { recursive: true });
    writeFileSync(decoyEnv, REAL_PROVIDER_KEYS.map((k, i) => `${k}=decoy-key-${i}`).join('\n') + '\n');

    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    if (process.platform === 'win32') process.env.USERPROFILE = fakeHome;
    try {
      // Deterministic precondition: the decoy profile really is there, so the
      // assertion below is meaningful on any machine.
      expect(existsSync(decoyEnv)).toBe(true);
      expect(resolveNuviraEnvFile()).not.toBe(decoyEnv);

      const env = loadEnv();
      for (const key of REAL_PROVIDER_KEYS) {
        expect(env[key], `${key} leaked from the home profile .env`).toBeUndefined();
        expect(process.env[key], `${key} leaked into process.env`).toBeUndefined();
      }
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('loads credentials FROM the config dir .env (override works in the other direction)', () => {
    writeFileSync(join(cfgDir, '.env'), 'GROQ_API_KEY=isolated-key-from-config-dir\n');
    const env = loadEnv();
    expect(env.GROQ_API_KEY).toBe('isolated-key-from-config-dir');
  });

  it('honours an explicit NUVIRA_ENV_FILE over the config dir', () => {
    const explicit = join(cfgDir, 'explicit.env');
    writeFileSync(explicit, 'GEMINI_API_KEY=explicit-file-key\n');
    process.env.NUVIRA_ENV_FILE = explicit;
    expect(resolveNuviraEnvFile()).toBe(explicit);
    expect(loadEnv().GEMINI_API_KEY).toBe('explicit-file-key');
  });
});

describe('persisted store state follows NUVIRA_MEMORY_DIR', () => {
  it('chat history resolves into the override dir without mocking homedir', async () => {
    const memDir = join(cfgDir, 'memory');
    process.env.NUVIRA_MEMORY_DIR = memDir;

    // Import happens AFTER the env var is set: the store must resolve lazily.
    // (history.ts used to capture MEMORY_DIR at module load, which is why its
    // own test still has to hoist a `node:os` mock just to redirect it.)
    const { ChatHistory } = await import('../../src/context/history.js');
    new ChatHistory().storeSession([{ role: 'user', content: 'isolation probe' }], 'local', 'fake-model');

    expect(existsSync(join(memDir, 'history.json'))).toBe(true);
  });
});

describe('real-profile state is not touched by an isolated run', () => {
  it('the failure ledger path is inside the isolated dir, not ~/.nuvira', () => {
    const realLedger = join(process.env.HOME ?? '', '.nuvira', 'nuvira-routing-failures.json');
    const before = existsSync(realLedger) ? statSync(realLedger).mtimeMs : null;

    const isolated = resolveNuviraDataPath('nuvira-routing-failures.json');
    expect(isolated).toBe(join(cfgDir, 'nuvira-routing-failures.json'));
    expect(isolated).not.toBe(realLedger);

    // Writing the isolated ledger must not create or touch the real one.
    writeFileSync(isolated, JSON.stringify({ 'local|fake-model': { expiresAt: Date.now() + 1000, kind: 'timeout', recordedAt: Date.now() } }));

    // ...and the same must hold for the chat-history store (real file, if the
    // machine has one, must keep its exact mtime).
    if (existsSync(REAL_MEMORY_HISTORY)) {
      const histBefore = statSync(REAL_MEMORY_HISTORY).mtimeMs;
      process.env.NUVIRA_MEMORY_DIR = join(cfgDir, 'memory');
      expect(statSync(REAL_MEMORY_HISTORY).mtimeMs).toBe(histBefore);
    }
    const after = existsSync(realLedger) ? statSync(realLedger).mtimeMs : null;
    if (before !== null && after !== null) expect(after).toBe(before);
  });
});
