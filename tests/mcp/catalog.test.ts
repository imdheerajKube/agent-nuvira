/**
 * I7 P2 — Curated MCP catalog tests (`src/mcp/catalog.ts`).
 *
 * Hermetic: installs/uninstalls write to a TEMP config dir (never ~/.mcp), the
 * machine is simulated with a temp PATH of fake executables (so the suite passes
 * with or without a real npx/uvx/docker), secrets resolve from the environment or
 * explicit values, and nothing ever touches the network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MCP_CATALOG,
  catalogNpmSpecs,
  chooseVariant,
  evaluateVariants,
  expandRefs,
  getCatalogEntry,
  installCatalogServer,
  isCatalogServerInstalled,
  searchCatalog,
  uninstallCatalogServer,
  catalogConfigPath,
  resolveSecret,
  type MCPCatalogEntry,
} from '../../src/mcp/catalog.js';
import { parseNpmSpec, verifyNpmSpec, verifyNpmSpecs } from '../../src/mcp/pin-verifier.js';
import type { MCPServerConfig } from '../../src/mcp/types.js';

let configDir = '';
let binDir = '';
/** A PATH with no toolchain at all — the "nothing is installed" machine. */
let emptyPath: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'buff-mcp-cat-'));
  binDir = mkdtempSync(join(tmpdir(), 'buff-mcp-cat-bin-'));
  emptyPath = mkdtempSync(join(tmpdir(), 'buff-mcp-cat-empty-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  rmSync(emptyPath, { recursive: true, force: true });
});

function fakeExecutable(name: string): void {
  const file = join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
  writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf-8');
  if (process.platform !== 'win32') chmodSync(file, 0o755);
}

const envWithBin = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: binDir,
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ...extra,
});
const envWithNothing = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: emptyPath,
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ...extra,
});

const entryOf = (name: string): MCPCatalogEntry => {
  const entry = getCatalogEntry(name);
  if (!entry) throw new Error(`catalog entry '${name}' missing`);
  return entry;
};

