/**
 * AdminCommand — P6 M6.5 governance policy surface tests.
 *
 * The command writes through ConfigManager.save() — mocked here so the tests
 * are hermetic and assert the exact merged payloads (mirroring the config CLI
 * test pattern). Also asserts the `policy` renderer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

import { AdminCommand } from '../../src/cli/admin.js';
import type { BuffConfig, GovernanceConfig } from '../../src/config/types.js';

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
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
