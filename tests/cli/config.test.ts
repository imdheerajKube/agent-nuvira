/**
 * ConfigCommand — unit tests for `buff config set` key paths added by
 * Nuvira-Router M2.3 (multi-account `apiKeys`) and M2.4 (governance policy).
 *
 * The command writes through ConfigManager.save() — mocked here so the tests
 * are hermetic and assert the exact merged payloads.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { ConfigCommand } from '../../src/cli/config.js';
import type { BuffConfig } from '../../src/config/types.js';

// ─── Test helpers ───────────────────────────────────────────────────────────

let saved: Partial<BuffConfig> | null;
let configState: BuffConfig;

function makeCommand() {
  const cmd = new ConfigCommand();
  (cmd as any).configManager = {
    getAll: vi.fn(() => configState),
    save: vi.fn((patch: Partial<BuffConfig>) => {
      saved = patch;
      // Mirrors ConfigManager.save's shallow merge for the assertions.
      configState = {
        ...configState,
        providers: { ...configState.providers, ...(patch.providers || {}) },
        routing: { ...configState.routing, ...(patch.routing || {}) },
      };
    }),
  };
  return cmd;
}

function runSet(cmd: ReturnType<typeof makeCommand>, key: string, value: string): void {
  // Parse through the production CLI shape (root program → config child → set
  // subcommand) so commander resolves subcommand options exactly like the real
  // binary does.
  const cli = new Command();
  cli.addCommand(cmd.create());
  cli.parse(['node', 'buff', 'config', 'set', key, value]);
}

describe('ConfigCommand set — M2.3 multi-account apiKeys', () => {
  beforeEach(() => {
    saved = null;
    configState = {
      defaultProvider: 'local',
      providers: { groq: { model: 'llama-3.3-70b-versatile' } },
    } as BuffConfig;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets providers.<name>.apiKeys as a string array (comma-separated)', () => {
    const cmd = makeCommand();
    runSet(cmd, 'providers.groq.apiKeys', 'k1, k2 ,k3');
    expect(saved?.providers?.groq?.apiKeys).toEqual(['k1', 'k2', 'k3']);
    // The primary key is untouched.
    expect(saved?.providers?.groq?.model).toBe('llama-3.3-70b-versatile');
  });

  it('clears apiKeys with an empty/whitespace value', () => {
    const cmd = makeCommand();
    runSet(cmd, 'providers.groq.apiKeys', '  ,  ');
    expect(saved?.providers?.groq?.apiKeys).toEqual([]);
  });

  it('still coerces numeric provider fields (model unaffected)', () => {
    const cmd = makeCommand();
    runSet(cmd, 'providers.groq.maxTokens', '4096');
    expect(saved?.providers?.groq?.maxTokens).toBe(4096);
  });
});

describe('ConfigCommand set — M2.4 governance policy', () => {
  beforeEach(() => {
    saved = null;
    configState = {
      defaultProvider: 'local',
      providers: {},
      routing: {},
    } as BuffConfig;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets routing.governance.allowProviders as a comma-separated list', () => {
    const cmd = makeCommand();
    runSet(cmd, 'routing.governance.allowProviders', 'groq,local');
    expect(saved?.routing?.governance?.allowProviders).toEqual(['groq', 'local']);
  });

  it('sets routing.governance.denyModels as a list', () => {
    const cmd = makeCommand();
    runSet(cmd, 'routing.governance.denyModels', 'gemini-2.5-flash, gemini-1.5-flash');
    expect(saved?.routing?.governance?.denyModels).toEqual(['gemini-2.5-flash', 'gemini-1.5-flash']);
  });

  it('sets routing.governance.maxCostUsd as a number', () => {
    const cmd = makeCommand();
    runSet(cmd, 'routing.governance.maxCostUsd', '0.002');
    expect(saved?.routing?.governance?.maxCostUsd).toBe(0.002);
  });

  it('sets routing.governance.allowUnblock as a boolean', () => {
    const cmd = makeCommand();
    runSet(cmd, 'routing.governance.allowUnblock', 'false');
    expect(saved?.routing?.governance?.allowUnblock).toBe(false);
  });

  it('sets routing.governance.piiPatterns as a list', () => {
    const cmd = makeCommand();
    runSet(cmd, 'routing.governance.piiPatterns', 'api[_-]?key, password');
    expect(saved?.routing?.governance?.piiPatterns).toEqual(['api[_-]?key', 'password']);
  });

  it('sets routing.nuviraSidecar.enabled as a boolean (P5 M5.4 flag)', () => {
    const cmd = makeCommand();
    runSet(cmd, 'routing.nuviraSidecar.enabled', 'true');
    expect(saved?.routing?.nuviraSidecar?.enabled).toBe(true);
  });

  it('sets routing.nuviraSidecar.image as a pinned image:tag (P5 M5.4)', () => {
    const cmd = makeCommand();
    runSet(cmd, 'routing.nuviraSidecar.image', 'ghcr.io/berriai/litellm:main-stable');
    expect(saved?.routing?.nuviraSidecar?.image).toBe('ghcr.io/berriai/litellm:main-stable');
  });

  it('sets the soft-signal gates routing.capabilityFit / contextFit / partialFlakiness as booleans', () => {
    const cmd = makeCommand();
    runSet(cmd, 'routing.partialFlakiness', 'false');
    expect(saved?.routing?.partialFlakiness).toBe(false);
    runSet(cmd, 'routing.partialFlakiness', 'true');
    expect(saved?.routing?.partialFlakiness).toBe(true);
    runSet(cmd, 'routing.capabilityFit', 'false');
    expect(saved?.routing?.capabilityFit).toBe(false);
    runSet(cmd, 'routing.contextFit', 'false');
    expect(saved?.routing?.contextFit).toBe(false);
  });

  it('rejects an unknown routing key with the full valid-key list (P4 M4.4)', () => {
    const cmd = makeCommand();
    runSet(cmd, 'routing.partialFitness', 'true');
    expect(saved?.routing?.partialFitness).toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('partialFlakiness'));
  });

  it('sets routing.compression.enabled as a boolean (M4.4, off by default)', () => {
    const cmd = makeCommand();
    runSet(cmd, 'routing.compression.enabled', 'true');
    expect(saved?.routing?.compression?.enabled).toBe(true);
  });

  it('sets routing.compression.keepRatio + minProseChars as numbers (M4.4)', () => {
    const cmd = makeCommand();
    runSet(cmd, 'routing.compression.keepRatio', '0.4');
    runSet(cmd, 'routing.compression.minProseChars', '1200');
    expect(saved?.routing?.compression?.keepRatio).toBe(0.4);
    expect(saved?.routing?.compression?.minProseChars).toBe(1200);
  });

  it('rejects an out-of-range compression keepRatio (M4.4 validation)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cmd = makeCommand();
    runSet(cmd, 'routing.compression.keepRatio', '2.5');
    expect(saved?.routing?.compression?.keepRatio).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('sets routing.gatewayTelemetry.enabled as a boolean (M7.4, off by default)', () => {
    const cmd = makeCommand();
    runSet(cmd, 'routing.gatewayTelemetry.enabled', 'true');
    expect(saved?.routing?.gatewayTelemetry?.enabled).toBe(true);
  });

  it('sets routing.gatewayTelemetry.healthFlags as a boolean (M7.4 per-provider flags)', () => {
    const cmd = makeCommand();
    runSet(cmd, 'routing.gatewayTelemetry.healthFlags', 'true');
    expect(saved?.routing?.gatewayTelemetry?.healthFlags).toBe(true);
  });

  it('merges gatewayTelemetry flags additively (M7.4)', () => {
    configState.routing = { gatewayTelemetry: { enabled: true } } as BuffConfig['routing'];
    const cmd = makeCommand();
    runSet(cmd, 'routing.gatewayTelemetry.healthFlags', 'true');
    expect(saved?.routing?.gatewayTelemetry?.enabled).toBe(true);
    expect(saved?.routing?.gatewayTelemetry?.healthFlags).toBe(true);
  });

  it('rejects an unknown gatewayTelemetry key with an error (M7.4 validation)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cmd = makeCommand();
    runSet(cmd, 'routing.gatewayTelemetry.nonsense', 'true');
    expect(saved?.routing?.gatewayTelemetry?.nonsense).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('rejects a non-boolean gatewayTelemetry.enabled value (M7.4 validation)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cmd = makeCommand();
    runSet(cmd, 'routing.gatewayTelemetry.enabled', 'maybe');
    expect(saved?.routing?.gatewayTelemetry?.enabled).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('merges into existing governance config (additive)', () => {
    configState.routing = { governance: { allowProviders: ['groq'] } } as BuffConfig['routing'];
    const cmd = makeCommand();
    runSet(cmd, 'routing.governance.maxCostUsd', '0.001');
    // save() receives the merged object from the command (existing spread in).
    expect(saved?.routing?.governance?.allowProviders).toEqual(['groq']);
    expect(saved?.routing?.governance?.maxCostUsd).toBe(0.001);
  });

  it('rejects an unknown governance key with an error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cmd = makeCommand();
    runSet(cmd, 'routing.governance.nonsense', 'true');
    const err = errorSpy.mock.calls.map((c) => String(c[0])).join(' ');
    expect(err).toContain('Unknown governance config key');
    expect(saved).toBeNull();
  });
});

describe('ConfigCommand set — M2.5 context preflight windows', () => {
  beforeEach(() => {
    saved = null;
    configState = {
      defaultProvider: 'local',
      providers: {},
      routing: {},
    } as BuffConfig;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets routing.contextWindows.<key> as a NUMBER (not a string)', () => {
    const cmd = makeCommand();
    runSet(cmd, 'routing.contextWindows.local', '16384');
    expect(saved?.routing?.contextWindows).toEqual({ local: 16384 });
    expect(typeof saved?.routing?.contextWindows?.local).toBe('number');
  });

  it('merges into existing contextWindows (additive)', () => {
    configState.routing = { contextWindows: { gemini: 1_048_576 } } as BuffConfig['routing'];
    const cmd = makeCommand();
    runSet(cmd, 'routing.contextWindows.groq', '32768');
    expect(saved?.routing?.contextWindows).toEqual({ gemini: 1_048_576, groq: 32768 });
  });

  it('rejects a non-positive or non-integer window value', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cmd = makeCommand();
    runSet(cmd, 'routing.contextWindows.local', 'abc');
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join(' ')).toContain('Invalid context window');
    expect(saved).toBeNull();
  });
});
