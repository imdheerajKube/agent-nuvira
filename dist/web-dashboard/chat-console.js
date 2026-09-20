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
import { dirname } from 'node:path';
// LEAF import on purpose: the dashboard console must not pull the whole tool
// registry in just to clean up / recognise followups.
import { isSuggestedFollowup, normalizeFollowups } from '../tools/followup-utils.js';
import { PlanStore } from '../tools/plan-store.js';
/** Per-session per-message limits (the CLI has no hard cap; bound the server). */
const MAX_MESSAGE_LENGTH = 8000;
const DEFAULT_MAX_TURNS = 40;
const DEFAULT_MAX_SESSIONS = 50;
export class ChatConsole {
    opts;
    sessions = new Map();
    busy = new Set();
    engine;
    listeners = new Set();
    /** Pending ask_user questions per session — resolved by the GUI's respond(). */
    pendingQuestions = new Map();
    /** P0.7 — per-session plan stores (plans never leak across conversations). */
    planStores = new Map();
    /**
     * P4 — the in-flight turn's AbortController per session (set while a turn
     * runs, deleted in finally). abort(sessionId) fires it: the engine stops at
     * the next loop boundary + aborts the in-flight provider request.
     */
    activeAborts = new Map();
    /**
     * Phase 4 (AGENTIC_CAPABILITY_ASSESSMENT Addendum v4) — the turn-completion
     * hook the SERVER fulfills (the DAG store records the turn's outcome into
     * the engine-badge + per-turn tool telemetry). Assign, never inject:
     * chat-console must not import the server module (circular). All calls are
     * guarded try/catch at the call site — a throwing hook must never break the
     * chat path.
     */
    onTurnCompleted;
    constructor(opts = {}) {
        this.opts = opts;
        this.engine = opts.engine ?? null;
        // P4 — reload persisted sessions so the sidebar resumes past conversations
        // after a server restart. Corrupt/unreadable stores degrade to empty.
        if (opts.persistPath && existsSync(opts.persistPath)) {
            try {
                const raw = readFileSync(opts.persistPath, 'utf8');
                const data = JSON.parse(raw);
                for (const [id, rec] of Object.entries(data?.sessions ?? {})) {
                    if (typeof id !== 'string' || !id || !rec || !Array.isArray(rec.turns))
                        continue;
                    this.sessions.set(id, { turns: rec.turns, title: String(rec.title ?? ''), createdAt: Number(rec.createdAt) || 0, updatedAt: Number(rec.updatedAt) || 0, ...(typeof rec.projectPath === 'string' && rec.projectPath ? { projectPath: rec.projectPath } : {}), ...(Array.isArray(rec.followups) && rec.followups.length > 0 ? { followups: normalizeFollowups(rec.followups) } : {}) });
                }
            }
            catch {
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
    turnTelemetry;
    /** Subscribe to a session's live events (progress lines / status). Returns an unsubscribe fn. */
    onEvent(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
    emit(sessionId, event) {
        for (const cb of this.listeners) {
            try {
                cb(sessionId, event);
            }
            catch {
                /* a listener must never break the console */
            }
        }
    }
    /** Lazily load the real agent engine (ChatCommand) on first use. */
    async ensureEngine() {
        if (this.engine)
            return this.engine;
        const { ChatCommand } = await import('../cli/chat.js');
        this.engine = new ChatCommand();
        return this.engine;
    }
    /** The stored turns for a session (empty when unknown). */
    history(sessionId) {
        return this.sessions.get(sessionId)?.turns ?? [];
    }
    /**
     * P4 — sidebar summaries, most recently updated first. The server exposes
     * these via `GET /api/sessions`.
     */
    list() {
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
    remove(sessionId) {
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
    rename(sessionId, title) {
        const rec = this.sessions.get(sessionId);
        if (!rec)
            return { ok: false, error: 'No such session.' };
        const clean = title.trim();
        rec.title = clean.length > 0 ? clean.slice(0, 120) : '';
        rec.updatedAt = Date.now();
        this.persist();
        return { ok: true };
    }
    /**
     * P4 — the full persisted record for one session (transcript for resume).
     * Returns null when unknown.
     */
    get(sessionId) {
        return this.sessions.get(sessionId) ?? null;
    }
    /** P4 — write the session store through to disk (atomic-ish: temp + rename). */
    persist() {
        const path = this.opts.persistPath;
        if (!path)
            return;
        try {
            mkdirSync(dirname(path), { recursive: true });
            const payload = JSON.stringify({ sessions: Object.fromEntries(this.sessions) });
            const tmp = `${path}.tmp`;
            writeFileSync(tmp, payload, 'utf8');
            renameSync(tmp, path);
        }
        catch {
            /* persistence is best-effort — a failed write must never break chat */
        }
    }
    /** True while a message is being answered in this session. */
    isBusy(sessionId) {
        return this.busy.has(sessionId);
    }
    /**
     * Run one turn for a session. Threads the stored history as context; the
     * reply (and followup chips) come back as data. One in-flight turn per
     * session; the ask_user tool is declined (returns no selection) so the turn
     * never blocks on a TTY prompt inside the server.
     */
    async answer(sessionId, message, opts = {}) {
        const clean = (message || '').trim();
        if (!clean)
            return { ok: false, error: 'Empty message.' };
        if (clean.length > MAX_MESSAGE_LENGTH) {
            return { ok: false, error: `Message exceeds ${MAX_MESSAGE_LENGTH} characters.` };
        }
        if (this.busy.has(sessionId)) {
            return { ok: false, error: 'A message is already being answered in this session — wait for it to finish.' };
        }
        // Enforce the session cap (drop oldest sessions).
        if (!this.sessions.has(sessionId) && this.sessions.size >= (this.opts.maxSessions ?? DEFAULT_MAX_SESSIONS)) {
            const oldest = this.sessions.keys().next().value;
            if (oldest)
                this.sessions.delete(oldest);
        }
        const existing = this.sessions.get(sessionId);
        const history = existing?.turns ?? [];
        // P5 — does this message match a followup the session was last offered?
        // (Chips send the raw prompt, so the server is the only place that can
        // know a message is a followup rather than a fresh request.)
        const continuation = isSuggestedFollowup(clean, existing?.followups);
        const now = Date.now();
        this.sessions.set(sessionId, {
            turns: history,
            title: existing?.title ?? '',
            createdAt: existing?.createdAt ?? now,
            updatedAt: existing?.updatedAt ?? now,
            ...(opts.projectPath ? { projectPath: opts.projectPath } : (existing?.projectPath ? { projectPath: existing.projectPath } : {})),
            ...(existing?.followups && existing.followups.length > 0 ? { followups: existing.followups } : {}),
        });
        this.busy.add(sessionId);
        // P4 — one AbortController per turn: abort(sessionId) fires it, the
        // engine stops at the next loop boundary (and aborts the in-flight
        // provider request), and the turn is DISCARDED (no persist, no events).
        const controller = new AbortController();
        this.activeAborts.set(sessionId, controller);
        // Stale-turn guard: after a cancel, a new turn may start while the old
        // engine unwinds — its callbacks must never emit into the new turn.
        const emitTurn = (event) => {
            if (controller.signal.aborted)
                return;
            this.emit(sessionId, event);
        };
        this.emit(sessionId, { kind: 'status', status: 'working' });
        // Phase 4 — begin the DAG turn telemetry window (engine badge 'loop',
        // per-tool telemetry accumulates below).
        try {
            this.turnTelemetry?.beginLoopTurn(`${sessionId}-${now}`, clean, opts.provider, opts.model);
        }
        catch {
            /* telemetry must never break the turn */
        }
        try {
            const engine = await this.ensureEngine();
            const answer = await engine.answerOnce(clean, {
                // P4 — the cancel signal rides into the turn.
                signal: controller.signal,
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
                    const opts2 = (choices ?? []);
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
                    if (info.tool === 'suggest_followups' || info.tool === 'ask_user' || info.tool === 'plan_todo')
                        return;
                    // Phase 4 — one record per COMPLETED call into the DAG store.
                    if (phase === 'called') {
                        try {
                            this.turnTelemetry?.recordLoopToolCall({
                                tool: info.tool,
                                ...(info.ok !== undefined ? { ok: info.ok } : {}),
                                ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}),
                                ...(info.error !== undefined ? { error: info.error } : {}),
                            });
                        }
                        catch {
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
            const turns = [...history, { role: 'user', content: clean }];
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
            this.emit(sessionId, { kind: 'status', status: 'done' });
            this.notifyTurnCompleted({
                sessionId,
                ok: true,
                generationFailed: answer.generationFailed === true,
                bounded: answer.bounded === true,
                provider: answer.provider ?? null,
                model: answer.model ?? null,
            });
            // E3b: strip raw suggest_followups JSON embedded in content
            const cleanContent = (answer.content || '')
                .replace(/\n?\*?\s*\{\s*"tool"\s*:\s*"suggest_followups"[\s\S]*$/, '')
                .replace(/\n?\*?\s*<function=suggest_followups[\s\S]*<\/function>/g, '')
                .trim();
            return {
                ok: true,
                content: cleanContent,
                followups: nextFollowups,
                provider: answer.provider ?? null,
                model: answer.model ?? null,
                generationFailed: answer.generationFailed === true,
                bounded: answer.bounded === true,
            };
        }
        catch (err) {
            // A cancel racing the engine's unwinding must not surface as an error
            // (the engine may throw AbortError before the loop returns cleanly).
            if (controller.signal.aborted) {
                this.notifyTurnCompleted({ sessionId, ok: false, cancelled: true });
                return { ok: false, error: 'The turn was cancelled.', cancelled: true };
            }
            this.emit(sessionId, { kind: 'status', status: 'error' });
            this.notifyTurnCompleted({ sessionId, ok: false, error: err instanceof Error ? err.message : String(err) });
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        finally {
            this.busy.delete(sessionId);
            this.activeAborts.delete(sessionId);
        }
    }
    /**
     * Phase 4 — invoke the turn-completion hook (the DAG store's endLoopTurn
     * lives server-side). Guarded: a throwing/broken hook never breaks the chat
     * path, and an unset hook is a clean no-op (unit tests).
     */
    notifyTurnCompleted(turn) {
        try {
            this.onTurnCompleted?.(turn);
        }
        catch {
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
    abort(sessionId) {
        const controller = this.activeAborts.get(sessionId);
        if (!controller)
            return false;
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
    askQuestion(sessionId, questionId, payload) {
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
    respond(sessionId, questionId, answer = {}) {
        const pending = this.pendingQuestions.get(questionId);
        if (!pending || pending.sessionId !== sessionId)
            return false;
        this.pendingQuestions.delete(questionId);
        const index = answer.index ?? -1;
        const resolved = {
            index,
            answer: Array.isArray(index) ? index : index === -1 ? [] : index,
            custom: answer.custom,
        };
        pending.resolve(resolved);
        return true;
    }
    /** The session's plan store — created on first use, dropped on reset. */
    planStoreFor(sessionId) {
        let store = this.planStores.get(sessionId);
        if (!store) {
            store = new PlanStore();
            this.planStores.set(sessionId, store);
        }
        return store;
    }
    /** Forget a session's history (new conversation) + drop its pending questions. */
    reset(sessionId) {
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
function lastAssistantText(turns) {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (turns[i].role === 'assistant' && turns[i].content.trim()) {
            const text = turns[i].content.replace(/\s+/g, ' ').trim();
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
function formatTurnContext(projectContext, attachments) {
    const parts = [];
    if (projectContext)
        parts.push(projectContext);
    for (const a of attachments ?? []) {
        parts.push(`[Attachment: ${a.name}]\n${a.content}`);
    }
    return parts.join('\n\n');
}
/** P4 — the FIRST user text (truncated) for the sidebar search + preview. */
function firstUserText(turns) {
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
function summarizeToolArgs(args) {
    if (!args)
        return undefined;
    const parts = [];
    for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null || value === '')
            continue;
        const shown = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
        const text = `${key}: ${shown}`;
        parts.push(text.length > 34 ? `${text.slice(0, 31)}…` : text);
    }
    if (parts.length === 0)
        return undefined;
    const joined = `{${parts.join(', ')}}`;
    return joined.length > 60 ? `${joined.slice(0, 57)}…` : joined;
}
/** A fresh session id for the client to hold (or the server may generate one). */
export function newChatSessionId() {
    return randomUUID();
}
//# sourceMappingURL=chat-console.js.map