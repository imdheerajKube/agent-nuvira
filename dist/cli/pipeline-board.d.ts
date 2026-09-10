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
import type { EventBus } from '../observability/event-bus.js';
type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
type ShellStatus = 'running' | 'done' | 'failed';
/** Node info from the plan-ready event (mirrors the DAG node shape). */
export interface PlanNodeInfo {
    id: string;
    agentType: string;
    description: string;
    complexity?: string;
}
interface BoardTask {
    id: string;
    agentType: string;
    description: string;
    status: TaskStatus;
    summary?: string;
    /** Accumulated "thinking" trail — shown as nested tree-guide lines. */
    updates: string[];
    startedAt?: number;
    endedAt?: number;
    /** Most recent repair labels (capped); `retryCount` tracks the total. */
    retries: string[];
    retryCount: number;
}
interface ShellLane {
    id: number;
    command: string;
    status: ShellStatus;
    exitCode?: number;
    startedAt: number;
    durationMs?: number;
}
/** H2 — a live sub-agent delegation lane (spawn → result/error). */
type DelegationStatus = 'running' | 'done' | 'failed';
interface DelegationLane {
    id: string;
    agentType: string;
    prompt: string;
    status: DelegationStatus;
    startedAt: number;
    durationMs?: number;
    summary?: string;
}
interface RecoveryNote {
    id: number;
    message: string;
}
/** Immutable snapshot of the board state, consumed by the ink view. */
export interface BoardModel {
    goal: string;
    startedAt: number;
    now: number;
    notes: string[];
    activity: string;
    tasks: BoardTask[];
    shells: ShellLane[];
    recoveries: RecoveryNote[];
    /** H2 — live sub-agent delegation lanes. */
    delegations: DelegationLane[];
    total: number;
    doneCount: number;
    runningCount: number;
    failedCount: number;
    selected: number;
    collapsed: ReadonlySet<string>;
    done: boolean;
    hasRunning: boolean;
    elapsedLabel: string;
    etaLabel: string | null;
    progressLabel: string | null;
    showKeymap: boolean;
}
/** The live TUI — reads the board's model via useSyncExternalStore. */
export declare function BoardView({ board }: {
    board: PipelineBoard;
}): import("react").JSX.Element;
export declare class PipelineBoard {
    private goal;
    private tasks;
    private order;
    /** Deterministic pre-flight inspection lines shown under the header. */
    private notes;
    /** Live "thinking" line for agents without a task step (e.g. the planner). */
    private activity;
    private shells;
    private shellSeq;
    /** H2 — live sub-agent delegation lanes (spawn → result/error). */
    private delegations;
    /** Recovery notes that arrived without a taskId (untethered). */
    private recoveries;
    private recSeq;
    private paused;
    private started;
    private done;
    /** Whether this board renders the live TUI (vs non-TTY log lines). */
    readonly tty: boolean;
    private stream;
    private attached;
    private unsubs;
    private bus?;
    private startedAt;
    /** Task ids the user has collapsed (only the header line is shown). */
    private collapsed;
    /** Currently selected task index (keyboard navigation). */
    private selected;
    private ink;
    /** useSyncExternalStore plumbing: version bumps per mutation. */
    private version;
    private listeners;
    constructor(opts?: {
        tty?: boolean;
        stream?: NodeJS.WriteStream;
        bus?: EventBus;
    });
    /** Subscribe to board mutations. Returns an unsubscribe function. */
    subscribe: (cb: () => void) => (() => void);
    /** Monotonic version — the stable snapshot for useSyncExternalStore. */
    getVersion: () => number;
    /** Whether the live view should animate right now. */
    isActive(): boolean;
    /** Snapshot of the board state for the ink view (and final frames). */
    buildModel(now?: number): BoardModel;
    private notify;
    /** Subscribe to orchestrator / shell / recovery events. Safe to call repeatedly. */
    attach(): void;
    /** Unsubscribe from all events (called automatically by finish()). */
    detach(): void;
    /**
     * Begin showing the board for a goal (first call), and re-render it on
     * subsequent calls. Also implements the orchestrator's spinner interface so
     * `start(text)` after a `stop()` resumes the live view with an activity line.
     */
    start(text?: string): void;
    private mountInk;
    private unmountInk;
    /** Spinner-compatible: freeze the board so prompts/logs print cleanly below. */
    stop(): void;
    /**
     * Finalize the board. In TTY mode the final static frame is left on screen;
     * in non-TTY (piped/CI) mode only a one-line summary is printed because the
     * discrete event lines already told the whole story. Then detaches from the
     * event bus so repeated runs (chat dev-mode) never leak handlers.
     */
    finish(success: boolean): void;
    /**
     * Freeze the board: stop live updates and keyboard control, and leave the
     * current frame on screen. The pipeline keeps running — the user just stops
     * watching the live view (pressed `q`).
     */
    freeze(): void;
    /** Move the selection cursor down. */
    selectNext(): void;
    /** Move the selection cursor up. */
    selectPrev(): void;
    /** Toggle the collapse state of the currently selected task. */
    toggleSelected(): void;
    /** Expand every task (show all detail lines). */
    expandAll(): void;
    /** Collapse every task (headers only). */
    collapseAll(): void;
    private handlePipelineStarted;
    private handlePlanReady;
    private handleTaskStarted;
    private handleTaskCompleted;
    private handleAgentUpdate;
    private handleInspection;
    private handleShellStart;
    private handleShellEnd;
    private handleRecovery;
    private handleDelegationSpawn;
    private handleDelegationResult;
    private handleDelegationError;
    private hasRunning;
    /** Running delegations first; most-recent finished lanes after (capped). */
    private activeDelegations;
    /** Most-recent finished shells first; running ones pinned on top. */
    private activeShells;
    /** Remaining-time estimate from completed-task durations (avg × remaining). */
    private etaLabel;
    /** Plain-text final frame (TTY finish/freeze) — mirrors the ink layout. */
    buildFinalFrame(success: boolean | null): string[];
    private logLine;
}
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
export declare class PipelineEventStream {
    private stream;
    private bus?;
    private unsubs;
    private attached;
    constructor(opts?: {
        stream?: NodeJS.WriteStream;
        bus?: EventBus;
    });
    attach(): void;
    detach(): void;
    /** Spinner-compatible (no-op) — pipelines can pass this as `spinner`. */
    stop(): void;
    /** Spinner-compatible (no-op) — pipelines can pass this as `spinner`. */
    start(_text?: string): void;
    /** Emit the terminal event and detach. */
    finish(success: boolean): void;
    private write;
}
export {};
//# sourceMappingURL=pipeline-board.d.ts.map