/**
 * Kanban Tools — Kanban board management.
 *
 * Hermes equivalent: kanban_tools.py
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

// ─── Kanban Board ─────────────────────────────────────────────────────────

export interface KanbanCard {
  id: string;
  title: string;
  description?: string;
  column: string;
  labels: string[];
  assignee?: string;
  dueDate?: number;
  createdAt: number;
  updatedAt: number;
  order: number;
}

export interface KanbanBoard {
  id: string;
  name: string;
  columns: string[];
  cards: KanbanCard[];
  createdAt: number;
  updatedAt: number;
}

const KANBAN_DIR = join(homedir(), '.buff', 'memory', 'kanban');

export class KanbanManager {
  private boards: Map<string, KanbanBoard> = new Map();

  constructor() { this.load(); }

  /**
   * Create a new board.
   */
  createBoard(name: string, columns: string[] = ['Backlog', 'Todo', 'In Progress', 'Review', 'Done']): KanbanBoard {
    const board: KanbanBoard = {
      id: randomUUID(), name, columns, cards: [], createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.boards.set(board.id, board);
    this.save();
    return board;
  }

  /**
   * Add a card to a board.
   */
  addCard(boardId: string, column: string, title: string, options: Partial<Omit<KanbanCard, 'id' | 'title' | 'column' | 'createdAt' | 'updatedAt' | 'order'>> = {}): KanbanCard | null {
    const board = this.boards.get(boardId);
    if (!board || !board.columns.includes(column)) return null;
    const order = board.cards.filter((c) => c.column === column).length;
    const card: KanbanCard = {
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
  moveCard(boardId: string, cardId: string, toColumn: string): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;
    const card = board.cards.find((c) => c.id === cardId);
    if (!card || !board.columns.includes(toColumn)) return false;
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
  getBoardStatus(boardId: string): Record<string, number> | null {
    const board = this.boards.get(boardId);
    if (!board) return null;
    const status: Record<string, number> = {};
    for (const col of board.columns) status[col] = board.cards.filter((c) => c.column === col).length;
    return status;
  }

  /**
   * Get a board.
   */
  getBoard(boardId: string): KanbanBoard | null {
    return this.boards.get(boardId) || null;
  }

  /**
   * Get all boards.
   */
  getAllBoards(): KanbanBoard[] {
    return [...this.boards.values()];
  }

  private load(): void {
    try {
      if (!existsSync(KANBAN_DIR)) return;
      const files = require('node:fs').readdirSync(KANBAN_DIR).filter((f: string) => f.endsWith('.json'));
      for (const file of files) {
        const data = readFileSync(join(KANBAN_DIR, file), 'utf-8');
        const board = JSON.parse(data) as KanbanBoard;
        this.boards.set(board.id, board);
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    try {
      if (!existsSync(KANBAN_DIR)) mkdirSync(KANBAN_DIR, { recursive: true });
      for (const [id, board] of this.boards) {
        writeFileSync(join(KANBAN_DIR, `${id}.json`), JSON.stringify(board, null, 2));
      }
    } catch (err) { logger.warn(`KanbanManager: Failed to save: ${err}`); }
  }
}

// ─── Cronjob Tools ────────────────────────────────────────────────────────

export interface CronJob {
  id: string;
  name: string;
  schedule: string; // cron expression
  command: string;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
  createdAt: number;
}

const CRON_DIR = join(homedir(), '.buff', 'memory', 'cronjobs');

export class CronJobManager {
  private jobs: Map<string, CronJob> = new Map();
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor() { this.load(); }

  /**
   * Create a cron job.
   */
  create(name: string, schedule: string, command: string): CronJob {
    const job: CronJob = {
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
  setEnabled(jobId: string, enabled: boolean): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.enabled = enabled;
    this.save();
    return true;
  }

  /**
   * Get all jobs.
   */
  getAllJobs(): CronJob[] {
    return [...this.jobs.values()];
  }

  /**
   * Delete a job.
   */
  deleteJob(jobId: string): boolean {
    const existed = this.jobs.delete(jobId);
    if (existed) this.save();
    return existed;
  }

  private parseNextRun(schedule: string): number {
    // Simple next-run calculation (1 minute from now for demo)
    return Date.now() + 60_000;
  }

  private load(): void {
    try {
      if (!existsSync(CRON_DIR)) return;
      const files = require('node:fs').readdirSync(CRON_DIR).filter((f: string) => f.endsWith('.json'));
      for (const file of files) {
        const data = readFileSync(join(CRON_DIR, file), 'utf-8');
        const job = JSON.parse(data) as CronJob;
        this.jobs.set(job.id, job);
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    try {
      if (!existsSync(CRON_DIR)) mkdirSync(CRON_DIR, { recursive: true });
      for (const [id, job] of this.jobs) {
        writeFileSync(join(CRON_DIR, `${id}.json`), JSON.stringify(job, null, 2));
      }
    } catch (err) { logger.warn(`CronJobManager: Failed to save: ${err}`); }
  }
}

// ─── Singletons ───────────────────────────────────────────────────────────

let _kanbanManager: KanbanManager | null = null;
let _cronJobManager: CronJobManager | null = null;

export function getKanbanManager(): KanbanManager {
  if (!_kanbanManager) _kanbanManager = new KanbanManager();
  return _kanbanManager;
}

export function getCronJobManager(): CronJobManager {
  if (!_cronJobManager) _cronJobManager = new CronJobManager();
  return _cronJobManager;
}
