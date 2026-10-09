/**
 * `nuvira state` — the ONE-READ project state surface.
 *
 * The command is deliberately a COMPOSITION of four existing records (plan,
 * open sessions, per-file verification debt, git drift) and must not become a
 * fifth source of truth. These tests seed each record through its OWN module and
 * assert the command prints it — and that `--json` prints the same facts.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StateCommand } from '../../src/cli/state.js';
import { planFilePath, writePlanFile } from '../../src/tools/plan-store.js';
import { recordWorkingState, clearWorkingState } from '../../src/learning/working-state.js';
import { openSession, listSessionSnapshots, clearSession } from '../../src/learning/session-store.js';
import type { ToolMessage } from '../../src/inference/interface.js';

const ORIGINAL_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;
const memDir = mkdtempSync(join(tmpdir(), 'nuvira-state-mem-'));
const project = mkdtempSync(join(tmpdir(), 'nuvira-state-proj-'));
process.env.NUVIRA_MEMORY_DIR = memDir;
writeFileSync(join(project, 'package.json'), '{"name":"probe"}\n');

afterAll(() => {
  if (ORIGINAL_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIGINAL_MEMORY_DIR;
  rmSync(memDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/** Capture everything the command prints (logger writes through console.log). */
async function runState(args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.map((x) => String(x)).join(' '));
  });
  try {
    await new StateCommand().create().parseAsync(['node', 'state', ...args]);
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

beforeEach(() => {
  // A pristine project each time: every record is cleared, then a test seeds
  // only the ones it is about. The modules persist to NUVIRA_MEMORY_DIR, which
  // is shared across the file, so without this a session or a debt would leak
  // into the next test and make it pass (or fail) on the wrong record.
  writePlanFile(planFilePath(`cli:${project}`), null);
  clearWorkingState(project);
  for (const s of listSessionSnapshots()) clearSession(s.id);
});

describe('nuvira state — one read of the project', () => {
  it('reports the plan, per-file debt and open session for this directory', async () => {
    writePlanFile(planFilePath(`cli:${project}`), {
      goal: 'ship the router',
      steps: [
        { id: 's1', description: 'write the domain model', status: 'done', note: 'written' },
        { id: 's2', description: 'wire the API', status: 'pending' },
      ],
      revision: 1,
      updatedAt: Date.now(),
    });
    recordWorkingState(project, {
      filesTouched: ['src/a.ts', 'src/b.ts'],
      verifiedPaths: ['src/a.ts'],
      unverifiedPaths: ['src/b.ts'],
    });
    const store = openSession({ goal: 'wire the API', cwd: project });
    store.save(
      [{ role: 'assistant', content: 'working' } as ToolMessage],
      { steps: 2, successfulTools: [], mutatedPaths: ['src/a.ts'] },
    );

    const out = await runState(['--dir', project]);

    // Plan, with its real progress and the open steps named.
    expect(out).toContain('ship the router');
    expect(out).toContain('1/2 done');
    expect(out).toContain('wire the API');
    expect(out).toContain('still open');
    // The open session is listed, with its id.
    expect(out).toContain('Open sessions');
    expect(out).toContain(store.id);
    // The per-file debt — by PATH, not a bare count.
    expect(out).toContain('Unverified changes');
    expect(out).toContain('src/b.ts');
    // A temp dir is not a repository: the drift section says so rather than
    // inventing a branch.
    expect(out).toContain('not a git repository');
  });

  it('says plainly when there is nothing outstanding', async () => {
    const out = await runState(['--dir', project]);
    expect(out).toContain('Plan — none tracked');
    expect(out).toContain('Open sessions — none');
    expect(out).toContain('Unverified changes — none outstanding');
    // Read-only is stated, not implied.
    expect(out).toContain('Read-only');
  });

  it('--json prints the same facts for a script', async () => {
    writePlanFile(planFilePath(`cli:${project}`), {
      goal: 'ship the router',
      steps: [{ id: 's1', description: 'write the domain model', status: 'running' }],
      revision: 1,
      updatedAt: Date.now(),
    });
    recordWorkingState(project, { filesTouched: ['x.ts'], unverifiedPaths: ['x.ts'] });

    const out = await runState(['--dir', project, '--json']);
    const data = JSON.parse(out) as {
      dir: string;
      plan: { goal: string } | null;
      ledger: { unverifiedPaths: Array<{ path: string }> } | null;
      openSessions: unknown[];
    };
    expect(data.plan?.goal).toBe('ship the router');
    expect(data.ledger?.unverifiedPaths.map((u) => u.path)).toContain('x.ts');
    expect(Array.isArray(data.openSessions)).toBe(true);
  });
});
