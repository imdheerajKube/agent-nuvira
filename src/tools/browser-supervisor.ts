/**
 * Browser Supervisor — Persistent CDP supervisor for dialog + frame detection.
 *
 * One CDPSupervisor runs per task that has a reachable CDP endpoint. It holds
 * a single persistent WebSocket to the browser, subscribes to Page/Runtime/Target
 * events, and surfaces observable state — pending dialogs and frame tree — through
 * a thread-safe snapshot that tool handlers consume.
 *
 * The supervisor output reaches the agent via:
 * 1. browser_snapshot merges supervisor state into its return payload
 * 2. browser_dialog tool responds to pending dialogs
 *
 * Hermes equivalent: browser_supervisor.py
 */

import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface SupervisorConfig {
  /** CDP WebSocket URL */
  cdpUrl: string;
  /** Task ID for isolation */
  taskId: string;
  /** Session timeout in ms (default: 300000) */
  timeoutMs?: number;
}

export interface SupervisorSnapshot {
  /** Whether supervisor is connected */
  connected: boolean;
  /** Pending dialogs */
  pendingDialogs: PendingDialog[];
  /** Frame tree */
  frames: FrameInfo[];
  /** Attached session IDs */
  sessions: string[];
  /** Last event timestamp */
  lastEventAt: number;
  /** Error message if disconnected */
  error?: string;
}

export interface PendingDialog {
  /** Dialog type */
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  /** Dialog message */
  message: string;
  /** Dialog URL */
  url: string;
  /** Default value (for prompt) */
  defaultValue?: string;
  /** CDP message ID for response */
  messageId: number;
  /** When dialog appeared */
  appearedAt: number;
}

export interface FrameInfo {
  /** Frame ID */
  id: string;
  /** Frame URL */
  url: string;
  /** Parent frame ID */
  parentId?: string;
  /** Frame name */
  name?: string;
}

// ─── CDPSupervisor ────────────────────────────────────────────────────────

export class CDPSupervisor extends EventEmitter {
  private config: SupervisorConfig;
  private ws: any = null; // WebSocket
  private snapshot: SupervisorSnapshot;
  private sessions: Map<string, string> = new Map(); // sessionId -> targetId
  private eventTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;

  constructor(config: SupervisorConfig) {
    super();
    this.config = config;
    this.snapshot = {
      connected: false,
      pendingDialogs: [],
      frames: [],
      sessions: [],
      lastEventAt: Date.now(),
    };
  }

  /**
   * Start the supervisor — connect to CDP and subscribe to events.
   */
  async start(): Promise<void> {
    try {
      // Dynamic import for WebSocket
      const { default: WebSocket } = await import('ws');
      
      this.ws = new WebSocket(this.config.cdpUrl);

      this.ws.on('open', () => {
        this.connected = true;
        this.snapshot.connected = true;
        this.snapshot.error = undefined;
        logger.info(`Browser Supervisor: Connected to CDP at ${this.config.cdpUrl}`);
        this.emit('connected');
        this.subscribeToEvents();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(JSON.parse(data.toString()));
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.snapshot.connected = false;
        logger.info('Browser Supervisor: Disconnected');
        this.emit('disconnected');
      });

      this.ws.on('error', (err: Error) => {
        this.snapshot.error = err.message;
        logger.error(`Browser Supervisor: WebSocket error: ${err.message}`);
        this.emit('error', err);
      });

      // Set timeout
      if (this.config.timeoutMs) {
        setTimeout(() => {
          if (this.connected) {
            this.stop();
            logger.warn('Browser Supervisor: Timeout reached, stopping');
          }
        }, this.config.timeoutMs);
      }
    } catch (err) {
      logger.error(`Browser Supervisor: Failed to start: ${err}`);
      this.snapshot.error = String(err);
    }
  }

