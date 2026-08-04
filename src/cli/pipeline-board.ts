/**
 * PipelineBoard — Live terminal view of the multi-agent pipeline.
 *
 * Turns the pipeline from a black box into a board the user can follow —
 * inspired by how Freebuff renders agent activity:
 *
 * ```
 * ⚡ Add JWT authentication to the Express app            [0:42]
 *    📂 Project type: Node.js · 42 source files · 8 tests found
 *    2/5 steps · 2 running in parallel · 40%
 *    ✓  📋 planner           — Created 4 task steps
 *    ✓  📂 context-gatherer  — Gathered 6 files
 *    ◐  ✏️ writer            — Drafting JWT middleware…
 *      │  💭 Generating code changes…
 *      │  💭 Proposing changes to 2 file(s): auth.ts, routes/auth.ts
 *    ⏳  👁️ reviewer
 *    ⏳  🧪 tester
 * ```
 *
 * Behavior:
 * - **Hierarchical tree guides** show nested activity under the running agent
 *   (like Freebuff's collapsible blocks): "thinking" updates ACCUMULATE per
 *   task instead of being overwritten, finished agents collapse to a one-line
 *   summary, and running agents show their live thought trail.
 * - **TTY mode:** the board re-draws in place on every update and animates a
 *   rotating "working" indicator while any agent is running.
 * - **Non-TTY / piped mode:** falls back to plain sequential log lines so CI
 *   and scripted runs still get readable output.
 * - Implements the orchestrator's `spinner` interface (`stop()` / `start()`)
 *   so rate-limit prompts and other interactive dialogs can pause the board.
 *
 * The board subscribes to the shared EventBus, so the SAME event stream also
 * keeps the web dashboard DAG alive — one source of truth, two surfaces.
 */

import { getEventBus, EventNames } from '../observability/event-bus.js';
import type { EventBus, EventRecord } from '../observability/event-bus.js';
import { getModuleRegistry } from '../agents/module-registry.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

interface BoardTask {
  id: string;
  agentType: string;
  description: string;
  status: TaskStatus;
  summary?: string;
  /** Accumulated "thinking" trail — shown as nested tree-guide lines. */
  updates: string[];
}

/** Node info from the plan-ready event (mirrors the DAG node shape). */
export interface PlanNodeInfo {
  id: string;
  agentType: string;
  description: string;
  complexity?: string;
}

const DONE_STATUS: TaskStatus[] = ['completed', 'failed', 'skipped'];

/** Rotating "working" indicator frames (TTY animation). */
const WORK_FRAMES = ['◐', '◓', '◑', '◒'];

/** Max thinking lines shown per running task; older lines are summarized. */
const MAX_THINKING_LINES = 4;

// ─── PipelineBoard ──────────────────────────────────────────────────────────

export class PipelineBoard {
  private goal = '';
  private tasks = new Map<string, BoardTask>();
  private order: string[] = [];
  /** Deterministic pre-flight inspection lines shown under the header. */
  private notes: string[] = [];
  /** Live "thinking" line for agents without a task step (e.g. the planner). */
  private activity = '';
  private paused = false;
  private started = false;
  private done = false;
  private tty: boolean;
  private stream: NodeJS.WriteStream;
  private lastHeight = 0;
  private attached = false;
  private unsubs: Array<() => void> = [];
  private bus?: EventBus;
  private startedAt = 0;
  private workFrame = 0;
  private workTimer: ReturnType<typeof setInterval> | null = null;
  /** Task ids the user has collapsed (only the header line is shown). */
  private collapsed = new Set<string>();
  /** Currently selected task index (keyboard navigation). */
  private selected = 0;
  private keyActive = false;
  private keyHandler: ((chunk: Buffer) => void) | null = null;
  /** Whether we resumed stdin for keyboard control (must pause it on exit). */
  private stdinResumed = false;
  private static registryIcons: Map<string, string> | null = null;

