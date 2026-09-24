/**
 * G1 + G2 — edit-verification guards.
 *
 * The calculator audit: across 99 LLM calls the loop never ran a single
 * verification tool, yet every turn ended `success=true, kind=acted` and the
 * answers asserted the edits worked ("successfully fixed", "now fully
 * operational"). These tests pin the two pure guards that close that gap.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessEditActivity,
  classifyEditActivity,
  detectAvailableChecks,
  detectUnverifiedEditClaim,
  isMutationTool,
  isParseOnlyCheck,
  isVerificationTool,
  verificationExercisedArtifact,
  verificationNudgeFor,
  MUTATION_TOOLS,
  VERIFICATION_TOOLS,
} from '../../src/tools/edit-verification.js';

describe('edit-verification — classification', () => {
  it('knows which tools mutate the workspace', () => {
    expect(isMutationTool('edit_file')).toBe(true);
    expect(isMutationTool('write_file')).toBe(true);
    expect(isMutationTool('read_file')).toBe(false);
    expect([...MUTATION_TOOLS].sort()).toEqual(['edit_file', 'write_file']);
  });

  it('knows which tools can verify a mutation', () => {
    expect(isVerificationTool('run_terminal')).toBe(true);
    expect(isVerificationTool('test')).toBe(true);
    expect(isVerificationTool('browser')).toBe(true);
    expect(isVerificationTool('run_cli')).toBe(true);
    // A sub-agent's prose summary is NOT an observed artifact.
    expect(isVerificationTool('delegate')).toBe(false);
    expect(VERIFICATION_TOOLS.has('edit_file')).toBe(false);
  });

  it('flags an edit with no verification as needing verification', () => {
    const a = classifyEditActivity(['read_file', 'edit_file', 'suggest_followups']);
    expect(a.mutations).toEqual(['edit_file']);
    expect(a.verifications).toEqual([]);
    expect(a.needsVerification).toBe(true);
  });

  it('does NOT need verification when a verification tool ran', () => {
    const a = classifyEditActivity(['edit_file', 'run_terminal']);
    expect(a.needsVerification).toBe(false);
    expect(a.verifications).toEqual(['run_terminal']);
  });

  it('does NOT need verification when nothing mutated the workspace', () => {
    expect(classifyEditActivity(['read_file', 'code_search']).needsVerification).toBe(false);
    expect(classifyEditActivity([]).needsVerification).toBe(false);
  });
});

describe('detectUnverifiedEditClaim — the false "I fixed it"', () => {
  it('flags the phrases the calculator session actually used', () => {
    const claims = [
      'I have successfully secured the calculator by replacing the dangerous eval() function.',
      'The inline event handlers have been successfully removed from index.html.',
      'I have applied the requested changes to fix the tab visibility issue.',
      'The converter is now fully operational with dynamic category-based unit selection.',
      'The UI/UX has been successfully modernized with a Dark Mode theme.',
      'I fixed the CSS structure and updated the converter.',
      'The issue is now fixed.',
      'The changes have been applied.',
    ];
    for (const c of claims) {
      expect(detectUnverifiedEditClaim(c, ['edit_file'], []), c).toBe(true);
    }
  });

  it('stays quiet when the edit WAS verified', () => {
    expect(
      detectUnverifiedEditClaim('I have fixed the converter and the tests pass.', ['edit_file'], ['run_terminal']),
    ).toBe(false);
    // the `test` pipeline also counts
    expect(detectUnverifiedEditClaim('Fixed it.', ['write_file'], ['test'])).toBe(false);
  });

  it('stays quiet when nothing mutated the workspace', () => {
    expect(detectUnverifiedEditClaim('I have fixed the example in my explanation.', [], [])).toBe(false);
    expect(detectUnverifiedEditClaim('Here is what I found: the bug is in tab switching.', ['read_file'], [])).toBe(
      false,
    );
  });

  it('is negation- and future-aware (no false positives)', () => {
    // A truthful "I could not fix it" must never be flagged.
    expect(
      detectUnverifiedEditClaim('I could not fix the converter — the dropdown data is missing.', ['edit_file'], []),
    ).toBe(false);
    // A description of a deliverable, not a claim of having done it.
    expect(
      detectUnverifiedEditClaim('I will update the styling once you confirm the palette.', ['edit_file'], []),
    ).toBe(false);
    expect(detectUnverifiedEditClaim('Shall I proceed to refactor script.js?', ['edit_file'], [])).toBe(false);
    // A plan (list) is not a completed change.
    expect(
      detectUnverifiedEditClaim('Here is the plan:\n- Implement updateUnits\n- Style the dropdowns', ['edit_file'], []),
    ).toBe(false);
  });

  it('is empty/whitespace safe', () => {
    expect(detectUnverifiedEditClaim('', ['edit_file'], [])).toBe(false);
    expect(detectUnverifiedEditClaim('   \n ', ['edit_file'], [])).toBe(false);
  });
});

describe('verificationExercisedArtifact — relevance, not just success', () => {
  const edit = (path: string) => ({ tool: 'edit_file', args: { path } });
  const run = (tool: string, args: Record<string, unknown>, result: string) => ({ tool, args, result });

  it('accepts a generic project check even when it never names the file', () => {
    for (const cmd of ['npm test', 'npm run build', 'pnpm run typecheck', 'tsc --noEmit', 'npx vitest run']) {
      expect(
        verificationExercisedArtifact([run('run_terminal', { command: cmd }, `run_terminal: done`)], ['app.js']),
        cmd,
      ).toBe(true);
    }
  });

  it('accepts a run that NAMES the changed file (the live grep case)', () => {
    expect(
      verificationExercisedArtifact(
        [run('run_terminal', { command: 'grep "border-radius: 20px;" style.css' }, 'style.css:13:  border-radius: 20px;')],
        ['style.css'],
      ),
    ).toBe(true);
  });

  it('accepts the pipeline test module and a browser run as inherently project-wide', () => {
    expect(verificationExercisedArtifact([run('test', {}, 'ok')], ['app.js'])).toBe(true);
    expect(verificationExercisedArtifact([run('browser', {}, 'ok')], ['app.js'])).toBe(true);
  });

  it('REJECTS a successful run that exercised nothing (the echo hi hole)', () => {
    expect(verificationExercisedArtifact([run('run_terminal', { command: 'echo hi' }, 'run_terminal: ✅ succeeded\nOutput:\nhi')], ['app.js'])).toBe(false);
    expect(
      verificationExercisedArtifact(
        [run('run_terminal', { command: 'ls' }, 'run_terminal: ✅ succeeded\nOutput:\nnode_modules\nsrc')],
        ['style.css'],
      ),
    ).toBe(false);
  });

  it('falls back to permissive when the changed paths are unknown', () => {
    expect(verificationExercisedArtifact([run('run_terminal', { command: 'echo hi' }, 'ok')], [])).toBe(true);
  });

  it('is false with no verification evidence at all', () => {
    expect(verificationExercisedArtifact([], ['app.js'])).toBe(false);
  });
});

/**
 * A parse check proves the source PARSES. It cannot observe behaviour, so it
 * must never close the verification gate — the 2026-09-23 re-test: the agent
 * ran `node -c script.js`, was counted "verified", and reported a buggy file
 * "in good shape" while the defect sat on the next line.
 */
