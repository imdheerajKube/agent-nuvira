/**
 * P0.5 — conversation-vs-pipeline gate tests.
 *
 * The observed failure: "agent can't answer a simple question if asked in
 * execute, it will only create a python program even against a genuine
 * question or clarification." The gate classifies an ask as a conversational
 * question (answer directly) vs a coding goal (pipeline) — deterministically,
 * no model call.
 */

import { describe, it, expect } from 'vitest';
import {
  isConversationalQuestion,
  hasCodingAction,
  resolveAskKind,
  looksLikeAgentCliAsk,
} from '../../src/nlu/conversation-gate.js';
import { parseRequestSync } from '../../src/nlu/parser.js';

describe('isConversationalQuestion — the P0.5 gate', () => {
  it('classifies genuine questions as conversational (answer directly, never the pipeline)', () => {
    for (const q of [
      'why is the test failing?',
      'what is the state of this project?',
      'assess the current state of the project',
      'can you explain how the router works?',
      'how does the auth flow work?',
      'what is a vector database?',
      'why did the build fail?',
      'explain the difference between sync and async',
      'should i use postgres or mysql?',
      'what is the meaning of life?',
      'why does deploy fail?', // "deploy" as a noun — a genuine question
      'what is the fix for this error?', // "fix" as a noun — a genuine question
    ]) {
      expect(isConversationalQuestion(q), q).toBe(true);
    }
  });

  it('classifies coding goals as tasks (run the pipeline), even when phrased as a question', () => {
    for (const q of [
      'fix the failing test in the login module',
      'can you fix the login bug?',
      'how do i add JWT auth to the app?',
      'create an NVDA addon that says hello when I press a key',
      'build a REST api for the inventory',
      'implement the checkout flow',
      'generate an image of a sunset', // canonical: pipeline
      'deploy the api to production',
      'install redis',
      'configure groq with my api key',
      'continue last week\'s ecommerce plan', // canonical: recall pipeline
      'refactor the login module',
      'write a script to parse the csv',
      'please fix the failing test',
      'could you deploy the api?',
    ]) {
      expect(isConversationalQuestion(q), q).toBe(false);
    }
  });

  it('treats bare greetings and acknowledgements as conversational (never a pipeline goal)', () => {
    for (const g of ['hi', 'thanks', 'ok', 'okay', 'yes', 'continue', 'go ahead', 'thank you']) {
      expect(isConversationalQuestion(g), g).toBe(true);
    }
  });

  it('is empty-safe', () => {
    expect(isConversationalQuestion('')).toBe(false);
    expect(isConversationalQuestion(null)).toBe(false);
    expect(isConversationalQuestion(undefined)).toBe(false);
    expect(isConversationalQuestion('   ')).toBe(false);
  });

  it('does not misfire "add 2 + 2" (math, not coding) into a task', () => {
    // "add" at sentence start is NOT a coding verb (mirrors the NLU create
    // rule's article/project-noun gate); only the polite form ("how do I add
    // auth…") is — where the object is code.
    expect(isConversationalQuestion('add 2 + 2')).toBe(true);
    expect(isConversationalQuestion('add Rahul to whatsapp')).toBe(true); // contact, not code
  });
});

describe('hasCodingAction — the command-position coding-verb override', () => {
  it('flags coding verbs in command position (sentence start or polite prefix)', () => {
    expect(hasCodingAction('fix the login bug')).toBe(true);
    expect(hasCodingAction('please create a module for that')).toBe(true);
    expect(hasCodingAction('can you fix the login bug?')).toBe(true);
    expect(hasCodingAction('how do i add JWT auth to the app?')).toBe(true);
    expect(hasCodingAction('could you deploy the api?')).toBe(true);
  });

  it('does NOT flag coding verbs used as nouns in a question', () => {
    // "fix" / "deploy" as nouns: "what is the fix…", "why does deploy fail"
    // are genuine questions — the override must not read them as imperatives.
    expect(hasCodingAction('what is the fix for this error?')).toBe(false);
    expect(hasCodingAction('why does deploy fail?')).toBe(false);
    expect(hasCodingAction('the build is broken')).toBe(false);
  });

  it('does not flag bare "add" at sentence start (math / contact add)', () => {
    expect(hasCodingAction('add 2 + 2')).toBe(false);
    expect(hasCodingAction('add Rahul to whatsapp')).toBe(false);
  });
});

