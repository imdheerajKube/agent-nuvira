/**
 * I7 P2 — Curated MCP catalog (`src/mcp/catalog.ts`).
 *
 * A vetted list
 * of MCP servers with EXACT-VERSION pins (no floating tags), a "vetted by"
 * stamp, and `prompt-secret` env placeholders that are resolved at install
 * time (from the environment or an explicit value) and written into the
 * standard MCP config file (~/.nuvira/mcp/<name>.json) — never into
 * buffconfig.json, and never echoed to the terminal.
 *
 * CLI surface (src/cli/mcp.ts):
 *   nuvira mcp catalog [--search <q>]   — list vetted servers (+ installed badge)
 *   nuvira mcp install <name>           — resolve pins → write config → ready
 *   nuvira mcp uninstall <name>         — remove the config file
 */
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
export declare const MCP_CATALOG: MCPCatalogEntry[];
/** Find a catalog entry by name. */
export declare function getCatalogEntry(name: string): MCPCatalogEntry | null;
/** Search the catalog by name/description keyword. */
export declare function searchCatalog(query: string): MCPCatalogEntry[];
/** The per-server config file for an installed catalog server. */
export declare function catalogConfigPath(name: string, configDir?: string): string;
/** Is a catalog server already installed? */
export declare function isCatalogServerInstalled(name: string, configDir?: string): boolean;
/**
 * Resolve a `prompt-secret` env value: from the live environment first; else
 * `provided` (the CLI's prompted value); else null (caller reports missing).
 */
export declare function resolveSecret(key: string, provided?: Record<string, string>): string | null;
/**
 * Install a catalog server: resolve secrets, write the standard MCP config
 * (never the buffconfig), return the config written. Skips when already
 * installed. Secrets are resolved from the environment or `providedSecrets`;
 * missing required secrets → ok:false with the key named (never logged).
 */
export declare function installCatalogServer(entry: MCPCatalogEntry, providedSecrets?: Record<string, string>, configDir?: string): {
    ok: boolean;
    reason?: string;
    path?: string;
};
/** Uninstall a catalog server (remove its config file). */
export declare function uninstallCatalogServer(name: string, configDir?: string): {
    ok: boolean;
    reason?: string;
};
//# sourceMappingURL=catalog.d.ts.map