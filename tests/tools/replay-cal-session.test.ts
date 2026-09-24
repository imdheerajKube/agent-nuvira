/**
 * REPLAY — the recorded calculator turn, driven through the real gates.
 *
 * This is not a scenario someone invented to make the fix look good. It is the
 * exact turn that produced the "it asked me for every small thing" complaint,
 * replayed against the current code. The request, the four edits, the
 * `node -c script.js` verification attempt and the four permission questions are
 * all taken verbatim from session `f624a182` in
 * `~/.nuvira/memory/chat-sessions.json` (project `/Users/dheeraj/Documents/cal`).
 *
 * What it measures is the only number that matters to the user: **how many times
 * did it stop and ask me?** The model is not re-run (that would not be
 * reproducible); the GATES are, because the prompt count is entirely a function
 * of them — the recorded turn's actions are fed to the same tools with the same
 * context the loop builds, and the renders are counted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getTool, type ToolContext } from '../../src/tools/registry.js';
import { classifyCommand } from '../../src/tools/run-terminal.js';
import { requestAuthorizesWrites } from '../../src/learning/autonomy-policy.js';
import { envelopeFromRequest } from '../../src/learning/intent-envelope.js';
import { RunTrace } from '../../src/learning/run-trace.js';

/** Turn 38 of session f624a182, verbatim. */
const LIVE_REQUEST =
  'why are you asking me this again and again ? 🤔 Apply a safe expression parser ' +
  '(supporting parentheses, advanced functions, and a degree/radian toggle) by updating ' +
  '`script.js` (replace calculate & scientific functions and add angle‑mode handling)?';

/**
 * The four permission questions the turn actually rendered, in order, verbatim
 * from the dashboard transcript. They are four phrasings of ONE ask — which is
 * why nothing short of comparing the questions themselves can catch the loop.
 */
const LIVE_ASKS = [
  'Run a JavaScript syntax check (`node -c script.js`) to make sure the edits parse?',
  'May I run `node -c script.js` to perform a syntax check?',
  'May I run `node -c script.js` to verify the changes are valid?',
  'Run a JavaScript syntax check (node -c script.js)?',
];

const FIXTURE_SCRIPT = [
  'function calculate() {',
  '  const val = display.value;',
  '  return val;',
  '}',
  'function scientific(op) {',
  '  const val = parseFloat(display.value);',
  '  switch (op) {',
  "    case 'sin': return Math.sin(val);",
  '  }',
  '}',
  '',
].join('\n');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nuvira-replay-'));
  writeFileSync(join(root, 'script.js'), FIXTURE_SCRIPT, 'utf-8');
  writeFileSync(join(root, 'index.html'), '<button id="sin">sin</button>\n', 'utf-8');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface ReplayResult {
  prompts: string[];
  envelopeGranted: boolean;
  verificationRan: boolean;
  verificationNeededConfirm: boolean;
  traceReport: string;
}

