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
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
// ─── Session Store ────────────────────────────────────────────────────────
const SESSION_DIR = join(resolveNuviraHome(), 'memory', 'sessions');
const THREAD_DIR = join(resolveNuviraHome(), 'memory', 'threads');
export class SessionStore {
    sessions = new Map();
    constructor() {
        this.load();
    }
    /**
     * Create a new session.
     */
    create(title, summary) {
        const session = {
            id: randomUUID(),
            title,
            summary: summary || '',
            messages: [],
            decisions: [],
            actionItems: [],
            tags: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        this.sessions.set(session.id, session);
        this.save();
        return session;
    }
    /**
     * Add a message to a session.
     */
    addMessage(sessionId, role, content, toolCalls) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return false;
        session.messages.push({
            role,
            content,
            timestamp: Date.now(),
            toolCalls,
        });
        session.updatedAt = Date.now();
        this.save();
        return true;
    }
    /**
     * Add a decision to a session.
     */
    addDecision(sessionId, decision) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return false;
        session.decisions.push(decision);
        session.updatedAt = Date.now();
        this.save();
        return true;
    }
    /**
     * Add an action item to a session.
     */
    addActionItem(sessionId, description, assignee) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return null;
        const item = {
            id: randomUUID(),
            description,
            status: 'pending',
            assignee,
            createdAt: Date.now(),
        };
        session.actionItems.push(item);
        session.updatedAt = Date.now();
        this.save();
        return item;
    }
    /**
     * Update action item status.
     */
    updateActionItem(sessionId, itemId, status) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return false;
        const item = session.actionItems.find((i) => i.id === itemId);
        if (!item)
            return false;
        item.status = status;
        session.updatedAt = Date.now();
        this.save();
        return true;
    }
    /**
     * Search sessions.
     */
    search(query) {
        const results = [];
        const lowerQuery = query.toLowerCase();
        for (const session of this.sessions.values()) {
            // Title match
            if (session.title.toLowerCase().includes(lowerQuery)) {
                results.push({
                    item: session,
                    score: 0.9,
                    excerpt: session.title,
                    matchType: 'title',
                });
                continue;
            }
            // Content match
            for (const msg of session.messages) {
                if (msg.content.toLowerCase().includes(lowerQuery)) {
                    const idx = msg.content.toLowerCase().indexOf(lowerQuery);
                    const start = Math.max(0, idx - 50);
                    const end = Math.min(msg.content.length, idx + query.length + 50);
                    results.push({
                        item: session,
                        score: 0.7,
                        excerpt: '...' + msg.content.slice(start, end) + '...',
                        matchType: 'content',
                    });
                    break;
                }
            }
            // Decision match
            for (const decision of session.decisions) {
                if (decision.toLowerCase().includes(lowerQuery)) {
                    results.push({
                        item: session,
                        score: 0.8,
                        excerpt: decision,
                        matchType: 'decision',
                    });
                    break;
                }
            }
            // Tag match
            if (session.tags.some((t) => t.toLowerCase().includes(lowerQuery))) {
                results.push({
                    item: session,
                    score: 0.6,
                    excerpt: session.tags.join(', '),
                    matchType: 'tag',
                });
            }
        }
        return results.sort((a, b) => b.score - a.score);
    }
    /**
     * Get a session by ID.
     */
    get(sessionId) {
        return this.sessions.get(sessionId) || null;
    }
    /**
     * Get all sessions.
     */
    getAll() {
        return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    /**
     * Delete a session.
     */
    delete(sessionId) {
        const existed = this.sessions.delete(sessionId);
        if (existed)
            this.save();
        return existed;
    }
    load() {
        try {
            if (!existsSync(SESSION_DIR))
                return;
            const files = readdirSync(SESSION_DIR).filter((f) => f.endsWith('.json'));
            for (const file of files) {
                const data = readFileSync(join(SESSION_DIR, file), 'utf-8');
                const session = JSON.parse(data);
                this.sessions.set(session.id, session);
            }
        }
        catch { /* ignore */ }
    }
    save() {
        try {
            if (!existsSync(SESSION_DIR))
                mkdirSync(SESSION_DIR, { recursive: true });
            for (const [id, session] of this.sessions) {
                writeFileSync(join(SESSION_DIR, `${id}.json`), JSON.stringify(session, null, 2));
            }
        }
        catch (err) {
            logger.warn(`SessionStore: Failed to save: ${err}`);
        }
    }
}
// ─── Thread Context Manager ───────────────────────────────────────────────
export class ThreadContextManager {
    threads = new Map();
    constructor() {
        this.load();
    }
    /**
     * Create a new thread context.
     */
    create(topic, summary) {
        const thread = {
            id: randomUUID(),
            topic,
            summary: summary || '',
            keyPoints: [],
            decisions: [],
            openQuestions: [],
            relatedSessions: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        this.threads.set(thread.id, thread);
        this.save();
        return thread;
    }
    /**
     * Add a key point to a thread.
     */
    addKeyPoint(threadId, point) {
        const thread = this.threads.get(threadId);
        if (!thread)
            return false;
        thread.keyPoints.push(point);
        thread.updatedAt = Date.now();
        this.save();
        return true;
    }
    /**
     * Add a decision to a thread.
     */
    addDecision(threadId, decision) {
        const thread = this.threads.get(threadId);
        if (!thread)
            return false;
        thread.decisions.push(decision);
        thread.updatedAt = Date.now();
        this.save();
        return true;
    }
    /**
     * Add an open question to a thread.
     */
    addOpenQuestion(threadId, question) {
        const thread = this.threads.get(threadId);
        if (!thread)
            return false;
        thread.openQuestions.push(question);
        thread.updatedAt = Date.now();
        this.save();
        return true;
    }
    /**
     * Resolve an open question.
     */
    resolveQuestion(threadId, question) {
        const thread = this.threads.get(threadId);
        if (!thread)
            return false;
        const idx = thread.openQuestions.indexOf(question);
        if (idx === -1)
            return false;
        thread.openQuestions.splice(idx, 1);
        thread.updatedAt = Date.now();
        this.save();
        return true;
    }
    /**
     * Link a session to a thread.
     */
    linkSession(threadId, sessionId) {
        const thread = this.threads.get(threadId);
        if (!thread)
            return false;
        if (!thread.relatedSessions.includes(sessionId)) {
            thread.relatedSessions.push(sessionId);
            thread.updatedAt = Date.now();
            this.save();
        }
        return true;
    }
    /**
     * Search threads.
     */
    search(query) {
        const lowerQuery = query.toLowerCase();
        return [...this.threads.values()].filter((t) => t.topic.toLowerCase().includes(lowerQuery) ||
            t.summary.toLowerCase().includes(lowerQuery) ||
            t.keyPoints.some((p) => p.toLowerCase().includes(lowerQuery)) ||
            t.decisions.some((d) => d.toLowerCase().includes(lowerQuery)));
    }
    /**
     * Get a thread by ID.
     */
    get(threadId) {
        return this.threads.get(threadId) || null;
    }
    /**
     * Get all threads.
     */
    getAll() {
        return [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    load() {
        try {
            if (!existsSync(THREAD_DIR))
                return;
            const files = readdirSync(THREAD_DIR).filter((f) => f.endsWith('.json'));
            for (const file of files) {
                const data = readFileSync(join(THREAD_DIR, file), 'utf-8');
                const thread = JSON.parse(data);
                this.threads.set(thread.id, thread);
            }
        }
        catch { /* ignore */ }
    }
    save() {
        try {
            if (!existsSync(THREAD_DIR))
                mkdirSync(THREAD_DIR, { recursive: true });
            for (const [id, thread] of this.threads) {
                writeFileSync(join(THREAD_DIR, `${id}.json`), JSON.stringify(thread, null, 2));
            }
        }
        catch (err) {
            logger.warn(`ThreadContextManager: Failed to save: ${err}`);
        }
    }
}
// ─── Singletons ───────────────────────────────────────────────────────────
let _sessionStore = null;
let _threadContextManager = null;
export function getSessionStore() {
    if (!_sessionStore)
        _sessionStore = new SessionStore();
    return _sessionStore;
}
export function getThreadContextManager() {
    if (!_threadContextManager)
        _threadContextManager = new ThreadContextManager();
    return _threadContextManager;
}
//# sourceMappingURL=session-tools.js.map