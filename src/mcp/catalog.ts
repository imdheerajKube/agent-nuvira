/**
 * I7 P2 — Curated MCP catalog (`src/mcp/catalog.ts`).
 *
 * Mirrors Hermes' `optional-mcps/<name>/manifest.yaml` policy: a vetted list
 * of MCP servers with EXACT-VERSION pins (no floating tags), a "vetted by"
 * stamp, and `prompt-secret` env placeholders that are resolved at install
 * time (from the environment or an explicit value) and written into the
 * standard MCP config file (~/.buff/mcp/<name>.json) — never into
 * buffconfig.json, and never echoed to the terminal.
 *
 * CLI surface (src/cli/mcp.ts):
 *   buff mcp catalog [--search <q>]   — list vetted servers (+ installed badge)
 *   buff mcp install <name>           — resolve pins → write config → ready
 *   buff mcp uninstall <name>         — remove the config file
 */

import { existsSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { logger } from '../utils/logger.js';
import { type MCPServerConfig, MCP_CONFIG_DIR } from './types.js';

// ─── Catalog entry ──────────────────────────────────────────────────────────

export interface MCPCatalogEntry {
  name: string;
  description: string;
  /** 'stdio' subprocess (command+args) or 'sse' remote endpoint. */
  transport: 'stdio' | 'sse';
  /** stdio command (e.g. "npx"). */
  command?: string;
  /** stdio args — MUST be exact-version pinned. */
  args?: string[];
  /** SSE endpoint URL (sse transport). */
  url?: string;
  /** Env vars to set. Value "prompt-secret" → resolved at install. */
  env?: Record<string, string>;
  /** Provenance: who vetted this entry. */
  vettedBy: string;
}

/** Vetted catalog (exact pins; 2-week-old minimum for freshness on review). */
export const MCP_CATALOG: MCPCatalogEntry[] = [
  {
    name: 'filesystem',
    description: 'Filesystem access (read/write/search within allowed roots)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem@0.6.2'],
    vettedBy: 'nous-catalog',
  },
  {
    name: 'github',
    description: 'GitHub API via MCP (repos, issues, PRs, search)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github@0.6.2'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'prompt-secret' },
    vettedBy: 'nous-catalog',
  },
  {
    name: 'fetch',
    description: 'Fetch a URL and convert it to readable markdown',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch@0.1.7'],
    vettedBy: 'nous-catalog',
  },
  {
    name: 'memory',
    description: 'Knowledge-graph based persistent memory (entities, relations, observations)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory@0.3.6'],
    vettedBy: 'nous-catalog',
  },
  {
    name: 'sequential-thinking',
    description: 'Structured, explicit reasoning over a problem space',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking@0.4.2'],
    vettedBy: 'nous-catalog',
  },
  {
    name: 'context7',
    description: 'Up-to-date library/framework documentation retrieval',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@1.5.2'],
    vettedBy: 'nous-catalog',
  },
];

// ─── Lookup ─────────────────────────────────────────────────────────────────

/** Find a catalog entry by name. */
export function getCatalogEntry(name: string): MCPCatalogEntry | null {
  return MCP_CATALOG.find((e) => e.name === name) ?? null;
}

/** Search the catalog by name/description keyword. */
export function searchCatalog(query: string): MCPCatalogEntry[] {
  const q = query.toLowerCase();
  return MCP_CATALOG.filter((e) => `${e.name} ${e.description}`.toLowerCase().includes(q));
}

// ─── Install path ───────────────────────────────────────────────────────────

/** The per-server config file for an installed catalog server. */
export function catalogConfigPath(name: string, configDir?: string): string {
  return join(configDir ?? join(homedir(), MCP_CONFIG_DIR), `${name}.json`);
}

/** Is a catalog server already installed? */
export function isCatalogServerInstalled(name: string, configDir?: string): boolean {
  return existsSync(catalogConfigPath(name, configDir));
}

/**
 * Resolve a `prompt-secret` env value: from the live environment first; else
 * `provided` (the CLI's prompted value); else null (caller reports missing).
 */
export function resolveSecret(key: string, provided?: Record<string, string>): string | null {
  const fromEnv = process.env[key];
  if (fromEnv) return fromEnv;
  const explicit = provided?.[key];
  return explicit ?? null;
}

/**
 * Install a catalog server: resolve secrets, write the standard MCP config
 * (never the buffconfig), return the config written. Skips when already
 * installed. Secrets are resolved from the environment or `providedSecrets`;
 * missing required secrets → ok:false with the key named (never logged).
 */
export function installCatalogServer(
  entry: MCPCatalogEntry,
  providedSecrets?: Record<string, string>,
  configDir?: string,
): { ok: boolean; reason?: string; path?: string } {
  const target = catalogConfigPath(entry.name, configDir);
  if (existsSync(target)) {
    return { ok: false, reason: `already installed at ${target}` };
  }

  // Resolve env (secrets + static values).
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.env ?? {})) {
    const resolved = value === 'prompt-secret' ? resolveSecret(key, providedSecrets) : value;
    if (resolved === null) {
      return { ok: false, reason: `missing required env var ${key} — set it or pass a value` };
    }
    env[key] = resolved;
  }

  const config: MCPServerConfig = {
    name: entry.name,
    transport: entry.transport,
    enabled: true,
    ...(entry.command ? { command: entry.command } : {}),
    ...(entry.args ? { args: entry.args } : {}),
    ...(entry.url ? { url: entry.url } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };

  try {
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, JSON.stringify(config, null, 2), 'utf-8');
    logger.success(`Installed MCP server '${entry.name}' → ${target}`);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, reason: `write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Uninstall a catalog server (remove its config file). */
export function uninstallCatalogServer(name: string, configDir?: string): { ok: boolean; reason?: string } {
  const target = catalogConfigPath(name, configDir);
  if (!existsSync(target)) {
    return { ok: false, reason: `'${name}' is not installed (no config at ${target})` };
  }
  try {
    unlinkSync(target);
    logger.success(`Uninstalled MCP server '${name}'`);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `unlink failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
