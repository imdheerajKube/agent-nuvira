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
import { logger } from '../utils/logger.js';
// ─── Browser Dialog Manager ───────────────────────────────────────────────
export class BrowserDialogManager {
    dialogHistory = [];
    /**
     * Get status of pending dialogs.
     */
    getStatus(taskId) {
        const supervisor = supervisorCache.get(taskId);
        if (!supervisor) {
            return { pendingCount: 0, pendingDialogs: [], supervisorConnected: false };
        }
        const snapshot = supervisor.getSnapshot();
        return {
            pendingCount: snapshot.pendingDialogs.length,
            pendingDialogs: snapshot.pendingDialogs,
            supervisorConnected: snapshot.connected,
        };
    }
    /**
     * Respond to a dialog.
     */
    async respond(taskId, dialogIndex, action, value) {
        const supervisor = supervisorCache.get(taskId);
        if (!supervisor) {
            return {
                success: false,
                dialog: {
                    type: 'alert',
                    message: 'No dialog found',
                    url: '',
                    messageId: 0,
                    appearedAt: Date.now(),
                },
                action,
                error: 'No supervisor found for this task',
            };
        }
        const snapshot = supervisor.getSnapshot();
        const dialog = snapshot.pendingDialogs[dialogIndex];
        if (!dialog) {
            return {
                success: false,
                dialog: {
                    type: 'alert',
                    message: `No dialog at index ${dialogIndex}`,
                    url: '',
                    messageId: 0,
                    appearedAt: Date.now(),
                },
                action,
                error: `No dialog at index ${dialogIndex}. Pending: ${snapshot.pendingDialogs.length}`,
            };
        }
        try {
            await supervisor.respondToDialog(dialog.messageId, action, value);
            this.dialogHistory.push({
                dialog,
                action,
                value,
                timestamp: Date.now(),
            });
            logger.info(`Browser Dialog: Responded to ${dialog.type} with ${action}`);
            return { success: true, dialog, action, value };
        }
        catch (err) {
            return { success: false, dialog, action, error: String(err) };
        }
    }
    /**
     * Accept all pending dialogs.
     */
    async acceptAll(taskId) {
        const status = this.getStatus(taskId);
        const responses = [];
        for (let i = 0; i < status.pendingDialogs.length; i++) {
            responses.push(await this.respond(taskId, i, 'accept'));
        }
        return responses;
    }
    /**
     * Dismiss all pending dialogs.
     */
    async dismissAll(taskId) {
        const status = this.getStatus(taskId);
        const responses = [];
        for (let i = 0; i < status.pendingDialogs.length; i++) {
            responses.push(await this.respond(taskId, i, 'dismiss'));
        }
        return responses;
    }
    /**
     * Get dialog history.
     */
    getHistory() {
        return [...this.dialogHistory];
    }
    /**
     * Clear dialog history.
     */
    clearHistory() {
        this.dialogHistory = [];
    }
}
// Cache supervisors by task ID
const supervisorCache = new Map();
// ─── Singleton ────────────────────────────────────────────────────────────
let _instance = null;
export function getBrowserDialogManager() {
    if (!_instance)
        _instance = new BrowserDialogManager();
    return _instance;
}
export function resetBrowserDialogManager() {
    _instance = null;
}
//# sourceMappingURL=browser-dialog.js.map