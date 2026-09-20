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
import { type FollowupSuggestion } from '../tools/followup-utils.js';
import { type PlanSnapshot, type PlanStoreLike } from '../tools/plan-store.js';
/** One stored turn in a chat session. */
export interface ChatTurn {
    role: 'user' | 'assistant';
    content: string;
}
/** The slice of ChatCommand the console drives (answerOnce satisfies it). */
export interface ChatEngine {
    answerOnce(message: string, opts?: {
        provider?: string;
        model?: string;
        dev?: boolean;
        history?: Array<{
            role: string;
            content: string;
        }>;
        askUser?: (question: string, choices: unknown[], multiSelect: boolean) => Promise<{
            answer: unknown;
            index: number | number[];
            custom?: string;
        }>;
        /** P3 — live working steps (tool calls / reasoning markers). */
        onProgress?: (line: string) => void;
        /** P3 — bounded project snapshot injected as a `[Project context]` message. */
        projectContext?: string;
        /** P4 — attached project dir; the engine recalls its sessions + facts. */
        projectPath?: string;
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
        onToolCall?: (phase: 'started' | 'called', info: {
            id?: string;
            tool: string;
            args?: Record<string, unknown>;
            ok?: boolean;
            result?: string;
            error?: string;
            durationMs?: number;
        }) => void;
        /** P0.7 — a plan mutation (structured checklist for the GUI card). */
        onPlanChange?: (snapshot: PlanSnapshot) => void;
        /** P3b — a git diff payload (rendered as a diff card in the GUI). */
        onGitDiff?: (payload: import('../tools/git-tool.js').GitDiffPayload) => void;
        /** P6a — a skill draft payload (rendered as the /learn preview card). */
        onSkillDraft?: (payload: import('../tools/skill-tool.js').SkillDraftPayload) => void;
        /** PA4 — a skill loaded but needs env vars (non-blocking notification). */
        onSecretRequest?: (payload: {
            skillName: string;
            missing: string[];
            persisted: Record<string, boolean>;
        }) => void;
        /** P0.7 — the session's plan store (per-conversation, survives turns). */
        planStore?: PlanStoreLike;
        /** Live gateway for gateway_send (gateway-triggered chat answers reuse the connected bridge). */
        gateway?: {
            send(target: string, text: string): Promise<boolean>;
            sendMedia?(target: string, media: {
                type: 'image' | 'video' | 'audio' | 'document';
                data: Uint8Array;
                caption?: string;
                filename?: string;
            }): Promise<boolean>;
            origin?: {
                platform: string;
                channelId: string;
            };
            autoDeliverMedia?(media: {
                type: 'image' | 'video' | 'audio' | 'document';
                data: Uint8Array;
                caption?: string;
                filename?: string;
            }): Promise<boolean>;
            directory: {
                resolve(target: string): {
                    platform: string;
                    channelId: string;
                } | null;
            };
        };
    }): Promise<{
        content: string;
        followups: FollowupSuggestion[];
        generationFailed?: boolean;
        /** Phase 4 — true when the loop hit its step bound (the DAG turn card shows ⛔ bounded). */
        bounded?: boolean;
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
export interface ChatAnswerResult {
    ok: boolean;
    content?: string;
    followups?: FollowupSuggestion[];
    provider?: string | null;
    model?: string | null;
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
    /** The raw content (text only — binary files are rejected client-side). */
    content: string;
    /** Source for the chip: 'file' | 'paste' | 'drop'. */
    kind?: 'file' | 'paste' | 'drop';
}
/** A live event for one session (P3 progress streaming). */
export type ChatConsoleEvent = {
    kind: 'progress';
    line: string;
} | {
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
} | {
    /** P0.7 — a plan mutation (rendered as a live checklist card in the GUI). */
    kind: 'plan';
    goal: string;
    steps: Array<{
        id: string;
        description: string;
        status: 'pending' | 'running' | 'done' | 'blocked';
    }>;
    revision: number;
} | {
    /** P3b — a git diff payload (rendered as a 🔧 diff card with +/− sections). */
    kind: 'diff';
    files: Array<{
        path: string;
        body: string;
    }>;
    summary: string;
} | {
    /** P6a — a skill draft (rendered as the /learn preview card: accept/edit/reject). */
    kind: 'skill_draft';
    name: string;
    description: string;
    markdown: string;
    updatedAt: number;
} | {
    /** PA4 — a skill loaded but needs env vars (non-blocking notification card). */
    kind: 'secret_request';
    skillName: string;
    missing: string[];
    persisted: Record<string, boolean>;
} | {
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
} | {
    kind: 'status';
    status: 'working' | 'done' | 'error';
} | {
    /**
     * P4 — one content token of the answer as it streams (the typewriter).
     * The POST response remains authoritative: the GUI renders the stream
     * live and REPLACES it with the final content when the turn resolves
     * (the engine's S1 longest-substantive logic may select an earlier,
     * longer answer than the last chunk).
     */
    kind: 'token';
    text: string;
} | {
    kind: 'question';
    /** Unique id the client echoes back in the respond call. */
    questionId: string;
    question: string;
    /** Choice options (label + optional description) — serializable for the GUI. */
    choices: Array<{
        label: string;
        description?: string;
    }>;
    multiSelect: boolean;
};
/** The selection shape the GUI sends back to answer a pending question. */
export interface QuestionAnswer {
    /** Selected option index (or indices for multiSelect). -1 / [] = skip (decline). */
    index?: number | number[];
    /** Free-text answer (the GUI's "Other" field). */
    custom?: string;
}
export declare class ChatConsole {
    private readonly opts;
    private sessions;
    private busy;
    private engine;
    private listeners;
    /** Pending ask_user questions per session — resolved by the GUI's respond(). */
    private pendingQuestions;
    /** P0.7 — per-session plan stores (plans never leak across conversations). */
    private planStores;
    /**
     * P4 — the in-flight turn's AbortController per session (set while a turn
     * runs, deleted in finally). abort(sessionId) fires it: the engine stops at
     * the next loop boundary + aborts the in-flight provider request.
     */
    private activeAborts;
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
    constructor(opts?: ChatConsoleOptions);
    /** Phase 4 — lazy handle on the telemetry sink (undefined until loaded). */
    private turnTelemetry?;
    /** Subscribe to a session's live events (progress lines / status). Returns an unsubscribe fn. */
    onEvent(cb: (sessionId: string, event: ChatConsoleEvent) => void): () => void;
    private emit;
    /** Lazily load the real agent engine (ChatCommand) on first use. */
    private ensureEngine;
    /** The stored turns for a session (empty when unknown). */
    history(sessionId: string): ChatTurn[];
    /**
     * P4 — sidebar summaries, most recently updated first. The server exposes
     * these via `GET /api/sessions`.
     */
    list(): ChatSessionSummary[];
    /**
     * Delete a session (sidebar ✕). Busy sessions refuse (an in-flight turn
     * owns the record); otherwise the store + disk are updated.
     */
    remove(sessionId: string): {
        ok: boolean;
        error?: string;
    };
    /** Rename a session (sidebar ✏️). Empty titles reset to the first message. */
    rename(sessionId: string, title: string): {
        ok: boolean;
        error?: string;
    };
    /**
     * P4 — the full persisted record for one session (transcript for resume).
     * Returns null when unknown.
     */
    get(sessionId: string): ChatSessionRecord | null;
    /** P4 — write the session store through to disk (atomic-ish: temp + rename). */
    private persist;
    /** True while a message is being answered in this session. */
    isBusy(sessionId: string): boolean;
    /**
     * Run one turn for a session. Threads the stored history as context; the
     * reply (and followup chips) come back as data. One in-flight turn per
     * session; the ask_user tool is declined (returns no selection) so the turn
     * never blocks on a TTY prompt inside the server.
     */
    answer(sessionId: string, message: string, opts?: {
        provider?: string;
        model?: string;
        projectContext?: string;
        projectPath?: string;
        attachments?: ChatAttachment[];
    }): Promise<ChatAnswerResult>;
    /**
     * Phase 4 — invoke the turn-completion hook (the DAG store's endLoopTurn
     * lives server-side). Guarded: a throwing/broken hook never breaks the chat
     * path, and an unset hook is a clean no-op (unit tests).
     */
    private notifyTurnCompleted;
    /**
     * P4 — cancel the in-flight turn for a session (the dashboard's Cancel
     * button; also fired when the client disconnects mid-turn). Returns false
     * when no turn is running. Busy is released IMMEDIATELY so a new message
     * can start while the old engine unwinds — the stale turn's events are
     * blocked by its controller guard and its result is discarded.
     */
    abort(sessionId: string): boolean;
    /**
     * Emit a question event and wait for the GUI's respond() (or skip).
     * Returns the ask_user result the engine expects; `index: -1` means the
     * user skipped, which preserves the pre-P0.1 "proceed on best judgment"
     * behavior.
     */
    private askQuestion;
    /**
     * Answer a pending question (from the GUI). Returns false when the
     * questionId is unknown or belongs to another session.
     */
    respond(sessionId: string, questionId: string, answer?: QuestionAnswer): boolean;
    /** The session's plan store — created on first use, dropped on reset. */
    private planStoreFor;
    /** Forget a session's history (new conversation) + drop its pending questions. */
    reset(sessionId: string): void;
}
/** A fresh session id for the client to hold (or the server may generate one). */
export declare function newChatSessionId(): string;
//# sourceMappingURL=chat-console.d.ts.map