import { describe, it, expect } from 'vitest';
import {
  classifyIntent,
  matchExplainRule,
  matchContinueRule,
  matchFixRule,
  matchConfigureRule,
  matchCreateRule,
  matchWriteRule,
  isNonCodeArtifactAsk,
  isContentArtifactAsk,
  extractTimeRange,
  RULE_TRUST_THRESHOLD,
  type IntentResult,
  type ModeHint,
} from '../../src/nlu/intent.js';

/** Deterministic "today" so temporal tests never depend on wall-clock time. */
const REF = new Date('2026-08-09T12:00:00Z');

// ─── Rule matrix ────────────────────────────────────────────────────────────

const RULE_MATRIX: Array<[string, IntentResult]> = [
  // create → dev
  ['create a new CLI tool', { intent: 'create', confidence: 0.9, modeHint: 'dev' }],
  ['please implement JWT auth', { intent: 'create', confidence: 0.9, modeHint: 'dev' }],
  ['build an api', { intent: 'create', confidence: 0.85, modeHint: 'dev' }],
  ['write a test', { intent: 'create', confidence: 0.85, modeHint: 'dev' }],
  ['I want to create a new module', { intent: 'create', confidence: 0.85, modeHint: 'dev' }],
  // continue → recall
  ["continue last week's ecommerce plan", { intent: 'continue', confidence: 0.95, modeHint: 'recall' }],
  ['resume the migration', { intent: 'continue', confidence: 0.9, modeHint: 'recall' }],
  ['pick up where I left off', { intent: 'continue', confidence: 0.9, modeHint: 'recall' }],
  // fix → execute
  ['fix the login bug', { intent: 'fix', confidence: 0.85, modeHint: 'execute' }],
  ['debug the failing test', { intent: 'fix', confidence: 0.85, modeHint: 'execute' }],
  ['resolve the merge conflict', { intent: 'fix', confidence: 0.85, modeHint: 'execute' }],
  // explain → chat
  ['explain how caching works', { intent: 'explain', confidence: 0.8, modeHint: 'chat' }],
  ['assess the current state of the project', { intent: 'explain', confidence: 0.8, modeHint: 'chat' }],
  ['evaluate whether the migration is safe', { intent: 'explain', confidence: 0.8, modeHint: 'chat' }],
  ['analyze the performance of the query', { intent: 'explain', confidence: 0.8, modeHint: 'chat' }],
  ['compare the two approaches', { intent: 'explain', confidence: 0.8, modeHint: 'chat' }],
  ['how do I add JWT auth to Express?', { intent: 'explain', confidence: 0.8, modeHint: 'chat' }],
  ['what is the difference between arrays and lists', { intent: 'explain', confidence: 0.8, modeHint: 'chat' }],
  // "add" — the most common developer phrasing (article or project-object only,
  // never bare verb-initial, so "add 2 + 2" stays out of dev mode)
  ['add a route to the express app', { intent: 'create', confidence: 0.85, modeHint: 'dev' }],
  ['add error handling to the api', { intent: 'create', confidence: 0.85, modeHint: 'dev' }],
  // configure → config
  ['configure the gemini api key', { intent: 'configure', confidence: 0.85, modeHint: 'config' }],
  ['switch provider to groq', { intent: 'configure', confidence: 0.85, modeHint: 'config' }],
  ['change model for this project', { intent: 'configure', confidence: 0.85, modeHint: 'config' }],
];

