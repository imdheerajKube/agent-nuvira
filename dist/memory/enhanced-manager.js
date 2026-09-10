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
import { getMemoryManager } from './manager.js';
import { BackgroundSyncManager } from './background-sync.js';
import { SessionExtractionManager } from './session-extraction.js';
import { DriftDetector } from './drift-detector.js';
import { getSQLiteStore } from './sqlite-store.js';
import { getCrossSessionPersistence } from './cross-session.js';
import { logger } from '../utils/logger.js';
// ─── Enhanced Memory Manager ────────────────────────────────────────────────
export class EnhancedMemoryManager extends EventEmitter {
    baseManager;
    backgroundSync;
    sessionExtraction;
    driftDetector;
    config;
    metrics;
    sessionId = null;
    sqliteStore = null;
    crossSession = null;
    constructor(config) {
        super();
        this.config = {
            enableBackgroundSync: config?.enableBackgroundSync ?? true,
            enableDriftDetection: config?.enableDriftDetection ?? true,
            enableSessionExtraction: config?.enableSessionExtraction ?? true,
            enableSQLite: config?.enableSQLite ?? true,
            syncConcurrency: config?.syncConcurrency ?? 3,
            drainTimeoutMs: config?.drainTimeoutMs ?? 5000,
        };
        this.baseManager = getMemoryManager();
        this.backgroundSync = new BackgroundSyncManager({
            maxConcurrent: this.config.syncConcurrency,
            drainTimeoutMs: this.config.drainTimeoutMs,
        });
        this.sessionExtraction = new SessionExtractionManager();
        this.driftDetector = new DriftDetector();
        // Initialize SQLite if enabled
        if (this.config.enableSQLite) {
            this.sqliteStore = getSQLiteStore();
            this.crossSession = getCrossSessionPersistence();
        }
        this.metrics = {
            turnsBuffered: 0,
            factsExtracted: 0,
            driftsDetected: 0,
            backgroundTasksQueued: 0,
            backgroundTasksCompleted: 0,
        };
        this.setupEventHandlers();
    }
    /**
     * Setup event handlers for background sync.
     */
    setupEventHandlers() {
        this.backgroundSync.on('task:completed', (event) => {
            this.metrics.backgroundTasksCompleted++;
            this.emit('sync:completed', event);
        });
        this.backgroundSync.on('task:failed', (event) => {
            logger.debug(`Background sync task failed: ${event.error}`);
            this.emit('sync:failed', event);
        });
        this.backgroundSync.on('task:execute', (task, resolve, reject) => {
            this.executeSyncTask(task, resolve, reject);
        });
    }
    /**
     * Begin a session.
     */
    async startSession(sessionId) {
        this.sessionId = sessionId;
        await this.baseManager.startSession(sessionId);
        // Load cross-session context if SQLite is enabled
        if (this.crossSession) {
            const context = await this.crossSession.loadSessionContext(sessionId);
            this.emit('session:started', { sessionId, contextLoaded: true });
        }
        else {
            this.emit('session:started', { sessionId, contextLoaded: false });
        }
    }
    /**
     * Build memory block for a query.
     */
    async buildMemoryBlock(query) {
        return this.baseManager.buildMemoryBlock(query);
    }
    /**
     * Record a completed user↔assistant turn (buffered, zero-cost).
     */
    async recordTurn(userText, assistantText) {
        // Buffer for session extraction
        if (this.config.enableSessionExtraction) {
            this.sessionExtraction.bufferTurn(userText, assistantText);
            this.metrics.turnsBuffered++;
        }
        // Save to SQLite if enabled
        if (this.sqliteStore && this.sessionId) {
            const trajectoryId = `traj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            this.sqliteStore.addTrajectory({
                id: trajectoryId,
                sessionId: this.sessionId,
                userText,
                assistantText,
            });
        }
        // Queue background sync
        if (this.config.enableBackgroundSync) {
            this.backgroundSync.enqueue({
                type: 'sync',
                data: { userText, assistantText, sessionId: this.sessionId },
                priority: 0,
            });
            this.metrics.backgroundTasksQueued++;
        }
        // Record in base manager (best-effort)
        await this.baseManager.recordTurn(userText, assistantText).catch(() => { });
    }
    /**
     * End the session — flush buffered turns into durable facts.
     */
    async endSession() {
        const sid = this.sessionId;
        if (!sid)
            return null;
        // Extract facts from buffered turns
        if (this.config.enableSessionExtraction) {
            const result = await this.sessionExtraction.extractAtSessionEnd();
            this.metrics.factsExtracted += result.statistics.factsExtracted;
            // Save extracted facts to SQLite
            if (this.sqliteStore) {
                for (const fact of result.facts) {
                    this.sqliteStore.addMemory({
                        id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        content: fact.content,
                        type: fact.type,
                        tags: fact.tags,
                        source: fact.source,
                        confidence: fact.confidence,
                        sessionId: sid,
                    });
                }
                // Save extracted patterns
                for (const pattern of result.patterns) {
                    this.sqliteStore.upsertPattern({
                        id: `pat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        pattern,
                        examples: [],
                        confidence: 0.5,
                    });
                }
                // Save extracted lessons
                for (const lesson of result.lessons) {
                    this.sqliteStore.addLesson({
                        id: `les_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        lesson,
                        context: 'session-extraction',
                        severity: 'medium',
                    });
                }
            }
            this.emit('session:extracted', result);
        }
        // Drain background sync queue
        if (this.config.enableBackgroundSync) {
            await this.backgroundSync.drain(this.config.drainTimeoutMs);
        }
        // End base session
        const endedSid = await this.baseManager.endSession();
        this.sessionId = null;
        this.emit('session:ended', { sessionId: sid });
        return endedSid;
    }
    /**
     * Execute a sync task in background.
     */
    async executeSyncTask(task, resolve, reject) {
        try {
            // Process the sync task
            await this.baseManager.recordTurn(task.data.userText, task.data.assistantText);
            resolve();
        }
        catch (err) {
            reject(err);
        }
    }
    /**
     * Add a memory with drift detection.
     */
    async addMemoryWithDriftDetection(filePath, content) {
        if (this.config.enableDriftDetection) {
            // Check for drift
            const driftCheck = this.driftDetector.checkDrift(filePath);
            if (driftCheck.hasDrift) {
                this.metrics.driftsDetected++;
                this.emit('drift:detected', { path: filePath, driftCheck });
                // Create backup
                const backupPath = this.driftDetector.backup(filePath);
                // Merge changes
                const merged = this.driftDetector.merge(filePath, content, driftCheck.currentContent || '');
                // Write merged content
                const fs = await import('fs');
                fs.writeFileSync(filePath, merged, 'utf-8');
                return { success: true, driftDetected: true };
            }
            // Snapshot before write
            this.driftDetector.snapshot(filePath);
        }
        // Write content
        const fs = await import('fs');
        fs.writeFileSync(filePath, content, 'utf-8');
        return { success: true, driftDetected: false };
    }
    /**
     * Get metrics.
     */
    getMetrics() {
        return {
            ...this.metrics,
            backgroundSync: this.backgroundSync.getMetrics(),
            sqlite: this.sqliteStore?.getStats(),
        };
    }
    /**
     * Get SQLite store.
     */
    getSQLiteStore() {
        return this.sqliteStore;
    }
    /**
     * Get cross-session persistence.
     */
    getCrossSession() {
        return this.crossSession;
    }
    /**
     * Get background sync manager.
     */
    getBackgroundSync() {
        return this.backgroundSync;
    }
    /**
     * Get drift detector.
     */
    getDriftDetector() {
        return this.driftDetector;
    }
    /**
     * Shutdown gracefully.
     */
    async shutdown() {
        await this.backgroundSync.shutdown();
        this.removeAllListeners();
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let _instance = null;
export function getEnhancedMemoryManager() {
    if (!_instance)
        _instance = new EnhancedMemoryManager();
    return _instance;
}
export function resetEnhancedMemoryManager() {
    if (_instance) {
        _instance.shutdown();
        _instance = null;
    }
}
//# sourceMappingURL=enhanced-manager.js.map