/**
 * AdminCommand — P6 M6.5 governance policy surface tests.
 *
 * The command writes through ConfigManager.save() — mocked here so the tests
 * are hermetic and assert the exact merged payloads (mirroring the config CLI
 * test pattern). Also asserts the `policy` renderer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

import { AdminCommand } from '../../src/cli/admin.js';
import type { BuffConfig, GovernanceConfig } from '../../src/config/types.js';

// ─── Hermetic RBAC dir (the admin command's RbacManager reads BUFF_CONFIG_DIR) ─

let rbacDir: string;
let originalConfigDir: string | undefined;
let originalActAs: string | undefined;

/** Point BUFF_CONFIG_DIR at a fresh temp dir so RBAC state is hermetic. */
function setupRbacDir(): void {
  rbacDir = mkdtempSync(join(tmpdir(), 'buff-admin-rbac-'));
  originalConfigDir = process.env.BUFF_CONFIG_DIR;
  process.env.BUFF_CONFIG_DIR = rbacDir;
  originalActAs = process.env.BUFF_ACT_AS;
  delete process.env.BUFF_ACT_AS; // legacy mode by default
}

function teardownRbacDir(): void {
  if (originalConfigDir === undefined) delete process.env.BUFF_CONFIG_DIR;
  else process.env.BUFF_CONFIG_DIR = originalConfigDir;
  if (originalActAs === undefined) delete process.env.BUFF_ACT_AS;
  else process.env.BUFF_ACT_AS = originalActAs;
  rmSync(rbacDir, { recursive: true, force: true });
}

/** Pre-seed a role assignment so the command exits legacy mode. */
function seedRole(user: string, role: string): void {
  writeFileSync(join(rbacDir, 'rbac.json'), JSON.stringify({
    version: 1,
    users: { [user]: { role, addedAt: Date.now(), via: 'local' } },
  }), 'utf-8');
}

// ─── Test helpers ───────────────────────────────────────────────────────────

let saved: Partial<BuffConfig> | null;
let configState: BuffConfig;

function makeCommand(): AdminCommand {
  const cmd = new AdminCommand();
  (cmd as any).configManager = {
    getAll: vi.fn(() => configState),
    save: vi.fn((patch: Partial<BuffConfig>) => {
      saved = patch;
      // Mirrors ConfigManager.save's shallow merge for the assertions.
      configState = {
        ...configState,
        providers: { ...configState.providers, ...(patch.providers || {}) },
        routing: { ...configState.routing, ...(patch.routing || {}) },
      } as BuffConfig;
    }),
  };
  return cmd;
}

function run(cmd: AdminCommand, args: string[]): void {
  const cli = new Command();
  cli.addCommand(cmd.create());
  cli.parse(['node', 'buff', 'admin', ...args]);
}

function gov(): GovernanceConfig {
  return (configState.routing?.governance || {}) as GovernanceConfig;
}

describe('AdminCommand — allow/deny lists (P6 M6.5)', () => {
  beforeEach(() => {
    saved = null;
    configState = { defaultProvider: 'local', providers: {} } as BuffConfig;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupRbacDir(); // empty → legacy single-user mode (writes allowed)
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownRbacDir();
  });

  it('allow adds providers to governance.allowProviders (deduped, merged with existing)', () => {
    const cmd = makeCommand();
    run(cmd, ['allow', 'groq']);
    expect(gov().allowProviders).toEqual(['groq']);

    run(cmd, ['allow', 'groq', 'local']);
    expect(gov().allowProviders).toEqual(['groq', 'local']);
  });

  it('deny adds providers to governance.denyProviders', () => {
    const cmd = makeCommand();
    run(cmd, ['deny', 'gemini', 'openrouter']);
    expect(gov().denyProviders).toEqual(['gemini', 'openrouter']);
  });

  it('allow-model / deny-model add to the model lists', () => {
    const cmd = makeCommand();
    run(cmd, ['allow-model', 'llama-3.3-70b-versatile']);
    run(cmd, ['deny-model', 'gemini-2.5-pro']);
    expect(gov().allowModels).toEqual(['llama-3.3-70b-versatile']);
    expect(gov().denyModels).toEqual(['gemini-2.5-pro']);
  });

  it('max-cost sets the admin hard cost cap and rejects invalid input without saving', () => {
    const cmd = makeCommand();
    run(cmd, ['max-cost', '0.01']);
    expect(gov().maxCostUsd).toBe(0.01);

    run(cmd, ['max-cost', 'abc']);
    expect(gov().maxCostUsd).toBe(0.01); // unchanged — the bad set was rejected
  });

  it('pii-min sets the PII privacy threshold and validates the 0..1 range', () => {
    const cmd = makeCommand();
    run(cmd, ['pii-min', '0.5']);
    expect(gov().minPrivacyForPii).toBe(0.5);

    run(cmd, ['pii-min', '1.5']);
    expect(gov().minPrivacyForPii).toBe(0.5); // rejected
  });

  it('unblock on|off toggles allowUnblock; invalid input is rejected', () => {
    const cmd = makeCommand();
    run(cmd, ['unblock', 'off']);
    expect(gov().allowUnblock).toBe(false);

    run(cmd, ['unblock', 'on']);
    expect(gov().allowUnblock).toBe(true);

    run(cmd, ['unblock', 'maybe']);
    expect(gov().allowUnblock).toBe(true); // rejected — unchanged
  });

  it('clear removes a single governance field (permissive on it again)', () => {
    const cmd = makeCommand();
    run(cmd, ['allow', 'groq']);
    run(cmd, ['deny', 'gemini']);
    expect(gov().allowProviders).toEqual(['groq']);

    run(cmd, ['clear', 'allowProviders']);
    expect(gov().allowProviders).toBeUndefined();
    expect(gov().denyProviders).toEqual(['gemini']); // other fields untouched
  });

  it('clear rejects unknown fields', () => {
    const cmd = makeCommand();
    run(cmd, ['clear', 'nonsense']);
    expect(gov()).toEqual({});
  });
});

