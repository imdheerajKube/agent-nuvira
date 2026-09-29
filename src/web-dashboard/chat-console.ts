/**
 * P3 — Dashboard chat console.
 *
 * In-process agent chat (GUI parity with `nuvira chat "<prompt>"`): each message
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
// LEAF import on purpose: the dashboard console must not pull the whole tool
// registry in just to clean up / recognise followups.
import { isSuggestedFollowup, normalizeFollowups, type FollowupSuggestion } from '../tools/followup-utils.js';
import {
  looksLikeReasoningLeakReply,
  stripLeadingReasoningTrace,
  stripToolCallArtifacts,
} from '../inference/tool-call-utils.js';
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
       * Session 3 — channel/format POLICY merged into the STABLE (system)
       * layer instead of being re-injected into every user turn. The gateway
       * passes its messaging-app rules here.
       */
      systemPolicy?: string;
      /**
       * P5 — the message is a picked FOLLOWUP (it matches the followups this
       * session was last offered): the engine marks it as a continuation of the
       * previous turn instead of a fresh independent request.
       */
      continuation?: boolean;
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
      /** P6a — a skill draft payload (rendered as the /learn preview card). */
      onSkillDraft?: (payload: import('../tools/skill-tool.js').SkillDraftPayload) => void;
      /** WS1 — a finding was recorded this turn, with the gate's verdict. */
      onFinding?: (finding: import('../findings/verdicts.js').WireFinding) => void;
      /**
       * WS2 — which surface this turn runs as, for the session debug log's
       * header. The console drives the SAME `answerOnce` the CLI and the
       * gateway do, so it must say who it is: a dashboard bug report must not
       * arrive labelled `cli-chat`.
       */
      debugSurface?: string;
      /**
       * WS2 — the conversation this turn belongs to. Recorded in the debug log's
       * header so the log is FINDABLE per chat: the server can serve the support
       * bundle for the conversation the user is looking at, and it can only do
       * that if the log names it.
       */
      debugSession?: string;
      /** PA4 — a skill loaded but needs env vars (non-blocking notification). */
      onSecretRequest?: (payload: { skillName: string; missing: string[]; persisted: Record<string, boolean> }) => void;
      /** P0.7 — the session's plan store (per-conversation, survives turns). */
      planStore?: PlanStoreLike;
      /** Live gateway for gateway_send (gateway-triggered chat answers reuse the connected bridge). */
      gateway?: {
        send(target: string, text: string): Promise<boolean>;
        /** Verified send to an explicit ref (failure reason via `lastSendError`). */
        sendToRef?(ref: { platform: string; channelId: string }, text: string, target?: string): Promise<boolean>;
        /** Why the most recent send to this target failed (undefined = none/ok). */
        lastSendError?(ref: { platform: string; channelId: string }): string | undefined;
        sendMedia?(target: string, media: { type: 'image' | 'video' | 'audio' | 'document'; data: Uint8Array; caption?: string; filename?: string }): Promise<boolean>;
        origin?: { platform: string; channelId: string };
        autoDeliverMedia?(media: { type: 'image' | 'video' | 'audio' | 'document'; data: Uint8Array; caption?: string; filename?: string }): Promise<boolean>;
        directory: { resolve(target: string): { platform: string; channelId: string } | null };
      };
    },
  ): Promise<{
    content: string;
    followups: FollowupSuggestion[];
    generationFailed?: boolean;
    /** Phase 4 — true when the loop hit its step bound (the DAG turn card shows ⛔ bounded). */
    bounded?: boolean;
    /** P4 — true when the turn was cancelled (the DAG turn card shows cancelled). */
    cancelled?: boolean;
    /** Names of the tools that actually executed (honest-action checks). */
    toolCalls?: string[];
    /** True when the answer claimed a delivery no delivery tool performed. */
    unverifiedActionClaim?: boolean;
    /** G13b — the request asked for an authored file and none was written. */
    undeliveredArtifact?: boolean;
    /** True when the answer closed on a promise the turn never carried out. */
    unfulfilledPromise?: boolean;
    provider?: string;
    model?: string;
    /**
     * R2 — the tool transport the engine reported for this turn (`native` /
     * `json` / `none`). Passed through so a caller of the console gets the same
     * attribution triple the CLI and the subagent child report.
     */
    transport?: 'native' | 'json' | 'none';
    /**
     * WS1 — every finding this turn recorded, in call order, already gated.
     * `[]` is a real answer ("this surface reports findings, and there were
     * none"), which is what lets the surfaces be compared honestly.
     */
    findings?: import('../findings/verdicts.js').WireFinding[];
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
  /**
   * R2 — the tool transport that served this turn, as the shared engine
   * reported it (`native` / `json` / `none`), or null when no transport was
   * reported at all. Null here means "not said" — deliberately different from
   * the `none` the engine returns for a turn that carried no tool call.
   */
  transport?: 'native' | 'json' | 'none' | null;
  /**
   * WS1 — every finding this turn recorded, in call order, already gated.
   * `[]` is a real answer ("this surface reports findings, and there were
   * none"), which is what lets the surfaces be compared honestly.
   */
  findings?: import('../findings/verdicts.js').WireFinding[];
  generationFailed?: boolean;
  /** Phase 4 — true when the loop hit its step bound before an end turn. */
  bounded?: boolean;
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
  /** P4b — the attached project dir at the time of the conversation (used to restore on resume). */
  projectPath?: string;
  /**
   * P5 — the followups the last answer offered. A message that MATCHES one of
   * these (a clicked chip) is recognised as a continuation of the previous
   * execution and carries the continuation marker into the model thread.
   */
  followups?: FollowupSuggestion[];
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
  /** The FIRST user message (truncated) — powers search + the preview line. */
  firstUser: string;
  /** P4b — the attached project dir (so the sidebar can show which project each conversation belongs to). */
  projectPath?: string;
}