describe('classifyIntent — rule matrix', () => {
  it.each(RULE_MATRIX)('classifies %j', (text, expected) => {
    const result = classifyIntent(text, REF);
    expect(result.intent).toBe(expected.intent);
    expect(result.modeHint).toBe(expected.modeHint);
    expect(result.confidence).toBe(expected.confidence);
  });

  it('prioritizes explain over create for "how to build" questions', () => {
    const result = classifyIntent('how do I build a website?', REF);
    expect(result.intent).toBe('explain');
    expect(result.modeHint).toBe('chat');
  });

  it('prioritizes continue over create for "continue building"', () => {
    const result = classifyIntent('continue building the app', REF);
    expect(result.intent).toBe('continue');
    expect(result.modeHint).toBe('recall');
  });

  it('never false-positives "the build failed" into create', () => {
    const result = classifyIntent('the build failed with a syntax error', REF);
    expect(result.intent).not.toBe('create');
  });

  it('never false-positives "make sure tests pass" into create', () => {
    const result = classifyIntent('make sure the tests pass before merging', REF);
    expect(result.intent).not.toBe('create');
  });

  it('never false-positives arithmetic "add" into create', () => {
    const result = classifyIntent('please add 2 + 2 and explain', REF);
    expect(result.intent).toBe('explain');
  });

  it('classifies "create a config file" as create, not configure', () => {
    const result = classifyIntent('create a config file', REF);
    expect(result.intent).toBe('create');
    expect(result.modeHint).toBe('dev');
  });

  it('still classifies "configure the gemini api key" as configure', () => {
    const result = classifyIntent('configure the gemini api key', REF);
    expect(result.intent).toBe('configure');
    expect(result.modeHint).toBe('config');
  });

  it('treats the empty string as unknown', () => {
    const result = classifyIntent('   ', REF);
    expect(result).toEqual({ intent: 'unknown', confidence: 0, modeHint: null });
  });

  it('never routes a non-coding artifact (teaching/fitness/life plan) into dev mode', () => {
    // Live incident: the WhatsApp ask "Can you create plan to enable my child
    // learn spoken English" hit the verb-initial create branch and ran the
    // developer pipeline (a Python SpeechRecognition/gTTS program).
    for (const ask of [
      'Can you create plan to enable my child learn spoken English',
      'Create a study plan for class 4',
      'create a workout plan',
      'Create a daily routine for my kid to learn English',
    ]) {
      const result = classifyIntent(ask, REF);
      expect(result.modeHint, ask).toBe('chat');
      expect(result.intent, ask).not.toBe('create');
    }
  });

  it('still routes a plan FOR code into dev mode', () => {
    const result = classifyIntent('create a plan for the ecommerce app', REF);
    expect(result.intent).toBe('create');
    expect(result.modeHint).toBe('dev');
  });
});

// ─── Non-coding artifacts ────────────────────────────────────────────────────

describe('isNonCodeArtifactAsk', () => {
  it('is true for a planning/lifestyle artifact with no coding object', () => {
    for (const t of [
      'create a plan for my child',
      'create a study plan for class 4',
      'make a diet chart for me',
      'build a schedule for my week',
      "continue last week's ecommerce plan", // artifact, but continue wins earlier
    ]) {
      expect(isNonCodeArtifactAsk(t), t).toBe(true);
    }
  });

  it('is false when the ask names a software deliverable', () => {
    for (const t of [
      'create a plan for the ecommerce app',
      'create a project plan for the API migration',
      'create a test plan for the new module',
      'fix the login bug',
    ]) {
      expect(isNonCodeArtifactAsk(t), t).toBe(false);
    }
  });

  it('classifies an artifact ask as write/chat via the rules', () => {
    expect(matchCreateRule('create a study plan for class 4')).toBeNull();
    expect(matchWriteRule('create a study plan for class 4')?.modeHint).toBe('chat');
  });
});

/**
 * OBJECT-BLINDNESS AUDIT — every rule that keys off a VERB is blind to that
 * verb's object on its own, so "create plan …", "build a routine", "fix my diet
 * plan" and "create a test for class 4" all read as coding tasks. This pins the
 * content-vs-code separation for each affected rule, in both directions, so a
 * future verb-list change cannot silently re-open the hole.
 */