describe('parse-only checks are not verification', () => {
  const run = (tool: string, args: Record<string, unknown>, result: string) => ({ tool, args, result });

  it('recognises parse-only commands', () => {
    for (const cmd of [
      'node --check script.js',
      'node -c script.js',
      'python -m py_compile app.py',
      'python3 -m py_compile app.py',
      'ruby -c app.rb',
      'php -l index.php',
      'bash -n deploy.sh',
    ]) {
      expect(isParseOnlyCheck(run('run_terminal', { command: cmd }, `run_terminal: \u2705 succeeded`)), cmd).toBe(true);
    }
  });

  it('does NOT treat a real check (or a combined run) as parse-only', () => {
    for (const cmd of ['npm test', 'npx vitest run', 'tsc --noEmit', 'npm run build']) {
      expect(isParseOnlyCheck(run('run_terminal', { command: cmd }, 'ok')), cmd).toBe(false);
    }
    // A run that parses AND tests is judged on the test, not demoted.
    expect(isParseOnlyCheck(run('run_terminal', { command: 'node -c a.js && npm test' }, 'ok'))).toBe(false);
  });

  it('rejects a parse check that NAMES the changed file (the live case)', () => {
    // This is exactly what the calculator re-test ran.
    expect(
      verificationExercisedArtifact(
        [run('run_terminal', { command: 'node -c script.js' }, 'run_terminal: \u2705 succeeded\n(no output)')],
        ['script.js'],
      ),
    ).toBe(false);
    expect(
      verificationExercisedArtifact(
        [run('run_terminal', { command: 'node --check script.js' }, 'script.js: syntax ok')],
        ['script.js'],
      ),
    ).toBe(false);
  });

  it('rejects a parse check even when the changed paths are unknown', () => {
    expect(
      verificationExercisedArtifact([run('run_terminal', { command: 'node --check a.js' }, 'ok')], []),
    ).toBe(false);
  });

  it('keeps the gate open when a parse check is all that ran', () => {
    const a = assessEditActivity(
      ['edit_file', 'run_terminal'],
      [{ tool: 'run_terminal', args: { command: 'node -c script.js' }, result: 'ok' }],
      ['script.js'],
    );
    expect(a.mutations).toEqual(['edit_file']);
    expect(a.needsVerification).toBe(true);
  });

  it('closes the gate once a real check also ran', () => {
    const a = assessEditActivity(
      ['edit_file', 'run_terminal'],
      [
        { tool: 'run_terminal', args: { command: 'node -c script.js' }, result: 'ok' },
        { tool: 'run_terminal', args: { command: 'npm test' }, result: 'ok' },
      ],
      ['script.js'],
    );
    expect(a.needsVerification).toBe(false);
  });
});

