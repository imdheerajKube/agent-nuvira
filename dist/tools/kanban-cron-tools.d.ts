/**
 * Kanban Tools — Kanban board management.
 *
 * Hermes equivalent: kanban_tools.py
 */
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
export declare class KanbanManager {
    private boards;
    constructor();
    /**
     * Create a new board.
     */
    createBoard(name: string, columns?: string[]): KanbanBoard;
    /**
     * Add a card to a board.
     */
    addCard(boardId: string, column: string, title: string, options?: Partial<Omit<KanbanCard, 'id' | 'title' | 'column' | 'createdAt' | 'updatedAt' | 'order'>>): KanbanCard | null;
    /**
     * Move a card to a different column.
     */
    moveCard(boardId: string, cardId: string, toColumn: string): boolean;
    /**
     * Get board status.
     */
    getBoardStatus(boardId: string): Record<string, number> | null;
    /**
     * Get a board.
     */
    getBoard(boardId: string): KanbanBoard | null;
    /**
     * Get all boards.
     */
    getAllBoards(): KanbanBoard[];
    private load;
    private save;
}
export interface CronJob {
    id: string;
    name: string;
    schedule: string;
    command: string;
    enabled: boolean;
    lastRun?: number;
    nextRun?: number;
    createdAt: number;
}
export declare class CronJobManager {
    private jobs;
    private timers;
    constructor();
    /**
     * Create a cron job.
     */
    create(name: string, schedule: string, command: string): CronJob;
    /**
     * Enable/disable a job.
     */
    setEnabled(jobId: string, enabled: boolean): boolean;
    /**
     * Get all jobs.
     */
    getAllJobs(): CronJob[];
    /**
     * Delete a job.
     */
    deleteJob(jobId: string): boolean;
    private parseNextRun;
    private load;
    private save;
}
export declare function getKanbanManager(): KanbanManager;
export declare function getCronJobManager(): CronJobManager;
//# sourceMappingURL=kanban-cron-tools.d.ts.map