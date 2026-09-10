import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
/**
 * PipelineBoard — Live terminal view of the multi-agent pipeline (ink v2).
 *
 * Turns the pipeline from a black box into a board the user can follow:
 *
 * ```
 * ⚡ Add JWT authentication to the Express app            [0:42]
 *    2/5 steps · 2 running in parallel · 40% · ETA ~2m 30s
 *       📂 Project type: Node.js · 42 source files · 8 tests found
 *    ▸ ◐  ✏️ writer    Implement JWT middleware        (0:12)
 *       │  ↻ 🔧 Repair attempt 2: switch-model
 *       │  💭 Generating code changes…
 *       │  ● working…
 *    ✓  📋 planner     Created 4 task steps — Wrote the plan
 *       💻 $ npm test ◐ (0:08)
 *       💻 $ git status ✓ (34ms)
 *       [j/k select · space toggle · e expand all · h collapse all · q freeze]
 * ```
 *
 * Built on **ink** (the React-for-CLI toolkit — the modern terminal-app standard;
 * plan E2 "Leverage" line). Behavior:
 * - **Parallel lanes** — every plan node is a lane; running agents animate a
 *   rotating "working" indicator and accumulate a per-step thought trail.
 * - **Shell lanes (E1)** — every subprocess (`exec:shell-start/end`) is a live
 *   `$ npm test` lane with spinner + elapsed, then collapses to a ✓/✗ summary.
 * - **Retry lanes** — `recover:*` events (classified / attempt / model-switch /
 *   budget-exhausted / result) render inline on the affected task lane — today
 *   they ran silently.
 * - **ETA + pulsing dot** — remaining-time estimate from completed-task
 *   durations; a live elapsed clock pulses while anything is running.
 * - **Keyboard control** — j/k or arrows select, space toggles collapse,
 *   e/h expand/collapse all, q freezes the live view.
 * - **Non-TTY / piped mode:** falls back to plain sequential log lines so CI
 *   and scripted runs still get readable output.
 * - Implements the orchestrator's `spinner` interface (`stop()` / `start()`)
 *   so rate-limit prompts and other interactive dialogs can pause the board.
 *
 * The board subscribes to the shared EventBus, so the SAME event stream also
 * keeps the web dashboard DAG alive — one source of truth, two surfaces.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text, render, useInput } from 'ink';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import { getModuleRegistry } from '../agents/module-registry.js';
const DONE_STATUS = ['completed', 'failed', 'skipped'];
/** Rotating "working" indicator frames (TTY animation). */
const WORK_FRAMES = ['◐', '◓', '◑', '◒'];
const MAX_THINKING_LINES = 4;
const MAX_RETRY_LINES = 3;
const MAX_SHELL_LANES = 6;
const MAX_DELEGATION_LANES = 4;
const MAX_RECOVERY_NOTES = 3;
const MAX_NOTES = 3;
// ─── Formatting + shared helpers ────────────────────────────────────────────
function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return mm > 0 ? `${mm}m ${String(ss).padStart(2, '0')}s` : `${ss}s`;
}
function formatClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function statusGlyph(status, frame, tty) {
    switch (status) {
        case 'running':
            return tty ? WORK_FRAMES[frame % WORK_FRAMES.length] : '●';
        case 'completed':
            return '✓';
        case 'failed':
            return '✗';
        case 'skipped':
            return '⏭';
        default:
            return '⏳';
    }
}
const TASK_STATUS_COLOR = {
    running: 'cyan',
    completed: 'green',
    failed: 'red',
    skipped: 'gray',
    pending: 'gray',
};
function shellKey(cwd, command) {
    return `${cwd ?? ''}::${command}`;
}
function recoveryLabel(event, d) {
    switch (event) {
        case EventNames.RECOVER_CLASSIFIED:
            return `Error classified: ${String(d.category ?? 'unknown')}`;
        case EventNames.RECOVER_ATTEMPT:
            return `Repair attempt ${String(d.attempt ?? '?')}: ${String(d.strategy ?? 'unknown')}`;
        case EventNames.RECOVER_MODEL_SWITCH:
            return `Switched to ${String(d.switchedTo ?? '?')}`;
        case EventNames.RECOVER_BUDGET_EXHAUSTED:
            return 'Repair budget exhausted';
        case EventNames.RECOVER_RESULT:
            return `Repair ${d.success ? 'succeeded' : 'failed'}`;
        default:
            return null;
    }
}
let registryIcons = null;
function iconFor(agentType) {
    if (!registryIcons) {
        try {
            registryIcons = new Map(getModuleRegistry().listModules().map((m) => [m.agentType, m.icon]));
        }
        catch {
            registryIcons = new Map();
        }
    }
    return registryIcons.get(agentType) ?? '⚙️';
}
// ─── Ink view ───────────────────────────────────────────────────────────────
/** Pulse the view every 500ms while active (TTY only) — drives spinner frames. */
function usePulse(board, active) {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (!active || !board.tty)
            return;
        const id = setInterval(() => setTick((t) => t + 1), 500);
        return () => clearInterval(id);
    }, [active, board.tty]);
    return tick;
}
function TaskLane({ task, selected, collapsed, frame, now, tty, }) {
    const isRunning = task.status === 'running';
    const runningElapsed = isRunning && task.startedAt != null ? ` (${formatClock(now - task.startedAt)})` : '';
    const name = `${iconFor(task.agentType)} ${task.agentType}`;
    const summary = !isRunning && task.status !== 'pending' && task.summary && !collapsed
        ? ` — ${task.summary}`
        : '';
    const earlierRepairs = task.retryCount - task.retries.length;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsxs(Text, { children: [selected ? '▸' : ' ', " "] }), _jsx(Text, { color: TASK_STATUS_COLOR[task.status], children: statusGlyph(task.status, frame, tty) }), _jsxs(Text, { children: ["  ", name.padEnd(20)] }), _jsx(Text, { dimColor: true, children: task.description.slice(0, 46) }), _jsx(Text, { dimColor: true, children: runningElapsed }), _jsx(Text, { dimColor: true, children: summary })] }), isRunning &&
                (collapsed ? (_jsx(Text, { dimColor: true, children: "      \u2502  (collapsed \u2014 press space to expand)" })) : (_jsxs(Box, { flexDirection: "column", children: [earlierRepairs > 0 && (_jsxs(Text, { color: "yellow", children: ["      \u2502  \u21BB +", earlierRepairs, " earlier repair(s)"] })), task.retries.map((r, i) => (_jsxs(Text, { color: "yellow", children: ['      │  ↻ ', r] }, i))), task.updates.length > MAX_THINKING_LINES && (_jsxs(Text, { dimColor: true, children: ["      \u2502  \u00B7\u00B7\u00B7 +", task.updates.length - MAX_THINKING_LINES, " earlier step(s)"] })), task.updates.slice(-MAX_THINKING_LINES).map((u, i) => (_jsxs(Text, { dimColor: true, children: ['      │  💭 ', u.replace(/\s+/g, ' ').slice(0, 80)] }, i))), _jsx(Text, { dimColor: true, children: "      \u2502  \u25CF working\u2026" })] })))] }));
}
function DelegationLaneView({ lane, frame, now, tty, }) {
    const running = lane.status === 'running';
    const glyph = running
        ? tty
            ? WORK_FRAMES[frame % WORK_FRAMES.length]
            : '●'
        : lane.status === 'done'
            ? '✓'
            : '✗';
    const tail = running
        ? ` (${formatClock(now - lane.startedAt)})`
        : lane.durationMs != null
            ? ` (${formatDuration(lane.durationMs)})`
            : '';
    const summary = !running && lane.summary ? ` — ${lane.summary.slice(0, 60)}` : '';
    const color = running ? 'cyan' : lane.status === 'done' ? 'green' : 'red';
    return (_jsxs(Text, { color: color, children: ['   🧑🔧 ', lane.agentType.padEnd(18), lane.prompt.slice(0, 40), ' ', glyph, tail, summary] }));
}
function ShellLaneView({ lane, frame, now, tty, }) {
    const running = lane.status === 'running';
    const glyph = running
        ? tty
            ? WORK_FRAMES[frame % WORK_FRAMES.length]
            : '●'
        : lane.status === 'done'
            ? '✓'
            : '✗';
    const tail = running
        ? ` (${formatClock(now - lane.startedAt)})`
        : lane.durationMs != null
            ? ` (${formatDuration(lane.durationMs)})`
            : '';
    const color = running ? 'cyan' : lane.status === 'done' ? 'green' : 'red';
    return (_jsxs(Text, { color: color, children: ['   💻 $ ', lane.command.slice(0, 80), ' ', glyph, tail] }));
}
/** The live TUI — reads the board's model via useSyncExternalStore. */
export function BoardView({ board }) {
    // Re-render on every board mutation (version bumps per event + notify()).
    useSyncExternalStore(board.subscribe, board.getVersion);
    const tick = usePulse(board, board.isActive());
    const model = board.buildModel();
    const frame = tick % WORK_FRAMES.length;
    useInput((input, key) => {
        if (key.escape || input === 'q' || input === 'Q') {
            board.freeze();
            return;
        }
        if (key.upArrow || input === 'k' || input === 'K') {
            board.selectPrev();
            return;
        }
        if (key.downArrow || input === 'j' || input === 'J') {
            board.selectNext();
            return;
        }
        if (input === ' ' || key.return) {
            board.toggleSelected();
            return;
        }
        if (input === 'e' || input === 'E') {
            board.expandAll();
            return;
        }
        if (input === 'h' || input === 'H') {
            board.collapseAll();
        }
    });
    return (_jsxs(Box, { flexDirection: "column", paddingLeft: 1, children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, children: `⚡ ${model.goal.slice(0, 72)}` }), _jsx(Text, { dimColor: true, children: `  [${model.elapsedLabel}]` })] }), model.progressLabel && _jsx(Text, { dimColor: true, children: `   ${model.progressLabel}` }), model.notes.map((n, i) => (_jsxs(Text, { dimColor: true, children: ['   ', n] }, i))), model.tasks.map((t, i) => (_jsx(TaskLane, { task: t, selected: i === model.selected, collapsed: model.collapsed.has(t.id), frame: frame, now: model.now, tty: board.tty }, t.id))), model.activity && (model.total === 0 || model.hasRunning) && (_jsx(Text, { dimColor: true, children: `   💭 ${model.activity.slice(0, 110)}` })), model.recoveries.map((r) => (_jsxs(Text, { color: "yellow", children: ['   🔧 ', r.message] }, r.id))), model.delegations.map((d) => (_jsx(DelegationLaneView, { lane: d, frame: frame, now: model.now, tty: board.tty }, d.id))), model.shells.length > 0 && (_jsx(Box, { flexDirection: "column", children: model.shells.map((s) => (_jsx(ShellLaneView, { lane: s, frame: frame, now: model.now, tty: board.tty }, s.id))) })), model.showKeymap && (_jsx(Text, { dimColor: true, children: "   [j/k select \u00B7 space toggle \u00B7 e expand all \u00B7 h collapse all \u00B7 q freeze]" }))] }));
}
// ─── PipelineBoard ──────────────────────────────────────────────────────────
export class PipelineBoard {
    goal = '';
    tasks = new Map();
    order = [];
    /** Deterministic pre-flight inspection lines shown under the header. */
    notes = [];
    /** Live "thinking" line for agents without a task step (e.g. the planner). */
    activity = '';
    shells = new Map();
    shellSeq = 0;
    /** H2 — live sub-agent delegation lanes (spawn → result/error). */
    delegations = new Map();
    /** Recovery notes that arrived without a taskId (untethered). */
    recoveries = [];
    recSeq = 0;
    paused = false;
    started = false;
    done = false;
    /** Whether this board renders the live TUI (vs non-TTY log lines). */
    tty;
    stream;
    attached = false;
    unsubs = [];
    bus;
    startedAt = 0;
    /** Task ids the user has collapsed (only the header line is shown). */
    collapsed = new Set();
    /** Currently selected task index (keyboard navigation). */
    selected = 0;
    ink = null;
    /** useSyncExternalStore plumbing: version bumps per mutation. */
    version = 0;
    listeners = new Set();
    constructor(opts) {
        this.stream = opts?.stream ?? process.stdout;
        this.tty = opts?.tty ?? (this.stream.isTTY === true);
        this.bus = opts?.bus;
    }
    // ── React store interface (ink view) ───────────────────────────────────
    /** Subscribe to board mutations. Returns an unsubscribe function. */
    subscribe = (cb) => {
        this.attach();
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    };
    /** Monotonic version — the stable snapshot for useSyncExternalStore. */
    getVersion = () => this.version;
    /** Whether the live view should animate right now. */
    isActive() {
        return this.started && !this.done && !this.paused;
    }
    /** Snapshot of the board state for the ink view (and final frames). */
    buildModel(now = Date.now()) {
        const total = this.order.length;
        const doneCount = this.order.filter((id) => DONE_STATUS.includes(this.tasks.get(id).status)).length;
        const runningCount = this.order.filter((id) => this.tasks.get(id).status === 'running').length;
        const failedCount = this.order.filter((id) => this.tasks.get(id).status === 'failed').length;
        const eta = this.etaLabel();
        const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
        const progressLabel = total > 0
            ? `${doneCount}/${total} steps${runningCount > 0 ? ` · ${runningCount} running${runningCount > 1 ? ' in parallel' : ''}` : ''} · ${pct}%${eta ? ` · ETA ${eta}` : ''}`
            : null;
        return {
            goal: this.goal,
            startedAt: this.startedAt,
            now,
            notes: this.notes.slice(-MAX_NOTES),
            activity: this.activity,
            tasks: this.order.map((id) => this.tasks.get(id)),
            shells: this.activeShells(),
            recoveries: this.recoveries.slice(-MAX_RECOVERY_NOTES),
            delegations: this.activeDelegations(),
            total,
            doneCount,
            runningCount,
            failedCount,
            selected: this.selected,
            collapsed: new Set(this.collapsed),
            done: this.done,
            hasRunning: runningCount > 0,
            elapsedLabel: formatClock(now - this.startedAt),
            etaLabel: eta,
            progressLabel,
            showKeymap: this.tty && total > 0 && !this.done && !this.paused,
        };
    }
    notify() {
        this.version++;
        for (const cb of this.listeners) {
            try {
                cb();
            }
            catch {
                /* a listener must never break the board */
            }
        }
    }
    // ── Lifecycle ───────────────────────────────────────────────────────────
    /** Subscribe to orchestrator / shell / recovery events. Safe to call repeatedly. */
    attach() {
        if (this.attached)
            return;
        this.attached = true;
        const bus = this.bus ?? getEventBus();
        this.unsubs.push(bus.on(EventNames.ORCHESTRATOR_PIPELINE_STARTED, (r) => this.handlePipelineStarted(r)), bus.on(EventNames.ORCHESTRATOR_PLAN_READY, (r) => this.handlePlanReady(r)), bus.on(EventNames.ORCHESTRATOR_TASK_STARTED, (r) => this.handleTaskStarted(r)), bus.on(EventNames.ORCHESTRATOR_TASK_COMPLETED, (r) => this.handleTaskCompleted(r)), bus.on(EventNames.ORCHESTRATOR_AGENT_UPDATE, (r) => this.handleAgentUpdate(r)), bus.on(EventNames.ORCHESTRATOR_INSPECTION, (r) => this.handleInspection(r)), 
        // E1 shell lanes — every subprocess is a visible lane.
        bus.on(EventNames.EXEC_SHELL_START, (r) => this.handleShellStart(r)), bus.on(EventNames.EXEC_SHELL_END, (r) => this.handleShellEnd(r)), 
        // E2 retry lanes — recovery events that used to run silently.
        bus.on(EventNames.RECOVER_CLASSIFIED, (r) => this.handleRecovery(r)), bus.on(EventNames.RECOVER_ATTEMPT, (r) => this.handleRecovery(r)), bus.on(EventNames.RECOVER_MODEL_SWITCH, (r) => this.handleRecovery(r)), bus.on(EventNames.RECOVER_BUDGET_EXHAUSTED, (r) => this.handleRecovery(r)), bus.on(EventNames.RECOVER_RESULT, (r) => this.handleRecovery(r)), 
        // H2 — sub-agent delegation lanes.
        bus.on(EventNames.DELEGATION_SPAWN, (r) => this.handleDelegationSpawn(r)), bus.on(EventNames.DELEGATION_RESULT, (r) => this.handleDelegationResult(r)), bus.on(EventNames.DELEGATION_ERROR, (r) => this.handleDelegationError(r)));
    }
    /** Unsubscribe from all events (called automatically by finish()). */
    detach() {
        for (const unsub of this.unsubs)
            unsub();
        this.unsubs = [];
        this.attached = false;
        this.listeners.clear();
    }
    /**
     * Begin showing the board for a goal (first call), and re-render it on
     * subsequent calls. Also implements the orchestrator's spinner interface so
     * `start(text)` after a `stop()` resumes the live view with an activity line.
     */
    start(text) {
        const isFirst = !this.started;
        if (isFirst) {
            this.goal = text || '';
            this.startedAt = Date.now();
            this.attach();
            this.started = true;
        }
        this.paused = false;
        this.done = false;
        if (text && !isFirst)
            this.activity = text;
        this.mountInk();
        this.notify();
    }
    mountInk() {
        if (!this.tty || this.ink || this.done)
            return;
        try {
            this.ink = render(_jsx(BoardView, { board: this }), { stdout: this.stream });
        }
        catch {
            // Rendering must never break execution — degrade to non-TTY log lines.
            this.ink = null;
        }
    }
    unmountInk() {
        if (!this.ink)
            return;
        try {
            this.ink.unmount();
        }
        catch {
            /* best-effort */
        }
        this.ink = null;
    }
    /** Spinner-compatible: freeze the board so prompts/logs print cleanly below. */
    stop() {
        this.paused = true;
        this.unmountInk();
        this.notify();
    }
    /**
     * Finalize the board. In TTY mode the final static frame is left on screen;
     * in non-TTY (piped/CI) mode only a one-line summary is printed because the
     * discrete event lines already told the whole story. Then detaches from the
     * event bus so repeated runs (chat dev-mode) never leak handlers.
     */
    finish(success) {
        if (!this.started || this.done) {
            this.detach();
            return;
        }
        this.done = true;
        this.unmountInk();
        if (this.tty) {
            const lines = this.buildFinalFrame(success);
            this.stream.write(lines.join('\n') + '\n');
        }
        else {
            this.logLine(success ? '✅ Pipeline completed' : '❌ Pipeline completed with failures');
        }
        this.detach();
        this.notify();
    }
    /**
     * Freeze the board: stop live updates and keyboard control, and leave the
     * current frame on screen. The pipeline keeps running — the user just stops
     * watching the live view (pressed `q`).
     */
    freeze() {
        if (!this.started || this.done)
            return;
        this.unmountInk();
        this.paused = true;
        if (this.tty) {
            const lines = this.buildFinalFrame(null);
            this.stream.write(lines.join('\n') + '\n');
        }
        this.notify();
    }
    // ── Keyboard navigation API (used by the ink view + tests) ──────────────
    /** Move the selection cursor down. */
    selectNext() {
        if (this.order.length === 0)
            return;
        this.selected = Math.min(this.order.length - 1, this.selected + 1);
        this.notify();
    }
    /** Move the selection cursor up. */
    selectPrev() {
        if (this.order.length === 0)
            return;
        this.selected = Math.max(0, this.selected - 1);
        this.notify();
    }
    /** Toggle the collapse state of the currently selected task. */
    toggleSelected() {
        const id = this.order[this.selected];
        if (!id)
            return;
        if (this.collapsed.has(id))
            this.collapsed.delete(id);
        else
            this.collapsed.add(id);
        this.notify();
    }
    /** Expand every task (show all detail lines). */
    expandAll() {
        this.collapsed.clear();
        this.notify();
    }
    /** Collapse every task (headers only). */
    collapseAll() {
        for (const id of this.order)
            this.collapsed.add(id);
        this.notify();
    }
    // ── Event handlers ─────────────────────────────────────────────────────
    handlePipelineStarted(record) {
        const d = record.data;
        if (d?.goal && !this.started)
            this.start(d.goal);
    }
    handlePlanReady(record) {
        const d = record.data;
        const nodes = d?.nodes || [];
        for (const n of nodes) {
            if (!this.tasks.has(n.id)) {
                this.tasks.set(n.id, {
                    id: n.id,
                    agentType: n.agentType,
                    description: n.description,
                    status: 'pending',
                    updates: [],
                    retries: [],
                    retryCount: 0,
                });
                this.order.push(n.id);
            }
        }
        if (!this.tty) {
            this.logLine(`📋 Plan ready: ${nodes.length} step(s) — ${nodes.map((n) => n.agentType).join(', ')}`);
        }
        this.notify();
    }
    handleTaskStarted(record) {
        const d = record.data;
        const existing = this.tasks.get(d.taskId);
        if (existing) {
            existing.status = 'running';
            existing.startedAt = Date.now();
            existing.retries = [];
            existing.retryCount = 0;
        }
        else {
            this.tasks.set(d.taskId, {
                id: d.taskId,
                agentType: d.agentType,
                description: d.description,
                status: 'running',
                updates: [],
                startedAt: Date.now(),
                retries: [],
                retryCount: 0,
            });
            this.order.push(d.taskId);
        }
        if (!this.tty) {
            this.logLine(`▶️  ${d.agentType}: ${d.description.slice(0, 80)}${d.description.length > 80 ? '…' : ''}`);
        }
        this.notify();
    }
    handleTaskCompleted(record) {
        const d = record.data;
        const task = this.tasks.get(d.taskId);
        if (task) {
            task.status = d.success ? 'completed' : 'failed';
            task.summary = d.summary;
            task.endedAt = Date.now();
        }
        if (!this.tty) {
            const icon = d.success ? '✅' : '❌';
            this.logLine(`   ${icon} ${d.agentType}: ${(d.summary || 'done').slice(0, 100)}`);
        }
        this.notify();
    }
    handleAgentUpdate(record) {
        const d = record.data;
        const msg = d.message || '';
        if (d.taskId && this.tasks.has(d.taskId)) {
            const task = this.tasks.get(d.taskId);
            if (msg && task.updates[task.updates.length - 1] !== msg) {
                task.updates.push(msg);
                if (task.updates.length > 20)
                    task.updates.splice(0, task.updates.length - 20);
            }
        }
        else {
            this.activity = msg;
        }
        if (!this.tty) {
            const tag = d.agentType === 'orchestrator' ? '⚡' : '💭';
            this.logLine(`   ${tag} ${d.agentType || 'Agent'} · ${d.stage || ''}: ${msg.slice(0, 130)}`);
        }
        this.notify();
    }
    handleInspection(record) {
        const d = record.data;
        const lines = d?.lines || [];
        this.notes.push(...lines);
        if (!this.tty) {
            for (const line of lines)
                this.logLine(`   📂 ${line}`);
        }
        this.notify();
    }
    handleShellStart(record) {
        const d = record.data;
        const command = d?.command || '?';
        // Lane key = command + cwd. Two IDENTICAL commands running concurrently
        // from the same cwd would share a lane (the second start replaces the
        // first) — a rare edge; accepted and documented (E2 review).
        this.shells.set(shellKey(d?.cwd, command), {
            id: this.shellSeq++,
            command,
            status: 'running',
            startedAt: Date.now(),
        });
        if (!this.tty)
            this.logLine(`💻 $ ${command.slice(0, 90)}`);
        this.notify();
    }
    handleShellEnd(record) {
        const d = record.data;
        const lane = this.shells.get(shellKey(d?.cwd, d?.command || '?'));
        if (lane) {
            lane.status = d.success ? 'done' : 'failed';
            lane.exitCode = d.exitCode;
            lane.durationMs = d.durationMs;
        }
        if (!this.tty) {
            const icon = d.success ? '✅' : '❌';
            this.logLine(`   ${icon} $ ${(d.command || '?').slice(0, 90)} (exit ${d.exitCode ?? '?'}${d.durationMs != null ? `, ${Math.round(d.durationMs)}ms` : ''})`);
        }
        this.notify();
    }
    handleRecovery(record) {
        const d = record.data;
        const label = recoveryLabel(record.event, d);
        if (!label)
            return;
        if (d.taskId && this.tasks.has(d.taskId)) {
            const task = this.tasks.get(d.taskId);
            task.retryCount++;
            if (task.retries[task.retries.length - 1] !== label)
                task.retries.push(label);
            if (task.retries.length > MAX_RETRY_LINES)
                task.retries.shift();
        }
        else {
            this.recoveries.push({ id: this.recSeq++, message: label });
        }
        if (!this.tty)
            this.logLine(`   🔧 ${label}`);
        this.notify();
    }
    // ── H2 delegation lane handlers ───────────────────────────────────────
    handleDelegationSpawn(record) {
        const d = record.data;
        const id = d?.id;
        if (!id)
            return;
        this.delegations.set(id, {
            id,
            agentType: d.agentType || 'sub-agent',
            prompt: d.prompt || '',
            status: 'running',
            startedAt: Date.now(),
        });
        if (!this.tty) {
            this.logLine(`🧑🔧 Sub-agent ${d.agentType || ''}: ${(d.prompt || '').slice(0, 80)}`);
        }
        this.notify();
    }
    handleDelegationResult(record) {
        const d = record.data;
        const lane = d?.id ? this.delegations.get(d.id) : undefined;
        if (lane) {
            lane.status = d.success ? 'done' : 'failed';
            lane.summary = d.summary;
            lane.durationMs = d.durationMs;
        }
        if (!this.tty) {
            const icon = d.success ? '✅' : '❌';
            this.logLine(`   ${icon} Sub-agent ${d.agentType || ''}: ${(d.summary || 'done').slice(0, 100)}`);
        }
        this.notify();
    }
    handleDelegationError(record) {
        const d = record.data;
        const lane = d?.id ? this.delegations.get(d.id) : undefined;
        if (lane) {
            lane.status = 'failed';
            lane.summary = d.error || 'failed';
        }
        if (!this.tty) {
            this.logLine(`   ❌ Sub-agent ${d.agentType || ''}: ${(d.error || 'failed').slice(0, 120)}`);
        }
        this.notify();
    }
    // ── Model helpers ────────────────────────────────────────────────────────
    hasRunning() {
        return this.order.some((id) => this.tasks.get(id).status === 'running');
    }
    /** Running delegations first; most-recent finished lanes after (capped). */
    activeDelegations() {
        const all = [...this.delegations.values()];
        const running = all.filter((s) => s.status === 'running').sort((a, b) => a.startedAt - b.startedAt);
        const finished = all
            .filter((s) => s.status !== 'running')
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, Math.max(0, MAX_DELEGATION_LANES - running.length));
        return [...running, ...finished];
    }
    /** Most-recent finished shells first; running ones pinned on top. */
    activeShells() {
        const all = [...this.shells.values()];
        const running = all.filter((s) => s.status === 'running').sort((a, b) => a.startedAt - b.startedAt);
        const finished = all
            .filter((s) => s.status !== 'running')
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, Math.max(0, MAX_SHELL_LANES - running.length));
        return [...running, ...finished];
    }
    /** Remaining-time estimate from completed-task durations (avg × remaining). */
    etaLabel() {
        if (this.order.length === 0)
            return null;
        const done = this.order.filter((id) => this.tasks.get(id).status === 'completed').length;
        const remaining = this.order.length - done;
        if (remaining <= 0)
            return null;
        const durations = [];
        for (const id of this.order) {
            const t = this.tasks.get(id);
            if (t.status === 'completed' && t.startedAt != null && t.endedAt != null) {
                durations.push(t.endedAt - t.startedAt);
            }
        }
        if (durations.length === 0)
            return null;
        const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
        return formatDuration(avg * remaining);
    }
    /** Plain-text final frame (TTY finish/freeze) — mirrors the ink layout. */
    buildFinalFrame(success) {
        const m = this.buildModel();
        const lines = [];
        const goal = m.goal.slice(0, 72) + (m.goal.length > 72 ? '…' : '');
        lines.push(`⚡ ${goal}   [${m.elapsedLabel}]`);
        if (m.progressLabel)
            lines.push(`   ${m.progressLabel}`);
        for (const note of m.notes)
            lines.push(`   ${note}`);
        for (const t of m.tasks) {
            const isRunning = t.status === 'running';
            const glyph = statusGlyph(t.status, 0, true);
            const name = `${iconFor(t.agentType)} ${t.agentType}`;
            const summary = !isRunning && t.status !== 'pending' && t.summary ? ` — ${t.summary}` : '';
            lines.push(`  ${glyph}  ${name.padEnd(22)} ${t.description.slice(0, 46)}${summary}`);
            if (isRunning) {
                for (const r of t.retries.slice(-MAX_RETRY_LINES))
                    lines.push(`      │  ↻ ${r}`);
                for (const u of t.updates.slice(-MAX_THINKING_LINES)) {
                    lines.push(`      │  💭 ${u.replace(/\s+/g, ' ').slice(0, 80)}`);
                }
                lines.push('      │  ● working…');
            }
        }
        if (m.activity && (m.total === 0 || m.hasRunning)) {
            lines.push(`   💭 ${m.activity.slice(0, 110)}`);
        }
        for (const r of m.recoveries)
            lines.push(`   🔧 ${r.message}`);
        for (const d of m.delegations) {
            const glyph = d.status === 'done' ? '✓' : d.status === 'failed' ? '✗' : '●';
            const tail = d.durationMs != null ? ` (${formatDuration(d.durationMs)})` : '';
            const summary = d.status !== 'running' && d.summary ? ` — ${d.summary.slice(0, 60)}` : '';
            lines.push(`   🧑🔧 ${d.agentType.padEnd(18)} ${d.prompt.slice(0, 40)} ${glyph}${tail}${summary}`);
        }
        for (const s of m.shells) {
            const glyph = s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : '●';
            const tail = s.durationMs != null ? ` (${formatDuration(s.durationMs)})` : '';
            lines.push(`   💻 $ ${s.command.slice(0, 80)} ${glyph}${tail}`);
        }
        if (success !== null) {
            lines.push(success ? '✅ Pipeline completed' : '❌ Pipeline completed with failures');
        }
        return lines;
    }
    logLine(text) {
        this.stream.write(text + '\n');
    }
}
// ─── PipelineEventStream (machine-readable NDJSON activity stream) ──────────
/**
 * PipelineEventStream — Machine-readable counterpart of PipelineBoard.
 *
 * Consumes the SAME event stream and emits one NDJSON line per event, so any
 * external consumer (CI, scripts, the VS Code extension panel, a webhook) can
 * render the same live activity the terminal board shows:
 *
 * ```
 * {"type":"pipeline-started","goal":"..."}
 * {"type":"inspection","lines":[...]}
 * {"type":"plan-ready","nodes":[...],"edges":[...]}
 * {"type":"task-started","taskId":"s1",...}
 * {"type":"agent-update",...}
 * {"type":"shell-start","command":"npm test",...}      ← E1
 * {"type":"recover-attempt","taskId":"s1","strategy":...} ← E2
 * {"type":"task-completed",...}
 * {"type":"pipeline-completed","success":true}
 * ```
 *
 * Implements the orchestrator spinner interface (`stop()`/`start()` are no-ops)
 * and is API-compatible with PipelineBoard so the CLI can swap them.
 */
