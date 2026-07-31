/**
 * Chat Provider — Manages chat session history, persistence, and message management
 * for the Agent-Nuvira Chat Panel (B1).
 *
 * Features:
 * - Persist chat sessions across VS Code restarts
 * - Create, switch, and delete chat sessions
 * - Auto-generate session titles from first message
 * - Support unlimited sessions with scrollable session list
 * - Each session stores: messages, timestamp, title, model
 */
import * as vscode from 'vscode';
export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    /** Optional file context attached to this message */
    fileContext?: {
        uri: string;
        language: string;
        content: string;
    }[];
    /** Whether this message is still streaming */
    streaming?: boolean;
}
export interface ChatSession {
    id: string;
    title: string;
    messages: ChatMessage[];
    createdAt: number;
    updatedAt: number;
    model?: string;
    provider?: string;
}
export declare class ChatHistoryProvider {
    private sessions;
    private activeSessionId;
    private storage;
    constructor(context: vscode.ExtensionContext);
    /**
     * Get all chat sessions, sorted by last updated (most recent first).
     */
    getSessions(): ChatSession[];
    /**
     * Get the active session ID.
     */
    getActiveSessionId(): string | null;
    /**
     * Get the active session.
     */
    getActiveSession(): ChatSession | null;
    /**
     * Get a session by ID.
     */
    getSession(id: string): ChatSession | null;
    /**
     * Create a new chat session and set it as active.
     */
    createSession(model?: string, provider?: string): ChatSession;
    /**
     * Switch to a different session.
     */
    switchSession(sessionId: string): ChatSession | null;
    /**
     * Delete a chat session.
     */
    deleteSession(sessionId: string): boolean;
    /**
     * Clear all sessions.
     */
    clearAllSessions(): void;
    /**
     * Add a message to the active session.
     */
    addMessage(message: Omit<ChatMessage, 'id' | 'timestamp'>): ChatMessage | null;
    /**
     * Update a message in the active session (e.g., for streaming updates).
     */
    updateMessage(messageId: string, updates: Partial<ChatMessage>): boolean;
    /**
     * Get the last N messages for context (for sending to the LLM).
     */
    getContextMessages(count?: number): ChatMessage[];
    private loadSessions;
    private saveSessions;
    private trimSessions;
    private generateId;
    private generateTitle;
}
//# sourceMappingURL=chatProvider.d.ts.map