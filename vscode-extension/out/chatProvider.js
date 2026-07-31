"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatHistoryProvider = void 0;
// ─── Constants ───────────────────────────────────────────────────────────────
const STORAGE_KEY = 'agent-nuvira.chatSessions';
const MAX_SESSIONS = 50;
const MAX_MESSAGES_PER_SESSION = 200;
// ─── ChatHistoryProvider ─────────────────────────────────────────────────────
class ChatHistoryProvider {
    sessions = [];
    activeSessionId = null;
    storage;
    constructor(context) {
        this.storage = context.workspaceState;
        this.loadSessions();
    }
    // ── Session Management ────────────────────────────────────────────────────
    /**
     * Get all chat sessions, sorted by last updated (most recent first).
     */
    getSessions() {
        return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    /**
     * Get the active session ID.
     */
    getActiveSessionId() {
        return this.activeSessionId;
    }
    /**
     * Get the active session.
     */
    getActiveSession() {
        if (!this.activeSessionId)
            return null;
        return this.sessions.find((s) => s.id === this.activeSessionId) || null;
    }
    /**
     * Get a session by ID.
     */
    getSession(id) {
        return this.sessions.find((s) => s.id === id) || null;
    }
    /**
     * Create a new chat session and set it as active.
     */
    createSession(model, provider) {
        const session = {
            id: this.generateId(),
            title: 'New Chat',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            model,
            provider,
        };
        this.sessions.push(session);
        this.activeSessionId = session.id;
        this.trimSessions();
        this.saveSessions();
        return session;
    }
    /**
     * Switch to a different session.
     */
    switchSession(sessionId) {
        const session = this.getSession(sessionId);
        if (session) {
            this.activeSessionId = sessionId;
            return session;
        }
        return null;
    }
    /**
     * Delete a chat session.
     */
    deleteSession(sessionId) {
        const index = this.sessions.findIndex((s) => s.id === sessionId);
        if (index === -1)
            return false;
        this.sessions.splice(index, 1);
        if (this.activeSessionId === sessionId) {
            this.activeSessionId = this.sessions.length > 0
                ? this.sessions[this.sessions.length - 1].id
                : null;
        }
        this.saveSessions();
        return true;
    }
    /**
     * Clear all sessions.
     */
    clearAllSessions() {
        this.sessions = [];
        this.activeSessionId = null;
        this.saveSessions();
    }
    // ── Message Management ────────────────────────────────────────────────────
    /**
     * Add a message to the active session.
     */
    addMessage(message) {
        if (!this.activeSessionId)
            return null;
        const session = this.getActiveSession();
        if (!session)
            return null;
        const newMessage = {
            ...message,
            id: this.generateId(),
            timestamp: Date.now(),
        };
        session.messages.push(newMessage);
        // Trim if needed
        if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
            session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
        }
        session.updatedAt = Date.now();
        // Auto-generate title from first user message
        if (session.title === 'New Chat' && message.role === 'user') {
            session.title = this.generateTitle(message.content);
        }
        this.saveSessions();
        return newMessage;
    }
    /**
     * Update a message in the active session (e.g., for streaming updates).
     */
    updateMessage(messageId, updates) {
        const session = this.getActiveSession();
        if (!session)
            return false;
        const index = session.messages.findIndex((m) => m.id === messageId);
        if (index === -1)
            return false;
        session.messages[index] = { ...session.messages[index], ...updates };
        session.updatedAt = Date.now();
        this.saveSessions();
        return true;
    }
    /**
     * Get the last N messages for context (for sending to the LLM).
     */
    getContextMessages(count = 20) {
        const session = this.getActiveSession();
        if (!session)
            return [];
        return session.messages.slice(-count);
    }
    // ── Private ───────────────────────────────────────────────────────────────
    loadSessions() {
        try {
            const stored = this.storage.get(STORAGE_KEY);
            if (stored) {
                this.sessions = stored.sessions || [];
                this.activeSessionId = stored.activeId;
            }
        }
        catch {
            this.sessions = [];
            this.activeSessionId = null;
        }
        // Create a default session if none exist
        if (this.sessions.length === 0) {
            this.createSession();
        }
    }
    saveSessions() {
        try {
            this.storage.update(STORAGE_KEY, {
                sessions: this.sessions,
                activeId: this.activeSessionId,
            });
        }
        catch (err) {
            console.error('[agent-nuvira] Failed to save chat sessions:', err);
        }
    }
    trimSessions() {
        if (this.sessions.length > MAX_SESSIONS) {
            // Remove oldest sessions (keep the newest MAX_SESSIONS)
            this.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
            this.sessions = this.sessions.slice(0, MAX_SESSIONS);
        }
    }
    generateId() {
        return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }
    generateTitle(content) {
        // Take first meaningful line, max 50 chars
        const cleaned = content
            .replace(/^[/#]+\s*/, '')
            .replace(/[\\n\\r]+/g, ' ')
            .trim();
        const maxLen = 50;
        return cleaned.length > maxLen
            ? cleaned.slice(0, maxLen) + '…'
            : cleaned || 'New Chat';
    }
}
exports.ChatHistoryProvider = ChatHistoryProvider;
//# sourceMappingURL=chatProvider.js.map