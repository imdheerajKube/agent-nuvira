/**
 * Diagnostic tests for real user scenarios — traces the exact decision path
 * through each NLU rule to identify gaps.
 *
 * Run: npx vitest run tests/nlu/user-scenarios.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  classifyIntent,
  matchExplainRule,
  matchContinueRule,
  matchFixRule,
  matchConfigureRule,
  matchWriteRule,
  matchCreateRule,
} from '../../src/nlu/intent.js';
import { parseRequestSync } from '../../src/nlu/parser.js';
import { resolveAction, resolveDispatch } from '../../src/nlu/actions.js';

// ─── Diagnostic helper ───────────────────────────────────────────────────────

function traceDecision(text: string) {
  const explain = matchExplainRule(text);
  const continue_ = matchContinueRule(text);
  const fix = matchFixRule(text);
  const configure = matchConfigureRule(text);
  const write = matchWriteRule(text);
  const create = matchCreateRule(text);
  const classified = classifyIntent(text);
  const parsed = parseRequestSync(text);
  const dispatch = resolveDispatch(parsed);

  return {
    text,
    rules: { explain, continue: continue_, fix, configure, write, create },
    classified: { intent: classified.intent, confidence: classified.confidence },
    parsed: { intent: parsed.intent, action: parsed.action.name, mode: parsed.mode, run: parsed.action.run },
    dispatch,
  };
}

// ─── User Scenario 1 ─────────────────────────────────────────────────────────

describe('User Scenario 1 — "Create a song for my 9 year old daughter"', () => {
  const TEXT = 'Create a song for my 9 year old daughter, occasion her birthday and her name is kashvi';

  it('traces the decision path', () => {
    const t = traceDecision(TEXT);
    console.log('\n📋 Scenario 1 Decision Trace:');
    console.log('  Text:', TEXT);
    console.log('  Rules matched:', JSON.stringify(t.rules, null, 2));
    console.log('  Classified:', t.classified);
    console.log('  Parsed:', t.parsed);
    console.log('  Dispatch:', t.dispatch);

    // EXPECTED: write intent → chat mode → write action
    // The user wants a SONG (creative content), not a coding pipeline.
    expect(t.parsed.intent).toBe('write');
    expect(t.parsed.mode).toBe('chat');
    expect(t.parsed.run).toBe('chat');
  });

  it('the write rule catches "create a song" as creative content', () => {
    const write = matchWriteRule(TEXT);
    console.log('  Write rule result:', write);
    // "create a song" has writing verb "create" + writing object "song"
    expect(write).not.toBeNull();
    expect(write!.intent).toBe('write');
  });

  it('the create rule returns null (documentNoun guard catches song)', () => {
    const create = matchCreateRule(TEXT);
    console.log('  Create rule result:', create);
    // "song" is in the documentNoun guard → create rule returns null
    // The write rule catches it instead → chat mode
    expect(create).toBeNull();
  });
});

// ─── User Scenario 2 ─────────────────────────────────────────────────────────

describe('User Scenario 2 — "Write a song in hindi for my son Yuvam and Yuvim"', () => {
  const TEXT = 'Write a song in hindi for my son Yuvam and Yuvim to tell them how much i miss them, I am their father Dheeraj';

  it('traces the decision path', () => {
    const t = traceDecision(TEXT);
    console.log('\n📋 Scenario 2 Decision Trace:');
    console.log('  Text:', TEXT);
    console.log('  Rules matched:', JSON.stringify(t.rules, null, 2));
    console.log('  Classified:', t.classified);
    console.log('  Parsed:', t.parsed);
    console.log('  Dispatch:', t.dispatch);

    // EXPECTED: write intent → chat mode → write action
    expect(t.parsed.intent).toBe('write');
    expect(t.parsed.mode).toBe('chat');
    expect(t.parsed.run).toBe('chat');
  });

  it('the write rule catches "write a song in hindi" as creative content', () => {
    const write = matchWriteRule(TEXT);
    console.log('  Write rule result:', write);
    expect(write).not.toBeNull();
    expect(write!.intent).toBe('write');
  });

  it('the creative frame guard in create rule detects "for my son"', () => {
    // The create rule has a creative frame guard: "for my/his/her/our" → write
    // This should prevent "write a song" from being classified as create
    const create = matchCreateRule(TEXT);
    console.log('  Create rule result:', create);
    // If the write rule fires first (higher priority), create is never reached
    // If create fires, the creative frame guard should redirect to write
  });
});

// ─── User Scenario 3 ─────────────────────────────────────────────────────────

describe('User Scenario 3 — "Design a flow chart for folder architecture"', () => {
  const TEXT = 'Design a flow chart for folder architecture';

  it('traces the decision path', () => {
    const t = traceDecision(TEXT);
    console.log('\n📋 Scenario 3 Decision Trace:');
    console.log('  Text:', TEXT);
    console.log('  Rules matched:', JSON.stringify(t.rules, null, 2));
    console.log('  Classified:', t.classified);
    console.log('  Parsed:', t.parsed);
    console.log('  Dispatch:', t.dispatch);

    // EXPECTED: This is ambiguous — could be:
    //   1. write (creative/document creation) → chat mode
    //   2. create (development task) → pipeline
    //   3. unknown → LLM decides
    //
    // The user wants DOCUMENT creation, not code. The model in chat mode
    // can generate the flowchart as text/mermaid. The pipeline would try
    // to create actual code files, which is wrong.
    console.log('\n  ⚠️  ANALYSIS:');
    console.log('  "Design" is not in any rule verb list.');
    console.log('  "flow chart" is not in the writing object list.');
    console.log('  "folder architecture" is not a coding object noun.');
    console.log('  → This should route to CHAT (unknown → LLM decides)');
    console.log('  → The LLM in chat mode can generate the flowchart.');
  });

  it('"Design" is now recognized by the write rule (creative verb)', () => {
    const explain = matchExplainRule(TEXT);
    const write = matchWriteRule(TEXT);
    const create = matchCreateRule(TEXT);
    console.log('  explain:', explain);
    console.log('  write:', write);
    console.log('  create:', create);

    // "design" is now a creative verb in the write rule
    // "flow chart" is a writing object → write intent → chat mode
    expect(explain).toBeNull();
    expect(write).not.toBeNull();
    expect(write!.intent).toBe('write');
    expect(create).toBeNull();
  });

  it('routes to write → chat mode (LLM generates the flowchart)', () => {
    const parsed = parseRequestSync(TEXT);
    console.log('  Current intent:', parsed.intent);
    console.log('  Current action:', parsed.action.name);
    console.log('  Current mode:', parsed.mode);
    console.log('  Current run:', parsed.action.run);

    // "design" is now a creative verb → write intent → chat mode
    // The LLM in chat mode generates the flowchart as text/mermaid
    expect(parsed.intent).toBe('write');
    expect(parsed.action.run).toBe('chat');
  });
});

// ─── Gap Analysis ────────────────────────────────────────────────────────────

describe('Gap Analysis — missing patterns', () => {
  it('identifies missing creative verbs in write rule', () => {
    const missingVerbs = [
      'design a poster',
      'draft a diagram',
      'sketch a wireframe',
      'draw a flowchart',
      'make a mind map',
      'create a mindmap',
      'draw a chart',
      'design a logo',
    ];

    console.log('\n🔍 Missing creative verbs that should route to WRITE (chat):');
    for (const text of missingVerbs) {
      const write = matchWriteRule(text);
      const create = matchCreateRule(text);
      const parsed = parseRequestSync(text);
      const status = parsed.action.run === 'chat' ? '✅' : '❌';
      console.log(`  ${status} "${text}" → ${parsed.intent} (${parsed.action.name}, ${parsed.mode})`);
      if (parsed.action.run !== 'chat') {
        console.log(`    ⚠️  Routes to PIPELINE instead of CHAT`);
      }
    }
  });

  it('identifies missing creative nouns in write rule', () => {
    const missingNouns = [
      'write a poster',
      'write a diagram',
      'write a wireframe',
      'write a flowchart',
      'write a mind map',
      'write a chart',
      'write a logo description',
      'write a brochure',
      'write a flyer',
      'write a pamphlet',
      'write a newsletter',
      'write a report',
      'write a presentation',
      'write a slideshow',
    ];

    console.log('\n🔍 Missing creative nouns that should route to WRITE (chat):');
    for (const text of missingNouns) {
      const write = matchWriteRule(text);
      const create = matchCreateRule(text);
      const parsed = parseRequestSync(text);
      const status = parsed.action.run === 'chat' ? '✅' : '❌';
      console.log(`  ${status} "${text}" → ${parsed.intent} (${parsed.action.name}, ${parsed.mode})`);
    }
  });

  it('identifies missing document-creation patterns', () => {
    const docPatterns = [
      'design a flow chart',
      'create a mind map',
      'draw a diagram',
      'make a wireframe',
      'sketch a layout',
      'draft a blueprint',
      'create a mockup',
      'design an infographic',
      'make a table of contents',
      'create an outline',
    ];

    console.log('\n🔍 Document-creation patterns (should route to CHAT, not pipeline):');
    for (const text of docPatterns) {
      const parsed = parseRequestSync(text);
      const status = parsed.action.run === 'chat' ? '✅' : '❌';
      console.log(`  ${status} "${text}" → ${parsed.intent} (${parsed.action.name}, ${parsed.mode})`);
    }
  });
});