  /**
   * Stop the supervisor.
   */
  stop(): void {
    if (this.eventTimer) {
      clearInterval(this.eventTimer);
      this.eventTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.snapshot.connected = false;
    logger.info('Browser Supervisor: Stopped');
  }

  /**
   * Get the current snapshot.
   */
  getSnapshot(): SupervisorSnapshot {
    return { ...this.snapshot, sessions: [...this.sessions.keys()] };
  }

  /**
   * Respond to a pending dialog.
   */
  async respondToDialog(messageId: number, action: 'accept' | 'dismiss', value?: string): Promise<void> {
    if (!this.connected || !this.ws) {
      throw new Error('Supervisor not connected');
    }

    const method = action === 'accept' ? 'Page.handleJavaScriptDialog' : 'Page.handleJavaScriptDialog';
    const params: Record<string, unknown> = { accept: action === 'accept' };
    if (value !== undefined) params.promptText = value;

    this.ws.send(JSON.stringify({
      id: messageId,
      method,
      params,
    }));

    // Remove from pending
    this.snapshot.pendingDialogs = this.snapshot.pendingDialogs.filter((d) => d.messageId !== messageId);
    this.emit('dialog-resolved', { messageId, action });
  }

  /**
   * Get the frame tree.
   */
  async getFrameTree(): Promise<FrameInfo[]> {
    return this.snapshot.frames;
  }

  /**
   * Navigate a frame.
   */
  async navigateFrame(frameId: string, url: string): Promise<void> {
    if (!this.connected || !this.ws) {
      throw new Error('Supervisor not connected');
    }

    this.ws.send(JSON.stringify({
      id: Date.now(),
      method: 'Page.navigate',
      params: { url, frameId },
    }));
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private subscribeToEvents(): void {
    // Subscribe to Page events
    this.send({ id: 1, method: 'Page.enable' });
    // Subscribe to Runtime events
    this.send({ id: 2, method: 'Runtime.enable' });
    // Subscribe to Target events
    this.send({ id: 3, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } });
    // Get frame tree
    this.send({ id: 4, method: 'Page.getFrameTree' });

    // Periodic health check
    this.eventTimer = setInterval(() => {
      if (this.connected) {
        this.send({ id: Date.now(), method: 'Runtime.evaluate', params: { expression: '1+1' } });
      }
    }, 30_000);
  }

  private handleMessage(msg: any): void {
    this.snapshot.lastEventAt = Date.now();

    // Handle events
    if (msg.method) {
      switch (msg.method) {
        case 'Page.javascriptDialogOpening':
          this.handleDialog(msg.params);
          break;
        case 'Page.frameNavigated':
          this.handleFrameNavigated(msg.params);
          break;
        case 'Page.frameDetached':
          this.handleFrameDetached(msg.params);
          break;
        case 'Target.attachedToTarget':
          this.handleTargetAttached(msg.params);
          break;
        case 'Target.detachedFromTarget':
          this.handleTargetDetached(msg.params);
          break;
      }
    }

    // Handle responses
    if (msg.id === 4 && msg.result?.frameTree) {
      this.parseFrameTree(msg.result.frameTree);
    }

    this.emit('message', msg);
  }

  private handleDialog(params: any): void {
    const dialog: PendingDialog = {
      type: params.type,
      message: params.message,
      url: params.url || '',
      defaultValue: params.defaultPrompt,
      messageId: params.messageId || Date.now(),
      appearedAt: Date.now(),
    };

    this.snapshot.pendingDialogs.push(dialog);
    logger.info(`Browser Supervisor: Dialog appeared: ${dialog.type} - ${dialog.message}`);
    this.emit('dialog', dialog);
  }

  private handleFrameNavigated(params: any): void {
    const frame = params.frame;
    if (!frame) return;

    const existing = this.snapshot.frames.find((f) => f.id === frame.id);
    if (existing) {
      existing.url = frame.url;
      existing.name = frame.name;
    } else {
      this.snapshot.frames.push({
        id: frame.id,
        url: frame.url,
        parentId: frame.parentId,
        name: frame.name,
      });
    }
  }

  private handleFrameDetached(params: any): void {
    this.snapshot.frames = this.snapshot.frames.filter((f) => f.id !== params.frameId);
  }

  private handleTargetAttached(params: any): void {
    this.sessions.set(params.sessionId, params.targetInfo?.targetId || '');
    logger.debug(`Browser Supervisor: Session attached: ${params.sessionId}`);
  }

  private handleTargetDetached(params: any): void {
    this.sessions.delete(params.sessionId);
    logger.debug(`Browser Supervisor: Session detached: ${params.sessionId}`);
  }

  private parseFrameTree(tree: any): void {
    if (!tree?.frame) return;

    const frame: FrameInfo = {
      id: tree.frame.id,
      url: tree.frame.url,
      name: tree.frame.name,
    };

    if (!this.snapshot.frames.find((f) => f.id === frame.id)) {
      this.snapshot.frames.push(frame);
    }

    // Recurse child frames
    if (tree.childFrames) {
      for (const child of tree.childFrames) {
        this.parseFrameTree(child);
      }
    }
  }

  private send(msg: any): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}

// ─── Supervisor Registry ──────────────────────────────────────────────────

const supervisors: Map<string, CDPSupervisor> = new Map();

/**
 * Get or create a supervisor for a task.
 */
export function getSupervisor(taskId: string, cdpUrl: string): CDPSupervisor {
  let supervisor = supervisors.get(taskId);
  if (!supervisor) {
    supervisor = new CDPSupervisor({ taskId, cdpUrl });
    supervisors.set(taskId, supervisor);
  }
  return supervisor;
}

/**
 * Remove a supervisor for a task.
 */
export function removeSupervisor(taskId: string): void {
  const supervisor = supervisors.get(taskId);
  if (supervisor) {
    supervisor.stop();
    supervisors.delete(taskId);
  }
}

/**
 * Get all active supervisors.
 */
export function getActiveSupervisors(): CDPSupervisor[] {
  return [...supervisors.values()];
}
