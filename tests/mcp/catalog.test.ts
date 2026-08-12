/**
 * I7 P2 — Curated MCP catalog tests (`src/mcp/catalog.ts`).
 *
 * Hermetic: installs/uninstalls write to a TEMP config dir (never ~/.buff/mcp),
 * secrets resolve from the environment or explicit values, and nothing ever
 * touches the network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MCP_CATALOG,
  getCatalogEntry,
  searchCatalog,
  installCatalogServer,
  uninstallCatalogServer,
  isCatalogServerInstalled,
  catalogConfigPath,
  resolveSecret,
} from '../../src/mcp/catalog.js';
import type { MCPServerConfig } from '../../src/mcp/types.js';

let configDir = '';

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'buff-mcp-cat-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('catalog content + lookup', () => {
  it('exposes vetted entries with exact-version pins', () => {
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(5);
    for (const e of MCP_CATALOG) {
      expect(e.name).toMatch(/^[a-z0-9-]+$/);
      expect(e.vettedBy).toBeTruthy();
      // Pinned versions only — no floating tags.
      if (e.args) {
        for (const arg of e.args) {
          if (arg.startsWith('@')) expect(arg).toMatch(/@\d+\.\d+\.\d+$/);
        }
      }
    }
  });

  it('looks up by name and searches by keyword', () => {
    expect(getCatalogEntry('filesystem')?.description).toContain('Filesystem');
    expect(getCatalogEntry('nope')).toBeNull();
    expect(searchCatalog('github').map((e) => e.name)).toContain('github');
  });
});

describe('install (secret resolution, config writing)', () => {
  it('writes the standard MCP config with static env', () => {
    const entry = getCatalogEntry('filesystem')!;
    const result = installCatalogServer(entry, {}, configDir);
    expect(result.ok).toBe(true);
    expect(result.path).toBe(catalogConfigPath('filesystem', configDir));
    expect(isCatalogServerInstalled('filesystem', configDir)).toBe(true);

    const cfg = JSON.parse(readFileSync(result.path!, 'utf-8')) as MCPServerConfig;
    expect(cfg.name).toBe('filesystem');
    expect(cfg.transport).toBe('stdio');
    expect(cfg.enabled).toBe(true);
    expect(cfg.command).toBe('npx');
  });

  it('resolves prompt-secret from the environment (never written to config)', () => {
    const prev = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'env-token-123';
    try {
      const entry = getCatalogEntry('github')!;
      const result = installCatalogServer(entry, {}, configDir);
      expect(result.ok).toBe(true);
      const cfg = JSON.parse(readFileSync(result.path!, 'utf-8')) as MCPServerConfig;
      expect(cfg.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('env-token-123');
      // The literal placeholder must never reach the file.
      expect(JSON.stringify(cfg)).not.toContain('prompt-secret');
    } finally {
      if (prev === undefined) delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
      else process.env.GITHUB_PERSONAL_ACCESS_TOKEN = prev;
    }
  });

  it('uses an explicit provided secret when the env is unset', () => {
    const entry = getCatalogEntry('github')!;
    const result = installCatalogServer(entry, { GITHUB_PERSONAL_ACCESS_TOKEN: 'explicit-token' }, configDir);
    expect(result.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(result.path!, 'utf-8')) as MCPServerConfig;
    expect(cfg.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('explicit-token');
  });

  it('fails cleanly when a required secret is missing (never writes)', () => {
    const entry = getCatalogEntry('github')!;
    const result = installCatalogServer(entry, {}, configDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(existsSync(catalogConfigPath('github', configDir))).toBe(false);
  });

  it('skips an already-installed server', () => {
    const entry = getCatalogEntry('fetch')!;
    expect(installCatalogServer(entry, {}, configDir).ok).toBe(true);
    const second = installCatalogServer(entry, {}, configDir);
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('already installed');
  });
});

describe('uninstall', () => {
  it('removes the config file', () => {
    const entry = getCatalogEntry('memory')!;
    installCatalogServer(entry, {}, configDir);
    expect(readdirSync(configDir)).toContain('memory.json');
    expect(uninstallCatalogServer('memory', configDir).ok).toBe(true);
    expect(isCatalogServerInstalled('memory', configDir)).toBe(false);
  });

  it('reports cleanly when nothing was installed', () => {
    const result = uninstallCatalogServer('context7', configDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not installed');
  });
});

describe('resolveSecret', () => {
  it('prefers the live environment over an explicit value', () => {
    const prev = process.env.MY_SECRET;
    process.env.MY_SECRET = 'env';
    try {
      expect(resolveSecret('MY_SECRET', { MY_SECRET: 'explicit' })).toBe('env');
      expect(resolveSecret('UNSET_SECRET', { UNSET_SECRET: 'explicit' })).toBe('explicit');
      expect(resolveSecret('ALSO_UNSET')).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.MY_SECRET;
      else process.env.MY_SECRET = prev;
    }
  });
});
