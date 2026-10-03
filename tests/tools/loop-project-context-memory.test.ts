/**
 * Loop project context — the memory blocks the loop now injects (Phase 4).
 *
 * `buildLoopProjectContext` gained two sections this phase:
 *   - the cross-TURN working state (files touched, verification debt, reports),
 *     the same ledger the orchestrator already injected; and
 *   - the cross-SESSION session digest (what recent asks did), deterministic and
 *     explicitly advisory.
 *
 * These tests pin that both land in the block for a project that has them, and
 * that a pristine project adds NEITHER (no prompt weight for a clean workspace).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLoopProjectContext } from '../../src/tools/loop-project-context.js';
import { recordWorkingState } from '../../src/learning/working-state.js';
import { recordSessionTurn } from '../../src/learning/session-digest.js';

let memDir: string;
let workspace: string;
let prevMemDir: string | undefined;

beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), 'nuvira-lpc-mem-'));
  workspace = mkdtempSync(join(tmpdir(), 'nuvira-lpc-ws-'));
  // `looksLikeProject` needs one project marker.
  writeFileSync(join(workspace, 'package.json'), '{"name":"probe"}\n');
  prevMemDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = memDir;
});

afterEach(() => {
  if (prevMemDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = prevMemDir;
  rmSync(memDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe('buildLoopProjectContext — memory blocks', () => {
  it('adds nothing memory-shaped for a pristine project', async () => {
    const block = await buildLoopProjectContext(workspace);
    expect(block).toContain('## Project');
    expect(block).not.toContain('Working state');
    expect(block).not.toContain('Recent sessions');
  });

  it('injects the cross-turn working state', async () => {
    recordWorkingState(workspace, {
      filesTouched: ['script.js'],
      unverifiedEdit: true,
      userMessage: 'still broken',
    });
    const block = await buildLoopProjectContext(workspace);
    expect(block).toContain('Working state');
    expect(block).toContain('script.js');
  });

  it('injects the cross-session digest, labelled as history not status', async () => {
    recordSessionTurn({
      projectPath: workspace,
      goal: 'add a converter tab',
      outcome: 'incomplete',
      tools: ['write_file'],
    });
    const block = await buildLoopProjectContext(workspace);
    expect(block).toContain('Recent sessions');
    expect(block).toContain('add a converter tab');
    expect(block).toContain('NOT a status');
  });
});
