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
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FollowupSuggestion } from '../tools/registry.js';
import { PlanStore, type PlanSnapshot, type PlanStoreLike } from '../tools/plan-store.js';

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
      /** P3 — bounded project snapshot injected as a `[Project context]` message. */
      projectContext?: string;
      /** P4 — attached project dir; the engine recalls its sessions + facts. */
      projectPath?: string;
      /**
       * P4 — stream answer tokens live (the typewriter). Called with each
       * content token as the model generates it; non-streaming providers
       * deliver the whole step content at once.
       */
      onToken?: (token: string) => void;
      /**
       * P4 — external cancellation (the dashboard Cancel button): the engine
       * stops the turn at the next loop boundary and aborts any in-flight
       * provider request. The console discards the cancelled turn entirely.
       */
      signal?: AbortSignal;
      /** P0.6 — one tool-call lifecycle event (started → called with outcome). */
      onToolCall?: (phase: 'started' | 'called', info: { id?: string; tool: string; args?: Record<string, unknown>; ok?: boolean; result?: string; error?: string; durationMs?: number }) => void;
      /** P0.7 — a plan mutation (structured checklist for the GUI card). */
      onPlanChange?: (snapshot: PlanSnapshot) => void;
      /** P3b — a git diff payload (rendered as a diff card in the GUI). */
      onGitDiff?: (payload: import('../tools/git-tool.js').GitDiffPayload) => void;
      /** P0.7 — the session's plan store (per-conversation, survives turns). */
      planStore?: PlanStoreLike;
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
  /**
   * P4 — JSON file the session store persists through (survives server
   * restarts, so the dashboard's session sidebar can resume any past
   * conversation). Absent = in-memory only (unit tests).
   */
  persistPath?: string;
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
  /** P4 — true when the turn was cancelled via abort() (discarded, no state). */
  cancelled?: boolean;
  error?: string;
}

/** P4 — one persisted session record (turns + sidebar metadata). */
export interface ChatSessionRecord {
  /** The conversation turns (user/assistant). */
  turns: ChatTurn[];
  /** Sidebar title — the first user message, truncated. */
  title: string;
  createdAt: number;
  updatedAt: number;
}

/** P4 — the sidebar summary shape for `GET /api/sessions`. */
export interface ChatSessionSummary {
  id: string;
  title: string;
  turnCount: number;
  createdAt: number;
  updatedAt: number;
  /** The last assistant reply (truncated) — "what this conversation was about". */
  preview: string;
}

