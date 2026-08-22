/**
 * Kanban Tools — Structured Kanban board management.
 *
 * Hermes equivalent: kanban_tools.py
 *
 * Provides:
 * - Board creation and management
 * - Card lifecycle (create, move, update, delete)
 * - Labels and categorization
 * - Due dates and priorities
 * - WIP (Work In Progress) limits
 * - Swimlanes
 * - Search and filtering
 * - Board statistics and reporting
 * - Integration with tool system (structured tool-call surface)
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export type CardPriority = 'low' | 'medium' | 'high' | 'critical';
export type CardStatus = 'active' | 'archived' | 'deleted';

export interface KanbanCard {
  id: string;
  title: string;
  description?: string;
  column: string;
  labels: string[];
  priority: CardPriority;
  assignee?: string;
  dueDate?: number;
  estimatedHours?: number;
  actualHours?: number;
  status: CardStatus;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  order: number;
}

export interface KanbanBoard {
  id: string;
  name: string;
  description?: string;
  columns: KanbanColumn[];
  swimlanes: string[];
  wipLimits: Record<string, number>;
  createdAt: number;
  updatedAt: number;
}

export interface KanbanColumn {
  name: string;
  order: number;
  wipLimit?: number;
  color?: string;
}

export interface BoardStats {
  boardId: string;
  boardName: string;
  totalCards: number;
  cardsByColumn: Record<string, number>;
  cardsByPriority: Record<CardPriority, number>;
  cardsByLabel: Record<string, number>;
  overdueCards: number;
  averageAge: number; // days
  throughput: number; // cards completed in last 7 days
}

// ─── Kanban Manager ───────────────────────────────────────────────────────

const KANBAN_DIR = join(homedir(), '.buff', 'memory', 'kanban');

export class KanbanManager {
  private boards: Map<string, KanbanBoard> = new Map();
  private cards: Map<string, KanbanCard> = new Map();

  constructor() {
    this.load();
  }

  // ─── Board Operations ──────────────────────────────────────────────

  /**
   * Create a new board.
   */
  createBoard(
    name: string,
    options: {
      description?: string;
      columns?: string[];
      swimlanes?: string[];
      wipLimits?: Record<string, number>;
    } = {},
  ): KanbanBoard {
    const columns: KanbanColumn[] = (options.columns || ['Backlog', 'Todo', 'In Progress', 'Review', 'Done'])
      .map((col, i) => ({ name: col, order: i }));

    const board: KanbanBoard = {
      id: randomUUID(),
      name,
      description: options.description,
      columns,
      swimlanes: options.swimlanes || [],
      wipLimits: options.wipLimits || {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.boards.set(board.id, board);
    this.save();
    logger.debug(`Kanban: Created board '${name}' with ${columns.length} columns`);
    return board;
  }

  /**
   * Get a board by ID.
   */
  getBoard(boardId: string): KanbanBoard | null {
    return this.boards.get(boardId) || null;
  }

  /**
   * Get all boards.
   */
  getAllBoards(): KanbanBoard[] {
    return [...this.boards.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Update board settings.
   */
  updateBoard(boardId: string, updates: Partial<Pick<KanbanBoard, 'name' | 'description' | 'swimlanes' | 'wipLimits'>>): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;

    if (updates.name) board.name = updates.name;
    if (updates.description !== undefined) board.description = updates.description;
    if (updates.swimlanes) board.swimlanes = updates.swimlanes;
    if (updates.wipLimits) board.wipLimits = updates.wipLimits;
    board.updatedAt = Date.now();
    this.save();
    return true;
  }

  /**
   * Delete a board.
   */
  deleteBoard(boardId: string): boolean {
    const existed = this.boards.delete(boardId);
    if (existed) {
      // Delete all cards in the board
      for (const [cardId, card] of this.cards) {
        if (card.metadata.boardId === boardId) this.cards.delete(cardId);
      }
      this.save();
    }
    return existed;
  }

  /**
   * Add a column to a board.
   */
  addColumn(boardId: string, columnName: string, wipLimit?: number): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;
    if (board.columns.some((c) => c.name === columnName)) return false;

    board.columns.push({
      name: columnName,
      order: board.columns.length,
      wipLimit,
    });
    board.updatedAt = Date.now();
    this.save();
    return true;
  }

  // ─── Card Operations ──────────────────────────────────────────────

  /**
   * Add a card to a board.
   */
  addCard(
    boardId: string,
    column: string,
    title: string,
    options: Partial<Omit<KanbanCard, 'id' | 'title' | 'column' | 'createdAt' | 'updatedAt' | 'order' | 'status'>> = {},
  ): KanbanCard | null {
    const board = this.boards.get(boardId);
    if (!board) return null;

    const col = board.columns.find((c) => c.name === column);
    if (!col) return null;

    // Check WIP limit
    const cardsInColumn = this.getCardsByColumn(boardId, column);
    if (col.wipLimit && cardsInColumn.length >= col.wipLimit) {
      logger.warn(`Kanban: WIP limit reached for column '${column}' (${col.wipLimit})`);
      return null;
    }

    const card: KanbanCard = {
      id: randomUUID(),
      title,
      description: options.description,
      column,
      labels: options.labels || [],
      priority: options.priority || 'medium',
      assignee: options.assignee,
      dueDate: options.dueDate,
      estimatedHours: options.estimatedHours,
      actualHours: options.actualHours,
      status: 'active',
      metadata: { ...options.metadata, boardId },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      order: cardsInColumn.length,
    };

    this.cards.set(card.id, card);
    board.updatedAt = Date.now();
    this.save();
    logger.debug(`Kanban: Added card '${title}' to column '${column}'`);
    return card;
  }

  /**
   * Get a card by ID.
   */
  getCard(cardId: string): KanbanCard | null {
    return this.cards.get(cardId) || null;
  }

  /**
   * Update a card.
   */
  updateCard(cardId: string, updates: Partial<Pick<KanbanCard, 'title' | 'description' | 'labels' | 'priority' | 'assignee' | 'dueDate' | 'estimatedHours' | 'actualHours'>>): boolean {
    const card = this.cards.get(cardId);
    if (!card) return false;

    Object.assign(card, updates, { updatedAt: Date.now() });
    this.save();
    return true;
  }

  /**
   * Move a card to a different column.
   */
  moveCard(boardId: string, cardId: string, toColumn: string): boolean {
    const board = this.boards.get(boardId);
    const card = this.cards.get(cardId);
    if (!board || !card) return false;

    const col = board.columns.find((c) => c.name === toColumn);
    if (!col) return false;

    // Check WIP limit
    const cardsInColumn = this.getCardsByColumn(boardId, toColumn);
    if (col.wipLimit && cardsInColumn.length >= col.wipLimit) {
      logger.warn(`Kanban: WIP limit reached for column '${toColumn}' (${col.wipLimit})`);
      return false;
    }

    card.column = toColumn;
    card.order = cardsInColumn.length;
    card.updatedAt = Date.now();

    if (toColumn === 'Done') {
      card.completedAt = Date.now();
    }

    board.updatedAt = Date.now();
    this.save();
    return true;
  }

  /**
   * Delete a card.
   */
  deleteCard(cardId: string): boolean {
    const existed = this.cards.delete(cardId);
    if (existed) this.save();
    return existed;
  }

  /**
   * Archive a card.
   */
  archiveCard(cardId: string): boolean {
    const card = this.cards.get(cardId);
    if (!card) return false;
    card.status = 'archived';
    card.updatedAt = Date.now();
    this.save();
    return true;
  }

  /**
   * Get cards by column.
   */
  getCardsByColumn(boardId: string, column: string): KanbanCard[] {
    return [...this.cards.values()]
      .filter((c) => c.metadata.boardId === boardId && c.column === column && c.status === 'active')
      .sort((a, b) => a.order - b.order);
  }

  /**
   * Get cards by board.
   */
  getCardsByBoard(boardId: string): KanbanCard[] {
    return [...this.cards.values()]
      .filter((c) => c.metadata.boardId === boardId && c.status === 'active')
      .sort((a, b) => a.order - b.order);
  }

  /**
   * Get cards by assignee.
   */
  getCardsByAssignee(boardId: string, assignee: string): KanbanCard[] {
    return [...this.cards.values()]
      .filter((c) => c.metadata.boardId === boardId && c.assignee === assignee && c.status === 'active');
  }

  /**
   * Get overdue cards.
   */
  getOverdueCards(boardId?: string): KanbanCard[] {
    const now = Date.now();
    return [...this.cards.values()]
      .filter((c) => c.status === 'active' && c.dueDate && c.dueDate < now && (!boardId || c.metadata.boardId === boardId));
  }

  // ─── Search ────────────────────────────────────────────────────────

  /**
   * Search cards by query.
   */
  searchCards(boardId: string, query: string): KanbanCard[] {
    const lowerQuery = query.toLowerCase();
    return this.getCardsByBoard(boardId).filter(
      (c) =>
        c.title.toLowerCase().includes(lowerQuery) ||
        c.description?.toLowerCase().includes(lowerQuery) ||
        c.labels.some((l) => l.toLowerCase().includes(lowerQuery)),
    );
  }

  /**
   * Filter cards by priority.
   */
  filterByPriority(boardId: string, priority: CardPriority): KanbanCard[] {
    return this.getCardsByBoard(boardId).filter((c) => c.priority === priority);
  }

  /**
   * Filter cards by label.
   */
  filterByLabel(boardId: string, label: string): KanbanCard[] {
    return this.getCardsByBoard(boardId).filter((c) => c.labels.includes(label));
  }

  // ─── Statistics ────────────────────────────────────────────────────

  /**
   * Get board statistics.
   */
  getStats(boardId: string): BoardStats | null {
    const board = this.boards.get(boardId);
    if (!board) return null;

    const cards = this.getCardsByBoard(boardId);
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    const cardsByColumn: Record<string, number> = {};
    for (const col of board.columns) cardsByColumn[col.name] = 0;
    for (const card of cards) cardsByColumn[card.column] = (cardsByColumn[card.column] || 0) + 1;

    const cardsByPriority: Record<CardPriority, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const card of cards) cardsByPriority[card.priority]++;

    const cardsByLabel: Record<string, number> = {};
    for (const card of cards) {
      for (const label of card.labels) cardsByLabel[label] = (cardsByLabel[label] || 0) + 1;
    }

    const overdueCards = cards.filter((c) => c.dueDate && c.dueDate < now).length;

    const ages = cards.map((c) => (now - c.createdAt) / (24 * 60 * 60 * 1000));
    const averageAge = ages.length > 0 ? ages.reduce((a, b) => a + b, 0) / ages.length : 0;

    const throughput = cards.filter((c) => c.completedAt && c.completedAt > sevenDaysAgo).length;

    return {
      boardId,
      boardName: board.name,
      totalCards: cards.length,
      cardsByColumn,
      cardsByPriority,
      cardsByLabel,
      overdueCards,
      averageAge,
      throughput,
    };
  }

  // ─── Persistence ──────────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(KANBAN_DIR)) return;
      const files = readdirSync(KANBAN_DIR).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const data = readFileSync(join(KANBAN_DIR, file), 'utf-8');
        const parsed = JSON.parse(data);
        if (parsed.columns) {
          this.boards.set(parsed.id, parsed);
        } else if (parsed.column) {
          this.cards.set(parsed.id, parsed);
        }
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    try {
      if (!existsSync(KANBAN_DIR)) mkdirSync(KANBAN_DIR, { recursive: true });
      for (const [id, board] of this.boards) {
        writeFileSync(join(KANBAN_DIR, `board-${id}.json`), JSON.stringify(board, null, 2));
      }
      for (const [id, card] of this.cards) {
        writeFileSync(join(KANBAN_DIR, `card-${id}.json`), JSON.stringify(card, null, 2));
      }
    } catch (err) {
      logger.warn(`KanbanManager: Failed to save: ${err}`);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _instance: KanbanManager | null = null;

export function getKanbanManager(): KanbanManager {
  if (!_instance) _instance = new KanbanManager();
  return _instance;
}

export function resetKanbanManager(): void {
  _instance = null;
}
