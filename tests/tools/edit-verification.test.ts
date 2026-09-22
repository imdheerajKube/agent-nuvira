/**
 * G1 + G2 — edit-verification guards.
 *
 * The calculator audit: across 99 LLM calls the loop never ran a single
 * verification tool, yet every turn ended `success=true, kind=acted` and the
 * answers asserted the edits worked ("successfully fixed", "now fully
 * operational"). These tests pin the two pure guards that close that gap.
 */

import { describe, it, expect } from 'vitest';
import {
  assessEditActivity,
  classifyEditActivity,
  detectUnverifiedEditClaim,
  isMutationTool,
  isVerificationTool,
  verificationExercisedArtifact,
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
    for (const cmd of ['npm test', 'npm run build', 'pnpm run typecheck', 'tsc --noEmit', 'npx vitest run', 'node --check script.js']) {
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
