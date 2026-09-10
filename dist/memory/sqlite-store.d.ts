/**
 * SQLiteStore — Enterprise-grade memory storage with SQLite.
 *
 * Provides ACID transactions, concurrent access, and cross-session persistence
 * for all memory types (facts, trajectories, patterns, lessons).
 *
 * Features:
 * - ACID transactions for data integrity
 * - Concurrent access with WAL mode
 * - Full-text search (FTS5)
 * - Automatic migrations
 * - Backup support
 * - Metrics and monitoring
 */
type MemoryRow = {
    id: string;
    content: string;
    type: string;
    tags: string;
    source: string;
    embedding: Buffer | null;
    confidence: number;
    access_count: number;
    created_at: number;
    updated_at: number;
    last_accessed: number | null;
    session_id: string | null;
};
type TrajectoryRow = {
    id: string;
    session_id: string;
    user_text: string;
    assistant_text: string;
    tokens_used: number;
    duration_ms: number;
    success: boolean;
    created_at: number;
};
type PatternRow = {
    id: string;
    pattern: string;
    frequency: number;
    examples: string;
    confidence: number;
    created_at: number;
    updated_at: number;
};
type LessonRow = {
    id: string;
    lesson: string;
    context: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    applied_count: number;
    created_at: number;
    updated_at: number;
};
interface SQLiteConfig {
    dbPath: string;
    walMode: boolean;
    busyTimeout: number;
    journalSizeLimit: number;
}
export declare class SQLiteStore {
    private dbPath;
    private config;
    private db;
    private currentVersion;
    constructor(config?: Partial<SQLiteConfig>);
    /**
     * Initialize the database.
     */
    initialize(): Promise<void>;
    /**
     * Run database migrations.
     */
    private runMigrations;
    /**
     * Add a memory.
     */
    addMemory(memory: {
        id: string;
        content: string;
        type: string;
        tags?: string[];
        source?: string;
        confidence?: number;
        sessionId?: string;
    }): void;
    /**
     * Get a memory by ID.
     */
    getMemory(id: string): MemoryRow | null;
    /**
     * Search memories using FTS.
     */
    searchMemories(query: string, limit?: number): MemoryRow[];
    /**
     * List memories by type.
     */
    listMemories(type?: string, limit?: number): MemoryRow[];
    /**
     * Update a memory.
     */
    updateMemory(id: string, updates: Partial<{
        content: string;
        type: string;
        tags: string[];
        confidence: number;
    }>): boolean;
    /**
     * Delete a memory.
     */
    deleteMemory(id: string): boolean;
    /**
     * Add a trajectory.
     */
    addTrajectory(trajectory: {
        id: string;
        sessionId: string;
        userText: string;
        assistantText: string;
        tokensUsed?: number;
        durationMs?: number;
        success?: boolean;
    }): void;
    /**
     * Get recent trajectories.
     */
    getRecentTrajectories(limit?: number): TrajectoryRow[];
    /**
     * Add or update a pattern.
     */
    upsertPattern(pattern: {
        id: string;
        pattern: string;
        frequency?: number;
        examples?: string[];
        confidence?: number;
    }): void;
    /**
     * Get top patterns.
     */
    getTopPatterns(limit?: number): PatternRow[];
    /**
     * Add a lesson.
     */
    addLesson(lesson: {
        id: string;
        lesson: string;
        context?: string;
        severity?: 'low' | 'medium' | 'high' | 'critical';
    }): void;
    /**
     * Get lessons by severity.
     */
    getLessonsBySeverity(severity: string, limit?: number): LessonRow[];
    /**
     * Increment lesson applied count.
     */
    incrementLessonApplied(id: string): void;
    /**
     * Get database statistics.
     */
    getStats(): {
        memories: {
            total: number;
            byType: Record<string, number>;
        };
        trajectories: {
            total: number;
            sessions: number;
        };
        patterns: {
            total: number;
            avgFrequency: number;
        };
        lessons: {
            total: number;
            bySeverity: Record<string, number>;
        };
    };
    /**
     * Create a backup.
     */
    backup(backupPath?: string): string;
    /**
     * Vacuum the database.
     */
    vacuum(): void;
    /**
     * Close the database.
     */
    close(): void;
    private memoryFallback;
    private trajectoryFallback;
    private patternFallback;
    private lessonFallback;
    private addMemoryFallback;
    private getMemoryFallback;
    private searchMemoriesFallback;
    private listMemoriesFallback;
    private updateMemoryFallback;
    private deleteMemoryFallback;
}
export declare function getSQLiteStore(): SQLiteStore;
export declare function resetSQLiteStore(): void;
export {};
//# sourceMappingURL=sqlite-store.d.ts.map