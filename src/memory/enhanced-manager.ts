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
import { getMemoryManager, type MemoryManager } from './manager.js';
import { BackgroundSyncManager } from './background-sync.js';
import { SessionExtractionManager } from './session-extraction.js';
import { DriftDetector } from './drift-detector.js';
import { getMemoryStore } from '../tools/memory-tools.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface EnhancedMemoryConfig {
  enableBackgroundSync: boolean;
  enableDriftDetection: boolean;
  enableSessionExtraction: boolean;
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

// ─── Enhanced Memory Manager ────────────────────────────────────────────────

export class EnhancedMemoryManager extends EventEmitter {
  private baseManager: MemoryManager;
  private backgroundSync: BackgroundSyncManager;
  private sessionExtraction: SessionExtractionManager;
  private driftDetector: DriftDetector;
  private config: EnhancedMemoryConfig;
  private metrics: MemoryMetrics;
  private sessionId: string | null = null;

  constructor(config?: Partial<EnhancedMemoryConfig>) {
    super();
    this.config = {
      enableBackgroundSync: config?.enableBackgroundSync ?? true,
      enableDriftDetection: config?.enableDriftDetection ?? true,
      enableSessionExtraction: config?.enableSessionExtraction ?? true,
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
  private setupEventHandlers(): void {
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
  async startSession(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    await this.baseManager.startSession(sessionId);
    this.emit('session:started', { sessionId });
  }

  /**
   * Build memory block for a query.
   */
  async buildMemoryBlock(query: string): Promise<any> {
    return this.baseManager.buildMemoryBlock(query);
  }

  /**
   * Record a completed user↔assistant turn (buffered, zero-cost).
   */
  async recordTurn(userText: string, assistantText: string): Promise<void> {
    // Buffer for session extraction
    if (this.config.enableSessionExtraction) {
      this.sessionExtraction.bufferTurn(userText, assistantText);
      this.metrics.turnsBuffered++;
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
    await this.baseManager.recordTurn(userText, assistantText).catch(() => {});
  }

  /**
   * End the session — flush buffered turns into durable facts.
   */
  async endSession(): Promise<string | null> {
    const sid = this.sessionId;
    if (!sid) return null;

    // Extract facts from buffered turns
    if (this.config.enableSessionExtraction) {
      const result = await this.sessionExtraction.extractAtSessionEnd();
      this.metrics.factsExtracted += result.statistics.factsExtracted;
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
  private async executeSyncTask(
    task: any,
    resolve: () => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    try {
      // Process the sync task
      await this.baseManager.recordTurn(
        task.data.userText,
        task.data.assistantText,
      );
      resolve();
    } catch (err: any) {
      reject(err);
    }
  }

  /**
   * Add a memory with drift detection.
   */
  async addMemoryWithDriftDetection(
    filePath: string,
    content: string,
  ): Promise<{ success: boolean; driftDetected: boolean }> {
    if (this.config.enableDriftDetection) {
      // Check for drift
      const driftCheck = this.driftDetector.checkDrift(filePath);
      if (driftCheck.hasDrift) {
        this.metrics.driftsDetected++;
        this.emit('drift:detected', { path: filePath, driftCheck });

        // Create backup
        const backupPath = this.driftDetector.backup(filePath);

        // Merge changes
        const merged = this.driftDetector.merge(
          filePath,
          content,
          driftCheck.currentContent || '',
        );

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
  getMetrics(): MemoryMetrics & { backgroundSync: any } {
    return {
      ...this.metrics,
      backgroundSync: this.backgroundSync.getMetrics(),
    };
  }

  /**
   * Get background sync manager.
   */
  getBackgroundSync(): BackgroundSyncManager {
    return this.backgroundSync;
  }

  /**
   * Get drift detector.
   */
  getDriftDetector(): DriftDetector {
    return this.driftDetector;
  }

  /**
   * Shutdown gracefully.
   */
  async shutdown(): Promise<void> {
    await this.backgroundSync.shutdown();
    this.removeAllListeners();
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: EnhancedMemoryManager | null = null;

export function getEnhancedMemoryManager(): EnhancedMemoryManager {
  if (!_instance) _instance = new EnhancedMemoryManager();
  return _instance;
}

export function resetEnhancedMemoryManager(): void {
  if (_instance) {
    _instance.shutdown();
    _instance = null;
  }
}
