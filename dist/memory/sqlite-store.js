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
import * as fs from 'fs';
import { join } from 'node:path';
import { resolveNuviraHome } from '../config/paths.js';
import * as path from 'path';
// ─── Migrations ─────────────────────────────────────────────────────────────
const MIGRATIONS = [
    {
        version: 1,
        name: 'create_memories',
        up: `
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('fact', 'preference', 'lesson', 'observation', 'pattern')),
        tags TEXT DEFAULT '[]',
        source TEXT DEFAULT '',
        embedding BLOB,
        confidence REAL DEFAULT 0.5,
        access_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed INTEGER,
        session_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
    `,
        down: 'DROP TABLE IF EXISTS memories;',
    },
    {
        version: 2,
        name: 'create_trajectories',
        up: `
      CREATE TABLE IF NOT EXISTS trajectories (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_text TEXT NOT NULL,
        assistant_text TEXT NOT NULL,
        tokens_used INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        success BOOLEAN DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_trajectories_session ON trajectories(session_id);
      CREATE INDEX IF NOT EXISTS idx_trajectories_created ON trajectories(created_at);
    `,
        down: 'DROP TABLE IF EXISTS trajectories;',
    },
    {
        version: 3,
        name: 'create_patterns',
        up: `
      CREATE TABLE IF NOT EXISTS patterns (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        frequency INTEGER DEFAULT 1,
        examples TEXT DEFAULT '[]',
        confidence REAL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_patterns_frequency ON patterns(frequency DESC);
    `,
        down: 'DROP TABLE IF EXISTS patterns;',
    },
    {
        version: 4,
        name: 'create_lessons',
        up: `
      CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY,
        lesson TEXT NOT NULL,
        context TEXT DEFAULT '',
        severity TEXT DEFAULT 'medium' CHECK(severity IN ('low', 'medium', 'high', 'critical')),
        applied_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_lessons_severity ON lessons(severity);
      CREATE INDEX IF NOT EXISTS idx_lessons_applied ON lessons(applied_count DESC);
    `,
        down: 'DROP TABLE IF EXISTS lessons;',
    },
    {
        version: 5,
        name: 'create_fts_memories',
        up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        type,
        tags,
        content='memories',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, type, tags)
        VALUES (new.rowid, new.content, new.type, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, type, tags)
        VALUES ('delete', old.rowid, old.content, old.type, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, type, tags)
        VALUES ('delete', old.rowid, old.content, old.type, old.tags);
        INSERT INTO memories_fts(rowid, content, type, tags)
        VALUES (new.rowid, new.content, new.type, new.tags);
      END;
    `,
        down: 'DROP TABLE IF EXISTS memories_fts;',
    },
];
// ─── SQLite Store ───────────────────────────────────────────────────────────
export class SQLiteStore {
    dbPath;
    config;
    db = null;
    currentVersion = 0;
    constructor(config) {
        this.config = {
            dbPath: config?.dbPath || join(resolveNuviraHome(), 'memory', 'memory.db'),
            walMode: config?.walMode ?? true,
            busyTimeout: config?.busyTimeout ?? 5000,
            journalSizeLimit: config?.journalSizeLimit ?? 67108864, // 64MB
        };
        this.dbPath = this.config.dbPath;
    }
    /**
     * Initialize the database.
     */
    async initialize() {
        // Ensure directory exists
        const dir = path.dirname(this.dbPath);
        fs.mkdirSync(dir, { recursive: true });
        // Try to load better-sqlite3
        let Database;
        try {
            Database = (await import('better-sqlite3')).default;
        }
        catch {
            console.warn('SQLiteStore: better-sqlite3 not available, using in-memory fallback');
            this.db = null;
            return;
        }
        try {
            this.db = new Database(this.dbPath, {
                verbose: process.env.DEBUG ? console.log : undefined,
            });
            // Configure SQLite
            this.db.pragma('journal_mode = WAL');
            this.db.pragma(`busy_timeout = ${this.config.busyTimeout}`);
            this.db.pragma('synchronous = NORMAL');
            this.db.pragma('cache_size = -64000'); // 64MB
            this.db.pragma(`journal_size_limit = ${this.config.journalSizeLimit}`);
            // Run migrations
            await this.runMigrations();
            console.log(`SQLiteStore: Initialized at ${this.dbPath}`);
        }
        catch (err) {
            console.warn('SQLiteStore: Failed to initialize, using in-memory fallback');
            this.db = null;
        }
    }
    /**
     * Run database migrations.
     */
    async runMigrations() {
        if (!this.db)
            return;
        // Create migrations table
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
        // Get current version
        const row = this.db.prepare('SELECT MAX(version) as version FROM migrations').get();
        this.currentVersion = row?.version || 0;
        // Apply pending migrations
        for (const migration of MIGRATIONS) {
            if (migration.version > this.currentVersion) {
                console.log(`SQLiteStore: Applying migration ${migration.version}: ${migration.name}`);
                this.db.exec(migration.up);
                this.db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)')
                    .run(migration.version, migration.name, Date.now());
                this.currentVersion = migration.version;
            }
        }
    }
    // ─── Memory Operations ──────────────────────────────────────────────────
    /**
     * Add a memory.
     */
    addMemory(memory) {
        if (!this.db) {
            this.addMemoryFallback(memory);
            return;
        }
        const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memories (id, content, type, tags, source, confidence, access_count, created_at, updated_at, last_accessed, session_id)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `);
        const now = Date.now();
        stmt.run(memory.id, memory.content, memory.type, JSON.stringify(memory.tags || []), memory.source || '', memory.confidence ?? 0.5, now, now, null, memory.sessionId || null);
    }
    /**
     * Get a memory by ID.
     */
    getMemory(id) {
        if (!this.db) {
            return this.getMemoryFallback(id);
        }
        const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ?');
        const row = stmt.get(id);
        if (row) {
            // Update access count
            this.db.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?')
                .run(Date.now(), id);
        }
        return row || null;
    }
    /**
     * Search memories using FTS.
     */
    searchMemories(query, limit = 10) {
        if (!this.db) {
            return this.searchMemoriesFallback(query, limit);
        }
        try {
            const stmt = this.db.prepare(`
        SELECT m.* FROM memories m
        JOIN memories_fts fts ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `);
            return stmt.all(query, limit);
        }
        catch {
            // Fallback to LIKE search
            const stmt = this.db.prepare(`
        SELECT * FROM memories
        WHERE content LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
            return stmt.all(`%${query}%`, limit);
        }
    }
    /**
     * List memories by type.
     */
    listMemories(type, limit = 100) {
        if (!this.db) {
            return this.listMemoriesFallback(type, limit);
        }
        if (type) {
            const stmt = this.db.prepare('SELECT * FROM memories WHERE type = ? ORDER BY created_at DESC LIMIT ?');
            return stmt.all(type, limit);
        }
        const stmt = this.db.prepare('SELECT * FROM memories ORDER BY created_at DESC LIMIT ?');
        return stmt.all(limit);
    }
    /**
     * Update a memory.
     */
    updateMemory(id, updates) {
        if (!this.db) {
            return this.updateMemoryFallback(id, updates);
        }
        const fields = [];
        const values = [];
        if (updates.content !== undefined) {
            fields.push('content = ?');
            values.push(updates.content);
        }
        if (updates.type !== undefined) {
            fields.push('type = ?');
            values.push(updates.type);
        }
        if (updates.tags !== undefined) {
            fields.push('tags = ?');
            values.push(JSON.stringify(updates.tags));
        }
        if (updates.confidence !== undefined) {
            fields.push('confidence = ?');
            values.push(updates.confidence);
        }
        if (fields.length === 0)
            return false;
        fields.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);
        const stmt = this.db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`);
        const result = stmt.run(...values);
        return result.changes > 0;
    }
    /**
     * Delete a memory.
     */
    deleteMemory(id) {
        if (!this.db) {
            return this.deleteMemoryFallback(id);
        }
        const stmt = this.db.prepare('DELETE FROM memories WHERE id = ?');
        const result = stmt.run(id);
        return result.changes > 0;
    }
    // ─── Trajectory Operations ──────────────────────────────────────────────
    /**
     * Add a trajectory.
     */
    addTrajectory(trajectory) {
        if (!this.db)
            return;
        const stmt = this.db.prepare(`
      INSERT INTO trajectories (id, session_id, user_text, assistant_text, tokens_used, duration_ms, success, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(trajectory.id, trajectory.sessionId, trajectory.userText, trajectory.assistantText, trajectory.tokensUsed ?? 0, trajectory.durationMs ?? 0, trajectory.success ?? true, Date.now());
    }
    /**
     * Get recent trajectories.
     */
    getRecentTrajectories(limit = 50) {
        if (!this.db)
            return [];
        const stmt = this.db.prepare('SELECT * FROM trajectories ORDER BY created_at DESC LIMIT ?');
        return stmt.all(limit);
    }
    // ─── Pattern Operations ─────────────────────────────────────────────────
    /**
     * Add or update a pattern.
     */
    upsertPattern(pattern) {
        if (!this.db)
            return;
        const stmt = this.db.prepare(`
      INSERT INTO patterns (id, pattern, frequency, examples, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        frequency = frequency + excluded.frequency,
        examples = excluded.examples,
        confidence = MAX(confidence, excluded.confidence),
        updated_at = excluded.updated_at
    `);
        const now = Date.now();
        stmt.run(pattern.id, pattern.pattern, pattern.frequency ?? 1, JSON.stringify(pattern.examples || []), pattern.confidence ?? 0.5, now, now);
    }
    /**
     * Get top patterns.
     */
    getTopPatterns(limit = 20) {
        if (!this.db)
            return [];
        const stmt = this.db.prepare('SELECT * FROM patterns ORDER BY frequency DESC LIMIT ?');
        return stmt.all(limit);
    }
    // ─── Lesson Operations ──────────────────────────────────────────────────
    /**
     * Add a lesson.
     */
    addLesson(lesson) {
        if (!this.db)
            return;
        const stmt = this.db.prepare(`
      INSERT INTO lessons (id, lesson, context, severity, applied_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `);
        const now = Date.now();
        stmt.run(lesson.id, lesson.lesson, lesson.context || '', lesson.severity || 'medium', now, now);
    }
    /**
     * Get lessons by severity.
     */
    getLessonsBySeverity(severity, limit = 20) {
        if (!this.db)
            return [];
        const stmt = this.db.prepare('SELECT * FROM lessons WHERE severity = ? ORDER BY created_at DESC LIMIT ?');
        return stmt.all(severity, limit);
    }
    /**
     * Increment lesson applied count.
     */
    incrementLessonApplied(id) {
        if (!this.db)
            return;
        this.db.prepare('UPDATE lessons SET applied_count = applied_count + 1, updated_at = ? WHERE id = ?')
            .run(Date.now(), id);
    }
    // ─── Statistics ─────────────────────────────────────────────────────────
    /**
     * Get database statistics.
     */
    getStats() {
        if (!this.db) {
            return {
                memories: { total: 0, byType: {} },
                trajectories: { total: 0, sessions: 0 },
                patterns: { total: 0, avgFrequency: 0 },
                lessons: { total: 0, bySeverity: {} },
            };
        }
        // Memory stats
        const memoryCount = this.db.prepare('SELECT COUNT(*) as count FROM memories').get()?.count || 0;
        const memoryByType = this.db.prepare('SELECT type, COUNT(*) as count FROM memories GROUP BY type').all();
        const byType = {};
        for (const row of memoryByType) {
            byType[row.type] = row.count;
        }
        // Trajectory stats
        const trajectoryCount = this.db.prepare('SELECT COUNT(*) as count FROM trajectories').get()?.count || 0;
        const sessionCount = this.db.prepare('SELECT COUNT(DISTINCT session_id) as count FROM trajectories').get()?.count || 0;
        // Pattern stats
        const patternCount = this.db.prepare('SELECT COUNT(*) as count FROM patterns').get()?.count || 0;
        const avgFrequency = this.db.prepare('SELECT AVG(frequency) as avg FROM patterns').get()?.avg || 0;
        // Lesson stats
        const lessonCount = this.db.prepare('SELECT COUNT(*) as count FROM lessons').get()?.count || 0;
        const lessonBySeverity = this.db.prepare('SELECT severity, COUNT(*) as count FROM lessons GROUP BY severity').all();
        const bySeverity = {};
        for (const row of lessonBySeverity) {
            bySeverity[row.severity] = row.count;
        }
        return {
            memories: { total: memoryCount, byType },
            trajectories: { total: trajectoryCount, sessions: sessionCount },
            patterns: { total: patternCount, avgFrequency: Math.round(avgFrequency) },
            lessons: { total: lessonCount, bySeverity },
        };
    }
    // ─── Backup & Maintenance ───────────────────────────────────────────────
    /**
     * Create a backup.
     */
    backup(backupPath) {
        const path = backupPath || `${this.dbPath}.backup.${Date.now()}`;
        if (this.db) {
            this.db.backup(path);
        }
        return path;
    }
    /**
     * Vacuum the database.
     */
    vacuum() {
        if (this.db) {
            this.db.exec('VACUUM');
        }
    }
    /**
     * Close the database.
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
    // ─── Fallback Methods (In-Memory) ───────────────────────────────────────
    memoryFallback = new Map();
    trajectoryFallback = [];
    patternFallback = new Map();
    lessonFallback = new Map();
    addMemoryFallback(memory) {
        this.memoryFallback.set(memory.id, {
            ...memory,
            tags: JSON.stringify(memory.tags || []),
            access_count: 0,
            created_at: Date.now(),
            updated_at: Date.now(),
            last_accessed: null,
        });
    }
    getMemoryFallback(id) {
        return this.memoryFallback.get(id) || null;
    }
    searchMemoriesFallback(query, limit) {
        const results = [];
        for (const memory of this.memoryFallback.values()) {
            if (memory.content.toLowerCase().includes(query.toLowerCase())) {
                results.push(memory);
                if (results.length >= limit)
                    break;
            }
        }
        return results;
    }
    listMemoriesFallback(type, limit) {
        const results = [];
        for (const memory of this.memoryFallback.values()) {
            if (!type || memory.type === type) {
                results.push(memory);
                if (results.length >= limit)
                    break;
            }
        }
        return results;
    }
    updateMemoryFallback(id, updates) {
        const memory = this.memoryFallback.get(id);
        if (!memory)
            return false;
        if (updates.content !== undefined)
            memory.content = updates.content;
        if (updates.type !== undefined)
            memory.type = updates.type;
        if (updates.tags !== undefined)
            memory.tags = JSON.stringify(updates.tags);
        if (updates.confidence !== undefined)
            memory.confidence = updates.confidence;
        memory.updated_at = Date.now();
        return true;
    }
    deleteMemoryFallback(id) {
        return this.memoryFallback.delete(id);
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let _instance = null;
export function getSQLiteStore() {
    if (!_instance)
        _instance = new SQLiteStore();
    return _instance;
}
export function resetSQLiteStore() {
    if (_instance) {
        _instance.close();
        _instance = null;
    }
}
//# sourceMappingURL=sqlite-store.js.map