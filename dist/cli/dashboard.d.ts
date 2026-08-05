/**
 * Dashboard command — Launch the Agent-Nuvira Web UI Dashboard.
 *
 * Usage:
 *   agent-nuvira dashboard          — Start dashboard on default port (3030)
 *   agent-nuvira dashboard --port 8080 — Start on a specific port
 *   agent-nuvira dashboard --host 0.0.0.0 — Listen on all interfaces
 *   agent-nuvira dashboard --build  — Build the dashboard before starting
 *   agent-nuvira dashboard --no-open — Don't auto-open browser
 *   agent-nuvira dashboard --force  — Detect a STALE dashboard on the port and
 *                                     offer to restart it (kills + re-binds)
 *
 * The dashboard provides:
 * - Real-time system overview with stats
 * - Cost tracking visualization (by provider/model)
 * - Conversation history browser
 * - Model benchmark results
 * - Memory store statistics
 * - System health monitoring
 *
 * Data refreshes automatically via Server-Sent Events every 10 seconds.
 * The server runs entirely on Node.js built-in modules (no Express, no WebSocket packages).
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class DashboardCommand extends BaseCommand {
    private server;
    create(): Command;
    private launchDashboard;
    /**
     * Bind one server on the port and keep serving until shutdown.
     *
     * Returns:
     *   'running' — bound successfully; stopped via Ctrl+C (SIGINT/SIGTERM)
     *   'restart' — bind failed with EADDRINUSE and --force killed the stale
     *               dashboard; caller should retry
     *   'failed'  — bind failed and nothing was restarted (hint already logged)
     */
    private serve;
    /**
     * Detect a stale dashboard on the port and — if the user confirms — stop it.
     *
     * Only ever kills a dashboard whose /api/model-registry answers with SPA HTML
     * (the API/SSE mismatch): a CURRENT dashboard is never touched, and a
     * non-dashboard process is never touched.
     */
    private tryForceRestart;
    private logEADDRINUSE;
    /**
     * Open the browser to the dashboard URL.
     * Uses the platform-specific command (open, xdg-open, start).
     */
    private openBrowser;
}
//# sourceMappingURL=dashboard.d.ts.map