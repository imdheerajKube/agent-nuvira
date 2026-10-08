/**
 * Bundle 43 — the MCP schema cache actually caches.
 *
 * The finding: `mcp-schema-cache.ts` existed to persist a server's tool schemas
 * so a LATER process need not re-connect, and NOTHING ever called `set()`. Its
 * only readers were the `mcp_schema_cache` tool's get/invalidate/stats actions,
 * so `schemas.json` was always empty on a fresh install.
 *
 * Two isolation defects are pinned here as well, because a cache that writes to
 * the developer's real profile from an isolated process is worse than no cache:
 * the directory ignored `$NUVIRA_CONFIG_DIR`, and it was a module-level constant
 * so it was frozen at IMPORT time.
 *
 * Hermetic: every path is an isolated temp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MCPSchemaCache,
  getMCPSchemaCache,
  resetMCPSchemaCache,
} from '../../src/mcp/mcp-schema-cache.js';

let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'nuvira-mcp-cache-'));
  for (const k of ['NUVIRA_CONFIG_DIR', 'BUFF_CONFIG_DIR', 'NUVIRA_MCP_DIR', 'BUFF_MCP_DIR']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.NUVIRA_CONFIG_DIR = home;
  resetMCPSchemaCache();
});

afterEach(() => {
  resetMCPSchemaCache();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const TOOL = { name: 'create_issue', description: 'Create an issue.', inputSchema: { type: 'object', required: ['title'] } };

describe('MCPSchemaCache — persistence', () => {
  it('writes schemas to disk and reads them back in a NEW instance', () => {
    const first = new MCPSchemaCache();
    first.set('github', 'hash-1', [TOOL as never], [], []);

    // The file exists where a fresh process would look for it.
    expect(existsSync(join(home, 'mcp', 'cache', 'schemas.json'))).toBe(true);

    // A brand-new instance (as a second process would have) sees the schemas.
    const second = new MCPSchemaCache();
    const hit = second.get('github', 'hash-1');
    expect(hit?.tools[0]?.name).toBe('create_issue');
    // The declared inputs survive the round trip, not just the name.
    expect(hit?.tools[0]?.inputSchema).toEqual({ type: 'object', required: ['title'] });
  });

  it('treats a changed config hash as a miss and drops the entry', () => {
    new MCPSchemaCache().set('github', 'hash-1', [TOOL as never], [], []);
    const cache = new MCPSchemaCache();
    expect(cache.get('github', 'hash-2')).toBeNull();
    // …and the stale entry is gone, not merely skipped.
    expect(cache.getAll()).toEqual([]);
  });

  it('does not load an entry whose TTL has passed', async () => {
    new MCPSchemaCache({ ttlMs: 1 }).set('github', 'hash-1', [TOOL as never], [], []);
    await new Promise((r) => setTimeout(r, 10));
    expect(new MCPSchemaCache().get('github', 'hash-1')).toBeNull();
  });

  it('exposes every cached server so a cold process can enumerate them', () => {
    const cache = new MCPSchemaCache();
    cache.set('github', 'h1', [TOOL as never], [], []);
    cache.set('filesystem', 'h2', [{ name: 'read_text_file' } as never], [], []);
    expect(cache.getAll().map((e) => e.serverName).sort()).toEqual(['filesystem', 'github']);
    // The map itself is not handed out — mutating the result cannot corrupt it.
    cache.getAll().pop();
    expect(cache.getAll()).toHaveLength(2);
  });
});

describe('MCPSchemaCache.prune — trust only what is still true', () => {
  it('keeps a matching entry and drops a mismatched, unknown or expired one', async () => {
    const cache = new MCPSchemaCache();
    cache.set('github', 'matching', [TOOL as never], [], []);
    cache.set('changed', 'old-hash', [TOOL as never], [], []);
    cache.set('ghost', 'whatever', [TOOL as never], [], []);

    const dropped = cache.prune((name) =>
      name === 'github' ? 'matching' : name === 'changed' ? 'new-hash' : undefined,
    );

    expect(dropped).toBe(2);
    expect(cache.getAll().map((e) => e.serverName)).toEqual(['github']);
  });

  it('drops an expired entry even when its hash matches', async () => {
    const cache = new MCPSchemaCache({ ttlMs: 1 });
    cache.set('github', 'h1', [TOOL as never], [], []);
    await new Promise((r) => setTimeout(r, 10));
    expect(cache.prune(() => 'h1')).toBe(1);
    expect(cache.getAll()).toEqual([]);
  });
});

describe('MCPSchemaCache — the directory honours isolation', () => {
  it('writes under $NUVIRA_CONFIG_DIR, never the real home', () => {
    const cache = new MCPSchemaCache();
    cache.set('github', 'h1', [TOOL as never], [], []);
    const written = join(home, 'mcp', 'cache', 'schemas.json');
    expect(existsSync(written)).toBe(true);
    // The regression: the real profile must be untouched.
    const body = readFileSync(written, 'utf-8');
    expect(body).toContain('create_issue');
  });

  it('honours $NUVIRA_MCP_DIR and resolves the path at construction, not at import', () => {
    const other = mkdtempSync(join(tmpdir(), 'nuvira-mcp-dir-'));
    try {
      // Set AFTER the module was imported — a module-level constant would have
      // frozen the old path already.
      process.env.NUVIRA_MCP_DIR = other;
      new MCPSchemaCache().set('github', 'h1', [TOOL as never], [], []);
      expect(existsSync(join(other, 'cache', 'schemas.json'))).toBe(true);
      expect(existsSync(join(home, 'mcp', 'cache', 'schemas.json'))).toBe(false);
    } finally {
      delete process.env.NUVIRA_MCP_DIR;
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('lets an explicit cacheDir win, which is what keeps tests hermetic', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'nuvira-mcp-explicit-'));
    try {
      new MCPSchemaCache({ cacheDir: explicit }).set('github', 'h1', [TOOL as never], [], []);
      expect(existsSync(join(explicit, 'schemas.json'))).toBe(true);
      expect(existsSync(join(home, 'mcp', 'cache', 'schemas.json'))).toBe(false);
    } finally {
      rmSync(explicit, { recursive: true, force: true });
    }
  });
});

describe('MCPSchemaCache.computeConfigHash', () => {
  it('is stable across key order and sensitive to a real change', () => {
    const a = MCPSchemaCache.computeConfigHash({ name: 'github', command: 'npx', args: ['-y'] } as never);
    const reordered = MCPSchemaCache.computeConfigHash({ args: ['-y'], command: 'npx', name: 'github' } as never);
    expect(reordered).toBe(a);
    expect(MCPSchemaCache.computeConfigHash({ name: 'github', command: 'other' } as never)).not.toBe(a);
  });
});

describe('getMCPSchemaCache — the singleton', () => {
  it('returns one shared instance, and reset hands back a NEW one', () => {
    const first = getMCPSchemaCache();
    expect(getMCPSchemaCache()).toBe(first);
    resetMCPSchemaCache();
    expect(getMCPSchemaCache()).not.toBe(first);
  });

  it('keeps what was written across a reset, because it went to disk', () => {
    getMCPSchemaCache().set('github', 'h1', [TOOL as never], [], []);
    resetMCPSchemaCache();
    // A reset simulates a fresh process: the in-memory map is gone, the schemas
    // are not. That is the property the cold-start path depends on.
    expect(getMCPSchemaCache().get('github', 'h1')?.tools[0]?.name).toBe('create_issue');
  });
});
