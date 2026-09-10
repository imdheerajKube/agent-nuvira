/**
 * Browser Dialog Tool — Respond to native JS dialogs.
 *
 * This tool is response-only: the agent reads pending_dialogs from
 * browser_snapshot output, then calls browser_dialog to accept or dismiss.
 *
 * Gated on the same CDP check as browser_cdp so it only appears when a CDP
 * endpoint is reachable.
 *
 * Hermes equivalent: browser_dialog_tool.py
 */
import type { PendingDialog } from './browser-supervisor.js';
export interface DialogResponse {
    /** Whether the response was successful */
    success: boolean;
    /** Dialog that was responded to */
    dialog: PendingDialog;
    /** Action taken */
    action: 'accept' | 'dismiss';
    /** Value entered (for prompt) */
    value?: string;
    /** Error message if failed */
    error?: string;
}
export interface DialogStatus {
    /** Pending dialogs count */
    pendingCount: number;
    /** Pending dialogs */
    pendingDialogs: PendingDialog[];
    /** Supervisor connected */
    supervisorConnected: boolean;
}
export declare class BrowserDialogManager {
    private dialogHistory;
    /**
     * Get status of pending dialogs.
     */
    getStatus(taskId: string): DialogStatus;
    /**
     * Respond to a dialog.
     */
    respond(taskId: string, dialogIndex: number, action: 'accept' | 'dismiss', value?: string): Promise<DialogResponse>;
    /**
     * Accept all pending dialogs.
     */
    acceptAll(taskId: string): Promise<DialogResponse[]>;
    /**
     * Dismiss all pending dialogs.
     */
    dismissAll(taskId: string): Promise<DialogResponse[]>;
    /**
     * Get dialog history.
     */
    getHistory(): Array<{
        dialog: PendingDialog;
        action: 'accept' | 'dismiss';
        value?: string;
        timestamp: number;
    }>;
    /**
     * Clear dialog history.
     */
    clearHistory(): void;
}
export declare function getBrowserDialogManager(): BrowserDialogManager;
export declare function resetBrowserDialogManager(): void;
//# sourceMappingURL=browser-dialog.d.ts.map