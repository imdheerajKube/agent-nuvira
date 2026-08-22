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
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

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

// ─── Browser Dialog Manager ───────────────────────────────────────────────

export class BrowserDialogManager {
  private dialogHistory: Array<{
    dialog: PendingDialog;
    action: 'accept' | 'dismiss';
    value?: string;
    timestamp: number;
  }> = [];

  /**
   * Get status of pending dialogs.
   */
  getStatus(taskId: string): DialogStatus {
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
  async respond(
    taskId: string,
    dialogIndex: number,
    action: 'accept' | 'dismiss',
    value?: string,
  ): Promise<DialogResponse> {
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
    } catch (err) {
      return { success: false, dialog, action, error: String(err) };
    }
  }

  /**
   * Accept all pending dialogs.
   */
  async acceptAll(taskId: string): Promise<DialogResponse[]> {
    const status = this.getStatus(taskId);
    const responses: DialogResponse[] = [];

    for (let i = 0; i < status.pendingDialogs.length; i++) {
      responses.push(await this.respond(taskId, i, 'accept'));
    }

    return responses;
  }

  /**
   * Dismiss all pending dialogs.
   */
  async dismissAll(taskId: string): Promise<DialogResponse[]> {
    const status = this.getStatus(taskId);
    const responses: DialogResponse[] = [];

    for (let i = 0; i < status.pendingDialogs.length; i++) {
      responses.push(await this.respond(taskId, i, 'dismiss'));
    }

    return responses;
  }

  /**
   * Get dialog history.
   */
  getHistory(): Array<{
    dialog: PendingDialog;
    action: 'accept' | 'dismiss';
    value?: string;
    timestamp: number;
  }> {
    return [...this.dialogHistory];
  }

  /**
   * Clear dialog history.
   */
  clearHistory(): void {
    this.dialogHistory = [];
  }
}

// ─── Supervisor access ─────────────────────────────────────────────────

import { getSupervisor } from './browser-supervisor.js';
import type { CDPSupervisor } from './browser-supervisor.js';

// Cache supervisors by task ID
const supervisorCache = new Map<string, CDPSupervisor>();

// ─── Singleton ────────────────────────────────────────────────────────────

let _instance: BrowserDialogManager | null = null;

export function getBrowserDialogManager(): BrowserDialogManager {
  if (!_instance) _instance = new BrowserDialogManager();
  return _instance;
}

export function resetBrowserDialogManager(): void {
  _instance = null;
}
