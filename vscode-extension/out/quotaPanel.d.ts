/**
 * Quota Panel — A VS Code WebView panel that visualizes the central quota
 * ledger (`~/.buff/memory/quota-ledger.json` + `quota-events.jsonl`).
 *
 * Mirrors the dashboard's Quota card so the extension view matches the CLI
 * transparency story:
 * - Summary cards (free/local savings vs paid spend, estimated $ saved)
 * - Ledger entries table (tokens consumed, reset window, parked state)
 * - Failover timeline (parked → failover → re-enabled)
 *
 * The panel is purely read-only — it renders whatever CLIManager.getQuotaStatus()
 * returns, offers a manual "Refresh" action, AND auto-refreshes live when the
 * ledger/timeline files change (fs.watch on the memory dir, mirroring the
 * dashboard's SSE quota watcher) so parked/failover events appear instantly
 * without clicking.
 */
import * as vscode from 'vscode';
import type { QuotaStatusInfo } from './types.js';
/**
 * True when a watch event filename refers to a quota file we care about.
 * A null/empty filename is treated as a trigger too (some platforms report
 * null on directory watches); macOS FSEvents can report FULL PATHS, so
 * normalize with basename() before comparing — exactly like the dashboard's
 * armQuotaWatcher.
 */
export declare function isQuotaWatchFile(filename: string | null | undefined): boolean;
export declare class QuotaPanel {
    static readonly viewType = "agent-nuvira.quotaView";
    private panel;
    private disposables;
    private loadStatus;
    /** Memory dir watched for live quota updates (BUFF_MEMORY_DIR-aware). */
    private watchDir;
    private watcher;
    private watchTimer;
    /** Periodic poll fallback (undefined while not armed). */
    private pollTimer;
    constructor(options: {
        loadStatus: () => Promise<QuotaStatusInfo>;
        /** Override the watched memory dir (defaults to BUFF_MEMORY_DIR || ~/.buff/memory). */
        watchDir?: string;
        /** Override the poll-fallback interval (ms). Default 60000. Tests inject a tiny value. */
        pollMs?: number;
    });
    private pollMs;
    /**
     * Create or reveal the quota panel.
     */
    createOrShow(extensionUri: vscode.Uri): void;
    /**
     * (Re)load the quota status from the CLI memory dir and render it.
     * Best-effort — a failed read renders the empty state.
     */
    refresh(): Promise<void>;
    /**
     * Check if the panel is visible.
     */
    get isVisible(): boolean;
    /**
     * Watch the memory dir and auto-refresh when quota files change, so a
     * failover/park/window-reset written by ANY process sharing BUFF_MEMORY_DIR
     * (CLI, chat, dashboard) shows up instantly without clicking Refresh.
     * Best-effort — a failed watcher must never break the panel.
     */
    private armWatcher;
    private disarmWatcher;
    private dispose;
    private getWebviewContent;
}
//# sourceMappingURL=quotaPanel.d.ts.map