export class PipelineEventStream {
    stream;
    bus;
    unsubs = [];
    attached = false;
    constructor(opts) {
        this.stream = opts?.stream ?? process.stdout;
        this.bus = opts?.bus;
    }
    attach() {
        if (this.attached)
            return;
        this.attached = true;
        const bus = this.bus ?? getEventBus();
        this.unsubs.push(bus.on(EventNames.ORCHESTRATOR_PIPELINE_STARTED, (r) => this.write('pipeline-started', r.data)), bus.on(EventNames.ORCHESTRATOR_INSPECTION, (r) => this.write('inspection', r.data)), bus.on(EventNames.ORCHESTRATOR_PLAN_READY, (r) => this.write('plan-ready', r.data)), bus.on(EventNames.ORCHESTRATOR_TASK_STARTED, (r) => this.write('task-started', r.data)), bus.on(EventNames.ORCHESTRATOR_AGENT_UPDATE, (r) => this.write('agent-update', r.data)), bus.on(EventNames.ORCHESTRATOR_TASK_COMPLETED, (r) => this.write('task-completed', r.data)), 
        // E1/E2 extensions — subprocess + recovery visibility for external consumers.
        bus.on(EventNames.EXEC_SHELL_START, (r) => this.write('shell-start', r.data)), bus.on(EventNames.EXEC_SHELL_END, (r) => this.write('shell-end', r.data)), 
        // H2 — sub-agent delegation lanes for external consumers.
        bus.on(EventNames.DELEGATION_SPAWN, (r) => this.write('delegation-spawn', r.data)), bus.on(EventNames.DELEGATION_RESULT, (r) => this.write('delegation-result', r.data)), bus.on(EventNames.DELEGATION_ERROR, (r) => this.write('delegation-error', r.data)), bus.on(EventNames.RECOVER_CLASSIFIED, (r) => this.write('recover-classified', r.data)), bus.on(EventNames.RECOVER_ATTEMPT, (r) => this.write('recover-attempt', r.data)), bus.on(EventNames.RECOVER_MODEL_SWITCH, (r) => this.write('recover-model-switch', r.data)), bus.on(EventNames.RECOVER_BUDGET_EXHAUSTED, (r) => this.write('recover-budget-exhausted', r.data)), bus.on(EventNames.RECOVER_RESULT, (r) => this.write('recover-result', r.data)));
    }
    detach() {
        for (const unsub of this.unsubs)
            unsub();
        this.unsubs = [];
        this.attached = false;
    }
    /** Spinner-compatible (no-op) — pipelines can pass this as `spinner`. */
    stop() {
        /* no-op */
    }
    /** Spinner-compatible (no-op) — pipelines can pass this as `spinner`. */
    start(_text) {
        this.attach();
    }
    /** Emit the terminal event and detach. */
    finish(success) {
        if (!this.attached)
            return;
        this.write('pipeline-completed', { success });
        this.detach();
    }
    write(type, data) {
        const payload = (data && typeof data === 'object' ? data : {});
        this.stream.write(JSON.stringify({ type, ...payload, ts: Date.now() }) + '\n');
    }
}
//# sourceMappingURL=pipeline-board.js.map