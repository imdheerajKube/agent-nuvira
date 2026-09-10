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
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { listTools } from '../tools/registry.js';
import { ConfigManager } from '../config/manager.js';
import { getEventBus } from '../observability/event-bus.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'));
/** Server identity advertised to MCP clients. */
export const AGENT_MCP_SERVER_INFO = { name: 'agent-nuvira', version: pkg.version };
/**
 * The safe public MCP surface — pipeline tools + code_search. Kept as an
 * explicit allowlist (not `listTools()` minus exclusions) so adding a new
 * registry tool NEVER silently exposes it over MCP.
 */
export const AGENT_MCP_TOOL_NAMES = [
    'build',
    'resume',
    'repair',
    'document',
    'website',
    'analyze',
    'test',
    'code_search',
    'web_search',
    'read_page',
];
/**
 * Build the MCP server with every safe H1 tool registered. Returns the SDK
 * McpServer (NOT yet connected — call `connectStdio()` or attach a transport).
 */
export async function createAgentMcpServer(opts = {}) {
    const server = new McpServer({
        name: AGENT_MCP_SERVER_INFO.name,
        version: AGENT_MCP_SERVER_INFO.version,
    });
    const cwd = opts.cwd ?? process.cwd();
    const configManager = opts.configManager ?? new ConfigManager();
    const configManagerCtx = configManager;
    const toolNames = new Set([...AGENT_MCP_TOOL_NAMES, ...(opts.extraTools ?? [])]);
    for (const tool of listTools()) {
        if (!toolNames.has(tool.name))
            continue;
        registerToolOnMcp(server, tool, { cwd, configManager: configManagerCtx });
    }
    return server;
}
/** Register one H1 tool on the SDK McpServer. */
function registerToolOnMcp(server, tool, ctx) {
    server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: tool.inputSchema,
    }, async (args) => {
        const startedAt = Date.now();
        try {
            // Headless run: no ink board, fresh context per call, observability
            // events still emitted so dashboards see pipeline runs.
            const text = await tool.run(args, {
                configManager: ctx.configManager,
                cwd: ctx.cwd,
                board: false,
                emit: (event, data, source) => {
                    try {
                        getEventBus().emit(event, data, source ?? 'mcp');
                    }
                    catch {
                        // Best-effort — a dead bus must not fail the tool call.
                    }
                },
            });
            return {
                content: [{ type: 'text', text }],
                structuredContent: { durationMs: Date.now() - startedAt },
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Tool "${tool.name}" failed: ${message}`,
                    },
                ],
                isError: true,
                structuredContent: { durationMs: Date.now() - startedAt },
            };
        }
    });
}
/**
 * Connect the server over stdio (the standard MCP server transport — how
 * MCP hosts / IDEs / other agents launch MCP servers) and start it.
 * Resolves once listening; the process stays alive until stdin closes.
 */
export async function connectStdio(server) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
/** Convenience: build + connect the stdio server in one call. */
export async function serveStdio(opts = {}) {
    const server = await createAgentMcpServer(opts);
    await connectStdio(server);
    return server;
}
//# sourceMappingURL=server.js.map