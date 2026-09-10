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
import { type SQLiteStore } from './sqlite-store.js';
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
export declare class CrossSessionPersistence {
    private store;
    private currentSessionId;
    constructor(store?: SQLiteStore);
    /**
     * Load session context at session start.
     */
    loadSessionContext(sessionId: string): Promise<SessionContext>;
    /**
     * Save session context at session end.
     */
    saveSessionContext(context: SessionContext): Promise<void>;
    /**
     * Get session history.
     */
    getSessionHistory(limit?: number): SessionHistory[];
    /**
     * Get context for a specific session.
     */
    getSessionContext(sessionId: string): Promise<SessionContext | null>;
    /**
     * Get memory context for prompt injection.
     */
    getMemoryContext(query: string): Promise<{
        facts: string;
        patterns: string;
        lessons: string;
        trajectories: string;
    }>;
    /**
     * Cleanup old sessions.
     */
    cleanupOldSessions(maxAgeDays?: number): number;
}
export declare function getCrossSessionPersistence(): CrossSessionPersistence;
export declare function resetCrossSessionPersistence(): void;
export {};
//# sourceMappingURL=cross-session.d.ts.map