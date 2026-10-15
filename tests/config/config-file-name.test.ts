/**
 * ONE config file naming rule, read by every reader.
 *
 * THE BUG THIS PINS (flagged as open in `bugs_identified_during full review.md`
 * §5, fixed here): `src/config/paths.ts` documented itself as the single source
 * of truth for "where does `nuviraconfig.json` live?" and resolved the NEW name
 * first, while `ConfigManager` built `join(configDir, 'buffconfig.json')` itself
 * and `mcp/settings.ts` read that same hardcoded name. So a profile written
 * under the new name was valid, resolvable, reported by
 * `resolveNuviraConfigPath()` — and ignored by every runtime reader (the CLI,
 * the router, chat/execute, the MCP layer), silently, because the file those
 * readers opened was a valid one either way.
 *
 * The two halves of the rule are asserted TOGETHER on purpose, because each is
 * useless alone:
 *   - both names are READ, lowest precedence first, so the new name wins key by
 *     key and neither file is discarded;
 *   - a WRITE goes to one file — the primary that exists, and the legacy name on
 *     a fresh install, so fixing the read does not split an install in two.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../../src/config/manager.js';
import { loadMcpSettings } from '../../src/mcp/settings.js';
import { resolveNuviraConfigPath, resolveNuviraConfigReadPaths } from '../../src/config/paths.js';

const NEW_NAME = 'nuviraconfig.json';
const LEGACY_NAME = 'buffconfig.json';

describe('the config file has one name per install', () => {
  let dir: string;

  const write = (name: string, body: unknown): void =>
    writeFileSync(join(dir, name), JSON.stringify(body, null, 2), 'utf-8');
  const read = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Record<string, unknown>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuvira-config-name-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a profile written under the NEW name — the one the resolver returns', () => {
    write(NEW_NAME, {
      defaultProvider: 'gemini',
      providers: { gemini: { model: 'from-the-new-name' } },
      // A nested section as well: the merge has to happen for the file, not only
      // for the keys a single top-level spread would carry.
      routing: { bandit: true, quota: { gemini: { requestsPerWindow: 1500 } } },
    });

    // Precondition, so this test cannot pass on a resolver that returns the
    // legacy name: the file the runtime is asked about IS the one written.
    expect(resolveNuviraConfigPath(dir)).toBe(join(dir, NEW_NAME));
    expect(resolveNuviraConfigReadPaths(dir)).toEqual([join(dir, NEW_NAME)]);

    const config = new ConfigManager(dir).getAll();
    expect(config.defaultProvider).toBe('gemini');
    expect(config.providers.gemini.model).toBe('from-the-new-name');
    expect(config.routing?.bandit).toBe(true);
    expect(config.routing?.quota?.gemini?.requestsPerWindow).toBe(1500);
  });

  it('writes BACK to the file it read, so a new-name profile is not forked', () => {
    write(NEW_NAME, { defaultProvider: 'gemini' });
    const manager = new ConfigManager(dir);
    manager.save({ defaultProvider: 'groq' } as never);

    // The value lands where it was read from…
    expect(read(NEW_NAME).defaultProvider).toBe('groq');
    // …and no second file appears beside it: a write to the other name would put
    // the new value where the next reader (resolver: new name first) never looks.
    expect(existsSync(join(dir, LEGACY_NAME))).toBe(false);
  });

  it('reads BOTH names when both exist, with the new one winning key by key', () => {
    write(LEGACY_NAME, {
      defaultProvider: 'groq',
      routing: { bandit: true, quota: { groq: { requestsPerWindow: 999 } } },
    });
    write(NEW_NAME, {
      routing: { bandit: false },
      gateway: { askUserWait: false },
    });

    const config = new ConfigManager(dir).getAll();
    // The new name overrides the key it states…
    expect(config.routing?.bandit).toBe(false);
    // …the legacy file's other keys SURVIVE (it is read, not shadowed)…
    expect(config.routing?.quota?.groq?.requestsPerWindow).toBe(999);
    expect(config.defaultProvider).toBe('groq');
    // …and the new file's own section is applied too.
    expect(config.gateway?.askUserWait).toBe(false);
  });

  it('a fresh install still writes the legacy name — reading the new one is not a migration', () => {
    const manager = new ConfigManager(dir);
    manager.save({ defaultProvider: 'local' } as never);

    expect(existsSync(join(dir, LEGACY_NAME))).toBe(true);
    expect(existsSync(join(dir, NEW_NAME))).toBe(false);
    // And the round trip reads what it wrote: one file, both directions.
    expect(new ConfigManager(dir).getAll().defaultProvider).toBe('local');
  });

  it('the MCP reader applies `mcp.*` from the new name, and merges a server across both files', () => {
    // A server whose `runtime.command` is in one file and whose `runtime.args`
    // are in the other must stay ONE server: the merge is `mergeMcpSetting`, the
    // same one `nuvira config set mcp.*` uses.
    write(LEGACY_NAME, {
      mcp: {
        maxToolsTotal: 25,
        servers: { context7: { runtime: { command: '/opt/node20/bin/node' } } },
      },
    });
    write(NEW_NAME, {
      mcp: {
        subagent: { inherit: 'full' },
        servers: { context7: { runtime: { args: ['/usr/local/bin/npx'] } } },
      },
    });

    const settings = loadMcpSettings(dir);
    expect(settings.maxToolsTotal).toBe(25);
    expect(settings.subagentInheritance).toBe('full');
    expect(settings.servers.context7?.runtime?.command).toBe('/opt/node20/bin/node');
    expect(settings.servers.context7?.runtime?.args).toEqual(['/usr/local/bin/npx']);

    // The manager's own accessor agrees, because both read this file set now.
    const viaManager = new ConfigManager(dir).getMcpConfig();
    expect(viaManager.maxToolsTotal).toBe(25);
    expect(viaManager.servers.context7?.runtime?.command).toBe('/opt/node20/bin/node');

    // And with ONLY the new name present, the section still applies — the case
    // that was silently ignored before this fix.
    const onlyNew = mkdtempSync(join(tmpdir(), 'nuvira-config-name-mcp-'));
    try {
      writeFileSync(
        join(onlyNew, NEW_NAME),
        JSON.stringify({ mcp: { maxToolsTotal: 42 } }),
        'utf-8',
      );
      expect(loadMcpSettings(onlyNew).maxToolsTotal).toBe(42);
    } finally {
      rmSync(onlyNew, { recursive: true, force: true });
    }
  });
});
