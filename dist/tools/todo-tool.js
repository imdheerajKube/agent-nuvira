/**
 * Todo Tool — Task management with priorities, due dates, and status tracking.
 *
 * Hermes equivalent: todo_tool.py
 */
import { randomUUID } from 'node:crypto';
import { resolveNuviraHome } from '../config/paths.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
// ─── Todo Store ───────────────────────────────────────────────────────────
const TODO_DIR = join(resolveNuviraHome(), 'memory');
const TODO_FILE = join(TODO_DIR, 'todos.json');
export class TodoStore {
    items = new Map();
    constructor() {
        this.load();
    }
    add(title, options = {}) {
        const item = {
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
    update(id, updates) {
        const item = this.items.get(id);
        if (!item)
            return null;
        Object.assign(item, updates, { updatedAt: Date.now() });
        if (updates.status === 'completed')
            item.completedAt = Date.now();
        this.save();
        return item;
    }
    remove(id) {
        const existed = this.items.delete(id);
        if (existed)
            this.save();
        return existed;
    }
    get(id) {
        return this.items.get(id) || null;
    }
    getAll(filters) {
        let items = [...this.items.values()];
        if (filters?.status)
            items = items.filter((i) => i.status === filters.status);
        if (filters?.priority)
            items = items.filter((i) => i.priority === filters.priority);
        if (filters?.tag)
            items = items.filter((i) => i.tags.includes(filters.tag));
        return items.sort((a, b) => {
            const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
            return priorityOrder[a.priority] - priorityOrder[b.priority];
        });
    }
    getStats() {
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
    load() {
        try {
            if (existsSync(TODO_FILE)) {
                const data = readFileSync(TODO_FILE, 'utf-8');
                const parsed = JSON.parse(data);
                for (const item of parsed) {
                    this.items.set(item.id, item);
                }
            }
        }
        catch { /* ignore */ }
    }
    save() {
        try {
            if (!existsSync(TODO_DIR))
                mkdirSync(TODO_DIR, { recursive: true });
            writeFileSync(TODO_FILE, JSON.stringify([...this.items.values()], null, 2));
        }
        catch (err) {
            logger.warn(`TodoStore: Failed to save: ${err}`);
        }
    }
}
let _instance = null;
export function getTodoStore() {
    if (!_instance)
        _instance = new TodoStore();
    return _instance;
}
//# sourceMappingURL=todo-tool.js.map