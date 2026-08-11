/**
 * Tests for PipelineBoard (ink v2) — the live terminal view of the pipeline.
 *
 * Two surfaces are tested:
 * 1. **Non-TTY log lines** — the class driven by EventBus events with a
 *    captured stream (plain sequential lines; CI-safe).
 * 2. **Ink TUI frames** — `<BoardView>` rendered via ink-testing-library;
 *    emitting events drives event→lane mapping (task lanes, shell lanes,
 *    retry lanes, ETA, parallel progress) and the keyboard API.
 *
 * Plus the machine-readable `PipelineEventStream` NDJSON contract.
 */

import { Writable } from 'node:stream';

import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';

import { EventBus, EventNames } from '../../src/observability/event-bus.js';
import { PipelineBoard, PipelineEventStream, BoardView } from '../../src/cli/pipeline-board.js';

/** Create a captured output stream. */
function makeStream(chunks: string[]): NodeJS.WriteStream {
  return new Writable({
    write(chunk: unknown, _encoding: BufferEncoding, cb: () => void) {
      chunks.push(String(chunk));
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
}

/** Let the ink reconciler commit a frame after a synchronous event emit. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

const PLAN_NODES = [
  { id: 's1', agentType: 'context-gatherer', description: 'Scan the codebase for auth files' },
  { id: 's2', agentType: 'writer', description: 'Implement JWT middleware', dependsOn: ['s1'] },
];

describe('PipelineBoard (non-TTY log lines)', () => {
  let bus: EventBus;
  let chunks: string[];
  let stream: NodeJS.WriteStream;
  let board: PipelineBoard;

  beforeEach(() => {
    bus = new EventBus();
    chunks = [];
    stream = makeStream(chunks);
    board = new PipelineBoard({ tty: false, stream, bus });
  });

  it('renders inspection, plan, task, thinking, and completion lines in order', () => {
    board.start('Add JWT auth');

    bus.emit(EventNames.ORCHESTRATOR_INSPECTION, {
      lines: ['Project type: Node.js', '42 source files · 8 test files found'],
    }, 'orchestrator');

    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: PLAN_NODES,
      edges: [{ from: 's1', to: 's2' }],
    }, 'orchestrator');

    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's1', agentType: 'context-gatherer', description: 'Scan the codebase for auth files',
    }, 'orchestrator');

    bus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
      agentType: 'Context Gatherer', stage: 'scanning', message: 'Scanning the project…',
    }, 'orchestrator');

    bus.emit(EventNames.ORCHESTRATOR_TASK_COMPLETED, {
      taskId: 's1', agentType: 'context-gatherer', success: true, summary: 'Gathered 6 files',
    }, 'orchestrator');

    board.finish(true);

    const out = chunks.join('');
    expect(out).toContain('Project type: Node.js');
    expect(out).toContain('42 source files · 8 test files found');
    expect(out).toContain('📋 Plan ready: 2 step(s)');
    expect(out).toContain('▶️  context-gatherer: Scan the codebase for auth files');
    expect(out).toContain('💭 Context Gatherer · scanning: Scanning the project…');
    expect(out).toContain('✅ context-gatherer: Gathered 6 files');
    expect(out).toContain('✅ Pipeline completed');
  });

  it('logs shell lanes (E1) and recovery lanes (E2) as plain lines', () => {
    board.start('Goal');

    bus.emit(EventNames.EXEC_SHELL_START, { command: 'npm test', cwd: '/repo' }, 'shell');
    bus.emit(EventNames.EXEC_SHELL_END, {
      command: 'npm test', cwd: '/repo', exitCode: 0, success: true, durationMs: 1200,
    }, 'shell');

    bus.emit(EventNames.RECOVER_CLASSIFIED, { taskId: 's1', category: 'test-failure' }, 'recover-module');
    bus.emit(EventNames.RECOVER_ATTEMPT, { taskId: 's1', attempt: 2, strategy: 'switch-model' }, 'recover-module');
    bus.emit(EventNames.RECOVER_RESULT, { taskId: 's1', success: true, attempts: 2 }, 'recover-module');

    const out = chunks.join('');
    expect(out).toContain('💻 $ npm test');
    expect(out).toContain('✅ $ npm test (exit 0, 1200ms)');
    expect(out).toContain('🔧 Error classified: test-failure');
    expect(out).toContain('🔧 Repair attempt 2: switch-model');
    expect(out).toContain('🔧 Repair succeeded');
  });

  it('leaves a TTY final static frame with lane summaries and the completion line', () => {
    const ttyBoard = new PipelineBoard({ tty: true, stream, bus });
    ttyBoard.start('Refactor auth');
    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: [{ id: 's1', agentType: 'writer', description: 'Refactor the auth module' }],
      edges: [],
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's1', agentType: 'writer', description: 'Refactor the auth module',
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
      agentType: 'Writer', stage: 'thinking', message: 'Reading the auth module…', taskId: 's1',
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
      agentType: 'Writer', stage: 'decided', message: 'Proposing changes to auth.ts', taskId: 's1',
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_TASK_COMPLETED, {
      taskId: 's1', agentType: 'writer', success: true, summary: 'Refactored auth.ts',
    }, 'orchestrator');
    ttyBoard.finish(true);

    const out = chunks.join('');
    // The final static frame shows the completed lane collapsed to a summary
    // (the accumulated trail is a live-view artifact — covered by the ink TUI
    // event→lane mapping tests).
    expect(out).toContain('✓  ✏️ writer');
    expect(out).toContain('Refactored auth.ts');
    expect(out).toContain('1/1 steps · 100%');
    expect(out).toContain('✅ Pipeline completed');
  });

  it('moves a selection cursor and collapses/expands tasks (keyboard nav API)', () => {
    const ttyBoard = new PipelineBoard({ tty: true, stream, bus });
    ttyBoard.start('Nav goal');
    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: [
        { id: 's1', agentType: 'writer', description: 'Write A' },
        { id: 's2', agentType: 'reviewer', description: 'Review B' },
      ],
      edges: [],
    }, 'orchestrator');

    ttyBoard.selectNext();
    ttyBoard.toggleSelected();
    ttyBoard.collapseAll();
    ttyBoard.expandAll();
    const frame = ttyBoard.buildFinalFrame(null).join('\n');
    expect(frame).toContain('writer');
    expect(frame).toContain('reviewer');
  });

  it('stop()/start() spinner interface does not throw and resumes output', () => {
    board.start('Goal');
    board.stop();
    // Non-TTY log lines continue (logLine is not paused) — the spinner pause
    // only freezes TTY live rendering.
    const before = chunks.join('');
    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: [{ id: 's1', agentType: 'writer', description: 'Write code' }],
      edges: [],
    }, 'orchestrator');
    expect(chunks.join('')).toContain('Plan ready');
    expect(board.isActive()).toBe(false);
    void before;
    board.start('resumed');
    expect(board.isActive()).toBe(true);
    board.finish(true);
    expect(chunks.join('')).toContain('✅ Pipeline completed');
  });

  it('freeze() stops the live TTY view and later events do not write', async () => {
    const ttyBoard = new PipelineBoard({ tty: true, stream, bus });
    ttyBoard.start('Freeze goal');
    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: [{ id: 's1', agentType: 'writer', description: 'Write code' }],
      edges: [],
    }, 'orchestrator');
    await flush();
    ttyBoard.freeze();
    expect(ttyBoard.isActive()).toBe(false);
    const before = chunks.join('');
    // The static frame was left on screen.
    expect(before).toContain('⚡ Freeze goal');
    // After freezing, later events must not add any output.
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's2', agentType: 'tester', description: 'Run tests',
    }, 'orchestrator');
    await flush();
    expect(chunks.join('')).toBe(before);
  });

  it('detaches after finish so later events no longer write', () => {
    board.start('Goal');
    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: [{ id: 's1', agentType: 'writer', description: 'Write code' }],
      edges: [],
    }, 'orchestrator');
    board.finish(true);

    const before = chunks.join('');
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's2', agentType: 'tester', description: 'Run tests',
    }, 'orchestrator');
    expect(chunks.join('')).toBe(before);
  });
});

describe('PipelineBoard (ink TUI — event→lane mapping)', () => {
  let bus: EventBus;
  let chunks: string[];
  let stream: NodeJS.WriteStream;

  beforeEach(() => {
    bus = new EventBus();
    chunks = [];
    stream = makeStream(chunks);
  });

  it('maps orchestrator events to parallel task lanes with progress', async () => {
    const board = new PipelineBoard({ tty: false, stream, bus });
    board.start('Add JWT auth');
    const { lastFrame, unmount } = render(<BoardView board={board} />);

    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, { nodes: PLAN_NODES, edges: [{ from: 's1', to: 's2' }] }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's1', agentType: 'context-gatherer', description: 'Scan the codebase for auth files',
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's2', agentType: 'writer', description: 'Implement JWT middleware',
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
      agentType: 'Writer', stage: 'drafting', message: 'Generating code…', taskId: 's2',
    }, 'orchestrator');
    await flush();

    const frame = lastFrame();
    expect(frame).toContain('⚡ Add JWT auth');
    expect(frame).toContain('context-gatherer');
    expect(frame).toContain('writer');
    expect(frame).toContain('2 running in parallel');
    expect(frame).toContain('💭 Generating code…');
    expect(frame).toContain('● working…');

    bus.emit(EventNames.ORCHESTRATOR_TASK_COMPLETED, {
      taskId: 's1', agentType: 'context-gatherer', success: true, summary: 'Gathered 6 files',
    }, 'orchestrator');
    await flush();
    expect(lastFrame()).toContain('Gathered 6 files');
    expect(lastFrame()).toContain('1/2 steps');
    unmount();
  });

  it('renders shell lanes and inline recovery lanes from events', async () => {
    const board = new PipelineBoard({ tty: false, stream, bus });
    board.start('Run goal');
    const { lastFrame, unmount } = render(<BoardView board={board} />);

    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: [{ id: 's1', agentType: 'writer', description: 'Write code' }],
      edges: [],
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's1', agentType: 'writer', description: 'Write code',
    }, 'orchestrator');

    bus.emit(EventNames.EXEC_SHELL_START, { command: 'npm test', cwd: '/repo' }, 'shell');
    await flush();
    expect(lastFrame()).toContain('$ npm test');

    bus.emit(EventNames.EXEC_SHELL_END, {
      command: 'npm test', cwd: '/repo', exitCode: 0, success: true, durationMs: 1200,
    }, 'shell');
    bus.emit(EventNames.RECOVER_CLASSIFIED, { taskId: 's1', category: 'test-failure' }, 'recover-module');
    bus.emit(EventNames.RECOVER_ATTEMPT, { taskId: 's1', attempt: 2, strategy: 'switch-model' }, 'recover-module');
    await flush();

    const frame = lastFrame();
    expect(frame).toContain('Error classified: test-failure');
    expect(frame).toContain('Repair attempt 2: switch-model');
    // The recovery lanes attach inline to the task lane (tree-guide retry marks).
    expect(frame).toContain('↻');
    unmount();
  });

  it('shows an ETA estimate once a task completes', async () => {
    const board = new PipelineBoard({ tty: false, stream, bus });
    board.start('ETA goal');
    const { lastFrame, unmount } = render(<BoardView board={board} />);

    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, { nodes: PLAN_NODES, edges: [] }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's1', agentType: 'context-gatherer', description: 'Scan',
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_TASK_COMPLETED, {
      taskId: 's1', agentType: 'context-gatherer', success: true, summary: 'Done',
    }, 'orchestrator');
    await flush();

    expect(lastFrame()).toContain('ETA');
    unmount();
  });

  it('keyboard API moves the selection cursor and collapse hides the trail', async () => {
    const board = new PipelineBoard({ tty: false, stream, bus });
    board.start('Nav goal');
    const { lastFrame, unmount } = render(<BoardView board={board} />);

    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: [
        { id: 's1', agentType: 'writer', description: 'Write A' },
        { id: 's2', agentType: 'reviewer', description: 'Review B' },
      ],
      edges: [],
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's1', agentType: 'writer', description: 'Write A',
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
      agentType: 'Writer', stage: 'drafting', message: 'Generating code…', taskId: 's1',
    }, 'orchestrator');
    await flush();

    expect(lastFrame()).toContain('💭 Generating code…');

    board.selectNext();
    await flush();
    expect(lastFrame()).toContain('▸ ⏳');
    expect(lastFrame()).toContain('Review B');

    board.toggleSelected();
    board.collapseAll();
    await flush();
    expect(lastFrame()).toContain('(collapsed — press space to expand)');

    board.expandAll();
    await flush();
    expect(lastFrame()).toContain('💭 Generating code…');
    unmount();
  });
});

describe('PipelineEventStream (NDJSON)', () => {
  let bus: EventBus;
  let chunks: string[];
  let stream: NodeJS.WriteStream;

  beforeEach(() => {
    bus = new EventBus();
    chunks = [];
    stream = makeStream(chunks);
  });

  it('emits one NDJSON line per pipeline event and finishes with pipeline-completed', () => {
    const sink = new PipelineEventStream({ stream, bus });
    sink.start('goal');
    bus.emit(EventNames.ORCHESTRATOR_PIPELINE_STARTED, { goal: 'Add auth' }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_INSPECTION, { lines: ['Project type: Node.js'] }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: [{ id: 's1', agentType: 'writer', description: 'Write code' }],
      edges: [],
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's1', agentType: 'writer', description: 'Write code',
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
      agentType: 'Writer', stage: 'drafting', message: 'Generating…', taskId: 's1',
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_TASK_COMPLETED, {
      taskId: 's1', agentType: 'writer', success: true, summary: 'Done',
    }, 'orchestrator');
    sink.finish(true);

    const lines = chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual([
      'pipeline-started',
      'inspection',
      'plan-ready',
      'task-started',
      'agent-update',
      'task-completed',
      'pipeline-completed',
    ]);
    expect(lines[1].lines).toEqual(['Project type: Node.js']);
    expect(lines[3].taskId).toBe('s1');
    expect(lines[4].agentType).toBe('Writer');
    expect(lines[5].success).toBe(true);
    expect(lines[6].success).toBe(true);
  });

  it('emits shell and recovery events as machine-readable lines (E1/E2 extension)', () => {
    const sink = new PipelineEventStream({ stream, bus });
    sink.start('goal');
    bus.emit(EventNames.EXEC_SHELL_START, { command: 'npm test', cwd: '/repo' }, 'shell');
    bus.emit(EventNames.EXEC_SHELL_END, {
      command: 'npm test', cwd: '/repo', exitCode: 0, success: true, durationMs: 1200,
    }, 'shell');
    bus.emit(EventNames.RECOVER_ATTEMPT, { taskId: 's1', attempt: 2, strategy: 'switch-model' }, 'recover-module');
    bus.emit(EventNames.RECOVER_RESULT, { taskId: 's1', success: true, attempts: 2 }, 'recover-module');
    sink.finish(true);

    const lines = chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual([
      'shell-start',
      'shell-end',
      'recover-attempt',
      'recover-result',
      'pipeline-completed',
    ]);
    expect(lines[0].command).toBe('npm test');
    expect(lines[1].exitCode).toBe(0);
    expect(lines[2].strategy).toBe('switch-model');
    expect(lines[3].success).toBe(true);
  });

  it('detaches after finish so later events are not emitted', () => {
    const sink = new PipelineEventStream({ stream, bus });
    sink.start('goal');
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's1', agentType: 'writer', description: 'Write',
    }, 'orchestrator');
    sink.finish(true);
    const before = chunks.join('');
    bus.emit(EventNames.ORCHESTRATOR_TASK_COMPLETED, {
      taskId: 's1', agentType: 'writer', success: true, summary: 'Done',
    }, 'orchestrator');
    expect(chunks.join('')).toBe(before);
  });
});
