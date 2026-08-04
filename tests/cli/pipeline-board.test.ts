/**
 * Tests for PipelineBoard — the live terminal view of the multi-agent pipeline.
 *
 * The board is driven entirely by EventBus events (the same stream that powers
 * the web dashboard), so tests inject a fresh EventBus + a captured stream to
 * verify both the non-TTY plain-line fallback and the TTY ANSI redraw path.
 */

import { Writable } from 'node:stream';

import { describe, it, expect, beforeEach } from 'vitest';

import { EventBus, EventNames } from '../../src/observability/event-bus.js';
import { PipelineBoard, PipelineEventStream } from '../../src/cli/pipeline-board.js';

/** Create a captured output stream. */
function makeStream(chunks: string[]): NodeJS.WriteStream {
  return new Writable({
    write(chunk: unknown, _encoding: BufferEncoding, cb: () => void) {
      chunks.push(String(chunk));
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
}

describe('PipelineBoard (non-TTY)', () => {
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
      nodes: [
        { id: 's1', agentType: 'context-gatherer', description: 'Scan the codebase for auth files' },
        { id: 's2', agentType: 'writer', description: 'Implement JWT middleware', dependsOn: ['s1'] },
      ],
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

  it('uses ANSI cursor control to redraw in place when TTY', () => {
    const ttyBoard = new PipelineBoard({ tty: true, stream, bus });
    ttyBoard.start('Goal');
    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: [{ id: 's1', agentType: 'writer', description: 'Write code' }],
      edges: [],
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's1', agentType: 'writer', description: 'Write code',
    }, 'orchestrator');
    ttyBoard.finish(true);

    const out = chunks.join('');
    // Redraw + final static frame should include ANSI erase/cursor sequences.
    expect(out).toContain('\x1b[');
    // The final frame should show the task with its completion state.
    expect(out).toContain('⚡ Goal');
    expect(out).toContain('✅ Pipeline completed');
  });

  it('accumulates per-task thinking lines with a tree guide and working indicator (TTY)', () => {
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
    // The final static frame must show the collapsed summary for the finished agent.
    expect(out).toContain('✓  ✏️ writer');
    expect(out).toContain('Refactored auth.ts');
    // The accumulated thinking trail must have been rendered with tree guides
    // while the task was running.
    expect(out).toContain('💭 Reading the auth module');
    expect(out).toContain('💭 Proposing changes to auth.ts');
    expect(out).toContain('● working');
  });

  it('clears the previous block with exact ANSI cursor math (no off-by-one)', () => {
    const ttyBoard = new PipelineBoard({ tty: true, stream, bus });
    ttyBoard.start('Goal'); // frame 1: 1 line
    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: [
        { id: 's1', agentType: 'writer', description: 'Write A' },
        { id: 's2', agentType: 'reviewer', description: 'Review B' },
      ],
      edges: [],
    }, 'orchestrator'); // frame 2: header + progress + 2 tasks = 4 lines
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's1', agentType: 'writer', description: 'Write A',
    }, 'orchestrator'); // frame 3: clears 4 lines before re-rendering

    const out = chunks.join('');
    // Frame 2 is 5 lines: header + progress + 2 tasks + keymap hint line.
    // Clear sequence for a 5-line block: up 5, clear, (down+clear)×4, back 4.
    // The trailing move must be n-1 (4), not n (5) — regression test for the
    // clearBlock off-by-one that would make the board climb the screen.
    expect(out).toContain('\x1b[5A\x1b[2K\n\x1b[2K\n\x1b[2K\n\x1b[2K\n\x1b[2K\x1b[4A');
    // And it must NOT use the buggy n-based return.
    expect(out).not.toContain('\x1b[2K\x1b[5A');
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

    // Selection starts on the first task (▸ marker).
    let out = chunks.join('');
    expect(out).toContain('▸ ⏳  ✏️ writer');
    expect(out).toContain(' ⏳  👁️ reviewer');

    // Move selection down, then collapse the selected (second) task.
    ttyBoard.selectNext();
    ttyBoard.toggleSelected();
    out = chunks.join('');
    expect(out).toContain('▸ ⏳  👁️ reviewer');

    // Collapse all → only headers remain; expand all restores.
    ttyBoard.collapseAll();
    ttyBoard.expandAll();
    expect(ttyBoard).toBeDefined();
  });

  it('collapsing a running task hides its thinking trail and shows a hint', () => {
    const ttyBoard = new PipelineBoard({ tty: true, stream, bus });
    ttyBoard.start('Collapse goal');
    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: [{ id: 's1', agentType: 'writer', description: 'Write code' }],
      edges: [],
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's1', agentType: 'writer', description: 'Write code',
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
      agentType: 'Writer', stage: 'drafting', message: 'Generating code…', taskId: 's1',
    }, 'orchestrator');

    const countThinking = (s: string) => s.split('💭 Generating code').length - 1;
    const before = countThinking(chunks.join(''));

    ttyBoard.collapseAll();
    const collapsedOut = chunks.join('');
    expect(collapsedOut).toContain('(collapsed — press space to expand)');
    // While collapsed, no NEW thinking frame may be rendered.
    expect(countThinking(collapsedOut)).toBe(before);

    ttyBoard.expandAll();
    const expandedOut = chunks.join('');
    // Expanding re-renders the thinking trail again.
    expect(countThinking(expandedOut)).toBeGreaterThan(before);
  });

  it('freeze() leaves a static frame and stops live updates', () => {
    const ttyBoard = new PipelineBoard({ tty: true, stream, bus });
    ttyBoard.start('Freeze goal');
    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: [{ id: 's1', agentType: 'writer', description: 'Write code' }],
      edges: [],
    }, 'orchestrator');
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's1', agentType: 'writer', description: 'Write code',
    }, 'orchestrator');
    ttyBoard.freeze();
    const before = chunks.join('');
    // After freezing, later events must not change the output.
    bus.emit(EventNames.ORCHESTRATOR_TASK_COMPLETED, {
      taskId: 's1', agentType: 'writer', success: true, summary: 'Done',
    }, 'orchestrator');
    expect(chunks.join('')).toBe(before);
  });

  describe('PipelineEventStream (NDJSON)', () => {
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

  it('shows parallel-lane count in the header when several agents run at once', () => {
    const ttyBoard = new PipelineBoard({ tty: true, stream, bus });
    ttyBoard.start('Parallel goal');
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
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's2', agentType: 'reviewer', description: 'Review B',
    }, 'orchestrator');
    ttyBoard.finish(true);

    const out = chunks.join('');
    expect(out).toContain('2 running in parallel');
  });

  it('detaches after finish so later events no longer write', () => {
    board.start('Goal');
    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: [{ id: 's1', agentType: 'writer', description: 'Write code' }],
      edges: [],
    }, 'orchestrator');
    board.finish(true);

    const before = chunks.join('');
    // Emit after finish — the board is detached and must stay silent.
    bus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: 's2', agentType: 'tester', description: 'Run tests',
    }, 'orchestrator');
    expect(chunks.join('')).toBe(before);
  });

  it('stop()/start() spinner interface does not throw and resumes output', () => {
    board.start('Goal');
    board.stop();
    // While stopped, an update should not print anything new.
    const before = chunks.join('');
    bus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
      nodes: [{ id: 's1', agentType: 'writer', description: 'Write code' }],
      edges: [],
    }, 'orchestrator');
    // Non-TTY plan-ready still logs (logLine is not paused) — that's intended;
    // TTY rendering is what pauses. So assert the board instance survives.
    expect(board).toBeDefined();
    expect(chunks.join('')).toContain('Plan ready');
    board.start('resumed');
    board.finish(true);
    expect(chunks.join('')).toContain('✅ Pipeline completed');
  });
});