describe('assessEditActivity — the single gate decision', () => {
  it('needs verification when the only run exercised nothing', () => {
    const a = assessEditActivity(
      ['edit_file', 'run_terminal'],
      [{ tool: 'run_terminal', args: { command: 'echo hi' }, result: 'ok' }],
      ['app.js'],
    );
    expect(a.mutations).toEqual(['edit_file']);
    expect(a.needsVerification).toBe(true);
  });

  it('is satisfied by a relevant run', () => {
    const a = assessEditActivity(
      ['edit_file', 'run_terminal'],
      [{ tool: 'run_terminal', args: { command: 'npm test' }, result: 'ok' }],
      ['app.js'],
    );
    expect(a.needsVerification).toBe(false);
  });

  it('never needs verification when nothing was mutated', () => {
    expect(assessEditActivity(['read_file'], [], []).needsVerification).toBe(false);
  });
});

/**
 * Stage 3 — the verification LADDER.
 *
 * The nudge already stated the right preference order (tests > typecheck > real
 * run) and still failed in a live turn, because the model had to guess what the
 * project HAD — and reached for `node -c`, the cheapest thing available. Naming
 * the actual command is the fix: "run `npm test`" leaves nothing to guess.
 */
describe('detectAvailableChecks + verificationNudgeFor', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nuvira-ladder-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const withPkg = (scripts: Record<string, string>): void => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts }), 'utf-8');
  };

  it('prefers the project\u2019s own test script above everything else', () => {
    withPkg({ test: 'vitest run', build: 'tsc', lint: 'eslint .' });
    const checks = detectAvailableChecks(root);
    expect(checks[0].command).toBe('npm test');
    expect(checks[0].strength).toBeGreaterThan(checks[1].strength);
  });

  it('finds a typecheck and a build when there is no test script', () => {
    withPkg({ typecheck: 'tsc --noEmit', build: 'tsc' });
    const commands = detectAvailableChecks(root).map((c) => c.command);
    expect(commands).toContain('npm run typecheck');
    expect(commands).toContain('npm run build');
  });

  it('recognises a configured runner with no package script', () => {
    withPkg({ build: 'tsc' });
    writeFileSync(join(root, 'vitest.config.ts'), 'export default {}', 'utf-8');
    expect(detectAvailableChecks(root)[0].command).toBe('npx vitest run');
  });

  it('falls back to a bare typechecker from tsconfig.json', () => {
    writeFileSync(join(root, 'tsconfig.json'), '{}', 'utf-8');
    expect(detectAvailableChecks(root).map((c) => c.command)).toContain('npx tsc --noEmit');
  });

  it('returns nothing for a project with no checks (a normal answer)', () => {
    expect(detectAvailableChecks(root)).toEqual([]);
  });

  it('never throws on an unreadable package.json', () => {
    writeFileSync(join(root, 'package.json'), 'not json at all', 'utf-8');
    expect(() => detectAvailableChecks(root)).not.toThrow();
  });

  it('NAMES the strongest check in the nudge (the whole point)', () => {
    withPkg({ test: 'vitest run', build: 'tsc' });
    const nudge = verificationNudgeFor(root, ['script.js']);
    expect(nudge).toContain('npm test');
    expect(nudge).toContain('script.js');
    // The parse-check exclusion stays explicit, so `node -c` is never the answer.
    expect(nudge).toContain('node --check');
    expect(nudge).toMatch(/do not count/);
  });

  it('directs to a REAL RUN when the project has no check to run', () => {
    const nudge = verificationNudgeFor(root, ['script.js']);
    expect(nudge).toMatch(/No test, typecheck or build command/);
    expect(nudge).toMatch(/REAL RUN/);
    expect(nudge).toMatch(/do NOT claim/);
  });

  it('offers at most three checks — an unbounded list is noise', () => {
    withPkg({ test: 'a', typecheck: 'b', build: 'c', lint: 'd', check: 'e' });
    const listed = verificationNudgeFor(root, []).split('\n').filter((l) => /^  \d\./.test(l));
    expect(listed).toHaveLength(3);
  });
});
