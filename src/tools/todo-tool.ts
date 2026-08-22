/**
 * Todo Tool — Task management with priorities, due dates, and status tracking.
 *
 * Hermes equivalent: todo_tool.py
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export type TodoStatus = 'pending' | 'in-progress' | 'completed' | 'cancelled';
export type TodoPriority = 'low' | 'medium' | 'high' | 'critical';

export interface TodoItem {
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
  priority: TodoPriority;
  tags: string[];
  dueDate?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  parentId?: string;
}

export interface TodoStats {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  overdue: number;
}

// ─── Todo Store ───────────────────────────────────────────────────────────

const TODO_DIR = join(homedir(), '.buff', 'memory');
const TODO_FILE = join(TODO_DIR, 'todos.json');

export class TodoStore {
  private items: Map<string, TodoItem> = new Map();

  constructor() {
    this.load();
  }

  add(title: string, options: Partial<Omit<TodoItem, 'id' | 'title' | 'status' | 'createdAt' | 'updatedAt'>> = {}): TodoItem {
    const item: TodoItem = {
      id: randomUUID(),
      title,
      description: options.description,
      status: 'pending',
      priority: options.priority || 'medium',
      tags: options.tags || [],
      dueDate: options.dueDate,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      parentId: options.parentId,
    };
    this.items.set(item.id, item);
    this.save();
    return item;
  }

  update(id: string, updates: Partial<Pick<TodoItem, 'title' | 'description' | 'status' | 'priority' | 'tags' | 'dueDate'>>): TodoItem | null {
    const item = this.items.get(id);
    if (!item) return null;

    Object.assign(item, updates, { updatedAt: Date.now() });
    if (updates.status === 'completed') item.completedAt = Date.now();
    this.save();
    return item;
  }

  remove(id: string): boolean {
    const existed = this.items.delete(id);
    if (existed) this.save();
    return existed;
  }

  get(id: string): TodoItem | null {
    return this.items.get(id) || null;
  }

  getAll(filters?: { status?: TodoStatus; priority?: TodoPriority; tag?: string }): TodoItem[] {
    let items = [...this.items.values()];
    if (filters?.status) items = items.filter((i) => i.status === filters.status);
    if (filters?.priority) items = items.filter((i) => i.priority === filters.priority);
    if (filters?.tag) items = items.filter((i) => i.tags.includes(filters.tag!));
    return items.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  getStats(): TodoStats {
    const now = Date.now();
    const items = [...this.items.values()];
    return {
      total: items.length,
      pending: items.filter((i) => i.status === 'pending').length,
      inProgress: items.filter((i) => i.status === 'in-progress').length,
      completed: items.filter((i) => i.status === 'completed').length,
      cancelled: items.filter((i) => i.status === 'cancelled').length,
      overdue: items.filter((i) => i.dueDate && i.dueDate < now && i.status !== 'completed').length,
    };
  }

  private load(): void {
    try {
      if (existsSync(TODO_FILE)) {
        const data = readFileSync(TODO_FILE, 'utf-8');
        const parsed = JSON.parse(data) as TodoItem[];
        for (const item of parsed) {
          this.items.set(item.id, item);
        }
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    try {
      if (!existsSync(TODO_DIR)) mkdirSync(TODO_DIR, { recursive: true });
      writeFileSync(TODO_FILE, JSON.stringify([...this.items.values()], null, 2));
    } catch (err) {
      logger.warn(`TodoStore: Failed to save: ${err}`);
    }
  }
}

let _instance: TodoStore | null = null;
export function getTodoStore(): TodoStore {
  if (!_instance) _instance = new TodoStore();
  return _instance;
}
