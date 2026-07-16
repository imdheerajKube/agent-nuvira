/**
 * ChatHistory — Stores and retrieves chat conversation history.
 *
 * History is stored in a JSON file at ~/.buff/memory/history.json
 * and supports keyword search for retrieving past conversations.
 *
 * Features:
 * - Store chat sessions with messages
 * - Keyword search across all past conversations
 * - Configurable retention period (default: 30 days)
 * - Automatic cleanup of old entries
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HistoryMessage {
  /** Role: 'user' or 'assistant' */
  role: 'user' | 'assistant';
  /** Message content */
  content: string;
  /** Timestamp when message was sent */
  timestamp: number;
}

export interface HistorySession {
  /** Unique session ID */
  id: string;
  /** Provider used */
  provider: string;
  /** Model used */
  model: string;
  /** When the session started */
  startedAt: number;
  /** When the session ended */
  endedAt: number;
  /** Messages in the session */
  messages: HistoryMessage[];
  /** Summary of the session (generated from first user message) */
  summary: string;
  /** Tags for categorizing sessions */
  tags: string[];
}

interface HistoryData {
  sessions: Record<string, HistorySession>;
  version: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MEMORY_DIR = join(homedir(), '.buff', 'memory');
const HISTORY_PATH = join(MEMORY_DIR, 'history.json');
const CURRENT_VERSION = 1;

/** Default retention period in days */
const DEFAULT_RETENTION_DAYS = 30;

/** Maximum sessions to keep */
const MAX_SESSIONS = 500;

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function readHistory(): HistoryData {
  try {
    ensureDir();
    if (!existsSync(HISTORY_PATH)) {
      return { sessions: {}, version: CURRENT_VERSION };
    }
    const raw = readFileSync(HISTORY_PATH, 'utf-8');
    return JSON.parse(raw) as HistoryData;
  } catch {
    return { sessions: {}, version: CURRENT_VERSION };
  }
}

function writeHistory(data: HistoryData): void {
  ensureDir();
  writeFileSync(HISTORY_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Extract a summary from the first user message.
 */
function generateSummary(messages: HistoryMessage[]): string {
  const firstUserMsg = messages.find((m) => m.role === 'user');
  if (!firstUserMsg) return 'Empty session';
  const text = firstUserMsg.content.slice(0, 120);
  return text.length < firstUserMsg.content.length ? text + '...' : text;
}

/**
 * Extract tags from messages for better search.
 * Simple keyword-based tagging.
 */
function extractTags(messages: HistoryMessage[]): string[] {
  const content = messages.map((m) => m.content.toLowerCase()).join(' ');
  const tags: string[] = [];

  const keywordTags: Record<string, string[]> = {
    'code': ['create', 'write', 'implement', 'code', 'function', 'class', 'file'],
    'debug': ['debug', 'fix', 'bug', 'error', 'issue', 'broken'],
    'refactor': ['refactor', 'improve', 'optimize', 'clean', 'restructure'],
    'explain': ['explain', 'what is', 'how does', 'why', 'describe', 'tell me about'],
    'architecture': ['architecture', 'design', 'plan', 'structure', 'pattern'],
    'test': ['test', 'testing', 'spec', 'assert', 'verify'],
    'config': ['config', 'setup', 'install', 'configure', 'deploy'],
  };

  for (const [tag, keywords] of Object.entries(keywordTags)) {
    if (keywords.some((kw) => content.includes(kw))) {
      tags.push(tag);
    }
  }

  return tags.slice(0, 5); // Max 5 tags
}

// ─── ChatHistory ────────────────────────────────────────────────────────────

/**
 * Manages chat conversation history with search capabilities.
 */
export class ChatHistory {
  /**
   * Store a completed chat session.
   */
  storeSession(
    messages: HistoryMessage[],
    provider: string,
    model: string,
  ): string {
    if (messages.length === 0) return '';

    const data = readHistory();
    this.pruneIfNeeded(data);

    const id = generateSessionId();
    const startedAt = messages[0]?.timestamp || Date.now();
    const endedAt = messages[messages.length - 1]?.timestamp || Date.now();

    const session: HistorySession = {
      id,
      provider,
      model,
      startedAt,
      endedAt,
      messages,
      summary: generateSummary(messages),
      tags: extractTags(messages),
    };

    data.sessions[id] = session;
    writeHistory(data);

    return id;
  }

  /**
   * Get a specific session by ID.
   */
  getSession(id: string): HistorySession | null {
    const data = readHistory();
    return data.sessions[id] || null;
  }

  /**
   * Search sessions by keyword in message content.
   * Performs case-insensitive substring matching on all messages.
   *
   * @param query  Search keyword or phrase
   * @param limit  Maximum results to return
   * @returns      Matching sessions sorted by relevance
   */
  search(query: string, limit: number = 10): HistorySession[] {
    const data = readHistory();
    const q = query.toLowerCase();

    const scored = Object.values(data.sessions)
      .map((session) => {
        let score = 0;

        // Score based on summary match
        if (session.summary.toLowerCase().includes(q)) {
          score += 5;
        }

        // Score based on tag matches
        if (session.tags.some((t) => t.includes(q))) {
          score += 3;
        }

        // Score based on message content matches
        for (const msg of session.messages) {
          const content = msg.content.toLowerCase();
          if (content.includes(q)) {
            // More weight for user messages and exact matches
            score += msg.role === 'user' ? 2 : 1;

            // Bonus for early messages (more relevant to the topic)
            const idx = session.messages.indexOf(msg);
            if (idx < 3) score += 0.5;
          }
        }

        return { session, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.session);

    return scored;
  }

  /**
   * Get all sessions, sorted by recency.
   */
  getAllSessions(limit: number = 50): HistorySession[] {
    const data = readHistory();
    return Object.values(data.sessions)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  /**
   * Get recent sessions (last N days).
   */
  getRecentSessions(days: number = 7): HistorySession[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const data = readHistory();
    return Object.values(data.sessions)
      .filter((s) => s.startedAt >= cutoff)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Get total number of stored sessions.
   */
  count(): number {
    const data = readHistory();
    return Object.keys(data.sessions).length;
  }

  /**
   * Clear all history.
   */
  clear(): void {
    writeHistory({ sessions: {}, version: CURRENT_VERSION });
  }

  /**
   * Delete sessions older than the specified retention period.
   */
  prune(retentionDays: number = DEFAULT_RETENTION_DAYS): number {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const data = readHistory();
    let removed = 0;

    for (const [id, session] of Object.entries(data.sessions)) {
      if (session.startedAt < cutoff) {
        delete data.sessions[id];
        removed++;
      }
    }

    if (removed > 0) {
      writeHistory(data);
    }

    return removed;
  }

  /**
   * Format a search result for display.
   */
  formatSessionSummary(session: HistorySession): string {
    const date = new Date(session.startedAt).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    const msgCount = session.messages.length;
    const tags = session.tags.length > 0 ? ` [${session.tags.join(', ')}]` : '';

    return `  📝 ${session.id.slice(0, 20).padEnd(22)} ${date.padEnd(20)} ${String(msgCount).padStart(3)} msgs  ${session.summary.slice(0, 60).padEnd(62)}${tags}`;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private pruneIfNeeded(data: HistoryData): void {
    const entries = Object.keys(data.sessions);
    if (entries.length < MAX_SESSIONS) return;

    // Remove oldest sessions
    const sorted = entries
      .map((id) => ({ id, session: data.sessions[id] }))
      .sort((a, b) => a.session.startedAt - b.session.startedAt);

    const toRemove = sorted.slice(0, entries.length - MAX_SESSIONS + 10);
    for (const { id } of toRemove) {
      delete data.sessions[id];
    }
  }
}

// Singleton instance
let historyInstance: ChatHistory | null = null;

export function getChatHistory(): ChatHistory {
  if (!historyInstance) {
    historyInstance = new ChatHistory();
  }
  return historyInstance;
}
