/**
 * PROJECT-ASSESSMENT PROTOCOL — the evidence rules for an "assess this codebase" ask.
 *
 * The block exists because a side-by-side audit on the SAME model and the same
 * prompt produced two findings that could not be reproduced against the real code
 * (an unreachable input described as one a user can type, an unmeasured
 * "hangs forever"), a root cause missed behind ten green tests, and an answer that
 * stopped mid-sentence after forward-referencing a section it never wrote.
 *
 * A second head-to-head run (same model, same prompt, a 60-module Python app) then
 * scored this CLI against another agent and added rules 6-11, for six defects the
 * first five did not cover — all of them SHAPES OF CHECK rather than missing
 * facts: it read the modules and not the seams, never ran the project's own
 * shipped checkers, repeated a claim from a file in the repo without resolving
 * its references, asserted a test-suite count before running anything, asked an
 * absent user for permission to run a read-only probe, and left its scratch files
 * in the tree it was auditing.
 *
 * These tests pin BOTH directions, because the narrowness is as load-bearing as the
 * block: an assessment ask must receive every rule, and an ordinary change request
 * must receive NOTHING (a false positive here would put a bug-hunt protocol, and
 * a filesystem walk for the project's own checks, in front of every "fix this
 * bug" turn and change how all ordinary work is done).
 */

import { describe, it, expect } from 'vitest';
import {
  ASSESSMENT_PROTOCOL_RULES,
  assessmentProtocolBlock,
  isProjectAssessmentGoal,
} from '../../src/learning/assessment-protocol.js';

/** The verbatim goal of the side-by-side audit that motivated this module. */
const REAL_AUDIT_GOAL =
  'Assess the project in the current directory (/Users/dheeraj/Documents/cal) and identify the bugs in it. ' +
  'For every bug you find, report the file and line, a severity (critical / major / minor), the user-visible ' +
  'symptom, and why it happens. Do not modify any files — this is an assessment only.';

describe('isProjectAssessmentGoal — assesses, so the protocol applies', () => {
  it('catches the verbatim goal of the side-by-side audit', () => {
    expect(isProjectAssessmentGoal(REAL_AUDIT_GOAL)).toBe(true);
  });

  it.each([
    'find the bugs in this repo',
    'identify the issues in the API layer',
    'audit the codebase for security problems',
    'assess the project at /Users/dheeraj/Documents/cal',
    'review the src directory',
    "what's wrong with this project?",
    'what is broken in the frontend',
    'analyse the codebase',
    'critique this application and list defects',
    'hunt for vulnerabilities in the backend',
  ])('fires on: %s', (goal) => {
    expect(isProjectAssessmentGoal(goal)).toBe(true);
  });
});

describe('isProjectAssessmentGoal — does NOT fire (the narrowness is the design)', () => {
  it.each([
    // Change requests. These are the overwhelming majority of turns; each one must
    // stay byte-identical to a build without this module.
    'fix the bug in mathEngine.js',
    'fix the factorial performance issue',
    'add tests for the converter',
    'refactor the store module',
    'implement a dark mode toggle',
    'the sin button shows Error — make it work',
    'update the README',
    'rename getUnitsForCategory',
    'deploy the app to production',
    // A verb with no code target is not a code audit.
    'review this sentence for grammar',
    'review my notes from the meeting',
    'assess the risk of this migration plan',
    // Not an ask at all.
    '',
    'hi',
  ])('stays silent on: %s', (goal) => {
    expect(isProjectAssessmentGoal(goal)).toBe(false);
  });

  it('leaves an authored ask alone even when it borrows review vocabulary', () => {
    // "review" + "novel" is the deliverable taxonomy's business, not a bug hunt.
    expect(isProjectAssessmentGoal('write a review of this novel')).toBe(false);
  });

  it('does not mistake a BUILD for an audit when the requirements say "analyse"', () => {
    // The verbatim shape measured 2026-10-26 (Ultimate Agent Benchmark, SaaS
    // platform): a build prompt whose step 1 is "Analyse requirements." and whose
    // requirements name a backend, a frontend and an API. It classified as an
    // assessment, so it got the bug-hunt protocol AND the assessment extension cap
    // — sized by the source files already present, which for a greenfield turn is
    // none (2 extensions, 115 steps, versus 178 on the build cap).
    const BUILD_GOAL =
      'You are the sole software engineer responsible for delivering a production-ready SaaS Operations Platform.\n' +
      'Before writing any code: 1. Analyse requirements. 2. Create PRD. 3. Create architecture document.\n' +
      'Requirements: Next.js frontend, Node.js backend, PostgreSQL, JWT Authentication, AI Assistant.\n' +
      'Work autonomously.';
    expect(isProjectAssessmentGoal(BUILD_GOAL)).toBe(false);
    expect(assessmentProtocolBlock(BUILD_GOAL)).toBe('');
  });

  it('still catches an audit that asks to inspect, when nothing is being delivered', () => {
    expect(isProjectAssessmentGoal('inspect the packages and evaluate the API')).toBe(true);
    expect(isProjectAssessmentGoal('review the codebase, do not modify any files')).toBe(true);
  });
});

