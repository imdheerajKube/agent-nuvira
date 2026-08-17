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
import { isConversationalQuestion, hasCodingAction } from '../../src/nlu/conversation-gate.js';

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
