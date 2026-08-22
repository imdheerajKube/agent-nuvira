/**
 * CrossSessionPersistence — Maintain memory across sessions.
 *
 * Loads and saves memory context at session boundaries to enable
 * continuous learning across multiple sessions.
 *
 * Features:
 * - Session context loading at start
 * - Session context saving at end
 * - Session history tracking
 * - Automatic cleanup of old sessions
 */

import { getSQLiteStore, type SQLiteStore } from './sqlite-store.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SessionContext {
  sessionId: string;
  memories: any[];
  trajectories: any[];
  patterns: any[];
  lessons: any[];
  startedAt: number;
  endedAt?: number;
  summary?: string;
}

interface SessionHistory {
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  memoryCount: number;
  trajectoryCount: number;
}

// ─── Cross-Session Persistence ──────────────────────────────────────────────

export class CrossSessionPersistence {
  private store: SQLiteStore;
  private currentSessionId: string | null = null;

  constructor(store?: SQLiteStore) {
    this.store = store || getSQLiteStore();
  }

  /**
   * Load session context at session start.
   */
  async loadSessionContext(sessionId: string): Promise<SessionContext> {
    this.currentSessionId = sessionId;

    // Load recent memories
    const memories = this.store.listMemories(undefined, 100);

    // Load recent trajectories
    const trajectories = this.store.getRecentTrajectories(50);

    // Load top patterns
    const patterns = this.store.getTopPatterns(20);

    // Load recent lessons
    const lessons = [
      ...this.store.getLessonsBySeverity('critical', 10),
      ...this.store.getLessonsBySeverity('high', 10),
    ];

    return {
      sessionId,
      memories,
      trajectories,
      patterns,
      lessons,
      startedAt: Date.now(),
    };
  }

  /**
   * Save session context at session end.
   */
  async saveSessionContext(context: SessionContext): Promise<void> {
    // Context is already persisted via individual operations
    // This method just logs and updates metadata
    logger.debug(`Session ${context.sessionId} saved: ${context.memories.length} memories, ${context.trajectories.length} trajectories`);
  }

  /**
   * Get session history.
   */
  getSessionHistory(limit = 20): SessionHistory[] {
    // Get from trajectories
    const trajectories = this.store.getRecentTrajectories(1000);

    // Group by session
    const sessions = new Map<string, SessionHistory>();

    for (const t of trajectories) {
      if (!sessions.has(t.session_id)) {
        sessions.set(t.session_id, {
          sessionId: t.session_id,
          startedAt: t.created_at,
          memoryCount: 0,
          trajectoryCount: 0,
        });
      }

      const session = sessions.get(t.session_id)!;
      session.trajectoryCount++;
      session.endedAt = t.created_at;
    }

    return Array.from(sessions.values())
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  /**
   * Get context for a specific session.
   */
  async getSessionContext(sessionId: string): Promise<SessionContext | null> {
    // Load memories created in this session
    const memories = this.store.listMemories(undefined, 1000)
      .filter((m: any) => m.session_id === sessionId);

    // Load trajectories for this session
    const trajectories = this.store.getRecentTrajectories(1000)
      .filter((t: any) => t.session_id === sessionId);

    if (memories.length === 0 && trajectories.length === 0) {
      return null;
    }

    return {
      sessionId,
      memories,
      trajectories,
      patterns: [],
      lessons: [],
      startedAt: trajectories[0]?.created_at || Date.now(),
      endedAt: trajectories[trajectories.length - 1]?.created_at,
    };
  }

  /**
   * Get memory context for prompt injection.
   */
  async getMemoryContext(query: string): Promise<{
    facts: string;
    patterns: string;
    lessons: string;
    trajectories: string;
  }> {
    // Search for relevant memories
    const memories = this.store.searchMemories(query, 20);
    const facts = memories
      .filter((m: any) => m.type === 'fact' || m.type === 'observation')
      .map((m: any) => m.content)
      .join('\n');

    // Get relevant patterns
    const patterns = this.store.getTopPatterns(10)
      .map((p: any) => p.pattern)
      .join('\n');

    // Get relevant lessons
    const lessons = [
      ...this.store.getLessonsBySeverity('critical', 5),
      ...this.store.getLessonsBySeverity('high', 5),
    ].map((l: any) => l.lesson)
      .join('\n');

    // Get similar trajectories
    const trajectories = this.store.getRecentTrajectories(10)
      .map((t: any) => `User: ${t.user_text.slice(0, 100)}\nAssistant: ${t.assistant_text.slice(0, 100)}`)
      .join('\n');

    return {
      facts,
      patterns,
      lessons,
      trajectories,
    };
  }

  /**
   * Cleanup old sessions.
   */
  cleanupOldSessions(maxAgeDays = 30): number {
    // This is a placeholder - in production, implement proper cleanup
    logger.debug(`CrossSessionPersistence: Cleanup not implemented yet`);
    return 0;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: CrossSessionPersistence | null = null;

export function getCrossSessionPersistence(): CrossSessionPersistence {
  if (!_instance) _instance = new CrossSessionPersistence();
  return _instance;
}

export function resetCrossSessionPersistence(): void {
  _instance = null;
}


