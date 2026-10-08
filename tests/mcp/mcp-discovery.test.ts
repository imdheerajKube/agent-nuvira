/**
 * Bundle 43 — MCP discovery survives a cold start.
 *
 * A fresh process should be able to answer "what can I do?" about a configured
 * MCP server WITHOUT connecting to it. That is the whole reason schemas are
 * cached, and it is the reason the cache write path had to be wired up.
 *
 * Pinned here:
 *   - a previous process's cached schemas are discovered on a cold start;
 *   - a RECONFIGURED server's stale schemas are ignored and pruned;
 *   - an UNINSTALLED server's schemas are dropped;
 *   - a live connection always wins over the cache;
 *   - discovery never connects (the live source is mocked, so a real spawn would
 *     show up as a failure rather than as coverage).
 *
 * Hermetic: isolated temp config dir, mocked live source, no server spawned.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readDiscoverableMcpTools } from '../../src/mcp/mcp-discovery.js';
import { MCPSchemaCache, getMCPSchemaCache, resetMCPSchemaCache } from '../../src/mcp/mcp-schema-cache.js';
import { capabilityIndex } from '../../src/tools/capability-registry.js';

// The live source. `vi.hoisted` so the mock factory (hoisted above the imports)
// can close over a holder this file controls per test.
const live = vi.hoisted(() => ({ tools: [] as Array<Record<string, unknown>> }));
vi.mock('../../src/tools/mcp-client-tool.js', () => ({
  getMCPToolManager: () => ({ listTools: () => live.tools }),
}));

let home: string;
const savedEnv: Record<string, string | undefined> = {};

/** Write a server config the way `nuvira mcp install` would. */
function configureServer(config: Record<string, unknown>): void {
  mkdirSync(join(home, 'mcp'), { recursive: true });
  writeFileSync(join(home, 'mcp', `${config.name}.json`), JSON.stringify(config));
}

/** Cache a server's schemas the way a PREVIOUS process's connect would have. */
function cacheSchemas(server: string, config: Record<string, unknown>, tools: Array<Record<string, unknown>>): void {
  getMCPSchemaCache().set(
    server,
    MCPSchemaCache.computeConfigHash(config as never),
    tools as never,
    [],
    [],
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'nuvira-mcp-discovery-'));
  for (const k of ['NUVIRA_CONFIG_DIR', 'BUFF_CONFIG_DIR', 'NUVIRA_MCP_DIR', 'BUFF_MCP_DIR']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.NUVIRA_CONFIG_DIR = home;
  resetMCPSchemaCache();
  live.tools = [];
});

afterEach(() => {
  resetMCPSchemaCache();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const CONFIG = { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'server-github'], enabled: true };

describe('readDiscoverableMcpTools — cold start', () => {
  it('discovers a configured server\'s tools from the cache with nothing connected', async () => {
    configureServer(CONFIG);
    cacheSchemas('github', CONFIG, [
      { name: 'create_issue', description: 'Create an issue.', inputSchema: { type: 'object', required: ['title'] }, annotations: { readOnlyHint: false } },
      { name: 'search_issues', description: 'Search issues.', annotations: { readOnlyHint: true } },
    ]);

    const tools = await readDiscoverableMcpTools();
    expect(tools.map((t) => `${t.server}/${t.name}`).sort()).toEqual([
      'github/create_issue',
      'github/search_issues',
    ]);
    // The declaration and the required inputs both survive the round trip.
    expect(tools.find((t) => t.name === 'create_issue')!.inputSchema).toEqual({ type: 'object', required: ['title'] });
    expect(tools.find((t) => t.name === 'search_issues')!.annotations).toEqual({ readOnlyHint: true });
  });

  it('IGNORES and prunes a server that has been reconfigured since', async () => {
    configureServer(CONFIG);
    // Cached under an older config — e.g. the command or args changed.
    cacheSchemas('github', { ...CONFIG, command: 'old-npx' }, [{ name: 'stale_tool', description: 'Stale.' }]);

    expect(await readDiscoverableMcpTools()).toEqual([]);
    // Pruned, not merely skipped — the stale schemas are gone from disk too.
    expect(getMCPSchemaCache().getAll()).toEqual([]);
  });

  it('DROPS the schemas of a server that is no longer configured', async () => {
    // Cached by some past install; no config file remains.
    cacheSchemas('ghost', { name: 'ghost', transport: 'stdio', command: 'x', enabled: true }, [
      { name: 'haunt', description: 'Haunt.' },
    ]);
    expect(await readDiscoverableMcpTools()).toEqual([]);
    expect(getMCPSchemaCache().getAll()).toEqual([]);
  });

  it('is empty and non-throwing with no configs and no cache', async () => {
    expect(await readDiscoverableMcpTools()).toEqual([]);
  });
});

describe('readDiscoverableMcpTools — live wins over the cache', () => {
  it('prefers the connected server\'s current tool list over the cached one', async () => {
    configureServer(CONFIG);
    cacheSchemas('github', CONFIG, [{ name: 'create_issue', description: 'CACHED description.' }]);
    live.tools = [
      { server: 'github', name: 'create_issue', description: 'LIVE description.', annotations: { readOnlyHint: true } },
    ];

    const tools = await readDiscoverableMcpTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.description).toBe('LIVE description.');
    expect(tools[0]!.annotations).toEqual({ readOnlyHint: true });
  });

  it('serves both sources, with distinct tools from each', async () => {
    configureServer(CONFIG);
    cacheSchemas('github', CONFIG, [{ name: 'cached_tool', description: 'From last time.' }]);
    live.tools = [{ server: 'github', name: 'live_tool', description: 'From right now.' }];

    const names = (await readDiscoverableMcpTools()).map((t) => t.name).sort();
    expect(names).toEqual(['cached_tool', 'live_tool']);
  });
});

describe('capabilityIndex — cold-start MCP reach (the end goal)', () => {
  it('surfaces cached MCP tools as capabilities, effect read from the declaration', async () => {
    configureServer(CONFIG);
    cacheSchemas('github', CONFIG, [
      { name: 'search_issues', description: 'Search issues in a repository.', inputSchema: { type: 'object', required: ['query'] }, annotations: { readOnlyHint: true } },
      { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', required: ['title'] } },
    ]);

    const index = await capabilityIndex([], { includeSkills: false });
    const mcp = index.filter((c) => c.kind === 'mcp');
    expect(mcp.map((c) => c.ref).sort()).toEqual(['github/create_issue', 'github/search_issues']);

    const search = mcp.find((c) => c.ref === 'github/search_issues')!;
    expect(search.effectClass).toBe('read');
    expect(search.requires.inputs).toEqual(['query']);
    expect(search.invoke).toEqual({
      tool: 'mcp_tool',
      args: { action: 'call', server: 'github', tool: 'search_issues' },
    });

    // Undeclared → off-machine and unknown, never silently safe.
    const create = mcp.find((c) => c.ref === 'github/create_issue')!;
    expect(create.effectClass).toBe('external');
    expect(create.reversible).toBe(false);
    expect(create.grantCategory).toBe('external');
  });
});