/** Drive the recorded turn's actions through the real tools; count the prompts. */
async function replay(): Promise<ReplayResult> {
  const prompts: string[] = [];
  const trace = new RunTrace();
  // ── The context the loop builds for this exact request ────────────────────
  // Before the fix, `requestAuthorizesWrites` vetoed the whole turn because the
  // message OPENS with "why" — so writesAuthorized was false AND there was no
  // envelope, which is why every question reached the user.
  const authorization = requestAuthorizesWrites(LIVE_REQUEST);
  const envelope = envelopeFromRequest(LIVE_REQUEST);
  const ctx: ToolContext = {
    configManager: {},
    cwd: root,
    writesAuthorized: authorization,
    authorizationRequest: LIVE_REQUEST,
    envelope,
    runTrace: trace,
    askUser: async (question: string) => {
      prompts.push(question);
      return { answer: 'Yes, run it', index: 0 };
    },
  };

  // 1. read (the turn began with read_file script.js)
  await getTool('read_file')!.run({ path: 'script.js' }, ctx);

  // 2. the four edits the turn applied
  await getTool('edit_file')!.run(
    { path: 'script.js', old_string: '  return val;\n}', new_string: '  return safeEval(val);\n}' },
    ctx,
  );
  await getTool('edit_file')!.run(
    { path: 'script.js', old_string: "    case 'sin': return Math.sin(val);", new_string: "    case 'sin': return Math.sin(toRadians(val));" },
    ctx,
  );
  await getTool('edit_file')!.run(
    { path: 'script.js', old_string: 'function scientific(op) {', new_string: 'function toRadians(x) { return x; }\nfunction scientific(op) {' },
    ctx,
  );
  await getTool('edit_file')!.run(
    { path: 'script.js', old_string: '  const val = parseFloat(display.value);', new_string: '  const val = safeEval(display.value);' },
    ctx,
  );

  // 3. the verification attempt that got refused and produced the ask loop
  const runResult = await getTool('run_terminal')!.run({ command: 'node -c script.js' }, ctx);
  const verificationRan = /succeeded/.test(runResult);
  const verificationNeededConfirm = /needs explicit confirmation/.test(runResult);

  // 4. the four questions the model then asked, verbatim and in order
  for (const question of LIVE_ASKS) {
    await getTool('ask_user')!.run({ question, choices: [{ label: 'Yes' }, { label: 'No' }] }, ctx);
  }

  return {
    prompts,
    envelopeGranted: envelope !== null,
    verificationRan,
    verificationNeededConfirm,
    traceReport: trace.selfReport(),
  };
}

describe('REPLAY — session f624a182 turn 38, through the current gates', () => {
  it('produces ZERO prompts where the live turn produced FOUR', async () => {
    const result = await replay();
    // eslint-disable-next-line no-console
    console.log(
      `\n  replay: permission prompts ${result.prompts.length} (was 4) · ` +
        `envelope granted=${result.envelopeGranted} · ` +
        `\`node -c\` ran=${result.verificationRan} needed-confirm=${result.verificationNeededConfirm}`,
    );
    // TWO independent mechanisms remove the prompts, and either alone would keep
    // this turn quiet: the syntax check is no longer gated at all (so the model
    // never hits the refusal that made it ask), and the questions are suppressed
    // by the live envelope and then by the repetition gate. Pinned at zero
    // because that is the measured behaviour AND the intent — a future change
    // that starts showing prompts here should fail loudly.
    expect(result.prompts).toEqual([]);
  });

  it('the request is now AUTHORIZED — the leading question no longer vetoes it', () => {
    // The single fact that switched every gate off in the live turn.
    const auth = requestAuthorizesWrites(LIVE_REQUEST);
    expect(auth.authorized).toBe(true);
    // The verdict names a real directive clause (this turn's second clause: add
    // angle-mode handling to `script.js`), not "asks about the work".
    expect(auth.reason).toMatch(/deliverable|change to work that already exists/);
  });

  it('a durable envelope is granted, so the gates can settle the later asks', async () => {
    const result = await replay();
    expect(result.envelopeGranted).toBe(true);
  });

  it('a read-only syntax check now RUNS — it never needed permission', async () => {
    expect(classifyCommand('node -c script.js')).toBe('verify');
    const result = await replay();
    expect(result.verificationRan).toBe(true);
    expect(result.verificationNeededConfirm).toBe(false);
  });

  it('the repeated asks are refused, and the run can say what it did', async () => {
    const result = await replay();
    const report = result.traceReport;
    // The material for answering "why are you asking me this again and again?".
    expect(report).toMatch(/You asked 4 question\(s\)/);
    expect(report).toMatch(/repeated a question you had already asked/);
    // The edits landed: the intent covered them.
    expect(readFileSync(join(root, 'script.js'), 'utf-8')).toContain('safeEval');
  });
});