/** A live event for one session (P3 progress streaming). */
export type ChatConsoleEvent =
  | { kind: 'progress'; line: string }
  | {
      /** P0.6 — one tool-call lifecycle step (rendered as a card in the GUI). */
      kind: 'tool';
      /** Stable per-call id (e.g. `call_1`) — the client matches started→called. */
      id: string;
      tool: string;
      phase: 'started' | 'called';
      /** One-line args preview, e.g. `{path: 'src/foo.ts'}` (60 chars). */
      args?: string;
      ok?: boolean;
      result?: string;
      error?: string;
      durationMs?: number;
    }
  | {
      /** P0.7 — a plan mutation (rendered as a live checklist card in the GUI). */
      kind: 'plan';
      goal: string;
      steps: Array<{ id: string; description: string; status: 'pending' | 'running' | 'done' | 'blocked' }>;
      revision: number;
    }
  | {
      /** P3b — a git diff payload (rendered as a 🔧 diff card with +/− sections). */
      kind: 'diff';
      files: Array<{ path: string; body: string }>;
      summary: string;
    }
  | { kind: 'status'; status: 'working' | 'done' | 'error' }
  | {
      /**
       * P4 — one content token of the answer as it streams (the typewriter).
       * The POST response remains authoritative: the GUI renders the stream
       * live and REPLACES it with the final content when the turn resolves
       * (the engine's S1 longest-substantive logic may select an earlier,
       * longer answer than the last chunk).
       */
      kind: 'token';
      text: string;
    }
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
  private sessions = new Map<string, ChatSessionRecord>();
  private busy = new Set<string>();
  private engine: ChatEngine | null;
  private listeners = new Set<(sessionId: string, event: ChatConsoleEvent) => void>();
  /** Pending ask_user questions per session — resolved by the GUI's respond(). */
  private pendingQuestions = new Map<
    string,
    { sessionId: string; resolve: (r: AskUserResult) => void }
  >();
  /** P0.7 — per-session plan stores (plans never leak across conversations). */
  private planStores = new Map<string, PlanStore>();
  /**
   * P4 — the in-flight turn's AbortController per session (set while a turn
   * runs, deleted in finally). abort(sessionId) fires it: the engine stops at
   * the next loop boundary + aborts the in-flight provider request.
   */
  private activeAborts = new Map<string, AbortController>();

  constructor(private readonly opts: ChatConsoleOptions = {}) {
    this.engine = opts.engine ?? null;
    // P4 — reload persisted sessions so the sidebar resumes past conversations
    // after a server restart. Corrupt/unreadable stores degrade to empty.
    if (opts.persistPath && existsSync(opts.persistPath)) {
      try {
        const raw = readFileSync(opts.persistPath, 'utf8');
        const data = JSON.parse(raw) as { sessions?: Record<string, ChatSessionRecord> };
        for (const [id, rec] of Object.entries(data?.sessions ?? {})) {
          if (typeof id !== 'string' || !id || !rec || !Array.isArray(rec.turns)) continue;
          this.sessions.set(id, { turns: rec.turns, title: String(rec.title ?? ''), createdAt: Number(rec.createdAt) || 0, updatedAt: Number(rec.updatedAt) || 0 });
        }
      } catch {
        /* unreadable store — start empty rather than crash the dashboard */
      }
    }
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
    return this.sessions.get(sessionId)?.turns ?? [];
  }

  /**
   * P4 — sidebar summaries, most recently updated first. The server exposes
   * these via `GET /api/sessions`.
   */
  list(): ChatSessionSummary[] {
    return [...this.sessions.entries()]
      .map(([id, rec]) => ({
        id,
        title: rec.title || '(untitled conversation)',
        turnCount: rec.turns.length,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        preview: lastAssistantText(rec.turns),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * P4 — the full persisted record for one session (transcript for resume).
   * Returns null when unknown.
   */
  get(sessionId: string): ChatSessionRecord | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** P4 — write the session store through to disk (atomic-ish: temp + rename). */
  private persist(): void {
    const path = this.opts.persistPath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const payload = JSON.stringify({ sessions: Object.fromEntries(this.sessions) });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, payload, 'utf8');
      renameSync(tmp, path);
    } catch {
      /* persistence is best-effort — a failed write must never break chat */
    }
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
    opts: { provider?: string; model?: string; projectContext?: string; projectPath?: string } = {},
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
    const existing = this.sessions.get(sessionId);
    const history = existing?.turns ?? [];
    const now = Date.now();
    this.sessions.set(sessionId, {
      turns: history,
      title: existing?.title ?? '',
      createdAt: existing?.createdAt ?? now,
      updatedAt: existing?.updatedAt ?? now,
    });
    this.busy.add(sessionId);
    // P4 — one AbortController per turn: abort(sessionId) fires it, the
    // engine stops at the next loop boundary (and aborts the in-flight
    // provider request), and the turn is DISCARDED (no persist, no events).
    const controller = new AbortController();
    this.activeAborts.set(sessionId, controller);
    // Stale-turn guard: after a cancel, a new turn may start while the old
    // engine unwinds — its callbacks must never emit into the new turn.
    const emitTurn = (event: ChatConsoleEvent): void => {
      if (controller.signal.aborted) return;
      this.emit(sessionId, event);
    };
    this.emit(sessionId, { kind: 'status', status: 'working' });
    try {
      const engine = await this.ensureEngine();
      const answer = await engine.answerOnce(clean, {
        // P4 — the cancel signal rides into the turn.
        signal: controller.signal,
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        // P3 — project context rides into the turn (the engine injects it as
        // a `[Project context]` message in the thread).
        ...(opts.projectContext ? { projectContext: opts.projectContext } : {}),
        // P4 — the attached project dir triggers the engine's per-turn recall
        // of that project's prior sessions + facts.
        ...(opts.projectPath ? { projectPath: opts.projectPath } : {}),
        // P4 — stream answer tokens to the GUI (the typewriter bubble).
        onToken: (text) => emitTurn({ kind: 'token', text }),
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
        onProgress: (line) => emitTurn({ kind: 'progress', line }),
        // P0.6 — structured step cards: forward each tool-call lifecycle
        // event. suggest_followups has its own chips UI and ask_user its own
        // question card — neither renders as a tool card.
        onToolCall: (phase, info) => {
          // ask_user/suggest_followups have their own cards; plan_todo is
          // rendered as the dedicated checklist card (the `plan` event).
          if (info.tool === 'suggest_followups' || info.tool === 'ask_user' || info.tool === 'plan_todo') return;
          emitTurn({
            kind: 'tool',
            id: info.id ?? `call_${Date.now().toString(36)}`,
            tool: info.tool,
            phase,
            args: summarizeToolArgs(info.args),
            ok: info.ok,
            result: info.result,
            error: info.error,
            durationMs: info.durationMs,
          });
        },
        // P0.7 — forward plan mutations as a dedicated checklist event (the
        // plan_todo tool itself is NOT a generic step card — the checklist
        // card is its rendering).
        onPlanChange: (snapshot) => {
          emitTurn({ kind: 'plan', goal: snapshot.goal, steps: snapshot.steps, revision: snapshot.revision });
        },
        // P3b — forward git diff payloads as a dedicated diff event (the git
        // tool's diff is rendered as a card, not a generic step card).
        onGitDiff: (payload) => {
          emitTurn({ kind: 'diff', files: payload.files, summary: payload.summary });
        },
        planStore: this.planStoreFor(sessionId),
      });
      // P4 — a cancelled turn is DISCARDED entirely: no session write, no
      // persist, no status:done, no events (the client already walked away
      // and may have started a new turn). abort() released busy immediately.
      if (controller.signal.aborted) {
        return { ok: false, error: 'The turn was cancelled.', cancelled: true };
      }
      const turns: ChatTurn[] = [...history, { role: 'user', content: clean }];
      if (answer.content && answer.content.trim()) {
        turns.push({ role: 'assistant', content: answer.content });
      }
      const maxTurns = this.opts.maxTurns ?? DEFAULT_MAX_TURNS;
      const kept = turns.length > maxTurns ? turns.slice(turns.length - maxTurns) : turns;
      // P4 — persist with sidebar metadata: title = first user message.
      const firstUser = kept.find((t) => t.role === 'user')?.content ?? existing?.title ?? '';
      this.sessions.set(sessionId, {
        turns: kept,
        title: existing?.title || firstUser.slice(0, 80),
        createdAt: existing?.createdAt ?? now,
        updatedAt: Date.now(),
      });
      this.persist();
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
      // A cancel racing the engine's unwinding must not surface as an error
      // (the engine may throw AbortError before the loop returns cleanly).
      if (controller.signal.aborted) {
        return { ok: false, error: 'The turn was cancelled.', cancelled: true };
      }
      this.emit(sessionId, { kind: 'status', status: 'error' });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.busy.delete(sessionId);
      this.activeAborts.delete(sessionId);
    }
  }

  /**
   * P4 — cancel the in-flight turn for a session (the dashboard's Cancel
   * button; also fired when the client disconnects mid-turn). Returns false
   * when no turn is running. Busy is released IMMEDIATELY so a new message
   * can start while the old engine unwinds — the stale turn's events are
   * blocked by its controller guard and its result is discarded.
   */
  abort(sessionId: string): boolean {
    const controller = this.activeAborts.get(sessionId);
    if (!controller) return false;
    // Resolve any pending ask_user question as a skip so the engine unwinds
    // (the loop's next boundary check stops it on the cancelled signal).
    for (const [id, p] of this.pendingQuestions) {
      if (p.sessionId === sessionId) {
        this.pendingQuestions.delete(id);
        p.resolve({ answer: [], index: -1 });
      }
    }
    controller.abort();
    this.busy.delete(sessionId);
    return true;
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

  /** The session's plan store — created on first use, dropped on reset. */
  private planStoreFor(sessionId: string): PlanStore {
    let store = this.planStores.get(sessionId);
    if (!store) {
      store = new PlanStore();
      this.planStores.set(sessionId, store);
    }
    return store;
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
    this.planStores.delete(sessionId);
    this.persist();
  }
}

/** P4 — the last assistant text (truncated) for the sidebar preview. */
function lastAssistantText(turns: ChatTurn[]): string {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === 'assistant' && turns[i].content.trim()) {
      const text = turns[i].content.replace(/\s+/g, ' ').trim();
      return text.length > 90 ? `${text.slice(0, 87)}…` : text;
    }
  }
  return '';
}

/**
 * P0.6 — one-line args preview for the tool card, e.g. `{path: 'src/foo.ts'}`.
 * Compact (60 chars max); values are truncated, keys with empty/undefined
 * values are dropped so the card never reads `{path: undefined}`.
 */
function summarizeToolArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue;
    const shown = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
    const text = `${key}: ${shown}`;
    parts.push(text.length > 34 ? `${text.slice(0, 31)}…` : text);
  }
  if (parts.length === 0) return undefined;
  const joined = `{${parts.join(', ')}}`;
  return joined.length > 60 ? `${joined.slice(0, 57)}…` : joined;
}

/** A fresh session id for the client to hold (or the server may generate one). */
export function newChatSessionId(): string {
  return randomUUID();
}
