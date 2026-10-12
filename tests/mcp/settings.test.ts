/**
 * MCP settings tests (`src/mcp/settings.ts`).
 *
 * Hermetic: the loader reads a TEMP config dir, and nothing here spawns,
 * connects or fetches.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MCP_SETTING_DEFAULTS,
  applyServerOverrides,
  effectiveToolCap,
  loadMcpSettings,
  mergeMcpSetting,
  parseMcpSetting,
  resolveMcpSettings,
} from '../../src/mcp/settings.js';
import type { MCPServerConfig } from '../../src/mcp/types.js';

let configDir = '';

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'buff-mcp-settings-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/** Parse-or-throw, so a broken fixture fails loudly inside the test. */
function parseSetting(key: string, value: string) {
  const parsed = parseMcpSetting(key, value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.mcp;
}

const server = (name: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig => ({
  name,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'pkg@1.0.0'],
  enabled: true,
  ...extra,
});

describe('parseMcpSetting + mergeMcpSetting (shared by CLI and dashboard)', () => {
  it('parses flags, caps and the subagent rule', () => {
    expect(parseMcpSetting('mcp.enabled', 'false')).toEqual({ ok: true, mcp: { enabled: false } });
    expect(parseMcpSetting('mcp.autoConnect', 'off')).toEqual({ ok: true, mcp: { autoConnect: false } });
    expect(parseMcpSetting('mcp.maxToolsTotal', '25')).toEqual({ ok: true, mcp: { maxToolsTotal: 25 } });
    expect(parseMcpSetting('mcp.subagent.inherit', 'full')).toEqual({
      ok: true,
      mcp: { subagent: { inherit: 'full' } },
    });
  });

  it('refuses values a typo would turn into a silent no-op', () => {
    for (const [key, value] of [
      ['mcp.enabled', 'maybe'],
      ['mcp.maxToolsTotal', '-3'],
      ['mcp.maxToolsTotal', 'lots'],
      ['mcp.subagent.inherit', 'everything'],
      ['mcp.nope', '1'],
      ['mcp.servers.github.nope', '1'],
      ['servers.github.enabled', 'true'],
    ] as const) {
      const parsed = parseMcpSetting(key, value);
      expect(parsed.ok, `${key}=${value} should be refused`).toBe(false);
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
    }
  });

  it('parses per-server overrides (enable, command, args, runtime)', () => {
    expect(parseMcpSetting('mcp.servers.github.enabled', 'false')).toEqual({
      ok: true,
      mcp: { servers: { github: { enabled: false } } },
    });
    expect(parseMcpSetting('mcp.servers.github.command', '/x/bin/gh-mcp')).toEqual({
      ok: true,
      mcp: { servers: { github: { command: '/x/bin/gh-mcp' } } },
    });
    expect(parseMcpSetting('mcp.servers.filesystem.args', '/a, /b')).toEqual({
      ok: true,
      mcp: { servers: { filesystem: { args: ['/a', '/b'] } } },
    });
    expect(parseMcpSetting('mcp.servers.context7.runtime.command', '/opt/node20/bin/node')).toEqual({
      ok: true,
      mcp: { servers: { context7: { runtime: { command: '/opt/node20/bin/node' } } } },
    });
  });

  it('clears a string override with an empty value', () => {
    expect(parseMcpSetting('mcp.servers.github.command', '')).toEqual({
      ok: true,
      mcp: { servers: { github: { command: undefined } } },
    });
  });

  it('merges patches without dropping the OTHER server or sibling keys', () => {
    const afterFirst = mergeMcpSetting(null, parseSetting('mcp.maxToolsTotal', '25'));
    const afterSecond = mergeMcpSetting(afterFirst, parseSetting('mcp.servers.context7.runtime.command', '/n20'));
    const afterThird = mergeMcpSetting(afterSecond, parseSetting('mcp.servers.filesystem.enabled', 'false'));

    expect(afterThird.maxToolsTotal).toBe(25);
    expect(afterThird.servers?.context7?.runtime?.command).toBe('/n20');
    expect(afterThird.servers?.filesystem?.enabled).toBe(false);
  });

  it('keeps runtime.args when the command is set later, and the command when args are added', () => {
    // A nested object cannot be treated as a flat key: setting half of it must
    // not erase the other half.
    const withArgs = mergeMcpSetting(null, {
      servers: { context7: { runtime: { command: '', args: ['/usr/local/bin/npx'] } } },
    });
    const withCommand = mergeMcpSetting(withArgs, parseSetting('mcp.servers.context7.runtime.command', '/n20'));
    expect(withCommand.servers?.context7?.runtime).toEqual({
      command: '/n20',
      args: ['/usr/local/bin/npx'],
    });
  });

  it('clears the whole runtime override when its command is emptied', () => {
    const withRuntime = mergeMcpSetting(null, parseSetting('mcp.servers.context7.runtime.command', '/n20'));
    const cleared = mergeMcpSetting(withRuntime, parseSetting('mcp.servers.context7.runtime.command', ''));
    expect(cleared.servers?.context7?.runtime).toBeUndefined();
  });
});

describe('resolveMcpSettings', () => {
  it('returns today\'s behaviour for an absent section — every default reproduces it', () => {
    const settings = resolveMcpSettings(null);
    expect(settings).toMatchObject({
      enabled: MCP_SETTING_DEFAULTS.enabled,
      autoConnect: MCP_SETTING_DEFAULTS.autoConnect,
      connectTimeoutMs: MCP_SETTING_DEFAULTS.connectTimeoutMs,
      maxToolsPerServer: MCP_SETTING_DEFAULTS.maxToolsPerServer,
      maxToolsTotal: MCP_SETTING_DEFAULTS.maxToolsTotal,
      subagentInheritance: 'conservative',
    });
    expect(settings.servers).toEqual({});
    expect(settings.warnings).toEqual([]);
  });

  it('defaults subagent inheritance to the CONSERVATIVE rule (§7.7)', () => {
    expect(MCP_SETTING_DEFAULTS.subagentInheritance).toBe('conservative');
    const full = resolveMcpSettings({ subagent: { inherit: 'full' } });
    expect(full.subagentInheritance).toBe('full');
  });

  it('falls back to conservative and warns on an unknown inheritance value', () => {
    const settings = resolveMcpSettings({ subagent: { inherit: 'everything' } });
    expect(settings.subagentInheritance).toBe('conservative');
    expect(settings.warnings.join(' ')).toContain("'conservative' or 'full'");
  });

  it('accepts string booleans (the way `config set` stores them)', () => {
    expect(resolveMcpSettings({ enabled: 'false' as unknown as boolean }).enabled).toBe(false);
    expect(resolveMcpSettings({ autoConnect: 'no' as unknown as boolean }).autoConnect).toBe(false);
  });

  it('clamps a connect budget so a typo cannot hang a turn', () => {
    const tooBig = resolveMcpSettings({ connectTimeoutMs: 999_999 });
    expect(tooBig.connectTimeoutMs).toBe(15_000);
    expect(tooBig.warnings.join(' ')).toContain('outside 250–15000');

    const tooSmall = resolveMcpSettings({ connectTimeoutMs: 5 });
    expect(tooSmall.connectTimeoutMs).toBe(250);

    const garbage = resolveMcpSettings({ connectTimeoutMs: 'soon' as unknown as number });
    expect(garbage.connectTimeoutMs).toBe(MCP_SETTING_DEFAULTS.connectTimeoutMs);
    expect(garbage.warnings.join(' ')).toContain('positive integer');
  });

  it('keeps the caps, with a total cap that can bind below the per-server cap', () => {
    const settings = resolveMcpSettings({ maxToolsPerServer: 15, maxToolsTotal: 20 });
    expect(effectiveToolCap('a', settings, 0)).toBe(15);
    expect(effectiveToolCap('b', settings, 12)).toBe(8); // total − used wins
    expect(effectiveToolCap('c', settings, 20)).toBe(0);
    expect(effectiveToolCap('d', settings, 99)).toBe(0);
  });

  it('honours a per-server tool cap and per-server override map', () => {
    const settings = resolveMcpSettings({
      maxToolsPerServer: 15,
      maxToolsTotal: 60,
      servers: { github: { maxTools: 4 } },
    });
    expect(effectiveToolCap('github', settings, 0)).toBe(4);
    expect(effectiveToolCap('other', settings, 0)).toBe(15);
  });
});

describe('applyServerOverrides', () => {
  it('passes servers through untouched when nothing is configured', () => {
    const configs = [server('github'), server('exa')];
    const out = applyServerOverrides(configs, { servers: {}, enabled: true });
    expect(out).toEqual(configs);
  });

  it('enables/disables a server and merges runtime + args overrides', () => {
    const out = applyServerOverrides([server('context7'), server('filesystem')], {
      enabled: true,
      servers: {
        filesystem: { enabled: false },
        context7: {
          runtime: { command: '/opt/node20/bin/node', args: ['/usr/local/bin/npx'] },
          args: ['-y', '@upstash/context7-mcp@4.3.0'],
          variant: 'npx',
        },
      },
    });
    expect(out.map((c) => c.name)).toEqual(['context7']);
    expect(out[0].runtime).toEqual({ command: '/opt/node20/bin/node', args: ['/usr/local/bin/npx'] });
    expect(out[0].args).toEqual(['-y', '@upstash/context7-mcp@4.3.0']);
    expect(out[0].variant).toBe('npx');
  });

  it('can point a server at a binary that is not on PATH (command override)', () => {
    const out = applyServerOverrides([server('github')], {
      enabled: true,
      servers: { github: { command: '/Users/me/.local/bin/github-mcp-server' } },
    });
    expect(out[0].command).toBe('/Users/me/.local/bin/github-mcp-server');
    expect(out[0].args).toEqual(['-y', 'pkg@1.0.0']); // other fields untouched
  });

  it('returns nothing at all when the master switch is off', () => {
    const out = applyServerOverrides([server('github')], { servers: {}, enabled: false });
    expect(out).toEqual([]);
  });

  it('can re-enable a server whose own file says enabled:false', () => {
    const out = applyServerOverrides([server('github', { enabled: false })], {
      enabled: true,
      servers: { github: { enabled: true } },
    });
    expect(out[0].enabled).toBe(true);
  });
});

describe('loadMcpSettings', () => {
  it('resolves defaults when the config file is absent', () => {
    expect(loadMcpSettings(configDir).subagentInheritance).toBe('conservative');
  });

  it('reads the mcp section from buffconfig.json', () => {
    writeFileSync(
      join(configDir, 'buffconfig.json'),
      JSON.stringify({ mcp: { autoConnect: false, maxToolsTotal: 25, subagent: { inherit: 'full' } } }),
      'utf-8',
    );
    const settings = loadMcpSettings(configDir);
    expect(settings.autoConnect).toBe(false);
    expect(settings.maxToolsTotal).toBe(25);
    expect(settings.subagentInheritance).toBe('full');
    // Untouched keys keep their defaults.
    expect(settings.maxToolsPerServer).toBe(MCP_SETTING_DEFAULTS.maxToolsPerServer);
  });

  it('survives a malformed config file instead of breaking a turn', () => {
    writeFileSync(join(configDir, 'buffconfig.json'), '{ not json', 'utf-8');
    expect(loadMcpSettings(configDir).enabled).toBe(true);
  });
});