describe('intent rules — object-blindness audit (content vs code)', () => {
  const CONTENT_ASKS = [
    'create a test for class 4', // academic test, not a software test
    'create a maths quiz for class 5',
    'create notes for class 4 science',
    'make a worksheet for grade 3',
    'create an exam paper for grade 8',
    'build a routine',
    'fix my diet plan',
    "correct my child's worksheet",
    'create a study plan for class 4',
    // Prose/document deliverables — the same object-blindness one step out.
    // Observed live (2026-09-21): "create a book which teaches maths division
    // for class 4 student" → create/dev → the developer pipeline, whose planner
    // is a senior software architect.
    "create a book which teaches math's devision for class 4 student",
    'create a book on gardening for beginners',
    'create a course on spoken english',
    'make a weekly grocery list',
    'create a guide for new parents',
    'make a table of contents',
  ];

  const CODE_ASKS: Array<[string, ModeHint]> = [
    ['create a test for the login function', 'dev'],
    ['write a test for the payment module', 'dev'],
    ['create a test suite for the API', 'dev'],
    ['create a plan for the ecommerce app', 'dev'],
    ['build a REST api', 'dev'],
    ['test the API', 'dev'],
    ['fix the failing test', 'execute'],
    // A CONTENT noun plus a coding noun stays a coding task — the guard is
    // vetoed by the software deliverable, not by the verb.
    ['create a book management API', 'dev'],
    ['create a course website', 'dev'],
    ['create a script to back up files', 'dev'],
    ['make a post endpoint handler', 'dev'],
  ];

  it('isContentArtifactAsk separates schoolwork/content from software', () => {
    for (const ask of CONTENT_ASKS) expect(isContentArtifactAsk(ask), ask).toBe(true);
    for (const [ask] of CODE_ASKS) expect(isContentArtifactAsk(ask), ask).toBe(false);
  });

  it('routes every content ask to chat and every code ask to its pipeline', () => {
    for (const ask of CONTENT_ASKS) {
      const result = classifyIntent(ask, REF);
      expect(result.modeHint, ask).toBe('chat');
      expect(result.intent, ask).not.toBe('create');
      expect(result.intent, ask).not.toBe('fix');
    }
    for (const [ask, mode] of CODE_ASKS) {
      expect(classifyIntent(ask, REF).modeHint, ask).toBe(mode);
    }
  });

  it('the FILTER/FIX rule no longer sends a life artifact to the debugger', () => {
    // Regression: the fix rule keys off the verb anywhere in the text, so
    // "fix my diet plan" ran the debugging pipeline (planner + runner +
    // debugger) instead of answering the content request.
    expect(matchFixRule('fix my diet plan')).toBeNull();
    expect(matchFixRule("correct my child's worksheet")).toBeNull();
    // A real code fix still wins.
    expect(matchFixRule('fix the failing test')?.intent).toBe('fix');
    expect(matchFixRule('debug the login module')?.intent).toBe('fix');
  });

  it('the CREATE rule no longer sends an academic or planning artifact to the pipeline', () => {
    expect(matchCreateRule('create a test for class 4')).toBeNull();
    expect(matchCreateRule('make a worksheet for grade 3')).toBeNull();
    expect(matchCreateRule('create a plan for my child')).toBeNull();
    // Books/courses/guides are prose, not software. "script" is deliberately
    // NOT a content noun — "create a script to back up files" stays dev.
    expect(matchCreateRule("create a book which teaches math's devision for class 4 student")).toBeNull();
    expect(matchCreateRule('create a course on spoken english')).toBeNull();
    expect(matchCreateRule('create a script to back up files')?.modeHint).toBe('dev');
    expect(matchCreateRule('create a book management API')?.modeHint).toBe('dev');
    // "report generator" is the ambiguous pair that classifies as NEITHER rule
    // (document noun vetoes create, code noun vetoes write) — it must still
    // dispatch, which the gate's command-position override guarantees.
    expect(matchCreateRule('create a report generator tool')).toBeNull();
    // Coding objects still resolve to dev mode.
    expect(matchCreateRule('create a test for the login function')?.modeHint).toBe('dev');
    expect(matchCreateRule('create a CLI tool')?.modeHint).toBe('dev');
  });
});

// ─── Unknown → confidence 0 (never a guess) ─────────────────────────────────

describe('classifyIntent — unknown contract', () => {
  it.each(['hello there', 'thanks!', 'random gibberish 42'])(
    'returns confidence 0 for %j',
    (text) => {
      const result = classifyIntent(text, REF);
      expect(result.intent).toBe('unknown');
      expect(result.confidence).toBe(0);
      expect(result.modeHint).toBeNull();
      expect(result.timeRange).toBeUndefined();
    },
  );
});

// ─── Temporal extraction ────────────────────────────────────────────────────

