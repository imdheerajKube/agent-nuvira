/**
 * AUTO-VERIFY — the loop runs the project's own check instead of only asking.
 *
 * Measured (2026-10-25 head-to-head): the delivery that won on evidence quoted
 * `125 failed / 476 passed` from the project's own suite; this loop asked the
 * model to verify and the model sometimes did not, so an audit could end with no
 * observed result at all. A nudge is advice; a check that RAN is evidence.
 *
 * The gate must stay narrow:
 *  - only when the turn MUTATED the workspace and nothing observed it,
 *  - only when the project declares a runnable check,
 *  - never for a prose-only deliverable (a written file is its own verification),
 *  - at most twice per turn,
 *  - and OFF unless the caller opts in (the CLI does; other callers keep their
 *    exact behaviour).
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLoop, autoVerifyReport, type ToolLoopDeps, type StepResponse, type ToolLoopOptions } from '../../src/tools/tool-loop.js';
import type { ToolContext } from '../../src/tools/registry.js';

/** A workspace whose package.json declares a check the loop can find. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-verify-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
  );
  return dir;
}

const EDIT: StepResponse = {
  content: '',
  toolCalls: [{ id: 'e1', name: 'write_file', arguments: { path: 'src/thing.ts', content: 'export const x = 1;\n' } }],
};
const ANSWER: StepResponse = { content: 'Done — the file is written.', toolCalls: [] };

function harness(script: StepResponse[], toolResult: (name: string) => string) {
  let i = 0;
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const events: string[] = [];
  const deps: ToolLoopDeps = {
    callModel: vi.fn(async () => script[Math.min(i++, script.length - 1)]),
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      toolCalls.push({ name, args });
      return toolResult(name);
    }),
    onEvent: (event: string) => events.push(event),
  };
  return { deps, toolCalls, events };
}

function run(deps: ToolLoopDeps, cwd: string, extra: Partial<ToolLoopOptions> = {}) {
  return runToolLoop({
    messages: [{ role: 'user', content: 'Add the thing to src/thing.ts' }],
    context: { cwd, configManager: {} } as ToolContext,
    deps,
    maxSteps: 8,
    maxContinuations: 0,
    ...extra,
  } as ToolLoopOptions & { deps: ToolLoopDeps });
}

describe('auto-verify — evidence instead of advice', () => {
  it("runs the project's own check when the turn edited files and verified nothing", async () => {
    const cwd = workspace();
    const { deps, toolCalls, events } = harness([EDIT, ANSWER], (name) =>
      name === 'run_terminal' ? 'run_terminal: `npm test` ✅ succeeded.\nOutput:\nok' : 'ok',
    );

    await run(deps, cwd, { autoVerify: true });

    const ran = toolCalls.find((c) => c.name === 'run_terminal');
    expect(ran).toBeDefined();
    expect(String(ran!.args.command)).toContain('npm');
    // The run is disclosed in the console line, not silent.
    expect(events.some((e) => e.includes('Auto-verify'))).toBe(true);
  });

  it('does NOT run the check when the caller has not opted in', async () => {
    const cwd = workspace();
    const { deps, toolCalls } = harness([EDIT, ANSWER], () => 'ok');

    await run(deps, cwd); // autoVerify omitted → off

    expect(toolCalls.some((c) => c.name === 'run_terminal')).toBe(false);
  });

  it('does NOT run a check for a prose-only deliverable', async () => {
    const cwd = workspace();
    const prose: StepResponse = {
      content: '',
      toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'REPORT.md', content: '# Audit\n\ntext\n' } }],
    };
    const { deps, toolCalls } = harness([prose, ANSWER], () => 'ok');

    await run(deps, cwd, { autoVerify: true });

    // A written file is verified by its content — a test runner cannot see it.
    expect(toolCalls.some((c) => c.name === 'run_terminal')).toBe(false);
  });

  it('reports a FAILED check as a failure and tells the model to fix it, not to claim success', () => {
    const failed = autoVerifyReport(
      { command: 'npm test', label: 'the "test" script in package.json' },
      'Error: run_terminal: `npm test` ❌ failed (exit 1).\nOutput:\n1 failing test',
      false,
    );
    expect(failed).toContain('❌ FAILED');
    expect(failed).toContain('Fix the failure above');
    expect(failed).toContain('do not '); // do not report complete while it fails
    expect(failed).toContain('1 failing test');

    const passed = autoVerifyReport({ command: 'npm test', label: 'the "test" script' }, 'ok', true);
    expect(passed).toContain('✅ passed');
    expect(passed).toContain('do not re-run it');
  });

  it('bounds the output it hands back', () => {
    const report = autoVerifyReport({ command: 'npm test', label: 'script' }, 'x'.repeat(50_000), false);
    expect(report.length).toBeLessThan(6_000);
    expect(report).toContain('output truncated');
  });
});