describe('assessmentProtocolBlock', () => {
  it('is empty for anything that is not an assessment', () => {
    expect(assessmentProtocolBlock('fix the bug in mathEngine.js')).toBe('');
    expect(assessmentProtocolBlock('')).toBe('');
  });

  it('carries every evidence rule, and names each one it enforces', () => {
    const block = assessmentProtocolBlock(REAL_AUDIT_GOAL);
    expect(block).toContain('TASK PROTOCOL: PROJECT ASSESSMENT');
    for (const rule of ASSESSMENT_PROTOCOL_RULES) {
      expect(block).toContain(rule);
    }
    // Every rule, by the failure it closes. Rules 1-5 come from the first
    // side-by-side audit; 6-11 from the second, head-to-head one.
    expect(block).toContain('MEASURE THE ARTIFACT, NOT A COPY');
    // R7 — an impact claim about lost data is a measurement, not an inference.
    expect(block).toContain('MEASURE THE CONSEQUENCE TOO');
    expect(block).toContain('REACHABILITY BEFORE SEVERITY');
    expect(block).toContain('QUANTIFY RESOURCE CLAIMS');
    expect(block).toContain('GREEN TESTS ARE NOT COVERAGE');
    expect(block).toContain('FINISH WHAT YOU REFERENCE');
    expect(block).toContain('LATENT');
    expect(block).toContain('REASONED');
    expect(block).toContain('UNMEASURED');
    expect(block).toContain('## Not covered');

    // 6. The seams: the three findings the audit missed all lived in the joins.
    expect(block).toContain('CHECK THE SEAMS, NOT ONLY THE MODULES');
    expect(block).toMatch(/CONSTANT/);
    expect(block).toMatch(/PARSED FIELD/);
    expect(block).toMatch(/PARTIAL input/);
    // Seam G: the 2026-10-25 rerun found the traversal and the 416 but still
    // graded `_organize_voice` LOW, because it called the function dead without
    // reading `installed_voices()`, the code that expects its output. The sweep
    // now names that check where the sweep — not a distant rule — is read.
    expect(block).toMatch(/grep its callers/);
    expect(block).toMatch(/reads the output it would have produced/);
    // Seams H-L: the classes the measured run dropped because they were cheap to
    // read and had no fixture — a control wired to nothing (pitch), an unguarded
    // platform call (`wx.App`, GetAccessible), a gate whose escape is disabled
    // (terms), a pickle/zip boundary, and per-run state that is truncated.
    expect(block).toMatch(/every input that should change output/);
    expect(block).toMatch(/platform-specific APIs/);
    expect(block).toMatch(/ESCAPE \(Disagree, Skip, Cancel\)/);
    expect(block).toMatch(/allow_pickle=True/);
    expect(block).toMatch(/resume\/per-run state/);
    // Rule 15: the false "pickle is absent" claim, which a grep for `pickle.load`
    // produced while the project called `np.load(..., allow_pickle=True)`.
    expect(block).toContain('"SAFE" IS A CLAIM: NAME THE SEARCH');
    expect(block).toMatch(/never EXISTENCE|STILL REPORTED/);
    // The MODULE PASS: the ten classes the measured run missed while following
    // seams. Each is a reading task, not a fixture, which is why a checklist —
    // not another rule — is what makes it happen.
    expect(block).toContain('## MODULE PASS');
    expect(block).toMatch(/control value read, then never applied/);
    expect(block).toMatch(/disabled until the user satisfies/);
    expect(block).toMatch(/page, index or offset assigned then overwritten/);
    expect(block).toMatch(/parsed, then never used/);
    expect(block).toMatch(/never installed by the installer/);
    expect(block).toMatch(/one silently replaces the other/);
    // 7. Run the project's own shipped checks, and delegate with an exact target.
    expect(block).toContain('RUN WHAT THE PROJECT ALREADY SHIPS');
    expect(block).toMatch(/EXACT file or suite/);
    // 8. A file in the repo is a claim to resolve, not a fact to repeat.
    expect(block).toContain('A FILE IN THE REPO IS A CLAIM, NOT A FACT');
    // 9. No measurement without the command that produced it.
    expect(block).toContain('NEVER CLAIM A MEASUREMENT YOU HAVE NOT TAKEN');
    expect(block).toContain('IN THIS TURN');
    // 10. Read-only work is the agent's to do, not a question to ask.
    expect(block).toContain('DECIDE; DO NOT ASK FOR WHAT YOU MAY ALREADY DO');
    // 11. Scratch files go outside the audited tree.
    expect(block).toContain('LEAVE THE TREE AS YOU FOUND IT');
    expect(block).toMatch(/OUTSIDE the audited repository/);
  });

  it('keeps the report shape of a normal run instead of imposing a new one', () => {
    const block = assessmentProtocolBlock(REAL_AUDIT_GOAL);
    // The strengths of the run that motivated this are the format to KEEP.
    expect(block).toMatch(/severity-labelled findings/);
    expect(block).toMatch(/file:line/);
    expect(block).toMatch(/fix/);
    expect(block).toMatch(/inherit the bug/);
  });

  it('appends the project\'s own checks when the caller found some, and nothing otherwise', () => {
    const bare = assessmentProtocolBlock(REAL_AUDIT_GOAL);
    // No checks ('' or undefined) must leave the block EXACTLY as it was, so a
    // project that declares none has the same prompt as a build without the
    // self-check module at all.
    expect(assessmentProtocolBlock(REAL_AUDIT_GOAL, { selfChecks: '' })).toBe(bare);
    expect(assessmentProtocolBlock(REAL_AUDIT_GOAL, {})).toBe(bare);
    // When there are checks, they are ADDED to the rules — never substituted
    // for them, which is what "enhance, never degrade" means here.
    const withChecks = assessmentProtocolBlock(REAL_AUDIT_GOAL, {
      selfChecks: '## This project\'s own checks — run these\n- `python tools/audit.py`',
    });
    expect(withChecks.startsWith(bare)).toBe(true);
    expect(withChecks).toContain('python tools/audit.py');
  });

  it('stays inside a small, fixed prompt budget', () => {
    // An optional context block: bounded, or the budget ladder has to trim the
    // project context to make room for advice about reporting.
    //
    // MEASURED after rules 6-11 and the "measure the consequence" clause landed:
    // 4571 chars / 79 lines (the five-rule block was ~3300 / 60). The ceiling
    // moved because eleven rules closing eleven MEASURED defect classes cannot
    // fit in the old one — the wording of the new rules was tightened first, and
    // several rules share a line — and it still leaves headroom, so it remains a
    // bound rather than a snapshot of today's prose.
    // MEASURED after rules 13-14 and the SEAM SWEEP landed: 6971 chars / 117
    // lines. The sweep is the part that earns the space: it names the six seams
    // whose absence cost the 2026-10-25 audit its highest-value findings (path
    // from a name made only of dots, the 416 on a complete `.part`, a version
    // gate against a stale constant, a parsed-but-unread field, cancel-while-
    // paused, and a posted event nobody binds). Ceilings move with a reason and
    // keep headroom; they are bounds, not snapshots of today's prose.
    // MEASURED after the MODULE PASS checklist (the ten classes a seam sweep does
    // not reach: a control wired to nothing, a gate whose escape is disabled, a
    // per-run file, two app objects, an overwritten index, an unbumped version
    // constant, an unused flag, an uninstalled dependency, a name collision):
    // 9714 chars / 156 lines.
    const block = assessmentProtocolBlock(REAL_AUDIT_GOAL);
    expect(block.length).toBeGreaterThan(800);
    expect(block.length).toBeLessThanOrEqual(9900);
    expect(block.split('\n').length).toBeLessThanOrEqual(156);
  });

  it('keeps every rule terse, so growth is a rule that had to be said, not prose', () => {
    // A global ceiling alone lets one rule sprawl while another is dropped to
    // compensate. This bounds the SHAPE: a numbered rule is its heading plus at
    // most seven lines of body, which is the length at which the block is read.
    // Rule 1 is the longest (it carries both halves of "measure it") at eight;
    // the rest are six or fewer, so a rule that grows past this is prose that has
    // not found its sentence yet.
    const lines = assessmentProtocolBlock(REAL_AUDIT_GOAL).split('\n');
    const headings = lines
      .map((line, i) => (/^\d+\.\s/.test(line) ? i : -1))
      .filter((i) => i >= 0);
    // 15 is deliberate: rule 12 (write the deliverable first) exists because a
    // measured audit spent its whole budget and delivered a 0-byte report; rule
    // 13 (read the consumer before calling a branch harmless) and rule 14 (prove
    // every High with a fixture) are Cline's two measured advantages over this
    // agent in the 2026-10-25 head-to-head.
    expect(headings.length).toBe(15);
    // The last rule's body ends where the SEAM SWEEP section begins; counting to
    // the end of the block would score the sweep as that rule's prose.
    const sweepStart = lines.findIndex((line) => line.startsWith('## SEAM SWEEP'));
    for (let i = 0; i < headings.length; i += 1) {
      const end =
        i + 1 < headings.length
          ? headings[i + 1]!
          : sweepStart > headings[i]!
            ? sweepStart
            : lines.length;
      const body = lines.slice(headings[i]!, end).filter((line) => line.trim() !== '');
      expect(body.length, `rule \"${lines[headings[i]!]!}\"`).toBeLessThanOrEqual(8);
    }
  });

  it('keeps the whole injected block bounded even with a project\'s checks attached', () => {
    // The self-check section is capped at MAX_CHECKS by its own module, so the
    // bound here is the worst case: the ceiling is what stops a repository with
    // two hundred scripts from displacing the project context.
    const withChecks = assessmentProtocolBlock(REAL_AUDIT_GOAL, {
      selfChecks: Array.from({ length: 10 }, (_, i) => `- \`python tools/check_${i}.py\``).join('\n'),
    });
    // MEASURED worst case on the audited project itself (10 checks): 9995 / 167,
    // after the MODULE PASS landed (8947 / 151 before it).
    expect(withChecks.length).toBeLessThanOrEqual(10200);
    expect(withChecks.split('\n').length).toBeLessThanOrEqual(167);
  });
});
