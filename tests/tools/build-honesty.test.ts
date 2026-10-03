/**
 * A3 Part 2 — build honesty.
 *
 * The live Aukat_check failure: `pyinstaller AukatCheck.spec` exited 1 (stale
 * `dist/`), the model opened the OLD app and answered "The app is now
 * successfully built and functional." The run's own ledger knew the build
 * failed; the prose contradicted it; nothing compared the two, so the turn
 * recorded `success: true` / `acted`.
 *
 * These tests pin the detector and the loop wiring. The bar they have to clear
 * is BOTH directions: fire on the contradiction, and stay silent on every
 * honest turn — a guard that cries wolf would cost more capability than the
 * false success it fixes.
 */

import { describe, it, expect } from 'vitest';

import {
  detectFailedBuildSuccessClaim,
  runToolLoop,
  type StepResponse,
} from '../../src/tools/tool-loop.js';
import type { ExecutedAction } from '../../src/findings/verdicts.js';
import type { ToolContext } from '../../src/tools/registry.js';

/** A turn's ledger entry for a shell command that ran. */
function ran(command: string, ok: boolean): ExecutedAction {
  return { tool: 'run_terminal', command, ok };
}

const CLAIM = 'The app is now successfully built and functional.';

describe('detectFailedBuildSuccessClaim — evidence against the prose', () => {
  it('fires when a build failed and the answer claims success', () => {
    expect(detectFailedBuildSuccessClaim(CLAIM, [ran('pyinstaller AukatCheck.spec', false)])).toBe(true);
  });

  it('stays silent when the build FAILED and the answer says so honestly', () => {
    const honest = 'The build failed with exit 1 — `dist/` was not empty. I could not complete the rebuild.';
    expect(detectFailedBuildSuccessClaim(honest, [ran('pyinstaller AukatCheck.spec', false)])).toBe(false);
  });

  it('stays silent when a later build SUCCEEDED — a real recovery is allowed to report success', () => {
    const ledger = [ran('npm run build', false), ran('npm run build', true)];
    expect(detectFailedBuildSuccessClaim(CLAIM, ledger)).toBe(false);
  });

  it('stays silent when no BUILD command failed (a failing test is not a build)', () => {
    expect(detectFailedBuildSuccessClaim(CLAIM, [ran('npx vitest run', false)])).toBe(false);
  });

  it('stays silent when no command ran at all', () => {
    expect(detectFailedBuildSuccessClaim(CLAIM, [])).toBe(false);
  });

  it('is sentence-scoped: a negation or a future tense elsewhere does not become a claim', () => {
    expect(detectFailedBuildSuccessClaim('The build was not successful. I will rebuild it next.', [ran('make', false)])).toBe(false);
    expect(detectFailedBuildSuccessClaim('I will package it successfully once you confirm.', [ran('make', false)])).toBe(false);
  });

  it('does not treat "without errors" / "without crashing" as a negation', () => {
    // The positive phrasings a blanket `error`/`crash` block would wrongly reject.
    expect(detectFailedBuildSuccessClaim('Rebuilt successfully without errors.', [ran('make', false)])).toBe(true);
    expect(detectFailedBuildSuccessClaim('The app launches without crashing.', [ran('cargo build', false)])).toBe(true);
  });

  it('does not fire on a build that merely completed with errors', () => {
    expect(detectFailedBuildSuccessClaim('The build completed with 3 errors.', [ran('make', false)])).toBe(false);
  });
});

/** Drive the loop with a scripted model and a mock executor. */
async function runScript(
  script: StepResponse[],
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
) {
  let i = 0;
  return runToolLoop({
    messages: [{ role: 'user', content: 'rebuild the app and verify it works' }],
    context: { configManager: {} } as ToolContext,
    deps: {
      callModel: async () => script[Math.min(i++, script.length - 1)],
      executeTool: async (name: string, args: Record<string, unknown>) => execute(name, args),
    },
  });
}

describe('the tool loop flags a failed build contradicted by a success claim', () => {
  it('sets unverifiedBuildClaim when the build errored and the reply reports success', async () => {
    const result = await runScript(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'run_terminal', arguments: { command: 'pyinstaller AukatCheck.spec' } }] },
        { content: CLAIM, toolCalls: [] },
      ],
      async () => 'Error: exit 1 — dist/ is not empty (use -y)',
    );
    expect(result.unverifiedBuildClaim).toBe(true);
  });

  it('does not flag a turn whose build actually succeeded', async () => {
    const result = await runScript(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'run_terminal', arguments: { command: 'npm run build' } }] },
        { content: CLAIM, toolCalls: [] },
      ],
      async () => 'build: done in 1.2s',
    );
    expect(result.unverifiedBuildClaim).toBeUndefined();
  });
});
