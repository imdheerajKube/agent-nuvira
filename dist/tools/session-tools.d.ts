/**
 * Session Tools — Session search and thread context management.
 *
 * Hermes equivalent: session_search_tool.py + thread_context.py
 *
 * Provides:
 * - Session search and retrieval
 * - Thread context management
 * - Conversation history tracking
 * - Key decision extraction
 * - Action item tracking
 */
export interface SessionEntry {
    /** Session ID */
    id: string;
    /** Session title */
    title: string;
    /** Session summary */
    summary: string;
    /** Messages in the session */
    messages: SessionMessage[];
    /** Key decisions made */
    decisions: string[];
    /** Action items */
    actionItems: ActionItem[];
    /** Tags for search */
    tags: string[];
    /** Created at */
    createdAt: number;
    /** Last updated */
    updatedAt: number;
}
export interface SessionMessage {
    /** Message role */
    role: 'user' | 'assistant' | 'system';
    /** Message content */
    content: string;
    /** Timestamp */
    timestamp: number;
    /** Tool calls in this message */
    toolCalls?: string[];
}
export interface ActionItem {
    /** Item ID */
    id: string;
    /** Description */
    description: string;
    /** Status */
    status: 'pending' | 'in-progress' | 'completed' | 'cancelled';
    /** Assignee */
    assignee?: string;
    /** Due date */
    dueDate?: number;
    /** Created at */
    createdAt: number;
}
export interface ThreadContext {
    /** Thread ID */
    id: string;
    /** Thread topic */
    topic: string;
    /** Summary of the thread */
    summary: string;
    /** Key points discussed */
    keyPoints: string[];
    /** Decisions made */
    decisions: string[];
    /** Open questions */
    openQuestions: string[];
    /** Related session IDs */
    relatedSessions: string[];
    /** Created at */
    createdAt: number;
    /** Last updated */
    updatedAt: number;
}
export interface SearchResult {
    /** Session or thread */
    item: SessionEntry | ThreadContext;
    /** Relevance score (0-1) */
    score: number;
    /** Matching excerpt */
    excerpt: string;
    /** Match type */
    matchType: 'title' | 'content' | 'tag' | 'decision' | 'action';
}
export declare class SessionStore {
    private sessions;
    constructor();
    /**
     * Create a new session.
     */
    create(title: string, summary?: string): SessionEntry;
    /**
     * Add a message to a session.
     */
    addMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string, toolCalls?: string[]): boolean;
    /**
     * Add a decision to a session.
     */
    addDecision(sessionId: string, decision: string): boolean;
    /**
     * Add an action item to a session.
     */
    addActionItem(sessionId: string, description: string, assignee?: string): ActionItem | null;
    /**
     * Update action item status.
     */
    updateActionItem(sessionId: string, itemId: string, status: ActionItem['status']): boolean;
    /**
     * Search sessions.
     */
    search(query: string): SearchResult[];
    /**
     * Get a session by ID.
     */
    get(sessionId: string): SessionEntry | null;
    /**
     * Get all sessions.
     */
    getAll(): SessionEntry[];
    /**
     * Delete a session.
     */
    delete(sessionId: string): boolean;
    private load;
    private save;
}
export declare class ThreadContextManager {
    private threads;
    constructor();
    /**
     * Create a new thread context.
     */
    create(topic: string, summary?: string): ThreadContext;
    /**
     * Add a key point to a thread.
     */
    addKeyPoint(threadId: string, point: string): boolean;
    /**
     * Add a decision to a thread.
     */
    addDecision(threadId: string, decision: string): boolean;
    /**
     * Add an open question to a thread.
     */
    addOpenQuestion(threadId: string, question: string): boolean;
    /**
     * Resolve an open question.
     */
    resolveQuestion(threadId: string, question: string): boolean;
    /**
     * Link a session to a thread.
     */
    linkSession(threadId: string, sessionId: string): boolean;
    /**
     * Search threads.
     */
    search(query: string): ThreadContext[];
    /**
     * Get a thread by ID.
     */
    get(threadId: string): ThreadContext | null;
    /**
     * Get all threads.
     */
    getAll(): ThreadContext[];
    private load;
    private save;
}
export declare function getSessionStore(): SessionStore;
export declare function getThreadContextManager(): ThreadContextManager;
//# sourceMappingURL=session-tools.d.ts.map