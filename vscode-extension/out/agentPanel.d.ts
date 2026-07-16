/**
 * Agent Panel — A VS Code WebView panel that displays real-time
 * agent execution progress, logs, diffs, and results.
 *
 * Features:
 * - Real-time progress updates with phase indicators
 * - Expandable log viewer
 * - File changes list with accept/reject controls
 * - Inline diff preview
 * - Status bar updates
 */
import * as vscode from 'vscode';
import type { AgentProgress, AgentResult, FileChange } from './types.js';
export declare class AgentPanel {
    static readonly viewType = "agent-baba-d.agentProgress";
    private panel;
    private disposables;
    private currentResult;
    private onAcceptChanges?;
    private onRejectChanges?;
    private onCancelTask?;
    /**
     * Create or reveal the agent progress panel.
     */
    createOrShow(extensionUri: vscode.Uri): void;
    /**
     * Set callbacks for webview actions.
     */
    setCallbacks(opts: {
        onAcceptChanges?: (changes: FileChange[]) => void;
        onRejectChanges?: (changes: FileChange[]) => void;
        onCancelTask?: () => void;
    }): void;
    /**
     * Update the progress display with the latest state.
     */
    updateProgress(progress: AgentProgress): void;
    /**
     * Show the final result of an agent task.
     */
    showResult(result: AgentResult): void;
    /**
     * Show an error message in the panel.
     */
    showError(error: string): void;
    /**
     * Update the status message.
     */
    updateStatus(status: string): void;
    /**
     * Show file diffs for proposed changes.
     */
    showDiffs(changes: FileChange[]): void;
    /**
     * Reset the panel to its initial state.
     */
    clear(): void;
    /**
     * Check if the panel is visible.
     */
    get isVisible(): boolean;
    private handleMessage;
    private dispose;
    private getWebviewContent;
}
//# sourceMappingURL=agentPanel.d.ts.map