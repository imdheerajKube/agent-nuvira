/**
 * Delegation State — SQLite-backed state for crash recovery.
 *
 * Unlike in-memory state, this survives process restarts.
 * Uses better-sqlite3 for synchronous, fast operations.
 *
 * Hermes equivalent: async_delegation.py's SQLite persistence
 */
import { existsSync, mkdirSync } from 'node:fs';
import { resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
// ─── SQLite State Store ───────────────────────────────────────────────────
const STATE_DIR = join(resolveNuviraHome(), 'cache', 'delegation');
const DB_PATH = join(STATE_DIR, 'delegation.db');
export class DelegationStateStore {
    db = null;
    constructor() {
        this.ensureDirectory();
        this.initDatabase();
    }
    ensureDirectory() {
        if (!existsSync(STATE_DIR)) {
            mkdirSync(STATE_DIR, { recursive: true });
        }
    }
    initDatabase() {
        try {
            // Try to use better-sqlite3 if available
            const Database = require('better-sqlite3');
            this.db = new Database(DB_PATH);
            // Create tables
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS delegations (
          id TEXT PRIMARY KEY,
          delegation_id TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          result TEXT,
          error TEXT,
          pid INTEGER,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          retry_count INTEGER DEFAULT 0,
          max_retries INTEGER DEFAULT 3
        );

        CREATE TABLE IF NOT EXISTS completions (
          id TEXT PRIMARY KEY,
          delegation_id TEXT NOT NULL,
          success INTEGER NOT NULL,
          result TEXT,
          error TEXT,
          duration_ms INTEGER,
          acknowledged INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_delegations_status ON delegations(status);
        CREATE INDEX IF NOT EXISTS idx_delegations_delegation_id ON delegations(delegation_id);
        CREATE INDEX IF NOT EXISTS idx_completions_acknowledged ON completions(acknowledged);
      `);
            logger.debug('DelegationState: SQLite database initialized');
        }
        catch (err) {
            logger.warn(`DelegationState: SQLite not available, falling back to JSON: ${err}`);
            this.db = null;
        }
    }
    // ─── Delegation Operations ─────────────────────────────────────────
    /**
     * Create a new delegation record.
     */
    createDelegation(goal, delegationId) {
        const id = randomUUID();
        const record = {
            id,
            delegationId: delegationId || id,
            goal,
            status: 'pending',
            createdAt: Date.now(),
            retryCount: 0,
            maxRetries: 3,
        };
        if (this.db) {
            this.db.prepare(`
        INSERT INTO delegations (id, delegation_id, goal, status, created_at, retry_count, max_retries)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, record.delegationId, goal, 'pending', record.createdAt, 0, 3);
        }
        return record;
    }
    /**
     * Update delegation status.
     */
    updateDelegation(id, updates) {
        if (this.db) {
            const setClauses = [];
            const values = [];
            if (updates.status !== undefined) {
                setClauses.push('status = ?');
                values.push(updates.status);
            }
            if (updates.result !== undefined) {
                setClauses.push('result = ?');
                values.push(updates.result);
            }
            if (updates.error !== undefined) {
                setClauses.push('error = ?');
                values.push(updates.error);
            }
            if (updates.pid !== undefined) {
                setClauses.push('pid = ?');
                values.push(updates.pid);
            }
            if (updates.startedAt !== undefined) {
                setClauses.push('started_at = ?');
                values.push(updates.startedAt);
            }
            if (updates.completedAt !== undefined) {
                setClauses.push('completed_at = ?');
                values.push(updates.completedAt);
            }
            if (updates.retryCount !== undefined) {
                setClauses.push('retry_count = ?');
                values.push(updates.retryCount);
            }
            if (setClauses.length === 0)
                return false;
            values.push(id);
            this.db.prepare(`UPDATE delegations SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
            return true;
        }
        return false;
    }
    /**
     * Get a delegation by ID.
     */
    getDelegation(id) {
        if (this.db) {
            const row = this.db.prepare('SELECT * FROM delegations WHERE id = ?').get(id);
            if (row)
                return this.rowToDelegation(row);
        }
        return null;
    }
    /**
     * Get pending delegations (for recovery).
     */
    getPendingDelegations() {
        if (this.db) {
            const rows = this.db.prepare("SELECT * FROM delegations WHERE status IN ('pending', 'running')").all();
            return rows.map((row) => this.rowToDelegation(row));
        }
        return [];
    }
    /**
     * Get delegations by delegation_id.
     */
    getDelegationsByGroup(delegationId) {
        if (this.db) {
            const rows = this.db.prepare('SELECT * FROM delegations WHERE delegation_id = ? ORDER BY created_at').all(delegationId);
            return rows.map((row) => this.rowToDelegation(row));
        }
        return [];
    }
    // ─── Completion Operations ─────────────────────────────────────────
    /**
     * Add a completion to the queue.
     */
    addCompletion(record) {
        if (this.db) {
            this.db.prepare(`
        INSERT INTO completions (id, delegation_id, success, result, error, duration_ms, acknowledged, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.id, record.delegationId, record.success ? 1 : 0, record.result, record.error, record.durationMs, 0, record.createdAt);
        }
    }
    /**
     * Get unacknowledged completions.
     */
    getUnacknowledgedCompletions() {
        if (this.db) {
            const rows = this.db.prepare('SELECT * FROM completions WHERE acknowledged = 0 ORDER BY created_at').all();
            return rows.map((row) => this.rowToCompletion(row));
        }
        return [];
    }
    /**
     * Acknowledge a completion.
     */
    acknowledgeCompletion(id) {
        if (this.db) {
            this.db.prepare('UPDATE completions SET acknowledged = 1 WHERE id = ?').run(id);
            return true;
        }
        return false;
    }
    /**
     * Drain all unacknowledged completions.
     */
    drainCompletions() {
        const completions = this.getUnacknowledgedCompletions();
        for (const c of completions) {
            this.acknowledgeCompletion(c.id);
        }
        return completions;
    }
    // ─── Recovery ──────────────────────────────────────────────────────
    /**
     * Recover pending delegations after crash.
     */
    recoverPendingDelegations() {
        const pending = this.getPendingDelegations();
        for (const record of pending) {
            // Mark as failed (process was lost)
            this.updateDelegation(record.id, {
                status: 'failed',
                error: 'Process lost during recovery',
                completedAt: Date.now(),
            });
        }
        return pending;
    }
    // ─── Internal ──────────────────────────────────────────────────────
    rowToDelegation(row) {
        return {
            id: row.id,
            delegationId: row.delegation_id,
            goal: row.goal,
            status: row.status,
            result: row.result,
            error: row.error,
            pid: row.pid,
            createdAt: row.created_at,
            startedAt: row.started_at,
            completedAt: row.completed_at,
            retryCount: row.retry_count,
            maxRetries: row.max_retries,
        };
    }
    rowToCompletion(row) {
        return {
            id: row.id,
            delegationId: row.delegation_id,
            success: row.success === 1,
            result: row.result,
            error: row.error,
            durationMs: row.duration_ms,
            acknowledged: row.acknowledged === 1,
            createdAt: row.created_at,
        };
    }
    /**
     * Close the database.
     */
    close() {
        if (this.db) {
            this.db.close();
        }
    }
}
// ─── Singleton ────────────────────────────────────────────────────────────
let _instance = null;
export function getDelegationStateStore() {
    if (!_instance)
        _instance = new DelegationStateStore();
    return _instance;
}
export function resetDelegationStateStore() {
    if (_instance) {
        _instance.close();
        _instance = null;
    }
}
//# sourceMappingURL=delegation-state.js.map