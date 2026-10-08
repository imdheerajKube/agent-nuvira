/**
 * MCP discovery — every MCP tool the agent can reach, WITHOUT connecting.
 *
 * Two sources, merged live-first:
 *
 *   1. servers connected THIS process — the freshest tool lists;
 *   2. cached schemas from a PREVIOUS process, trusted only while the server is
 *      still configured AND its config hash is unchanged.
 *
 * The cache is what makes discovery survive a cold start: without it, a fresh
 * process sees an MCP server's tools only after something has connected, so
 * "what can I do?" is unanswerable exactly when the user is asking it.
 *
 * This function NEVER connects. A capability search must not be able to spawn a
 * server as a side effect, so an unreachable server simply contributes its cached
 * schemas or nothing.
 */

import type { ToolAnnotations } from './types.js';

/** An MCP tool, normalised for discovery. */
export interface DiscoverableMcpTool {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

const keyOf = (t: { server: string; name: string }): string => `${t.server}/${t.name}`;

/**
 * Merge the live connection state with the persisted schema cache.
 *
 * Live wins on a collision — a connected server's current tool list is the
 * authority, and the cache is only a memory of a previous one.
 */
export async function readDiscoverableMcpTools(): Promise<DiscoverableMcpTool[]> {
  const out = new Map<string, DiscoverableMcpTool>();

  // ── 1. Live: servers connected in THIS process ──
  try {
    const { getMCPToolManager } = await import('../tools/mcp-client-tool.js');
    for (const t of getMCPToolManager().listTools()) out.set(keyOf(t), t as DiscoverableMcpTool);
  } catch {
    // Best-effort — no live manager means the cache is all we have (or nothing).
  }

  // ── 2. Cache: servers discovered by a PREVIOUS process ──
  try {
    const [{ getMCPSchemaCache, MCPSchemaCache }, { MCPManager }] = await Promise.all([
      import('./mcp-schema-cache.js'),
      import('./manager.js'),
    ]);
    const cache = getMCPSchemaCache();

    // The current configs are the authority on which servers still exist and what
    // each hashes to — so a RECONFIGURED server's stale schemas are pruned rather
    // than trusted, and an uninstalled server's schemas are dropped entirely.
    const hashes = new Map(
      new MCPManager()
        .discoverConfigs()
        .map((c) => [c.name, MCPSchemaCache.computeConfigHash(c as unknown as Record<string, unknown>)]),
    );
    cache.prune((name) => hashes.get(name));

    for (const entry of cache.getAll()) {
      if (hashes.get(entry.serverName) !== entry.configHash) continue;
      for (const tool of entry.tools) {
        const candidate: DiscoverableMcpTool = {
          server: entry.serverName,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        };
        if (!out.has(keyOf(candidate))) out.set(keyOf(candidate), candidate);
      }
    }
  } catch {
    // Best-effort — an unreadable cache must never break discovery.
  }

  return [...out.values()];
}
