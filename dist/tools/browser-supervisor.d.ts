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
export declare class CDPSupervisor extends EventEmitter {
    private config;
    private ws;
    private snapshot;
    private sessions;
    private eventTimer;
    private connected;
    constructor(config: SupervisorConfig);
    /**
     * Start the supervisor — connect to CDP and subscribe to events.
     */
    start(): Promise<void>;
    /**
     * Stop the supervisor.
     */
    stop(): void;
    /**
     * Get the current snapshot.
     */
    getSnapshot(): SupervisorSnapshot;
    /**
     * Respond to a pending dialog.
     */
    respondToDialog(messageId: number, action: 'accept' | 'dismiss', value?: string): Promise<void>;
    /**
     * Get the frame tree.
     */
    getFrameTree(): Promise<FrameInfo[]>;
    /**
     * Navigate a frame.
     */
    navigateFrame(frameId: string, url: string): Promise<void>;
    private subscribeToEvents;
    private handleMessage;
    private handleDialog;
    private handleFrameNavigated;
    private handleFrameDetached;
    private handleTargetAttached;
    private handleTargetDetached;
    private parseFrameTree;
    private send;
}
/**
 * Get or create a supervisor for a task.
 */
export declare function getSupervisor(taskId: string, cdpUrl: string): CDPSupervisor;
/**
 * Remove a supervisor for a task.
 */
export declare function removeSupervisor(taskId: string): void;
/**
 * Get all active supervisors.
 */
export declare function getActiveSupervisors(): CDPSupervisor[];
//# sourceMappingURL=browser-supervisor.d.ts.map