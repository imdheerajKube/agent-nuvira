/**
 * F2 follow-up — Agent-Nuvira as an MCP SERVER (`src/mcp/server.ts`).
 *
 * Exposes the H1 tool registry over the Model Context Protocol so OTHER
 * clients (dashboard, gateway, IDEs, MCP hosts, other agents) can invoke
 * the agent's tools without going through the CLI.
 * a Python reference implementation of an MCP stdio server (the plan's
 * F2 "expose agent tools via MCP" outcome — the CONSUMING side landed in
 * Session 28 with the SDK-based client).
 *
 * The public surface is deliberately SAFE:
 * - Pipeline tools (`build` / `resume` / `repair` / `document` / `website` /
 *   `analyze` / `test`) — headless runs (no ink board; the orchestrator still
 *   emits its usual observability events).
 * - `code_search` — pure filesystem, no LLM, no loop.
 * - `web_search` / `read_page` — read-only network (timeouts + browser UA),
 *   no LLM, no loop.
 *
 * Deliberately EXCLUDED (they need an interactive loop or a live user):
 * - `ask_user` / `suggest_followups` — loop-internal experience tools.
 * - `verify_requirement` / `delegate` — require a resolved LLM (callLLM).
 * - `publish` — irreversible; stays CLI-only where the confirm path exists.
 *
 * Every tool runs with `board: false` (headless) and a fresh ConfigManager —
 * the same pipeline core the CLI uses, with zero divergence.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConfigManager } from '../config/manager.js';
/** Server identity advertised to MCP clients. */
export declare const AGENT_MCP_SERVER_INFO: {
    name: string;
    version: string;
};
/**
 * The safe public MCP surface — pipeline tools + code_search. Kept as an
 * explicit allowlist (not `listTools()` minus exclusions) so adding a new
 * registry tool NEVER silently exposes it over MCP.
 */
export declare const AGENT_MCP_TOOL_NAMES: readonly ["build", "resume", "repair", "document", "website", "analyze", "test", "code_search", "web_search", "read_page"];
/** Options for createAgentMcpServer. */
export interface AgentMcpServerOptions {
    /** Working directory for tool runs (defaults to process.cwd()). */
    cwd?: string;
    /** ConfigManager override (tests inject a temp-config instance). */
    configManager?: ConfigManager;
    /**
     * Extra tools to expose beyond the safe surface (e.g. 'publish'). Empty by
     * default — explicit opt-in for irreversible/loop-dependent tools.
     */
    extraTools?: string[];
}
/**
 * Build the MCP server with every safe H1 tool registered. Returns the SDK
 * McpServer (NOT yet connected — call `connectStdio()` or attach a transport).
 */
export declare function createAgentMcpServer(opts?: AgentMcpServerOptions): Promise<McpServer>;
/**
 * Connect the server over stdio (the standard MCP server transport — how
 * MCP hosts / IDEs / other agents launch MCP servers) and start it.
 * Resolves once listening; the process stays alive until stdin closes.
 */
export declare function connectStdio(server: McpServer): Promise<void>;
/** Convenience: build + connect the stdio server in one call. */
export declare function serveStdio(opts?: AgentMcpServerOptions): Promise<McpServer>;
//# sourceMappingURL=server.d.ts.map