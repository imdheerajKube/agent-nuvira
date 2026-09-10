/**
 * Kanban Tools — Kanban board management.
 *
 * Hermes equivalent: kanban_tools.py
 */
import { randomUUID } from 'node:crypto';
import { resolveNuviraHome } from '../config/paths.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
const KANBAN_DIR = join(resolveNuviraHome(), 'memory', 'kanban');
export class KanbanManager {
    boards = new Map();
    constructor() { this.load(); }
    /**
     * Create a new board.
     */
    createBoard(name, columns = ['Backlog', 'Todo', 'In Progress', 'Review', 'Done']) {
        const board = {
            id: randomUUID(), name, columns, cards: [], createdAt: Date.now(), updatedAt: Date.now(),
        };
        this.boards.set(board.id, board);
        this.save();
        return board;
    }
    /**
     * Add a card to a board.
     */
    addCard(boardId, column, title, options = {}) {
        const board = this.boards.get(boardId);
        if (!board || !board.columns.includes(column))
            return null;
        const order = board.cards.filter((c) => c.column === column).length;
        const card = {
            id: randomUUID(), title, description: options.description, column,
            labels: options.labels || [], assignee: options.assignee, dueDate: options.dueDate,
            createdAt: Date.now(), updatedAt: Date.now(), order,
        };
        board.cards.push(card);
        board.updatedAt = Date.now();
        this.save();
        return card;
    }
    /**
     * Move a card to a different column.
     */
    moveCard(boardId, cardId, toColumn) {
        const board = this.boards.get(boardId);
        if (!board)
            return false;
        const card = board.cards.find((c) => c.id === cardId);
        if (!card || !board.columns.includes(toColumn))
            return false;
        card.column = toColumn;
        card.order = board.cards.filter((c) => c.column === toColumn).length;
        card.updatedAt = Date.now();
        board.updatedAt = Date.now();
        this.save();
        return true;
    }
    /**
     * Get board status.
     */
    getBoardStatus(boardId) {
        const board = this.boards.get(boardId);
        if (!board)
            return null;
        const status = {};
        for (const col of board.columns)
            status[col] = board.cards.filter((c) => c.column === col).length;
        return status;
    }
    /**
     * Get a board.
     */
    getBoard(boardId) {
        return this.boards.get(boardId) || null;
    }
    /**
     * Get all boards.
     */
    getAllBoards() {
        return [...this.boards.values()];
    }
    load() {
        try {
            if (!existsSync(KANBAN_DIR))
                return;
            const files = require('node:fs').readdirSync(KANBAN_DIR).filter((f) => f.endsWith('.json'));
            for (const file of files) {
                const data = readFileSync(join(KANBAN_DIR, file), 'utf-8');
                const board = JSON.parse(data);
                this.boards.set(board.id, board);
            }
        }
        catch { /* ignore */ }
    }
    save() {
        try {
            if (!existsSync(KANBAN_DIR))
                mkdirSync(KANBAN_DIR, { recursive: true });
            for (const [id, board] of this.boards) {
                writeFileSync(join(KANBAN_DIR, `${id}.json`), JSON.stringify(board, null, 2));
            }
        }
        catch (err) {
            logger.warn(`KanbanManager: Failed to save: ${err}`);
        }
    }
}
const CRON_DIR = join(resolveNuviraHome(), 'memory', 'cronjobs');
export class CronJobManager {
    jobs = new Map();
    timers = new Map();
    constructor() { this.load(); }
    /**
     * Create a cron job.
     */
    create(name, schedule, command) {
        const job = {
            id: randomUUID(), name, schedule, command, enabled: true,
            nextRun: this.parseNextRun(schedule), createdAt: Date.now(),
        };
        this.jobs.set(job.id, job);
        this.save();
        return job;
    }
    /**
     * Enable/disable a job.
     */
    setEnabled(jobId, enabled) {
        const job = this.jobs.get(jobId);
        if (!job)
            return false;
        job.enabled = enabled;
        this.save();
        return true;
    }
    /**
     * Get all jobs.
     */
    getAllJobs() {
        return [...this.jobs.values()];
    }
    /**
     * Delete a job.
     */
    deleteJob(jobId) {
        const existed = this.jobs.delete(jobId);
        if (existed)
            this.save();
        return existed;
    }
    parseNextRun(schedule) {
        // Simple next-run calculation (1 minute from now for demo)
        return Date.now() + 60_000;
    }
    load() {
        try {
            if (!existsSync(CRON_DIR))
                return;
            const files = require('node:fs').readdirSync(CRON_DIR).filter((f) => f.endsWith('.json'));
            for (const file of files) {
                const data = readFileSync(join(CRON_DIR, file), 'utf-8');
                const job = JSON.parse(data);
                this.jobs.set(job.id, job);
            }
        }
        catch { /* ignore */ }
    }
    save() {
        try {
            if (!existsSync(CRON_DIR))
                mkdirSync(CRON_DIR, { recursive: true });
            for (const [id, job] of this.jobs) {
                writeFileSync(join(CRON_DIR, `${id}.json`), JSON.stringify(job, null, 2));
            }
        }
        catch (err) {
            logger.warn(`CronJobManager: Failed to save: ${err}`);
        }
    }
}
// ─── Singletons ───────────────────────────────────────────────────────────
let _kanbanManager = null;
let _cronJobManager = null;
export function getKanbanManager() {
    if (!_kanbanManager)
        _kanbanManager = new KanbanManager();
    return _kanbanManager;
}
export function getCronJobManager() {
    if (!_cronJobManager)
        _cronJobManager = new CronJobManager();
    return _cronJobManager;
}
//# sourceMappingURL=kanban-cron-tools.js.map