/**
 * An attachment that rides into a turn as `[Attachment: <name>]` context — a
 * file picked in the composer or a large pasted text block (the dashboard
 * twin of `nuvira chat -f <file>`). Content travels inline (client reads the
 * file, server injects it into the same answerOnce context).
 */
export interface ChatAttachment {
  /** Display name, e.g. `requirements.md` or `pasted-text.txt`. */
  name: string;
  /**
   * The content the model sees.
   *
   * Inline TEXT for what the composer could decode, or — for binary documents — the
   * result of server-side extraction through `read_extract`, which is either the
   * extracted text or an explicit `[could NOT be read]` block. It is never the file's
   * raw bytes: `/api/chat` hydrates binary attachments before calling this method
   * (`attachment-extract.ts`), so a PDF cannot arrive here as mojibake.
   */
  content: string;
  /** Source for the chip: 'file' | 'paste' | 'drop'. */
  kind?: 'file' | 'paste' | 'drop';
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
  | {
      /** P6a — a skill draft (rendered as the /learn preview card: accept/edit/reject). */
      kind: 'skill_draft';
      name: string;
      description: string;
      markdown: string;
      updatedAt: number;
    }
  | {
      /** PA4 — a skill loaded but needs env vars (non-blocking notification card). */
      kind: 'secret_request';
      skillName: string;
      missing: string[];
      persisted: Record<string, boolean>;
    }
  | {
      /** Execution result from skill execution engine. */
      kind: 'execution_result';
      skillName: string;
      runtime: string;
      success: boolean;
      durationMs: number;
      exitCode: number;
      stdout: string;
      stderr: string;
      timestamp: number;
    }
  | {
      /**
       * WS1 — a finding was recorded this turn, carrying the verdict the GATE
       * computed and the evidence behind it.
       *
       * Forwarded live for the same reason `plan`/`diff` are: the verdict is the
       * thing the reader needs to see WHILE the turn runs — a CONFIRMED claim and
       * a PLAUSIBLE guess must not arrive as interchangeable prose. Unlike those
       * two, the console does NOT collect these for the result — the caller
       * already owns the collection (`onFinding`/`findings`), and a second copy
       * here would be the drift this workstream exists to refuse.
       */
      kind: 'finding';
      finding: import('../findings/verdicts.js').WireFinding;
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
  /**
   * Phase 4 (AGENTIC_CAPABILITY_ASSESSMENT Addendum v4) — the turn-completion
   * hook the SERVER fulfills (the DAG store records the turn's outcome into
   * the engine-badge + per-turn tool telemetry). Assign, never inject:
   * chat-console must not import the server module (circular). All calls are
   * guarded try/catch at the call site — a throwing hook must never break the
   * chat path.
   */
  onTurnCompleted?: (turn: {
    sessionId: string;
    ok: boolean;
    error?: string;
    cancelled?: boolean;
    generationFailed?: boolean;
    /** Phase 4 — true when the loop hit its step bound before an end turn. */
    bounded?: boolean;
    provider?: string | null;
    model?: string | null;
  }) => void;

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
          this.sessions.set(id, { turns: rec.turns, title: String(rec.title ?? ''), createdAt: Number(rec.createdAt) || 0, updatedAt: Number(rec.updatedAt) || 0, ...(typeof rec.projectPath === 'string' && rec.projectPath ? { projectPath: rec.projectPath } : {}), ...(Array.isArray(rec.followups) && rec.followups.length > 0 ? { followups: normalizeFollowups(rec.followups) } : {}) });
        }
      } catch {
        /* unreadable store — start empty rather than crash the dashboard */
      }
    }
    // Phase 4 — the console reports every REAL turn's start + tool calls into
    // the injectable telemetry sink (server.ts fulfills it with the DAG
    // store; unit tests can capture the same calls). Cheap: two exported
    // function calls, guarded internally, no I/O on this side.
    void import('./loop-turn-telemetry.js').then((m) => {
      this.turnTelemetry = m;
    }).catch(() => {
      /* telemetry is optional — the console works without it */
    });
  }

  /** Phase 4 — lazy handle on the telemetry sink (undefined until loaded). */
  private turnTelemetry?: typeof import('./loop-turn-telemetry.js');

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
    return sanitizeStoredTurns(this.sessions.get(sessionId)?.turns ?? []);
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
        firstUser: firstUserText(rec.turns),
        ...(rec.projectPath ? { projectPath: rec.projectPath } : {}),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Delete a session (sidebar ✕). Busy sessions refuse (an in-flight turn
   * owns the record); otherwise the store + disk are updated.
   */
  remove(sessionId: string): { ok: boolean; error?: string } {
    if (this.busy.has(sessionId)) {
      return { ok: false, error: 'A message is being answered in this session — wait for it to finish.' };
    }
    const existed = this.sessions.delete(sessionId);
    this.activeAborts.delete(sessionId);
    this.pendingQuestions.delete(sessionId);
    this.persist();
    return { ok: existed };
  }

  /** Rename a session (sidebar ✏️). Empty titles reset to the first message. */
  rename(sessionId: string, title: string): { ok: boolean; error?: string } {
    const rec = this.sessions.get(sessionId);
    if (!rec) return { ok: false, error: 'No such session.' };
    const clean = title.trim();
    rec.title = clean.length > 0 ? clean.slice(0, 120) : '';
    rec.updatedAt = Date.now();
    this.persist();
    return { ok: true };
  }

  /**
   * P4 — the full persisted record for one session (transcript for resume).
   * Returns null when unknown.
   *
   * Sanitized on read like `history()`: this is what `GET /api/sessions/:id`
   * serves, so it is the path that re-rendered an OLD turn's raw tool JSON when
   * the reader reopened the conversation. Sanitizing only the live turn would
   * leave every existing session permanently unreadable.
   */
  get(sessionId: string): ChatSessionRecord | null {
    const rec = this.sessions.get(sessionId);
    return rec ? { ...rec, turns: sanitizeStoredTurns(rec.turns) } : null;
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
   * Append one exchange to a session WITHOUT running a turn.
   *
   * The deferred retry loop needs this: an ask can be re-run minutes or hours
   * later, and both the result and the user's "yes" must land in the SAME
   * thread they belong to — otherwise a reload shows a conversation that is
   * missing an answer the agent promised.
   *
   * `user` is null when the ask is already in the history (a retry re-runs a
   * message that was recorded the first time, and duplicating it would show the
   * same request twice in the thread).
   */
  appendTurns(sessionId: string, user: string | null, assistant: string): void {
    try {
      const existing = this.sessions.get(sessionId);
      const now = Date.now();
      const turns: ChatTurn[] = [...(existing?.turns ?? [])];
      if (user && user.trim()) turns.push({ role: 'user', content: user });
      if (assistant && assistant.trim()) turns.push({ role: 'assistant', content: assistant });
      const maxTurns = this.opts.maxTurns ?? DEFAULT_MAX_TURNS;
      const kept = turns.length > maxTurns ? turns.slice(turns.length - maxTurns) : turns;
      const firstUser = kept.find((t) => t.role === 'user')?.content ?? existing?.title ?? '';
      this.sessions.set(sessionId, {
        turns: kept,
        title: existing?.title || firstUser.slice(0, 80),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(existing?.projectPath ? { projectPath: existing.projectPath } : {}),
        ...(existing?.followups && existing.followups.length > 0 ? { followups: existing.followups } : {}),
      });
      this.persist();
    } catch {
      /* best-effort — history is a convenience, never a blocker */
    }
  }

  /**
   * Rewrite the session's last assistant turn, or append one when the turn
   * stored none.
   *
   * WHY: a failed turn's bubble is composed by the ROUTE (it appends the model
   * breadth report and the "reply *yes*" offer to whatever the engine returned),
   * so the text the reader sees is not the text the console stored. Without
   * this, a reload showed a failure with no explanation — or no bubble at all —
   * for a retry that IS queued and running. The gateway does the same thing with
   * its `record()`; this is the dashboard's half.
   */
  amendLastAssistantTurn(sessionId: string, content: string): void {
    try {
      const existing = this.sessions.get(sessionId);
      if (!existing) return;
      const turns: ChatTurn[] = [...existing.turns];
      const last = turns[turns.length - 1];
      if (last && last.role === 'assistant') turns[turns.length - 1] = { role: 'assistant', content };
      else if (content.trim()) turns.push({ role: 'assistant', content });
      this.sessions.set(sessionId, { ...existing, turns, updatedAt: Date.now() });
      this.persist();
    } catch {
      /* best-effort — history is a convenience, never a blocker */
    }
  }

  /**
   * Run one turn for a session. Threads the stored history as context; the
   * reply (and followup chips) come back as data. One in-flight turn per
   * session; the ask_user tool is declined (returns no selection) so the turn
   * never blocks on a TTY prompt inside the server.
   *
   * `recordTurn: false` runs the turn WITHOUT writing the session (see the
   * deferred-retry broker) — the caller owns the thread in that case.
   */
  async answer(
    sessionId: string,
    message: string,
    opts: {
      provider?: string;
      model?: string;
      projectContext?: string;
      projectPath?: string;
      attachments?: ChatAttachment[];
      recordTurn?: boolean;
      /** WS1 — a finding was recorded this turn, with the gate's verdict. */
      onFinding?: (finding: import('../findings/verdicts.js').WireFinding) => void;
    } = {},
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
    // A DEFERRED RETRY runs with history writing off (`recordTurn: false`): the
    // ask was already recorded by the attempt that failed, and the retry broker
    // writes the outcome itself (with the header that explains the unprompted
    // bubble). Writing here too would duplicate the ask or the answer.
    const recordTurn = opts.recordTurn !== false;
    // P5 — does this message match a followup the session was last offered?
    // (Chips send the raw prompt, so the server is the only place that can
    // know a message is a followup rather than a fresh request.)
    const continuation = isSuggestedFollowup(clean, existing?.followups);
    const now = Date.now();
    if (recordTurn) {
      this.sessions.set(sessionId, {
        turns: history,
        title: existing?.title ?? '',
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing?.updatedAt ?? now,
        ...(opts.projectPath ? { projectPath: opts.projectPath } : (existing?.projectPath ? { projectPath: existing.projectPath } : {})),
        ...(existing?.followups && existing.followups.length > 0 ? { followups: existing.followups } : {}),
      });
    }
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
    // Phase 4 — begin the DAG turn telemetry window (engine badge 'loop',
    // per-tool telemetry accumulates below).
    try {
      this.turnTelemetry?.beginLoopTurn(
        `${sessionId}-${now}`,
        clean,
        opts.provider,
        opts.model,
      );
    } catch {
      /* telemetry must never break the turn */
    }
    try {
      const engine = await this.ensureEngine();
      // WS1 — the findings this turn records, collected from the engine's
      // `onFinding` seam (the same event the CLI and the gateway hear).
      const findings: import('../findings/verdicts.js').WireFinding[] = [];
      const answer = await engine.answerOnce(clean, {
        // P4 — the cancel signal rides into the turn.
        signal: controller.signal,
        // WS1 — a recorded finding, forwarded live and kept for the result.
        onFinding: (finding) => {
          findings.push(finding);
          // Live card: the GUI subscribes to the console's event stream, so the
          // verdict appears as the turn records it (the POST response remains
          // authoritative for the transcript snapshot).
          emitTurn({ kind: 'finding', finding });
          opts.onFinding?.(finding);
        },
        // WS2 (#24) — this turn is the DASHBOARD's, and the session debug log's
        // header must say so (the engine is shared with the CLI and gateway).
        debugSurface: 'dashboard-chat',
        // ...and which CONVERSATION it belongs to, so the log it writes can be
        // found again from the chat rather than only from a filesystem listing.
        debugSession: sessionId,
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        // P5 — a followup chip continues the previous execution.
        ...(continuation ? { continuation: true } : {}),
        // P3 — project context rides into the turn (the engine injects it as
        // a `[Project context]` message in the thread). Attachments join the
        // same context block (the dashboard twin of `nuvira chat -f <file>`).
        ...(opts.projectContext || (opts.attachments && opts.attachments.length > 0)
          ? { projectContext: formatTurnContext(opts.projectContext, opts.attachments) }
          : {}),
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
          // Phase 4 — one record per COMPLETED call into the DAG store.
          if (phase === 'called') {
            try {
              this.turnTelemetry?.recordLoopToolCall({
                tool: info.tool,
                ...(info.ok !== undefined ? { ok: info.ok } : {}),
                ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}),
                ...(info.error !== undefined ? { error: info.error } : {}),
              });
            } catch {
              /* telemetry must never break the turn */
            }
          }
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
        // P6a — forward skill draft payloads as a dedicated preview-card
        // event (accept / edit / reject live in the GUI, not the thread).
        onSkillDraft: (payload) => {
          emitTurn({
            kind: 'skill_draft',
            name: payload.name,
            description: payload.description,
            markdown: payload.markdown,
            updatedAt: payload.updatedAt,
          });
        },
        // PA4 — forward skill secret-request events as a notification card.
        onSecretRequest: (payload) => {
          emitTurn({
            kind: 'secret_request',
            skillName: payload.skillName,
            missing: payload.missing,
            persisted: payload.persisted,
          });
        },
        planStore: this.planStoreFor(sessionId),
      });
      // P4 — a cancelled turn is DISCARDED entirely: no session write, no
      // persist, no status:done, no events (the client already walked away
      // and may have started a new turn). abort() released busy immediately.
      if (controller.signal.aborted) {
        this.notifyTurnCompleted({
          sessionId,
          ok: false,
          cancelled: true,
          provider: answer.provider ?? null,
          model: answer.model ?? null,
        });
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
      // P5 — remember the followups this answer offered so the NEXT message can
      // be recognised as a continuation (and so the chips survive a reload).
      const nextFollowups = normalizeFollowups(answer.followups);
      if (recordTurn) {
        this.sessions.set(sessionId, {
          turns: kept,
          title: existing?.title || firstUser.slice(0, 80),
          createdAt: existing?.createdAt ?? now,
          updatedAt: Date.now(),
          // P4b — persist the project path so it can be restored on resume.
          ...(opts.projectPath ? { projectPath: opts.projectPath } : (existing?.projectPath ? { projectPath: existing.projectPath } : {})),
          ...(nextFollowups.length > 0 ? { followups: nextFollowups } : {}),
        });
        this.persist();
      }
      this.emit(sessionId, { kind: 'status', status: 'done' });
      this.notifyTurnCompleted({
        sessionId,
        ok: true,
        generationFailed: answer.generationFailed === true,
        bounded: answer.bounded === true,
        provider: answer.provider ?? null,
        model: answer.model ?? null,
      });
      // E3b: strip raw suggest_followups artifacts — the ONE shared helper (the
      // gateway and CLI use it too), so a new artifact shape is fixed once.
      let cleanContent = stripToolCallArtifacts(answer.content || '');
      // ANSWER-QUALITY guard, mirroring the gateway's: the loop now REJECTS a
      // reply that is the model's own reasoning (see `looksLikeReasoningLeakReply`
      // in cli/chat.ts's confuseCheck), so a bubble here normally means every
      // candidate narrated. Recover the deliverable if one sat behind the trace
      // (two of the three real incidents did) instead of showing the reader
      // "The user said \"Hi\" … According to the instructions: …".
      if (looksLikeReasoningLeakReply(cleanContent)) {
        const salvaged = stripLeadingReasoningTrace(cleanContent);
        if (salvaged.trim() && !looksLikeReasoningLeakReply(salvaged)) {
          cleanContent = salvaged;
        } else {
          cleanContent =
            '🤖 Sorry — I could not produce a usable answer just now. Please try again in a moment, or rephrase the request.';
        }
      }
      // HONESTY GUARDS — the same corrections the gateway appends, so a
      // dashboard reader is never shown "I have sent it" as done, or
      // "I will now …" as pending, when nothing actually happened. The trace
      // panel records the flag too; this makes the CHAT BUBBLE honest.
      let honestContent = cleanContent;
      if (answer.unverifiedActionClaim) {
        honestContent +=
          '\n\n⚠️ Heads-up: I could not confirm that message was actually sent — the send action did not complete. ' +
          'Please ask me to try again, or send it yourself.';
      }
      if (answer.unfulfilledPromise) {
        honestContent +=
          '\n\n⚠️ Note: I described what I was about to do, but I did not actually carry it out yet. ' +
          'Say "go ahead" and I will do it now.';
      }
      // G13b — the deliverable case, which reads MOST like success: a complete
      // story in the bubble and no file anywhere. The correction is appended to
      // the bubble (the trace records the flag) so the reader is not left to
      // discover the missing artifact by opening a path that was never created.
      if (answer.undeliveredArtifact) {
        honestContent +=
          '\n\n⚠️ Note: this request asked for a written deliverable, but no file was written — ' +
          'the text above is the answer, not the artifact. Say "save it to a file" and I will write it now.';
      }
      return {
        ok: true,
        content: honestContent,
        followups: nextFollowups,
        provider: answer.provider ?? null,
        model: answer.model ?? null,
        // A wire value, not a guess: the engine reports `native`/`json`/`none`,
        // and only a surface that never said gets null.
        transport: answer.transport ?? null,
        generationFailed: answer.generationFailed === true,
        bounded: answer.bounded === true,
        // WS1 — the findings the turn recorded (empty when it recorded none).
        findings,
      };
    } catch (err) {
      // A cancel racing the engine's unwinding must not surface as an error
      // (the engine may throw AbortError before the loop returns cleanly).
      if (controller.signal.aborted) {
        this.notifyTurnCompleted({ sessionId, ok: false, cancelled: true });
        return { ok: false, error: 'The turn was cancelled.', cancelled: true };
      }
      this.emit(sessionId, { kind: 'status', status: 'error' });
      this.notifyTurnCompleted({ sessionId, ok: false, error: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.busy.delete(sessionId);
      this.activeAborts.delete(sessionId);
    }
  }

  /**
   * Phase 4 — invoke the turn-completion hook (the DAG store's endLoopTurn
   * lives server-side). Guarded: a throwing/broken hook never breaks the chat
   * path, and an unset hook is a clean no-op (unit tests).
   */
  private notifyTurnCompleted(turn: {
    sessionId: string;
    ok: boolean;
    error?: string;
    cancelled?: boolean;
    generationFailed?: boolean;
    bounded?: boolean;
    provider?: string | null;
    model?: string | null;
  }): void {
    try {
      this.onTurnCompleted?.(turn);
    } catch {
      /* the hook must never break the console */
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
/**
 * Sanitize stored turns ON READ — never on write.
 *
 * A stored transcript is the USER'S record and is not ours to rewrite. But the
 * content in it is whatever the engine returned at the time, so a turn stored
 * BEFORE a strip was fixed keeps its raw artifact forever: reopening an old
 * conversation (or the 15-second refresh) re-rendered the model's
 * `{"suggest_followups":[…]}` block as the answer. These turns are the real
 * evidence of that — one calculator session had 13 of them — and a fix that
 * only covers new turns leaves every existing session permanently unreadable.
 *
 * The same sanitized view is what seeds the NEXT turn's context, which is the
 * other half of why read-side is the right place: the model should not be fed
 * its own tool JSON back as conversation history.
 */
function sanitizeStoredTurns(turns: ChatTurn[]): ChatTurn[] {
  return turns.map((t) => {
    if (t.role !== 'assistant' || !t.content) return t;
    const clean = stripToolCallArtifacts(t.content);
    return clean === t.content ? t : { ...t, content: clean };
  });
}

function lastAssistantText(turns: ChatTurn[]): string {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === 'assistant' && turns[i].content.trim()) {
      const text = stripToolCallArtifacts(turns[i].content).replace(/\s+/g, ' ').trim();
      return text.length > 90 ? `${text.slice(0, 87)}…` : text;
    }
  }
  return '';
}

/**
 * P8 — combine the project snapshot and turn attachments into the single
 * context block the engine injects before the message. Project context stays
 * first; each attachment is a `[Attachment: <name>]` section with the raw
 * content, so "read this file" works exactly like `nuvira chat -f`.
 */
function formatTurnContext(projectContext: string | undefined, attachments: ChatAttachment[] | undefined): string {
  const parts: string[] = [];
  if (projectContext) parts.push(projectContext);
  for (const a of attachments ?? []) {
    parts.push(`[Attachment: ${a.name}]\n${a.content}`);
  }
  return parts.join('\n\n');
}

/** P4 — the FIRST user text (truncated) for the sidebar search + preview. */
function firstUserText(turns: ChatTurn[]): string {
  for (const t of turns) {
    if (t.role === 'user' && t.content.trim()) {
      const text = t.content.replace(/\s+/g, ' ').trim();
      return text.length > 120 ? `${text.slice(0, 117)}…` : text;
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