describe('catalog content + lookup', () => {
  it('exposes capability slots with offers, variants, ranks and a trust level', () => {
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(5);
    for (const entry of MCP_CATALOG) {
      expect(entry.name).toMatch(/^[a-z0-9-]+$/);
      expect(entry.description).toBeTruthy();
      expect(entry.offers.length).toBeGreaterThan(0);
      expect(entry.variants.length).toBeGreaterThan(0);
      for (const variant of entry.variants) {
        expect(variant.id).toMatch(/^[a-z0-9-]+$/);
        expect(['first-party', 'official', 'community']).toContain(variant.trust);
        expect(Number.isInteger(variant.rank)).toBe(true);
        // Every variant must be startable-shaped: a command, or a URL.
        expect(variant.command || variant.url).toBeTruthy();
        // A variant that cannot run must say what it needs.
        expect(Array.isArray(variant.requires)).toBe(true);
        for (const prereq of variant.requires) expect(prereq.hint).toBeTruthy();
      }
    }
  });

  it('pins npm specs to exact versions — no floating tags', () => {
    for (const spec of catalogNpmSpecs()) {
      const parsed = parseNpmSpec(spec);
      expect(parsed, `${spec} is not an exact npm spec`).not.toBeNull();
      expect(parsed!.version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('contains none of the pins that do not resolve on npm (the §2 defect)', () => {
    const specs = catalogNpmSpecs().join(' ');
    // Verified live: fetch 404s; the other three versions never existed.
    expect(specs).not.toContain('server-fetch');
    expect(specs).not.toContain('context7-mcp@1.5.2');
    expect(specs).not.toContain('server-memory@0.3.6');
    expect(specs).not.toContain('server-sequential-thinking@0.4.2');
    // …and the deprecated github npm package is gone entirely.
    expect(specs).not.toContain('server-github');
  });

  it('keeps the working modern pins', () => {
    const specs = catalogNpmSpecs();
    expect(specs).toContain('@upstash/context7-mcp@4.3.0');
    expect(specs).toContain('@modelcontextprotocol/server-memory@1.0.0');
    expect(specs).toContain('@modelcontextprotocol/server-sequential-thinking@1.0.0');
    expect(specs).toContain('@modelcontextprotocol/server-filesystem@1.0.0');
  });

  it('records what each slot supersedes, so the audit trail survives the fix', () => {
    expect(entryOf('github').supersedes).toContain('no longer supported');
    expect(entryOf('fetch').supersedes).toContain('does not exist on npm');
    expect(entryOf('context7').supersedes).toContain('1.5.2');
  });

  it('looks up by name and searches by keyword', () => {
    expect(getCatalogEntry('filesystem')?.description).toContain('Filesystem');
    expect(getCatalogEntry('nope')).toBeNull();
    expect(searchCatalog('github').map((e) => e.name)).toContain('github');
  });
});

describe('variant selection', () => {
  it('defaults github to the hosted remote entry, never the opt-in local binary', () => {
    // Both are runnable here — the opt-in rule, not the probe, decides.
    fakeExecutable('npx');
    fakeExecutable('github-mcp-server');
    const chosen = chooseVariant(entryOf('github'), {
      probe: { env: envWithBin({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' }), nodeVersion: '20.18.1' },
    });
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    expect(chosen.choice.variant.id).toBe('remote');
    expect(chosen.choice.variant.transport).toBe('sse');

    const local = chooseVariant(entryOf('github'), {
      variantId: 'local-binary',
      probe: { env: envWithBin({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' }), nodeVersion: '20.18.1' },
    });
    expect(local.ok && local.choice.variant.id).toBe('local-binary');
  });

  it('reaches a locally installed binary that is NOT on PATH via an explicit command', () => {
    // The REAL case: github-mcp-server lives at ~/.local/bin, which is not on
    // PATH. The probe is right to report it missing; an explicit path is the
    // answer, and it must (a) satisfy the command prerequisite and (b) be used.
    const binary = join(binDir, 'github-mcp-server');
    writeFileSync(binary, '#!/bin/sh\n', 'utf-8');
    if (process.platform !== 'win32') chmodSync(binary, 0o755);

    const probeEnv = envWithNothing({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' });
    const refused = installCatalogServer(entryOf('github'), {}, configDir, {
      variantId: 'local-binary',
      probe: { env: probeEnv, nodeVersion: '20.18.1' },
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('not found on PATH');

    const installed = installCatalogServer(entryOf('github'), {}, configDir, {
      variantId: 'local-binary',
      command: binary,
      probe: { env: probeEnv, nodeVersion: '20.18.1' },
    });
    expect(installed.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(installed.path!, 'utf-8')) as MCPServerConfig;
    expect(cfg.command).toBe(binary);
    expect(cfg.args).toEqual(['stdio']);
  });

  it('does not accept a command path that is not executable', () => {
    const notThere = join(binDir, 'ghost-binary');
    const result = installCatalogServer(entryOf('github'), {}, configDir, {
      variantId: 'local-binary',
      command: notThere,
      probe: { env: envWithNothing({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' }), nodeVersion: '20.18.1' },
    });
    expect(result.ok).toBe(false); // still missing: the path was not verified
    expect(result.reason).toContain('not found on PATH');
  });

  it('falls back to the Node-18-safe context7 release when Node 20 is not available', () => {
    fakeExecutable('npx');
    const on18 = chooseVariant(entryOf('context7'), {
      probe: { env: envWithBin(), nodeVersion: '18.18.0' },
    });
    expect(on18.ok).toBe(true);
    if (!on18.ok) return;
    expect(on18.choice.variant.id).toBe('npx-node18');

    const on20 = chooseVariant(entryOf('context7'), {
      probe: { env: envWithBin(), nodeVersion: '20.18.1' },
    });
    expect(on20.ok && on20.choice.variant.id).toBe('npx');
  });

  it('meets the context7 Node floor with a runtime override instead of raising the global floor', () => {
    fakeExecutable('npx');
    fakeExecutable('node20');
    const chosen = chooseVariant(entryOf('context7'), {
      probe: { env: envWithBin(), nodeVersion: '18.18.0' },
      runtime: { command: 'node20', args: ['/usr/local/bin/npx'] },
    });
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    expect(chosen.choice.variant.id).toBe('npx');
    expect(chosen.choice.status.ok).toBe(true);
    expect(chosen.choice.status.unverified.join(' ')).toContain('node20');
  });

  it('offers three real ways to run fetch, and picks the one this machine has', () => {
    const fetch = entryOf('fetch');
    expect(fetch.variants.map((v) => v.id).sort()).toEqual(['docker', 'npx', 'uvx']);

    fakeExecutable('uvx');
    const uvOnly = chooseVariant(fetch, { probe: { env: envWithBin(), nodeVersion: '20.18.1' } });
    expect(uvOnly.ok && uvOnly.choice.variant.id).toBe('uvx');

    fakeExecutable('npx');
    const both = chooseVariant(fetch, { probe: { env: envWithBin(), nodeVersion: '20.18.1' } });
    expect(both.ok && both.choice.variant.id).toBe('npx'); // rank wins

    const none = chooseVariant(fetch, { probe: { env: envWithNothing(), nodeVersion: '20.18.1' } });
    expect(none.ok).toBe(false);
    if (none.ok) return;
    // A refusal must name every way it could work and what each one is missing.
    expect(none.reason).toContain('npx');
    expect(none.reason).toContain('uvx');
    expect(none.reason).toContain('docker');
    expect(none.reason).toContain('not found on PATH');
  });

  it('reports an unknown variant id with the ids that exist', () => {
    const chosen = chooseVariant(entryOf('fetch'), { variantId: 'nope' });
    expect(chosen.ok).toBe(false);
    if (chosen.ok) return;
    expect(chosen.reason).toContain('npx, uvx, docker');
  });

  it('evaluates every variant with a status (for the catalog listing)', () => {
    const choices = evaluateVariants(entryOf('memory'), { probe: { env: envWithNothing(), nodeVersion: '18.18.0' } });
    expect(choices).toHaveLength(1);
    expect(choices[0].status.ok).toBe(false);
    expect(choices[0].status.missing.length).toBeGreaterThan(0);
  });
});

describe('install (variant choice, prerequisite gate, config writing)', () => {
  it('writes the standard MCP config for the chosen variant', () => {
    fakeExecutable('npx');
    const result = installCatalogServer(entryOf('filesystem'), {}, configDir, {
      probe: { env: envWithBin(), nodeVersion: '18.18.0' },
    });
    expect(result.ok).toBe(true);
    expect(result.variantId).toBe('npx');
    expect(result.path).toBe(catalogConfigPath('filesystem', configDir));
    expect(isCatalogServerInstalled('filesystem', configDir)).toBe(true);

    const cfg = JSON.parse(readFileSync(result.path!, 'utf-8')) as MCPServerConfig;
    expect(cfg.name).toBe('filesystem');
    expect(cfg.transport).toBe('stdio');
    expect(cfg.enabled).toBe(true);
    expect(cfg.variant).toBe('npx');
    expect(cfg.command).toBe('npx');
    expect(cfg.args).toContain('@modelcontextprotocol/server-filesystem@1.0.0');
  });

  it('refuses to install a variant this machine cannot run, naming the dependency', () => {
    const result = installCatalogServer(entryOf('fetch'), {}, configDir, {
      probe: { env: envWithNothing(), nodeVersion: '18.18.0' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no variant of 'fetch' can run on this machine yet");
    // Every way it could work is named, each with its own missing dependency.
    expect(result.reason).toContain('uvx');
    expect(result.missing?.join(' ')).toContain('not found on PATH');
    expect(existsSync(catalogConfigPath('fetch', configDir))).toBe(false);
  });

  it('installs anyway with force, choosing the preferred runnable-shaped variant', () => {
    const result = installCatalogServer(entryOf('fetch'), {}, configDir, {
      probe: { env: envWithNothing(), nodeVersion: '18.18.0' },
      force: true,
    });
    expect(result.ok).toBe(true);
    expect(result.variantId).toBe('npx'); // lowest rank, never an opt-in variant
    expect(isCatalogServerInstalled('fetch', configDir)).toBe(true);
  });

  it('refuses a named variant that cannot run until --force', () => {
    const refused = installCatalogServer(entryOf('fetch'), {}, configDir, {
      variantId: 'docker',
      probe: { env: envWithNothing(), nodeVersion: '18.18.0' },
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("variant 'docker'");
    expect(refused.reason).toContain('not found on PATH');

    const forced = installCatalogServer(entryOf('fetch'), {}, configDir, {
      variantId: 'docker',
      probe: { env: envWithNothing(), nodeVersion: '18.18.0' },
      force: true,
    });
    expect(forced.ok).toBe(true);
  });

  it('writes a runtime override (variant-level and explicit)', () => {
    fakeExecutable('npx');
    fakeExecutable('node20');
    const result = installCatalogServer(entryOf('context7'), {}, configDir, {
      probe: { env: envWithBin(), nodeVersion: '18.18.0' },
      runtime: { command: 'node20', args: ['/usr/local/bin/npx'] },
    });
    expect(result.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(result.path!, 'utf-8')) as MCPServerConfig;
    expect(cfg.variant).toBe('npx');
    expect(cfg.runtime).toEqual({ command: 'node20', args: ['/usr/local/bin/npx'] });
  });

  it('resolves prompt-secret from the environment (never written to config)', () => {
    const prev = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'env-token-123';
    try {
      const result = installCatalogServer(entryOf('github'), {}, configDir, {
        probe: { env: envWithBin(), nodeVersion: '20.18.1' },
      });
      expect(result.ok).toBe(true);
      const cfg = JSON.parse(readFileSync(result.path!, 'utf-8')) as MCPServerConfig;
      expect(cfg.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('env-token-123');
      // The remote variant carries the token in its Authorization header.
      expect(cfg.headers?.Authorization).toBe('Bearer env-token-123');
      // The literal placeholder must never reach the file.
      expect(JSON.stringify(cfg)).not.toContain('prompt-secret');
    } finally {
      if (prev === undefined) delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
      else process.env.GITHUB_PERSONAL_ACCESS_TOKEN = prev;
    }
  });

  it('uses an explicit provided secret when the env is unset', () => {
    const result = installCatalogServer(
      entryOf('github'),
      { GITHUB_PERSONAL_ACCESS_TOKEN: 'explicit-token' },
      configDir,
      { probe: { env: envWithBin(), nodeVersion: '20.18.1' } },
    );
    expect(result.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(result.path!, 'utf-8')) as MCPServerConfig;
    expect(cfg.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('explicit-token');
  });

  it('lets a secret supplied on the command line satisfy the variant prerequisite', () => {
    // The bug the end-to-end run caught: `install github --env TOKEN=…` must
    // satisfy the env prerequisite it exists to provide, and the probe must see
    // the SAME environment the config is written from.
    const previous = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    try {
      const result = installCatalogServer(
        entryOf('github'),
        { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_from_flag' },
        configDir,
        { probe: { env: envWithNothing(), nodeVersion: '20.18.1' } },
      );
      expect(result.ok).toBe(true);
      const cfg = JSON.parse(readFileSync(result.path!, 'utf-8')) as MCPServerConfig;
      expect(cfg.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_from_flag');
      expect(cfg.headers?.Authorization).toBe('Bearer ghp_from_flag');
    } finally {
      if (previous !== undefined) process.env.GITHUB_PERSONAL_ACCESS_TOKEN = previous;
    }
  });

  it('refuses cleanly when a required secret is missing (never writes)', () => {
    const previous = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    try {
      const result = installCatalogServer(entryOf('github'), {}, configDir, {
        probe: { env: envWithNothing(), nodeVersion: '20.18.1' },
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('GITHUB_PERSONAL_ACCESS_TOKEN');
      expect(existsSync(catalogConfigPath('github', configDir))).toBe(false);
    } finally {
      if (previous !== undefined) process.env.GITHUB_PERSONAL_ACCESS_TOKEN = previous;
    }
  });

  it('never blocks on an OPTIONAL secret (context7 works without a key)', () => {
    fakeExecutable('npx');
    const result = installCatalogServer(entryOf('context7'), {}, configDir, {
      probe: { env: envWithBin(), nodeVersion: '20.18.1' },
    });
    expect(result.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(result.path!, 'utf-8')) as MCPServerConfig;
    expect(cfg.env?.CONTEXT7_API_KEY).toBeUndefined();
  });

  it('writes a provided optional secret when it exists', () => {
    fakeExecutable('npx');
    const result = installCatalogServer(entryOf('context7'), { CONTEXT7_API_KEY: 'c7-key' }, configDir, {
      probe: { env: envWithBin(), nodeVersion: '20.18.1' },
    });
    expect(result.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(result.path!, 'utf-8')) as MCPServerConfig;
    expect(cfg.env?.CONTEXT7_API_KEY).toBe('c7-key');
  });

  it('refuses when the caller reports the pin does not resolve, and tolerates an unchecked registry', () => {
    fakeExecutable('npx');
    const pinned = {
      checked: true,
      ok: false,
      reason: "npm has no 'memory@9.9.9'",
    };
    const refused = installCatalogServer(entryOf('memory'), {}, configDir, {
      probe: { env: envWithBin(), nodeVersion: '18.18.0' },
      pinVerdict: pinned,
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('does not resolve');

    const offline = installCatalogServer(entryOf('memory'), {}, configDir, {
      probe: { env: envWithBin(), nodeVersion: '18.18.0' },
      pinVerdict: { checked: false, ok: false, reason: 'registry unreachable' },
    });
    expect(offline.ok).toBe(true);
    expect(offline.unverifiedPins).toBe(true);
  });

  it('puts 0600 permissions on a config that carries a secret', () => {
    if (process.platform === 'win32') return;
    const result = installCatalogServer(
      entryOf('github'),
      { GITHUB_PERSONAL_ACCESS_TOKEN: 'tok' },
      configDir,
      { probe: { env: envWithBin(), nodeVersion: '20.18.1' } },
    );
    expect(result.ok).toBe(true);
    const mode = statSync(result.path!).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('skips an already-installed server', () => {
    fakeExecutable('npx');
    const probe = { env: envWithBin(), nodeVersion: '18.18.0' };
    expect(installCatalogServer(entryOf('fetch'), {}, configDir, { probe }).ok).toBe(true);
    const second = installCatalogServer(entryOf('fetch'), {}, configDir, { probe });
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('already installed');
  });
});

describe('uninstall', () => {
  it('removes the config file', () => {
    fakeExecutable('npx');
    installCatalogServer(entryOf('memory'), {}, configDir, { probe: { env: envWithBin(), nodeVersion: '18.18.0' } });
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

describe('resolveSecret + expandRefs', () => {
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

  it('expands ${VAR} references and leaves unknown ones untouched', () => {
    expect(expandRefs('Bearer ${TOKEN}', { TOKEN: 'abc' })).toBe('Bearer abc');
    expect(expandRefs('Bearer ${MISSING}', {})).toBe('Bearer ${MISSING}');
  });
});

describe('pin verifier', () => {
  it('parses scoped and unscoped specs', () => {
    expect(parseNpmSpec('@upstash/context7-mcp@4.3.0')).toEqual({
      name: '@upstash/context7-mcp',
      version: '4.3.0',
    });
    expect(parseNpmSpec('firecrawl-mcp@1.2.3')).toEqual({ name: 'firecrawl-mcp', version: '1.2.3' });
    expect(parseNpmSpec('no-version')).toBeNull();
  });

  it('resolves a spec through an injected registry response', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ versions: { '4.3.0': {}, '1.0.34': {} } }), { status: 200 })) as unknown as typeof fetch;
    const ok = await verifyNpmSpec('@upstash/context7-mcp@4.3.0', { fetchImpl });
    expect(ok.checked).toBe(true);
    expect(ok.ok).toBe(true);

    const missing = await verifyNpmSpec('@upstash/context7-mcp@1.5.2', { fetchImpl });
    expect(missing.checked).toBe(true);
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain('1.5.2');
  });

  it('reports a deprecated version without failing it', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ versions: { '2025.4.8': { deprecated: 'Package no longer supported.' } } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const verdict = await verifyNpmSpec('@modelcontextprotocol/server-github@2025.4.8', { fetchImpl });
    expect(verdict.ok).toBe(true);
    expect(verdict.deprecated).toContain('no longer supported');
  });

  it('reports a 404 as checked-and-missing, and a network failure as unchecked', async () => {
    const notFound = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    const missing = await verifyNpmSpec('@modelcontextprotocol/server-fetch@0.1.7', { fetchImpl: notFound });
    expect(missing).toMatchObject({ checked: true, ok: false });
    expect(missing.reason).toContain('no package');

    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const offline = await verifyNpmSpec('@upstash/context7-mcp@4.3.0', { fetchImpl: down });
    expect(offline.checked).toBe(false);
    expect(offline.reason).toContain('unreachable');
  });

  it('verifies several specs at once, keyed by spec', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ versions: { '1.0.0': {} } }), { status: 200 })) as unknown as typeof fetch;
    const map = await verifyNpmSpecs(['a@1.0.0', 'b@2.0.0'], { fetchImpl });
    expect([...map.keys()]).toEqual(['a@1.0.0', 'b@2.0.0']);
    expect(map.get('a@1.0.0')?.ok).toBe(true);
    expect(map.get('b@2.0.0')?.ok).toBe(false);
  });
});