describe('AdminCommand — policy renderer', () => {
  beforeEach(() => {
    saved = null;
    configState = { defaultProvider: 'local', providers: {} } as BuffConfig;
    setupRbacDir(); // legacy mode → policy read is always allowed
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownRbacDir();
  });

  it('reports a fully permissive policy when no rules are set', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cmd = makeCommand();
    run(cmd, ['policy']);
    const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toMatch(/fully permissive/i);
    expect(out).toMatch(/No rules active/i);
  });

  it('renders the configured rules and JSON output', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    configState = {
      defaultProvider: 'local',
      providers: {},
      routing: {
        governance: {
          allowProviders: ['groq', 'local'],
          denyProviders: ['gemini'],
          maxCostUsd: 0.01,
          allowUnblock: false,
        },
      },
    } as BuffConfig;
    const cmd = makeCommand();
    run(cmd, ['policy']);
    const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('groq, local');
    expect(out).toContain('gemini');
    expect(out).toContain('$0.01');
    expect(out).toMatch(/Enforced on every Auto pick/);

    run(cmd, ['policy', '--json']);
    const jsonCall = logSpy.mock.calls.find((c) => c[0] && String(c[0]).startsWith('{'));
    expect(jsonCall).toBeTruthy();
    const parsed = JSON.parse(String(jsonCall![0]));
    expect(parsed.governance.allowProviders).toEqual(['groq', 'local']);
  });
});

describe('AdminCommand — RBAC gating (P6 M6.1)', () => {
  beforeEach(() => {
    saved = null;
    configState = { defaultProvider: 'local', providers: {} } as BuffConfig;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupRbacDir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownRbacDir();
  });

  it('legacy mode (no roles) allows policy writes', () => {
    const cmd = makeCommand();
    run(cmd, ['allow', 'groq']);
    expect(gov().allowProviders).toEqual(['groq']);
  });

  it('blocks policy writes for a viewer and logs an RbacError', () => {
    seedRole('alice', 'viewer');
    process.env.BUFF_ACT_AS = 'alice';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cmd = makeCommand();
    run(cmd, ['allow', 'groq']);
    // The write was rejected — no governance payload saved.
    expect(gov().allowProviders).toBeUndefined();
    expect(errSpy.mock.calls.some((c) => c.join(' ').includes('Access denied'))).toBe(true);
  });

  it('allows policy writes for an admin', () => {
    seedRole('alice', 'admin');
    process.env.BUFF_ACT_AS = 'alice';
    const cmd = makeCommand();
    run(cmd, ['allow', 'groq']);
    expect(gov().allowProviders).toEqual(['groq']);
  });

  it('policy read stays open to every role', () => {
    seedRole('alice', 'viewer');
    process.env.BUFF_ACT_AS = 'alice';
    const cmd = makeCommand();
    run(cmd, ['policy']); // must not throw / log an access error
    expect(gov()).toEqual({});
  });

  it('role add works in legacy mode (first assignment exits legacy)', () => {
    const cmd = makeCommand();
    run(cmd, ['role', 'add', 'bob', 'operator']);
    const rbacFile = join(rbacDir, 'rbac.json');
    const raw = JSON.parse(require('node:fs').readFileSync(rbacFile, 'utf-8'));
    expect(raw.users.bob.role).toBe('operator');
  });

  it('blocks role management for a non-admin', () => {
    seedRole('bob', 'operator');
    process.env.BUFF_ACT_AS = 'bob';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cmd = makeCommand();
    run(cmd, ['role', 'add', 'mallory', 'viewer']);
    expect(errSpy.mock.calls.some((c) => c.join(' ').includes('Access denied'))).toBe(true);
    // mallory was NOT added.
    const raw = JSON.parse(require('node:fs').readFileSync(join(rbacDir, 'rbac.json'), 'utf-8'));
    expect(raw.users.mallory).toBeUndefined();
  });

  it('blocks EVERY mutating policy command for a viewer (guard coverage parity)', () => {
    seedRole('alice', 'viewer');
    process.env.BUFF_ACT_AS = 'alice';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Every subcommand that mutates the governance policy must be gated by
    // guard('policy.write') — not just `allow`. If one is missed, its payload
    // would land in configState and this test catches the regression.
    const mutating: Array<[string[], keyof GovernanceConfig]> = [
      [['allow', 'groq'], 'allowProviders'],
      [['deny', 'gemini'], 'denyProviders'],
      [['allow-model', 'm1'], 'allowModels'],
      [['deny-model', 'm2'], 'denyModels'],
      [['max-cost', '0.5'], 'maxCostUsd'],
      [['pii-min', '0.8'], 'minPrivacyForPii'],
      [['unblock', 'off'], 'allowUnblock'],
      [['clear', 'allowProviders'], 'allowProviders'],
    ];
    for (const [args] of mutating) {
      run(makeCommand(), args);
    }
    // Nothing was written — every payload would have been rejected.
    expect(gov()).toEqual({});
    // One Access-denied log per blocked write (8 total).
    const denied = errSpy.mock.calls.filter((c) => c.join(' ').includes('Access denied')).length;
    expect(denied).toBe(mutating.length);
  });

  it('whoami reports the acting identity and role', () => {
    seedRole('alice', 'admin');
    process.env.BUFF_ACT_AS = 'alice';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cmd = makeCommand();
    run(cmd, ['whoami']);
    const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('alice');
    expect(out).toContain('admin');
    expect(out).toContain('policy.write');
  });
});
