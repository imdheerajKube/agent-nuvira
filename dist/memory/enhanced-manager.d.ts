/**
 * EnhancedMemoryManager — Memory manager with background sync.
 *
 * Extends the base MemoryManager with:
 * - Background sync for zero-cost per-turn operations
 * - Session-end extraction for fact distillation
 * - Drift detection for memory file safety
 * - Daemon thread management
 *
 * This is the recommended entry point for production use.
 */
import { EventEmitter } from 'events';
import { BackgroundSyncManager } from './background-sync.js';
import { DriftDetector } from './drift-detector.js';
import { type SQLiteStore } from './sqlite-store.js';
import { type CrossSessionPersistence } from './cross-session.js';
interface EnhancedMemoryConfig {
    enableBackgroundSync: boolean;
    enableDriftDetection: boolean;
    enableSessionExtraction: boolean;
    enableSQLite: boolean;
    syncConcurrency: number;
    drainTimeoutMs: number;
}
interface MemoryMetrics {
    turnsBuffered: number;
    factsExtracted: number;
    driftsDetected: number;
    backgroundTasksQueued: number;
    backgroundTasksCompleted: number;
}
export declare class EnhancedMemoryManager extends EventEmitter {
    private baseManager;
    private backgroundSync;
    private sessionExtraction;
    private driftDetector;
    private config;
    private metrics;
    private sessionId;
    private sqliteStore;
    private crossSession;
    constructor(config?: Partial<EnhancedMemoryConfig>);
    /**
     * Setup event handlers for background sync.
     */
    private setupEventHandlers;
    /**
     * Begin a session.
     */
    startSession(sessionId: string): Promise<void>;
    /**
     * Build memory block for a query.
     */
    buildMemoryBlock(query: string): Promise<any>;
    /**
     * Record a completed user↔assistant turn (buffered, zero-cost).
     */
    recordTurn(userText: string, assistantText: string): Promise<void>;
    /**
     * End the session — flush buffered turns into durable facts.
     */
    endSession(): Promise<string | null>;
    /**
     * Execute a sync task in background.
     */
    private executeSyncTask;
    /**
     * Add a memory with drift detection.
     */
    addMemoryWithDriftDetection(filePath: string, content: string): Promise<{
        success: boolean;
        driftDetected: boolean;
    }>;
    /**
     * Get metrics.
     */
    getMetrics(): MemoryMetrics & {
        backgroundSync: any;
        sqlite?: any;
    };
    /**
     * Get SQLite store.
     */
    getSQLiteStore(): SQLiteStore | null;
    /**
     * Get cross-session persistence.
     */
    getCrossSession(): CrossSessionPersistence | null;
    /**
     * Get background sync manager.
     */
    getBackgroundSync(): BackgroundSyncManager;
    /**
     * Get drift detector.
     */
    getDriftDetector(): DriftDetector;
    /**
     * Shutdown gracefully.
     */
    shutdown(): Promise<void>;
}
export declare function getEnhancedMemoryManager(): EnhancedMemoryManager;
export declare function resetEnhancedMemoryManager(): void;
export {};
//# sourceMappingURL=enhanced-manager.d.ts.map