/**
 * Gateway Chat History Store (`src/gateway/chat-store.ts`).
 *
 * Persists per-contact conversation history to disk so that gateway chats
 * (WhatsApp, Telegram, Discord, ...) survive restarts. Follows the same
 * conventions as DeliveryLedger/InboxLedger:
 *
 * - File: `~/.nuvira/gateway/chat-history.json`
 * - Keyed by `platform:channelId`
 * - Each conversation holds the last N message pairs (user + assistant)
 * - TTL: conversations older than 7 days are automatically pruned
 * - Cap: max 100 conversations stored; oldest evicted first
 * - Best-effort: read/write failures never throw
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveBuffConfigDir } from '../config/paths.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max message pairs retained per contact. */
export const CHAT_HISTORY_MAX_PAIRS = 10;
/** Max number of distinct conversations (contacts) stored. */
export const CHAT_HISTORY_MAX_CONVERSATIONS = 100;
/** Conversations older than this (ms) are pruned. 7 days. */
export const CHAT_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Epoch-ms when this message was stored. */
  ts: number;
}

export interface ChatConversation {
  /** Platform + channel id, e.g. "whatsapp:9188006663237". */
  key: string;
  /** Messages in chronological order (oldest first). */
  messages: ChatMessage[];
  /** Epoch-ms of the last message (for TTL/pruning). */
  lastActiveAt: number;
  /** User-defined tags for organizing conversations. */
  tags?: string[];
}

interface ChatHistoryData {
  version: number;
  conversations: Record<string, ChatConversation>;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export class GatewayChatStore {
  private file: string;

  constructor(configDir?: string) {
    this.file = join(resolveBuffConfigDir(configDir), 'gateway', 'chat-history.json');
  }

  /** Absolute path of the store file. */
  get storePath(): string {
    return this.file;
  }

  /** Load all conversations from disk. Never throws. */
  private read(): ChatHistoryData {
    try {
      if (!existsSync(this.file)) return { version: 1, conversations: {} };
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as ChatHistoryData;
      if (parsed && typeof parsed.conversations === 'object') return parsed;
      return { version: 1, conversations: {} };
    } catch {
      return { version: 1, conversations: {} };
    }
  }

  /** Persist conversations to disk. Never throws. */
  private write(data: ChatHistoryData): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      /* best-effort — a failed write must never break a chat turn */
    }
  }

  /**
   * Load conversation history for a contact.
   * Returns messages in chronological order (oldest first), or [] if none.
   */
  getHistory(key: string): ChatMessage[] {
    const data = this.read();
    const conv = data.conversations[key];
    return conv?.messages ?? [];
  }

  /**
   * Append a user message + assistant response to a contact's conversation.
   * Trims to CHAT_HISTORY_MAX_PAIRS and persists to disk.
   */
  append(key: string, userMessage: string, assistantMessage: string): void {
    const data = this.read();
    const now = Date.now();
    const existing = data.conversations[key];

    const messages: ChatMessage[] = [
      ...(existing?.messages ?? []),
      { role: 'user', content: userMessage, ts: now },
      { role: 'assistant', content: assistantMessage, ts: now },
    ];

    // Trim to max pairs (each pair = 2 messages).
    const maxMessages = CHAT_HISTORY_MAX_PAIRS * 2;
    const trimmed = messages.slice(-maxMessages);

    data.conversations[key] = {
      key,
      messages: trimmed,
      lastActiveAt: now,
    };

    this.write(data);
  }

  /**
   * Remove conversation history for a specific contact.
   */
  clear(key: string): void {
    const data = this.read();
    delete data.conversations[key];
    this.write(data);
  }

  /** Set tags on a conversation (replaces existing tags). */
  setTags(key: string, tags: string[]): void {
    const data = this.read();
    const conv = data.conversations[key];
    if (!conv) return;
    conv.tags = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    this.write(data);
  }

  /** Add a single tag to a conversation (no-op if already present). */
  addTag(key: string, tag: string): void {
    const data = this.read();
    const conv = data.conversations[key];
    if (!conv) return;
    const normalized = tag.trim().toLowerCase();
    if (!normalized) return;
    if (!conv.tags) conv.tags = [];
    if (!conv.tags.includes(normalized)) conv.tags.push(normalized);
    this.write(data);
  }

  /** Remove a single tag from a conversation. */
  removeTag(key: string, tag: string): void {
    const data = this.read();
    const conv = data.conversations[key];
    if (!conv?.tags) return;
    const normalized = tag.trim().toLowerCase();
    conv.tags = conv.tags.filter((t) => t !== normalized);
    this.write(data);
  }

  /** Get all unique tags across all conversations. */
  getAllTags(): string[] {
    const data = this.read();
    const tags = new Set<string>();
    for (const conv of Object.values(data.conversations)) {
      if (conv.tags) conv.tags.forEach((t) => tags.add(t));
    }
    return [...tags].sort();
  }

  /**
   * Prune conversations older than CHAT_HISTORY_TTL_MS and enforce the
   * max-conversations cap (evict oldest first). Returns the number removed.
   */
  prune(now = Date.now()): number {
    const data = this.read();
    const keys = Object.keys(data.conversations);
    const before = keys.length;

    // Remove expired conversations.
    for (const key of keys) {
      const conv = data.conversations[key];
      if (now - conv.lastActiveAt > CHAT_HISTORY_TTL_MS) {
        delete data.conversations[key];
      }
    }

    // Enforce cap: sort remaining by lastActiveAt ascending, remove oldest.
    const remaining = Object.entries(data.conversations)
      .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt);
    while (remaining.length > CHAT_HISTORY_MAX_CONVERSATIONS) {
      const [oldestKey] = remaining.shift()!;
      delete data.conversations[oldestKey];
    }

    this.write(data);
    return before - Object.keys(data.conversations).length;
  }

  /** All conversations, sorted by lastActiveAt descending. */
  getAllConversations(): ChatConversation[] {
    const data = this.read();
    return Object.values(data.conversations)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /** Total number of stored conversations. */
  count(): number {
    return Object.keys(this.read().conversations).length;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: GatewayChatStore | null = null;

export function getGatewayChatStore(configDir?: string): GatewayChatStore {
  if (!_instance) _instance = new GatewayChatStore(configDir);
  return _instance;
}

export function resetGatewayChatStore(): void {
  _instance = null;
}
