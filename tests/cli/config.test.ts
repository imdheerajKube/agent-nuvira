/**
 * ConfigCommand — unit tests for `nuvira config set` key paths added by
 * Nuvira-Router M2.3 (multi-account `apiKeys`) and M2.4 (governance policy).
 *
 * The command writes through ConfigManager.save() — mocked here so the tests
 * are hermetic and assert the exact merged payloads.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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

  it('merges quota limits across providers (sibling preservation, Session 36)', () => {
    configState.routing = { quota: { gemini: { requestsPerWindow: 1500 } } } as BuffConfig['routing'];
    const cmd = makeCommand();
    runSet(cmd, 'routing.quota.groq.tokensPerWindow', '12000');
    // ConfigManager.save shallow-merges `routing` — the setter must send the
    // FULL merged quota map so sibling providers survive.
    expect(saved?.routing?.quota).toEqual({
      gemini: { requestsPerWindow: 1500 },
      groq: { tokensPerWindow: 12000 },
    });
  });
});

describe('ConfigCommand set — modality.image backend (BYOK)', () => {
  beforeEach(() => {
    saved = null;
    configState = { defaultProvider: 'local', providers: {} } as BuffConfig;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets modality.image.provider', () => {
    const cmd = makeCommand();
    runSet(cmd, 'modality.image.provider', 'gemini');
    expect(saved?.modality?.image?.provider).toBe('gemini');
  });

  it('merges modality.image.model into an existing provider choice (additive)', () => {
    configState.modality = { image: { provider: 'gemini' } };
    const cmd = makeCommand();
    runSet(cmd, 'modality.image.model', 'gemini-2.5-flash-image');
    expect(saved?.modality?.image?.provider).toBe('gemini');
    expect(saved?.modality?.image?.model).toBe('gemini-2.5-flash-image');
  });

  it('rejects an unknown modality.image field', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cmd = makeCommand();
    runSet(cmd, 'modality.image.nonsense', 'x');
    expect(saved).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown modality.image config key'));
  });
});

describe('ConfigCommand set — dashboard.cwd (workspace for unattached chat turns)', () => {
  beforeEach(() => {
    saved = null;
    configState = { defaultProvider: 'local', providers: {} } as BuffConfig;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores an EXISTING directory as an absolute path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buff-cwd-ok-'));
    try {
      runSet(makeCommand(), 'dashboard.cwd', dir);
      expect(saved?.dashboard?.cwd).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a path that is not a directory (never writes a broken fallback)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runSet(makeCommand(), 'dashboard.cwd', '/no/such/dir-xyz-123');
    // NOT saved: a typo here would re-open the accidental-cwd hole this setting
    // exists to close, so it must fail loudly instead of being persisted.
    expect(saved).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('existing directory'));
  });

  it('clears the setting with dashboard.cwd.clear', () => {
    configState.dashboard = { cwd: '/tmp' };
    runSet(makeCommand(), 'dashboard.cwd.clear', 'true');
    expect(saved?.dashboard?.cwd).toBeUndefined();
  });
});

describe('ConfigCommand gateway — validated-sender policies (allow/disallow/reply)', () => {
  // Hermetic RBAC: an empty BUFF_CONFIG_DIR role file → legacy single-user
  // mode → guardRbacAction('gateway.manage') is permissive, so the command
  // writes go through without seeding an admin.
  let rbacDir: string;
  let originalConfigDir: string | undefined;
  let originalActAs: string | undefined;

  function setupRbacDir(): void {
    rbacDir = mkdtempSync(join(tmpdir(), 'buff-gw-policy-rbac-'));
    originalConfigDir = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_CONFIG_DIR = rbacDir;
    originalActAs = process.env.NUVIRA_ACT_AS;
    delete process.env.NUVIRA_ACT_AS;
  }

  function teardownRbacDir(): void {
    if (originalConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = originalConfigDir;
    if (originalActAs === undefined) delete process.env.NUVIRA_ACT_AS;
    else process.env.NUVIRA_ACT_AS = originalActAs;
    rmSync(rbacDir, { recursive: true, force: true });
  }

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
          gateway: { ...(configState.gateway || {}), ...(patch.gateway || {}) },
        } as BuffConfig;
      }),
    };
    return cmd;
  }

  function runGateway(cmd: ReturnType<typeof makeCommand>, args: string[]): void {
    const cli = new Command();
    cli.addCommand(cmd.create());
    cli.parse(['node', 'buff', 'config', 'gateway', ...args]);
  }

  beforeEach(() => {
    saved = null;
    configState = {
      defaultProvider: 'local',
      providers: {},
      routing: {},
    } as BuffConfig;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupRbacDir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownRbacDir();
  });

  it('allow adds users to gateway.policies.<platform>.allowedUsers (deduped, merged)', () => {
    const cmd = makeCommand();
    runGateway(cmd, ['allow', 'whatsapp', 'user', '919876543210']);
    expect(saved?.gateway?.policies?.whatsapp?.allowedUsers).toEqual(['919876543210']);

    runGateway(cmd, ['allow', 'whatsapp', 'user', '919876543210', '919999999999']);
    expect(saved?.gateway?.policies?.whatsapp?.allowedUsers).toEqual(['919876543210', '919999999999']);
  });

  it('allow adds groups to allowedGroups without touching sibling users', () => {
    const cmd = makeCommand();
    runGateway(cmd, ['allow', 'telegram', 'user', 'u-1']);
    runGateway(cmd, ['allow', 'telegram', 'group', 'g-family']);
    const pol = saved?.gateway?.policies?.telegram as { allowedUsers?: string[]; allowedGroups?: string[] };
    expect(pol.allowedUsers).toEqual(['u-1']);
    expect(pol.allowedGroups).toEqual(['g-family']);
  });

  it('disallow removes a user and drops the key when the list empties', () => {
    const cmd = makeCommand();
    runGateway(cmd, ['allow', 'discord', 'user', 'u-1', 'u-2']);
    runGateway(cmd, ['disallow', 'discord', 'user', 'u-1']);
    expect(saved?.gateway?.policies?.discord?.allowedUsers).toEqual(['u-2']);

    runGateway(cmd, ['disallow', 'discord', 'user', 'u-2']);
    const pol = saved?.gateway?.policies?.discord as { allowedUsers?: string[] };
    expect(pol.allowedUsers).toBeUndefined();
  });

  it('reply silent sets silentDrop; reply polite writes silentDrop: false (explicit opt-in)', () => {
    const cmd = makeCommand();
    runGateway(cmd, ['reply', 'whatsapp', 'silent']);
    expect(saved?.gateway?.policies?.whatsapp?.silentDrop).toBe(true);

    // HARD POLICY: silent is the DEFAULT — `polite` must write `false`, NOT
    // delete the key (deleting would keep the silent default).
    runGateway(cmd, ['reply', 'whatsapp', 'polite']);
    const pol = saved?.gateway?.policies?.whatsapp as { silentDrop?: boolean };
    expect(pol.silentDrop).toBe(false);
  });

  it('notify add/remove/list manage gateway.statusRecipients', () => {
    const cmd = makeCommand();
    runGateway(cmd, ['notify', 'add', 'whatsapp:Alex', 'telegram:123456']);
    expect(saved?.gateway?.statusRecipients).toEqual(['whatsapp:Alex', 'telegram:123456']);

    runGateway(cmd, ['notify', 'add', 'whatsapp:Alex', 'slack:ops']);
    expect(saved?.gateway?.statusRecipients).toEqual(['whatsapp:Alex', 'telegram:123456', 'slack:ops']);

    runGateway(cmd, ['notify', 'remove', 'telegram:123456']);
    expect(saved?.gateway?.statusRecipients).toEqual(['whatsapp:Alex', 'slack:ops']);

    // list is a no-op read — nothing saved.
    runGateway(cmd, ['notify', 'list']);
    expect(saved).not.toBeNull(); // last saved was the remove; list itself doesn't save
  });

  it('notify rejects an unknown action', () => {
    const cmd = makeCommand();
    runGateway(cmd, ['notify', 'bogus', 'x']);
    expect(saved).toBeNull();
  });

  it('rejects unknown platforms, bad kinds, and bad reply modes', () => {
    const cmd = makeCommand();
    runGateway(cmd, ['allow', 'notreal', 'user', 'x']);
    expect(saved).toBeNull();
    runGateway(cmd, ['allow', 'whatsapp', 'admin', 'x']);
    expect(saved).toBeNull();
    runGateway(cmd, ['reply', 'whatsapp', 'loud']);
    expect(saved).toBeNull();
  });
});

describe('ConfigCommand service — third-party service keys (dashboard parity)', () => {
  // Hermetic: a temp env file + an empty config dir (legacy RBAC → the
  // credential.write guard is permissive). Values land in NUVIRA_ENV_FILE.
  let dir: string;
  let originalConfigDir: string | undefined;
  let originalEnvFile: string | undefined;
  let originalActAs: string | undefined;
  const TOUCHED = ['BRAVE_SEARCH_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_CSE_API_KEY', 'GOOGLE_CSE_ID'];

  function envFilePath(): string {
    return process.env.NUVIRA_ENV_FILE as string;
  }

  function runService(args: string[]): void {
    const cmd = new ConfigCommand();
    const cli = new Command();
    cli.addCommand(cmd.create());
    cli.parse(['node', 'buff', 'config', 'service', ...args]);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buff-svc-cli-'));
    originalConfigDir = process.env.NUVIRA_CONFIG_DIR;
    originalEnvFile = process.env.NUVIRA_ENV_FILE;
    originalActAs = process.env.NUVIRA_ACT_AS;
    process.env.NUVIRA_CONFIG_DIR = dir;
    process.env.NUVIRA_ENV_FILE = join(dir, 'test.env');
    delete process.env.NUVIRA_ACT_AS;
    for (const k of TOUCHED) delete process.env[k];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = originalConfigDir;
    if (originalEnvFile === undefined) delete process.env.NUVIRA_ENV_FILE;
    else process.env.NUVIRA_ENV_FILE = originalEnvFile;
    if (originalActAs === undefined) delete process.env.NUVIRA_ACT_AS;
    else process.env.NUVIRA_ACT_AS = originalActAs;
    for (const k of TOUCHED) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  });

  it('sets one env var for a service (positional form)', () => {
    runService(['set', 'search-brave', 'BRAVE_SEARCH_API_KEY', 'brave-key-123']);
    expect(readFileSync(envFilePath(), 'utf-8')).toContain('BRAVE_SEARCH_API_KEY=brave-key-123');
  });

  it('sets via --set and rejects unknown service ids and env vars', () => {
    runService(['set', 'image-gemini', '--set', 'GEMINI_API_KEY=gkey']);
    expect(readFileSync(envFilePath(), 'utf-8')).toContain('GEMINI_API_KEY=gkey');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runService(['set', 'not-a-service', 'X', 'y']);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown service'));
    runService(['set', 'search-brave', 'NOT_A_VAR', 'y']);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown env var'));
  });

  it('unset removes one var (--yes) and leaves the service\'s others intact', () => {
    runService(['set', 'search-google-cse', '--set', 'GOOGLE_CSE_API_KEY=k', '--set', 'GOOGLE_CSE_ID=cx']);
    runService(['unset', 'search-google-cse', 'GOOGLE_CSE_API_KEY', '--yes']);
    const content = readFileSync(envFilePath(), 'utf-8');
    expect(content).not.toContain('GOOGLE_CSE_API_KEY');
    expect(content).toContain('GOOGLE_CSE_ID=cx');
  });

  it('treats a keyless service as a no-op instead of writing', () => {
    runService(['set', 'image-pollinations', 'X', 'y']);
    // No env file is created for a keyless backend.
    expect(() => readFileSync(envFilePath(), 'utf-8')).toThrow();
  });
});
