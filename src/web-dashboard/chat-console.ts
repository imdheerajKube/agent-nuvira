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
      /** P3 — live working steps (tool calls / reasoning markers). */
      onProgress?: (line: string) => void;
      /** Live gateway for gateway_send (gateway-triggered chat answers reuse the connected bridge). */
      gateway?: {
        send(target: string, text: string): Promise<boolean>;
        directory: { resolve(target: string): { platform: string; channelId: string } | null };
      };
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

/** A live event for one session (P3 progress streaming). */
export type ChatConsoleEvent =
  | { kind: 'progress'; line: string }
  | { kind: 'status'; status: 'working' | 'done' | 'error' }
  | {
      kind: 'question';
      /** Unique id the client echoes back in the respond call. */
      questionId: string;
      question: string;
      /** Choice options (label + optional description) — serializable for the GUI. */
      choices: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
    };

/** The selection shape the GUI sends back to answer a pending question. */
export interface QuestionAnswer {
  /** Selected option index (or indices for multiSelect). -1 / [] = skip (decline). */
  index?: number | number[];
  /** Free-text answer (the GUI's "Other" field). */
  custom?: string;
}

/** The shape answerOnce's askUser expects. */
interface AskUserResult {
  answer: unknown;
  index: number | number[];
  custom?: string;
}

export class ChatConsole {
  private sessions = new Map<string, ChatTurn[]>();
  private busy = new Set<string>();
  private engine: ChatEngine | null;
  private listeners = new Set<(sessionId: string, event: ChatConsoleEvent) => void>();
  /** Pending ask_user questions per session — resolved by the GUI's respond(). */
  private pendingQuestions = new Map<
    string,
    { sessionId: string; resolve: (r: AskUserResult) => void }
  >();

  constructor(private readonly opts: ChatConsoleOptions = {}) {
    this.engine = opts.engine ?? null;
  }

  /** Subscribe to a session's live events (progress lines / status). Returns an unsubscribe fn. */
  onEvent(cb: (sessionId: string, event: ChatConsoleEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(sessionId: string, event: ChatConsoleEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(sessionId, event);
      } catch {
        /* a listener must never break the console */
      }
    }
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
    this.emit(sessionId, { kind: 'status', status: 'working' });
    try {
      const engine = await this.ensureEngine();
      const answer = await engine.answerOnce(clean, {
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        history: history.map((h) => ({ role: h.role, content: h.content })),
        // P0.1 — real ask_user round-trip: emit a `question` event, wait for
        // the GUI's respond() (or a skip), then feed the selection back. The
        // previous stub declined every clarification, so the GUI agent could
        // never ask "should I fix it?" / "verified list or send-by-name?".
        askUser: async (question, choices, multiSelect) => {
          const questionId = randomUUID();
          const opts2 = (choices ?? []) as Array<{ label?: string; description?: string }>;
          return this.askQuestion(sessionId, questionId, {
            question: String(question ?? ''),
            choices: opts2.map((c) => ({ label: String(c?.label ?? ''), description: c?.description ? String(c.description) : undefined })),
            multiSelect: multiSelect === true,
          });
        },
        // P3 — stream the agent's working steps to the GUI (tool calls, model
        // reasoning markers) instead of a silent wait.
        onProgress: (line) => this.emit(sessionId, { kind: 'progress', line }),
      });
      const turns: ChatTurn[] = [...history, { role: 'user', content: clean }];
      if (answer.content && answer.content.trim()) {
        turns.push({ role: 'assistant', content: answer.content });
      }
      const maxTurns = this.opts.maxTurns ?? DEFAULT_MAX_TURNS;
      this.sessions.set(sessionId, turns.length > maxTurns ? turns.slice(turns.length - maxTurns) : turns);
      this.emit(sessionId, { kind: 'status', status: 'done' });
      return {
        ok: true,
        content: answer.content,
        followups: answer.followups ?? [],
        provider: answer.provider ?? null,
        model: answer.model ?? null,
        generationFailed: answer.generationFailed === true,
      };
    } catch (err) {
      this.emit(sessionId, { kind: 'status', status: 'error' });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.busy.delete(sessionId);
    }
  }

  /**
   * Emit a question event and wait for the GUI's respond() (or skip).
   * Returns the ask_user result the engine expects; `index: -1` means the
   * user skipped, which preserves the pre-P0.1 "proceed on best judgment"
   * behavior.
   */
  private askQuestion(
    sessionId: string,
    questionId: string,
    payload: { question: string; choices: Array<{ label: string; description?: string }>; multiSelect: boolean },
  ): Promise<AskUserResult> {
    this.emit(sessionId, { kind: 'question', questionId, ...payload });
    return new Promise((resolve) => {
      // A stale turn could leave a question unanswered forever; the GUI's
      // skip button resolves it, and reset() sweeps leftovers. The promise
      // itself never rejects — worst case the model proceeds on best
      // judgment (the pre-P0.1 behavior).
      this.pendingQuestions.set(questionId, { sessionId, resolve });
    });
  }

  /**
   * Answer a pending question (from the GUI). Returns false when the
   * questionId is unknown or belongs to another session.
   */
  respond(sessionId: string, questionId: string, answer: QuestionAnswer = {}): boolean {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending || pending.sessionId !== sessionId) return false;
    this.pendingQuestions.delete(questionId);
    const index = answer.index ?? -1;
    const resolved: AskUserResult = {
      index,
      answer: Array.isArray(index) ? index : index === -1 ? [] : index,
      custom: answer.custom,
    };
    pending.resolve(resolved);
    return true;
  }

  /** Forget a session's history (new conversation) + drop its pending questions. */
  reset(sessionId: string): void {
    for (const [id, p] of this.pendingQuestions) {
      if (p.sessionId === sessionId) {
        this.pendingQuestions.delete(id);
        p.resolve({ answer: [], index: -1 });
      }
    }
    this.sessions.delete(sessionId);
    this.busy.delete(sessionId);
  }
}

/** A fresh session id for the client to hold (or the server may generate one). */
export function newChatSessionId(): string {
  return randomUUID();
}