  constructor(opts?: { tty?: boolean; stream?: NodeJS.WriteStream; bus?: EventBus }) {
    this.stream = opts?.stream ?? process.stdout;
    this.tty = opts?.tty ?? (this.stream.isTTY === true);
    this.bus = opts?.bus;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Subscribe to orchestrator events. Safe to call multiple times. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const bus = this.bus ?? getEventBus();
    this.unsubs.push(
      bus.on(EventNames.ORCHESTRATOR_PIPELINE_STARTED, (r) => this.handlePipelineStarted(r)),
      bus.on(EventNames.ORCHESTRATOR_PLAN_READY, (r) => this.handlePlanReady(r)),
      bus.on(EventNames.ORCHESTRATOR_TASK_STARTED, (r) => this.handleTaskStarted(r)),
      bus.on(EventNames.ORCHESTRATOR_TASK_COMPLETED, (r) => this.handleTaskCompleted(r)),
      bus.on(EventNames.ORCHESTRATOR_AGENT_UPDATE, (r) => this.handleAgentUpdate(r)),
      bus.on(EventNames.ORCHESTRATOR_INSPECTION, (r) => this.handleInspection(r)),
    );
  }

  /** Unsubscribe from orchestrator events (called automatically by finish()). */
  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.attached = false;
    this.stopWorkTimer();
  }

  /**
   * Begin showing the board for a goal (first call), and re-render it on
   * subsequent calls. Also implements the orchestrator's spinner interface so
   * `start(text)` after a `stop()` resumes the live view with an activity line.
   */
  start(text?: string): void {
    const isFirst = !this.started;
    if (isFirst) {
      this.goal = text || '';
      this.startedAt = Date.now();
      this.attach();
      this.started = true;
    }
    this.paused = false;
    this.done = false;
    if (text && !isFirst) this.activity = text;
    this.render();
    this.ensureWorkTimer();
    this.startKeyboard();
  }

  /** Spinner-compatible: freeze the board so prompts/logs print cleanly below. */
  stop(): void {
    this.paused = true;
    this.stopWorkTimer();
    this.stopKeyboard();
    if (this.tty && this.lastHeight > 0) {
      this.clearBlock();
      this.lastHeight = 0;
    }
  }

  /**
   * Finalize the board. In TTY mode the final static frame is left on screen;
   * in non-TTY (piped/CI) mode only a one-line summary is printed because the
   * discrete event lines already told the whole story. Then detaches from the
   * event bus so repeated runs (chat dev-mode) never leak handlers.
   */
  finish(success: boolean): void {
    if (!this.started || this.done) {
      this.detach();
      return;
    }
    this.done = true;
    this.stopWorkTimer();
    this.stopKeyboard();
    this.releaseStdin();
    if (this.tty) {
      this.clearBlock();
      const lines = this.buildLines();
      lines.push(success ? '✅ Pipeline completed' : '❌ Pipeline completed with failures');
      this.stream.write(lines.join('\n') + '\n');
    } else {
      this.logLine(success ? '✅ Pipeline completed' : '❌ Pipeline completed with failures');
    }
    this.lastHeight = 0;
    this.detach();
  }

  /**
   * Freeze the board: stop live updates and keyboard control, and leave the
   * current frame on screen. The pipeline keeps running — the user just stops
   * watching the live view (pressed `q`).
   */
  freeze(): void {
    if (!this.started || this.done) return;
    this.stopWorkTimer();
    this.stopKeyboard();
    this.releaseStdin();
    this.paused = true;
    if (this.tty) {
      this.clearBlock();
      const lines = this.buildLines();
      this.stream.write(lines.join('\n') + '\n');
    }
    this.lastHeight = 0;
  }

  // ── Keyboard navigation (Freebuff-style collapse/expand) ──────────────

  /** Move the selection cursor down. */
  selectNext(): void {
    if (this.order.length === 0) return;
    this.selected = Math.min(this.order.length - 1, this.selected + 1);
    this.render();
  }

  /** Move the selection cursor up. */
  selectPrev(): void {
    if (this.order.length === 0) return;
    this.selected = Math.max(0, this.selected - 1);
    this.render();
  }

  /** Toggle the collapse state of the currently selected task. */
  toggleSelected(): void {
    const id = this.order[this.selected];
    if (!id) return;
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    this.render();
  }

  /** Expand every task (show all detail lines). */
  expandAll(): void {
    this.collapsed.clear();
    this.render();
  }

  /** Collapse every task (headers only). */
  collapseAll(): void {
    for (const id of this.order) this.collapsed.add(id);
    this.render();
  }

  /** Enable raw-mode key handling (TTY only). */
  private startKeyboard(): void {
    if (!this.tty || this.keyActive || this.done || !process.stdin.isTTY) return;
    this.keyActive = true;
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      this.stdinResumed = true;
    } catch {
      this.keyActive = false;
      return;
    }
    let esc = 0; // 0 = idle, 1 = saw \x1b, 2 = saw \x1b[, 3 = saw \x1bO (SS3)
    this.keyHandler = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (esc === 0) {
          if (byte === 0x1b) { esc = 1; continue; }
          if (byte === 0x03) { this.freeze(); continue; } // Ctrl+C
          const ch = String.fromCharCode(byte);
          if (ch === 'j' || ch === 'J') this.selectNext();
          else if (ch === 'k' || ch === 'K') this.selectPrev();
          else if (ch === ' ' || ch === '\r' || ch === '\n') this.toggleSelected();
          else if (ch === 'e' || ch === 'E') this.expandAll();
          else if (ch === 'h' || ch === 'H') this.collapseAll();
          else if (ch === 'q' || ch === 'Q') this.freeze();
          continue;
        }
        if (esc === 1) {
          esc = byte === 0x5b ? 2 : byte === 0x4f ? 3 : 0;
          continue;
        }
        // \x1b[A up, \x1b[B down, \x1bOA up, \x1bOB down
        if (byte === 0x41) this.selectPrev();
        else if (byte === 0x42) this.selectNext();
        esc = 0;
      }
    };
    process.stdin.on('data', this.keyHandler);
  }

  /** Disable raw-mode key handling (also restores normal stdin behavior). */
  private stopKeyboard(): void {
    if (!this.keyActive) return;
    this.keyActive = false;
    if (this.keyHandler) {
      process.stdin.off('data', this.keyHandler);
      this.keyHandler = null;
    }
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Best-effort — stdin may already be in normal mode.
    }
  }

  /**
   * Release stdin entirely. A resumed stdin keeps the Node event loop alive,
   * so after the board is permanently done (finish/freeze) it MUST be paused
   * or `buff execute` would hang after printing the result. Not called on a
   * transient stop() — inquirer needs stdin for rate-limit prompts.
   */
  private releaseStdin(): void {
    if (!this.stdinResumed) return;
    this.stdinResumed = false;
    try {
      process.stdin.pause();
    } catch {
      // Best-effort — stdin may not be resumable in every environment.
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  private handlePipelineStarted(record: EventRecord): void {
    const d = record.data as { goal?: string };
    if (d?.goal && !this.started) this.start(d.goal);
  }

  private handlePlanReady(record: EventRecord): void {
    const d = record.data as { nodes?: PlanNodeInfo[]; edges?: Array<{ from: string; to: string }> };
    const nodes = d?.nodes || [];
    for (const n of nodes) {
      if (!this.tasks.has(n.id)) {
        this.tasks.set(n.id, {
          id: n.id,
          agentType: n.agentType,
          description: n.description,
          status: 'pending',
          updates: [],
        });
        this.order.push(n.id);
      }
    }
    if (!this.tty) {
      this.logLine(`📋 Plan ready: ${nodes.length} step(s) — ${nodes.map((n) => n.agentType).join(', ')}`);
    }
    this.render();
    // No agent is executing yet — nothing to animate; the timer restarts on
    // the first task-started event.
    if (!this.hasRunning()) this.stopWorkTimer();
  }

  private handleTaskStarted(record: EventRecord): void {
    const d = record.data as { taskId: string; agentType: string; description: string };
    const existing = this.tasks.get(d.taskId);
    if (existing) {
      existing.status = 'running';
    } else {
      this.tasks.set(d.taskId, {
        id: d.taskId,
        agentType: d.agentType,
        description: d.description,
        status: 'running',
        updates: [],
      });
      this.order.push(d.taskId);
    }
    if (!this.tty) {
      this.logLine(`▶️  ${d.agentType}: ${d.description.slice(0, 80)}${d.description.length > 80 ? '…' : ''}`);
    }
    this.render();
    this.ensureWorkTimer();
  }

  private handleTaskCompleted(record: EventRecord): void {
    const d = record.data as { taskId: string; agentType: string; success: boolean; summary?: string };
    const task = this.tasks.get(d.taskId);
    if (task) {
      task.status = d.success ? 'completed' : 'failed';
      task.summary = d.summary;
    }
    if (!this.tty) {
      const icon = d.success ? '✅' : '❌';
      this.logLine(`   ${icon} ${d.agentType}: ${(d.summary || 'done').slice(0, 100)}`);
    }
    this.render();
    if (!this.hasRunning()) this.stopWorkTimer();
  }

  private handleAgentUpdate(record: EventRecord): void {
    const d = record.data as { agentType?: string; stage?: string; message?: string; taskId?: string };
    const msg = d.message || '';
    if (d.taskId && this.tasks.has(d.taskId)) {
      // Task-bound update → append to that agent's accumulated thinking trail
      // (rendered as tree-guide lines under the running agent).
      const task = this.tasks.get(d.taskId)!;
      if (msg && task.updates[task.updates.length - 1] !== msg) {
        task.updates.push(msg);
        // Cap the accumulated trail so the board stays bounded.
        if (task.updates.length > 20) task.updates.splice(0, task.updates.length - 20);
      }
    } else {
      // Untethered update (planner, routing decisions, orchestrator notes) →
      // shown as the single activity line.
      this.activity = msg;
    }
    if (!this.tty) {
      const tag = d.agentType === 'orchestrator' ? '⚡' : '💭';
      this.logLine(`   ${tag} ${d.agentType || 'Agent'} · ${d.stage || ''}: ${msg.slice(0, 130)}`);
    }
    this.render();
  }

  private handleInspection(record: EventRecord): void {
    const d = record.data as { lines?: string[] };
    const lines = d?.lines || [];
    this.notes.push(...lines);
    if (!this.tty) {
      for (const line of lines) this.logLine(`   📂 ${line}`);
    }
    this.render();
  }

  // ── Working animation ──────────────────────────────────────────────────

  private hasRunning(): boolean {
    return this.order.some((id) => this.tasks.get(id)!.status === 'running');
  }

  /** Rotate the working indicator (TTY only) so active agents feel alive. */
  private ensureWorkTimer(): void {
    if (!this.tty || this.done || this.workTimer) return;
    if (!this.hasRunning() && this.order.length > 0) return;
    this.workTimer = setInterval(() => {
      this.workFrame = (this.workFrame + 1) % WORK_FRAMES.length;
      if (!this.paused && !this.done && this.hasRunning()) {
        this.render();
      }
    }, 400);
  }

  private stopWorkTimer(): void {
    if (this.workTimer) {
      clearInterval(this.workTimer);
      this.workTimer = null;
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  private iconFor(agentType: string): string {
    if (!PipelineBoard.registryIcons) {
      try {
        PipelineBoard.registryIcons = new Map(
          getModuleRegistry().listModules().map((m) => [m.agentType, m.icon]),
        );
      } catch {
        PipelineBoard.registryIcons = new Map();
      }
    }
    return PipelineBoard.registryIcons.get(agentType) ?? '⚙️';
  }

  private elapsedLabel(): string {
    const s = Math.floor((Date.now() - this.startedAt) / 1000);
    const mm = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  private statusIndicator(status: TaskStatus): string {
    switch (status) {
      case 'running':
        return this.tty ? WORK_FRAMES[this.workFrame] : '●';
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

  private buildLines(): string[] {
    const lines: string[] = [];
    const total = this.order.length;
    const finished = this.order.filter((id) => DONE_STATUS.includes(this.tasks.get(id)!.status)).length;
    const running = this.order.filter((id) => this.tasks.get(id)!.status === 'running').length;

    lines.push(`⚡ ${this.goal.slice(0, 72)}${this.goal.length > 72 ? '…' : ''}${this.tty ? `   [${this.elapsedLabel()}]` : ''}`);
    if (total > 0) {
      const pct = Math.round((finished / total) * 100);
      const parallelHint = running > 1 ? ` · ${running} running in parallel` : '';
      lines.push(`   ${finished}/${total} steps${running > 0 ? ` · ${running} running` : ''}${parallelHint} · ${pct}%`);
    }
    for (const note of this.notes.slice(-4)) {
      lines.push(`   ${note}`);
    }

    // Per-task branch lines — finished agents collapse to a summary (Freebuff-style).
    for (let idx = 0; idx < this.order.length; idx++) {
      const id = this.order[idx];
      const t = this.tasks.get(id)!;
      const icon = this.iconFor(t.agentType);
      const name = `${icon} ${t.agentType}`;
      const label = this.statusIndicator(t.status);
      const isSelected = idx === this.selected;
      // One-column selection marker when keyboard navigation is live.
      const selector = isSelected ? '▸' : ' ';
      const header = `  ${selector} ${label}  ${name.padEnd(22)} ${t.description.slice(0, 46)}${t.description.length > 46 ? '…' : ''}`;
      const isCollapsed = this.collapsed.has(id);

      if (t.status === 'running') {
        lines.push(header);
        if (isCollapsed) {
          lines.push('      │  (collapsed — press space to expand)');
        } else {
          // Accumulated thought trail with tree guides (like Freebuff's expanded block).
          const show = t.updates.slice(-MAX_THINKING_LINES);
          const hidden = t.updates.length - show.length;
          if (hidden > 0) lines.push(`      │  ··· +${hidden} earlier step(s)`);
          for (const u of show) {
            const trimmed = u.replace(/\s+/g, ' ').slice(0, 80);
            lines.push(`      │  💭 ${trimmed}`);
          }
          lines.push('      │  ● working…');
        }
      } else if (t.status === 'completed' || t.status === 'failed') {
        const summary = !isCollapsed ? (t.summary || '').replace(/\s+/g, ' ').slice(0, 60) : '';
        lines.push(`${header}${summary ? ` — ${summary}` : ''}`);
      } else {
        lines.push(header);
      }
    }

    if (this.activity && (total === 0 || running > 0)) {
      lines.push(`   💭 ${this.activity.slice(0, 110)}`);
    }
    // Keymap hint (hidden in the final static frame).
    if (this.tty && total > 0 && !this.done && !this.paused) {
      lines.push('   [j/k select · space toggle · e expand all · h collapse all · q freeze]');
    }
    return lines;
  }

  /**
   * Erase the previously-rendered block from the terminal.
   *
   * Cursor trace (block of n lines, cursor currently below it at line L+n):
   * 1. `\x1b[${n}A`  → move up to line L
   * 2. `\x1b[2K`      → clear line L
   * 3. `('\n' + clear).repeat(n - 1)` → clear lines L+1 … L+n-1
   * 4. `\x1b[${n-1}A` → move back UP to line L (NOT `n` — after step 3 the
   *    cursor sits on the LAST cleared line, so `n-1` is the correct return)
   */
  private clearBlock(): void {
    if (!this.tty || this.lastHeight <= 0) return;
    const n = this.lastHeight;
    const up = `\x1b[${n}A`;
    const clear = '\x1b[2K';
    const back = `\x1b[${Math.max(0, n - 1)}A`;
    this.stream.write(up + clear + ('\n' + clear).repeat(n - 1) + back);
  }

  private render(): void {
    if (!this.started || this.paused || this.done || !this.tty) return;
    const lines = this.buildLines();
    if (lines.length === 0) return;
    this.clearBlock();
    this.stream.write(lines.join('\n') + '\n');
    this.lastHeight = lines.length;
  }

  private logLine(text: string): void {
    this.stream.write(text + '\n');
  }
}

// ─── PipelineEventStream (machine-readable NDJSON activity stream) ──────────

/**
 * PipelineEventStream — Machine-readable counterpart of PipelineBoard.
 *
 * Consumes the SAME orchestrator event stream and emits one NDJSON line per
 * event, so any external consumer (CI, scripts, the VS Code extension panel,
 * a webhook) can render the same live activity the terminal board shows:
 *
 * ```
 * {"type":"pipeline-started","goal":"..."}
 * {"type":"inspection","lines":["Project type: Node.js","..."]}
 * {"type":"plan-ready","nodes":[...],"edges":[...]}
 * {"type":"task-started","taskId":"s1","agentType":"writer","description":"..."}
 * {"type":"agent-update","agentType":"Writer","stage":"drafting","message":"..."}
 * {"type":"task-completed","taskId":"s1","success":true,"summary":"..."}
 * {"type":"pipeline-completed","success":true}
 * ```
 *
 * Implements the orchestrator spinner interface (`stop()`/`start()` are no-ops)
 * and is API-compatible with PipelineBoard so the CLI can swap them.
 */
export class PipelineEventStream {
  private stream: NodeJS.WriteStream;
  private bus?: EventBus;
  private unsubs: Array<() => void> = [];
  private attached = false;

  constructor(opts?: { stream?: NodeJS.WriteStream; bus?: EventBus }) {
    this.stream = opts?.stream ?? process.stdout;
    this.bus = opts?.bus;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const bus = this.bus ?? getEventBus();
    this.unsubs.push(
      bus.on(EventNames.ORCHESTRATOR_PIPELINE_STARTED, (r) => this.write('pipeline-started', r.data)),
      bus.on(EventNames.ORCHESTRATOR_INSPECTION, (r) => this.write('inspection', r.data)),
      bus.on(EventNames.ORCHESTRATOR_PLAN_READY, (r) => this.write('plan-ready', r.data)),
      bus.on(EventNames.ORCHESTRATOR_TASK_STARTED, (r) => this.write('task-started', r.data)),
      bus.on(EventNames.ORCHESTRATOR_AGENT_UPDATE, (r) => this.write('agent-update', r.data)),
      bus.on(EventNames.ORCHESTRATOR_TASK_COMPLETED, (r) => this.write('task-completed', r.data)),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.attached = false;
  }

  /** Spinner-compatible (no-op) — pipelines can pass this as `spinner`. */
  stop(): void {
    /* no-op */
  }

  /** Spinner-compatible (no-op) — pipelines can pass this as `spinner`. */
  start(_text?: string): void {
    this.attach();
  }

  /** Emit the terminal event and detach. */
  finish(success: boolean): void {
    if (!this.attached) return;
    this.write('pipeline-completed', { success });
    this.detach();
  }

  private write(type: string, data: unknown): void {
    const payload = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    this.stream.write(JSON.stringify({ type, ...payload, ts: Date.now() }) + '\n');
  }
}
