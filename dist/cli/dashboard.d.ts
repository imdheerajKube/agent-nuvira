/**
 * Dashboard command — Launch the Agent-Nuvira Web UI Dashboard.
 *
 * Usage:
 *   agent-nuvira dashboard          — Start dashboard on default port (3030)
 *   agent-nuvira dashboard --port 8080 — Start on a specific port
 *   agent-nuvira dashboard --host 0.0.0.0 — Listen on all interfaces
 *   agent-nuvira dashboard --build  — Build the dashboard before starting
 *   agent-nuvira dashboard --no-open — Don't auto-open browser
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
     * Open the browser to the dashboard URL.
     * Uses the platform-specific command (open, xdg-open, start).
     */
    private openBrowser;
}
//# sourceMappingURL=dashboard.d.ts.map