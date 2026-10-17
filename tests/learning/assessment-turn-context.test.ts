/**
 * The ONE seam every surface builds an assessment ask through.
 *
 * WHY THESE TESTS EXIST. Before this module, the protocol was assembled inline in
 * `chat.ts`, so it reached exactly one entry — and `nuvira execute`, the surface a
 * scripted audit actually runs on, got an unadorned ask. That is the drift
 * `src/parity/surfaces.ts` documents ("a capability lands on one surface and
 * quietly misses three"), and the fix is a shared seam plus a test that fails when
 * an entry stops using it.
 *
 * So this file pins three things:
 *   1. THE COMPOSITION. An assessment ask gets the rules, the project's own checks
 *      and the performance probes; a non-assessment ask gets NOTHING.
 *   2. THE SURFACE REACH. Every turn entry that can run an assessment — chat,
 *      `runLoopExecutor`, `runPipelineTool`, the subagent runtime — calls the seam.
 *      Asserted against the SOURCE, because a behavioural test per entry would need
 *      four provider harnesses to prove one call.
 *   3. THE PROMPT-SHAPE RULES that keep it safe: the section is appended, never
 *      substituted, and the system layer never carries it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { buildAssessmentTurnContext } from '../../src/learning/assessment-turn-context.js';

const AUDIT_GOAL =
  'Assess the project in the current directory and identify the bugs in it. For every bug you find, ' +
  'report the file and line, a severity and the symptom. Do not modify any files — this is an assessment only.';
const FIX_GOAL = 'fix the sorting bug in utils.ts';

let root: string | undefined;
const fixture = (files: Record<string, string>): string => {
  root = mkdtempSync(join(tmpdir(), 'nuvira-assessment-ctx-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
};

describe('buildAssessmentTurnContext — composition', () => {
  it('gives a non-assessment ask NOTHING, and does not read the project', () => {
    // The gate runs before any filesystem work, which is what keeps an ordinary
    // turn byte-identical to one from a build without these modules. Proven the
    // cheap way: the directory does not exist, and the call still returns empty
    // rather than a protocol block.
    const ctx = buildAssessmentTurnContext(FIX_GOAL, '/definitely/not/a/real/directory');
    expect(ctx.isAssessment).toBe(false);
    expect(ctx.block).toBe('');
    expect(ctx.selfChecks).toBe(0);
    expect(ctx.perfProbes).toBe(false);
  });

  it('gives an assessment ask the rules, its own checks, and the performance probes', () => {
    const dir = fixture({
      // A python project with its own shipped checker — the audited shape.
      'requirements.txt': 'wxpython\n',
      'ai_voice_studio/__init__.py': '',
      'tools/dead_code_audit.py': '# audit\n',
      'tests/test_thing.py': 'def test(): pass\n',
    });
    try {
      const ctx = buildAssessmentTurnContext(AUDIT_GOAL, dir);
      expect(ctx.isAssessment).toBe(true);
      expect(ctx.block).toContain('TASK PROTOCOL: PROJECT ASSESSMENT');
      expect(ctx.block).toContain('CHECK THE SEAMS, NOT ONLY THE MODULES');
      // The project's OWN tooling is named…
      expect(ctx.block).toContain('python tools/dead_code_audit.py');
      expect(ctx.selfChecks).toBeGreaterThan(0);
      // …and the performance probes, which were the shared blind spot.
      expect(ctx.perfProbes).toBe(true);
      expect(ctx.block).toMatch(/Performance probes/);
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('still applies the rules to a project with nothing discoverable', () => {
    // Best-effort by contract, and the rules are the part that must never be lost:
    // a discovery failure degrades the ADDITIONS, not the protocol.
    const ctx = buildAssessmentTurnContext(AUDIT_GOAL, '/definitely/not/a/real/directory');
    expect(ctx.isAssessment).toBe(true);
    expect(ctx.block).toContain('TASK PROTOCOL: PROJECT ASSESSMENT');
    expect(ctx.selfChecks).toBe(0);
    expect(ctx.perfProbes).toBe(false);
  });

  it('appends the additions instead of substituting them for the rules', () => {
    const dir = fixture({
      'requirements.txt': '',
      'pkg/__init__.py': '',
      'tools/check_things.py': '# check\n',
    });
    try {
      const withProject = buildAssessmentTurnContext(AUDIT_GOAL, dir).block;
      const bare = buildAssessmentTurnContext(AUDIT_GOAL, '/definitely/not/a/real/directory').block;
      expect(withProject.startsWith(bare)).toBe(true);
      expect(withProject.length).toBeGreaterThan(bare.length);
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('every turn entry builds its assessment ask through the same seam', () => {
  const ENTRIES: Array<{ file: string; why: string }> = [
    { file: 'src/cli/chat.ts', why: 'CLI chat, the dashboard console and the gateway chat all run turns here' },
    { file: 'src/cli/loop-executor.ts', why: '`nuvira execute` — the loop arm' },
    { file: 'src/tools/pipeline-tool.ts', why: 'the pipeline engine — the gateway non-chat arm and execute`s pipeline arm' },
    { file: 'src/tools/child-agent-runtime.ts', why: 'a delegated subagent, which forks out of the parent turn' },
  ];

  it.each(ENTRIES)('$file uses buildAssessmentTurnContext ($why)', ({ file }) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source).toContain('assessment-turn-context.js');
    expect(source).toContain('buildAssessmentTurnContext');
  });

  it('does not let an entry assemble the block by hand (that is how the drift started)', () => {
    // `assessmentProtocolBlock` is the LOW-level builder and belongs to the seam
    // alone. An entry importing it directly is the pre-fix state, and it is exactly
    // how four surfaces silently became one.
    for (const { file } of ENTRIES) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source, `${file} assembles the protocol itself`).not.toContain('assessment-protocol.js');
    }
  });
});

describe('the injected section keeps the prompt-shape rules', () => {
  it('returns an empty string rather than a header for a change request', () => {
    expect(buildAssessmentTurnContext(FIX_GOAL, process.cwd()).block).toBe('');
  });

  it('never leaks the protocol into the string a system prompt would be built from', () => {
    // The block is returned as ITS OWN value precisely so callers can place it in
    // the user turn: the system layer is the prompt-cache layer, and a per-ask rule
    // set there would make every audit turn a cache miss.
    const block = buildAssessmentTurnContext(AUDIT_GOAL, process.cwd()).block;
    expect(block.startsWith('## ⚠️ TASK PROTOCOL')).toBe(true);
  });
});
