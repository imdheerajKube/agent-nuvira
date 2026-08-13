/**
 * P3 — Dashboard chat console.
 *
 * In-process agent chat (GUI parity with `buff chat "<prompt>"`): each message
 * runs ONE tool-loop turn through ChatCommand.answerOnce — the exact engine
 * behind the CLI's single-shot chat — with the conversation history threaded
 * across turns so the GUI holds a real session, not isolated prompts.
 *
 * The engine is injectable so unit tests drive the console with a fake
 * answerOnce (no LLM, no tool loop); the default lazily imports the CLI chat
 * module on first use so the dashboard server never pays for it at import
 * time (chat.ts pulls the whole CLI router).
 */

import { randomUUID } from 'node:crypto';
import type { FollowupSuggestion } from '../tools/registry.js';

/** One stored turn in a chat session. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** The slice of ChatCommand the console drives (answerOnce satisfies it). */
export interface ChatEngine {
  answerOnce(
    message: string,
    opts?: {
      provider?: string;
      model?: string;
      dev?: boolean;
      history?: Array<{ role: string; content: string }>;
      askUser?: (question: string, choices: unknown[], multiSelect: boolean) => Promise<{ answer: unknown; index: number | number[]; custom?: string }>;
    },
  ): Promise<{
    content: string;
    followups: FollowupSuggestion[];
    generationFailed?: boolean;
    provider?: string;
    model?: string;
  }>;
}

export interface ChatConsoleOptions {
  /** Injectable engine (default: lazy ChatCommand — the real agent). */
  engine?: ChatEngine;
  /** Cap on turns kept per session (oldest dropped). */
  maxTurns?: number;
  /** Cap on in-memory sessions (oldest dropped). */
  maxSessions?: number;
}

/** Per-session per-message limits (the CLI has no hard cap; bound the server). */
const MAX_MESSAGE_LENGTH = 8000;
const DEFAULT_MAX_TURNS = 40;
const DEFAULT_MAX_SESSIONS = 50;

export interface ChatAnswerResult {
  ok: boolean;
  content?: string;
  followups?: FollowupSuggestion[];
  provider?: string | null;
  model?: string | null;
  generationFailed?: boolean;
  error?: string;
}

export class ChatConsole {
  private sessions = new Map<string, ChatTurn[]>();
  private busy = new Set<string>();
  private engine: ChatEngine | null;

  constructor(private readonly opts: ChatConsoleOptions = {}) {
    this.engine = opts.engine ?? null;
  }

  /** Lazily load the real agent engine (ChatCommand) on first use. */
  private async ensureEngine(): Promise<ChatEngine> {
    if (this.engine) return this.engine;
    const { ChatCommand } = await import('../cli/chat.js');
    this.engine = new ChatCommand() as unknown as ChatEngine;
    return this.engine;
  }

  /** The stored turns for a session (empty when unknown). */
  history(sessionId: string): ChatTurn[] {
    return this.sessions.get(sessionId) ?? [];
  }

  /** True while a message is being answered in this session. */
  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId);
  }

  /**
   * Run one turn for a session. Threads the stored history as context; the
   * reply (and followup chips) come back as data. One in-flight turn per
   * session; the ask_user tool is declined (returns no selection) so the turn
   * never blocks on a TTY prompt inside the server.
   */
  async answer(
    sessionId: string,
    message: string,
    opts: { provider?: string; model?: string } = {},
  ): Promise<ChatAnswerResult> {
    const clean = (message || '').trim();
    if (!clean) return { ok: false, error: 'Empty message.' };
    if (clean.length > MAX_MESSAGE_LENGTH) {
      return { ok: false, error: `Message exceeds ${MAX_MESSAGE_LENGTH} characters.` };
    }
    if (this.busy.has(sessionId)) {
      return { ok: false, error: 'A message is already being answered in this session — wait for it to finish.' };
    }
    // Enforce the session cap (drop oldest sessions).
    if (!this.sessions.has(sessionId) && this.sessions.size >= (this.opts.maxSessions ?? DEFAULT_MAX_SESSIONS)) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest) this.sessions.delete(oldest);
    }
    const history = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, history);
    this.busy.add(sessionId);
    try {
      const engine = await this.ensureEngine();
      const answer = await engine.answerOnce(clean, {
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        history: history.map((h) => ({ role: h.role, content: h.content })),
        // Non-TTY ask_user: decline the clarification so the model proceeds
        // on best judgment instead of blocking on the server's piped stdin.
        askUser: async () => ({ answer: [], index: -1 }),
      });
      const turns: ChatTurn[] = [...history, { role: 'user', content: clean }];
      if (answer.content && answer.content.trim()) {
        turns.push({ role: 'assistant', content: answer.content });
      }
      const maxTurns = this.opts.maxTurns ?? DEFAULT_MAX_TURNS;
      this.sessions.set(sessionId, turns.length > maxTurns ? turns.slice(turns.length - maxTurns) : turns);
      return {
        ok: true,
        content: answer.content,
        followups: answer.followups ?? [],
        provider: answer.provider ?? null,
        model: answer.model ?? null,
        generationFailed: answer.generationFailed === true,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.busy.delete(sessionId);
    }
  }

  /** Forget a session's history (new conversation). */
  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.busy.delete(sessionId);
  }
}

/** A fresh session id for the client to hold (or the server may generate one). */
export function newChatSessionId(): string {
  return randomUUID();
}