describe('extractTimeRange', () => {
  it("extracts a date range for 'last week'", () => {
    const range = extractTimeRange("continue last week's ecommerce plan", REF);
    expect(range).toBeDefined();
    expect(range!.text).toBe('last week');
    expect(range!.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(range!.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(range!.timex).toMatch(/^\d{4}-W\d{2}$/); // ISO week notation
  });

  it("extracts a point date for 'yesterday'", () => {
    const range = extractTimeRange('continue yesterday work', REF);
    expect(range).toBeDefined();
    expect(range!.text).toBe('yesterday');
    expect(range!.start).toBe('2026-08-08');
  });

  it("extracts a point date for '2 days ago'", () => {
    const range = extractTimeRange('resume the plan from 2 days ago', REF);
    expect(range).toBeDefined();
    expect(range!.text).toBe('2 days ago');
    expect(range!.start).toBe('2026-08-07');
  });

  it('returns undefined for text without temporal references', () => {
    expect(extractTimeRange('resume the migration', REF)).toBeUndefined();
    expect(extractTimeRange('fix the login bug', REF)).toBeUndefined();
  });

  it('attaches timeRange only on the continue intent', () => {
    const result = classifyIntent("continue last week's ecommerce plan", REF);
    expect(result.timeRange).toBeDefined();
    expect(result.confidence).toBe(0.95);

    const noTemporal = classifyIntent('resume the migration', REF);
    expect(noTemporal.timeRange).toBeUndefined();
    expect(noTemporal.confidence).toBe(0.9);
  });
});

// ─── Pure rule functions ────────────────────────────────────────────────────

describe('rule functions are pure', () => {
  it('matchExplainRule', () => {
    expect(matchExplainRule('explain how caching works')?.intent).toBe('explain');
    expect(matchExplainRule('create a cli tool')).toBeNull();
  });

  it('matchContinueRule', () => {
    expect(matchContinueRule('resume the plan', REF)?.intent).toBe('continue');
    expect(matchContinueRule('fix the bug', REF)).toBeNull();
  });

  it('matchFixRule', () => {
    expect(matchFixRule('fix the login bug')?.intent).toBe('fix');
    expect(matchFixRule('debug the failing test')?.intent).toBe('fix');
    expect(matchFixRule('explain how caching works')).toBeNull();
  });

  it('does NOT treat hyphen/underscore identifiers as fix keywords (live bug: nuvira-fix-validation)', () => {
    // A project/branch name containing the substring "fix" is NOT a fix request —
    // the old \\b word-boundary regex matched inside the hyphenated token and
    // misrouted a deploy goal into the debugging pipeline (runner → debugger).
    expect(matchFixRule('Deploy this website to Cloudflare Pages using project nuvira-fix-validation')).toBeNull();
    expect(matchFixRule('publish branch fix-123 to production')).toBeNull();
    expect(matchFixRule('checkout the hotfix_2024 branch')).toBeNull();
    // Real fix intent still matches.
    expect(matchFixRule('fix the login bug')?.intent).toBe('fix');
    expect(matchFixRule('please debug the failing test')?.intent).toBe('fix');
  });

  it('classifies a deploy goal as NOT fix (even with hyphenated project names)', () => {
    const result = classifyIntent(
      'Deploy this website to Cloudflare Pages. Use the project name nuvira-fix-validation. Verify the live URL with curl.',
      REF,
    );
    expect(result.intent).not.toBe('fix');
  });

  it('matchConfigureRule', () => {
    expect(matchConfigureRule('configure the gemini api key')?.intent).toBe('configure');
    expect(matchConfigureRule('create a cli tool')).toBeNull();
  });

  it('matchCreateRule', () => {
    expect(matchCreateRule('create a new CLI tool')?.intent).toBe('create');
    expect(matchCreateRule('the build failed')?.intent).toBeUndefined();
  });

  it('exports a trust threshold above every rule confidence', () => {
    for (const [text] of RULE_MATRIX) {
      const result = classifyIntent(text, REF);
      expect(result.confidence).toBeGreaterThanOrEqual(RULE_TRUST_THRESHOLD);
    }
  });
});

// ─── Performance budget ─────────────────────────────────────────────────────

describe('performance budget', () => {
  it('classifies the full matrix in <5ms average (zero network, pure rules)', () => {
    const texts = RULE_MATRIX.map(([t]) => t);
    // Warm-up (module init + recognizer lazy state).
    for (let i = 0; i < 50; i++) classifyIntent(texts[i % texts.length], REF);
    const iterations = 200;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      classifyIntent(texts[i % texts.length], REF);
    }
    const avgMs = (performance.now() - start) / iterations;
    expect(avgMs).toBeLessThan(5);
  });
});