/**
 * resolveAskKind — the ONE routing decision every surface now shares.
 *
 * Before it existed the gateway re-derived the choice from
 * `parseRequestSync().action.run` alone, so the same ask got different answers
 * on different surfaces: "how do I add JWT auth to the app?" (the NLU's
 * explain rule traps it) came back as PROSE on WhatsApp while chat/execute
 * actually did the work; conversely a question shaped like a task still burned
 * a multi-agent pipeline run on WhatsApp.
 */
describe('resolveAskKind — one routing rule for every surface', () => {
  it('routes genuine questions to chat', () => {
    for (const q of [
      'why is the test failing?',
      'assess the current state of the project',
      'How to teach division to a class 4 student? Give some examples.',
      'Write a song in Hindi for my daughter',
      'write a poem and send it to Alex',
      'hi',
    ]) {
      expect(resolveAskKind(q), q).toBe('chat');
    }
  });

  it('routes coding goals to the pipeline', () => {
    for (const g of [
      'fix the failing test',
      'deploy the api',
      'refactor the router',
      'build the dashboard page',
    ]) {
      expect(resolveAskKind(g), g).toBe('pipeline');
    }
  });

  it('regression: a CODING TASK phrased as a question runs the pipeline (was chat on the gateway)', () => {
    // `parseRequestSync` alone returns action.run 'chat' (explain) for these —
    // the gateway used to answer with prose instead of doing the work.
    for (const ask of ['how do I add JWT auth to the app?', 'can you fix the login bug?']) {
      expect(resolveAskKind(ask), ask).toBe('pipeline');
    }
  });

  it('regression: a question shaped like a task is NOT sent to the pipeline', () => {
    for (const q of ['what is the fix for this error?', 'why does deploy fail?']) {
      expect(resolveAskKind(q), q).toBe('chat');
    }
  });

  it('accepts an already-computed parse (the gateway passes the one it already made)', () => {
    const text = 'fix the failing test';
    // Same verdict with or without the caller's parse — no second parse needed.
    expect(resolveAskKind(text)).toBe('pipeline');
    expect(resolveAskKind(text, parseRequestSync(text))).toBe('pipeline');
  });

  it('treats empty/blank input as chat (nothing to run)', () => {
    expect(resolveAskKind('')).toBe('chat');
    expect(resolveAskKind('   ')).toBe('chat');
    expect(resolveAskKind(null)).toBe('chat');
  });
});

/**
 * looksLikeAgentCliAsk — a local CLI command is NOT a coding goal.
 * Observed live: a sender typed a diagnostic command into WhatsApp and the
 * gateway dispatched a SIX-TASK multi-agent pipeline that failed after 112s.
 */
describe('looksLikeAgentCliAsk', () => {
  it('recognises a CLI command aimed at the agent', () => {
    for (const t of [
      'run nuvira gateway status',
      'nuvira gateway status',
      'agent-nuvira models',
      'buff gateway delivery',
      'please run nuvira config gateway',
    ]) {
      expect(looksLikeAgentCliAsk(t), t).toBe(true);
    }
  });

  it('does NOT hijack a normal task that merely names the agent', () => {
    for (const t of [
      'nuvira fix the tests',
      'buff fix the login bug',
      'fix the failing test',
      'write a song for my daughter',
      '',
    ]) {
      expect(looksLikeAgentCliAsk(t), t).toBe(false);
    }
  });
});
