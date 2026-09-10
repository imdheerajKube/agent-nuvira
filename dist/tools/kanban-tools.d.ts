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
    averageAge: number;
    throughput: number;
}
export declare class KanbanManager {
    private boards;
    private cards;
    constructor();
    /**
     * Create a new board.
     */
    createBoard(name: string, options?: {
        description?: string;
        columns?: string[];
        swimlanes?: string[];
        wipLimits?: Record<string, number>;
    }): KanbanBoard;
    /**
     * Get a board by ID.
     */
    getBoard(boardId: string): KanbanBoard | null;
    /**
     * Get all boards.
     */
    getAllBoards(): KanbanBoard[];
    /**
     * Update board settings.
     */
    updateBoard(boardId: string, updates: Partial<Pick<KanbanBoard, 'name' | 'description' | 'swimlanes' | 'wipLimits'>>): boolean;
    /**
     * Delete a board.
     */
    deleteBoard(boardId: string): boolean;
    /**
     * Add a column to a board.
     */
    addColumn(boardId: string, columnName: string, wipLimit?: number): boolean;
    /**
     * Add a card to a board.
     */
    addCard(boardId: string, column: string, title: string, options?: Partial<Omit<KanbanCard, 'id' | 'title' | 'column' | 'createdAt' | 'updatedAt' | 'order' | 'status'>>): KanbanCard | null;
    /**
     * Get a card by ID.
     */
    getCard(cardId: string): KanbanCard | null;
    /**
     * Update a card.
     */
    updateCard(cardId: string, updates: Partial<Pick<KanbanCard, 'title' | 'description' | 'labels' | 'priority' | 'assignee' | 'dueDate' | 'estimatedHours' | 'actualHours'>>): boolean;
    /**
     * Move a card to a different column.
     */
    moveCard(boardId: string, cardId: string, toColumn: string): boolean;
    /**
     * Delete a card.
     */
    deleteCard(cardId: string): boolean;
    /**
     * Archive a card.
     */
    archiveCard(cardId: string): boolean;
    /**
     * Get cards by column.
     */
    getCardsByColumn(boardId: string, column: string): KanbanCard[];
    /**
     * Get cards by board.
     */
    getCardsByBoard(boardId: string): KanbanCard[];
    /**
     * Get cards by assignee.
     */
    getCardsByAssignee(boardId: string, assignee: string): KanbanCard[];
    /**
     * Get overdue cards.
     */
    getOverdueCards(boardId?: string): KanbanCard[];
    /**
     * Search cards by query.
     */
    searchCards(boardId: string, query: string): KanbanCard[];
    /**
     * Filter cards by priority.
     */
    filterByPriority(boardId: string, priority: CardPriority): KanbanCard[];
    /**
     * Filter cards by label.
     */
    filterByLabel(boardId: string, label: string): KanbanCard[];
    /**
     * Get board statistics.
     */
    getStats(boardId: string): BoardStats | null;
    private load;
    private save;
}
export declare function getKanbanManager(): KanbanManager;
export declare function resetKanbanManager(): void;
//# sourceMappingURL=kanban-tools.d.ts.map