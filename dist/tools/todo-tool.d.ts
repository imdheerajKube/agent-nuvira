/**
 * Todo Tool — Task management with priorities, due dates, and status tracking.
 *
 * Hermes equivalent: todo_tool.py
 */
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
export declare class TodoStore {
    private items;
    constructor();
    add(title: string, options?: Partial<Omit<TodoItem, 'id' | 'title' | 'status' | 'createdAt' | 'updatedAt'>>): TodoItem;
    update(id: string, updates: Partial<Pick<TodoItem, 'title' | 'description' | 'status' | 'priority' | 'tags' | 'dueDate'>>): TodoItem | null;
    remove(id: string): boolean;
    get(id: string): TodoItem | null;
    getAll(filters?: {
        status?: TodoStatus;
        priority?: TodoPriority;
        tag?: string;
    }): TodoItem[];
    getStats(): TodoStats;
    private load;
    private save;
}
export declare function getTodoStore(): TodoStore;
//# sourceMappingURL=todo-tool.d.ts.map