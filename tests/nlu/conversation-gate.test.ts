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
  explainAskKind,
  isConversationalQuestion,
  hasCodingAction,
  isLongFormDeliverable,
  resolveAskKind,
  looksLikeAgentCliAsk,
} from '../../src/nlu/conversation-gate.js';
import { parseRequestSync } from '../../src/nlu/parser.js';
import { isAuthoredGoal } from '../../src/learning/deliverable-class.js';

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

/**
 * A long-form authored deliverable must reach the machinery that can finish it.
 *
 * Live evidence: "write a 12 page story called Kharig Nights about a village boy
 * who finds a lamp in a banyan root" was read as a conversational question (the
 * NLU maps `write` to a chat action) and answered in ONE reply — no unit ledger,
 * no progress measurement, no unattended continuation. Fine-looking for 12
 * pages; fatal for "write a 200 page book", which is the ask this whole
 * workstream exists to serve.
 */
describe('isLongFormDeliverable — a book is never a conversational question', () => {
  it('routes an explicit multi-unit prose ask to the pipeline', () => {
    expect(isLongFormDeliverable('write a 200 page book about the sea')).toBe(true);
    expect(isLongFormDeliverable('write a 12 page story called Kharig Nights about a boy')).toBe(true);
    expect(isLongFormDeliverable('tell me a story in 8 chapters about rain')).toBe(true);
    expect(isConversationalQuestion('write a 200 page book about the sea')).toBe(false);
    expect(resolveAskKind('write a 200 page book about the sea')).toBe('pipeline');
    expect(explainAskKind('write a 200 page book about the sea').base).toBe('pipeline');
  });

  it('keeps a short ask conversational — one generation IS the answer', () => {
    expect(isLongFormDeliverable('write a poem about rain')).toBe(false);
    expect(isLongFormDeliverable('write a 1 page summary of the meeting')).toBe(false);
    expect(isConversationalQuestion('write a poem about rain')).toBe(true);
  });

  it('does NOT invent a magnitude for a bare "book"', () => {
    // The classifier defaults an unnumbered book to 10 chapters; a DEFAULT is
    // not something the user asked for, so it must not re-route the ask.
    expect(isLongFormDeliverable('write a book about the sea')).toBe(false);
    expect(resolveAskKind("Create a book which teaches math's devision for class 4 student")).toBe('chat');
  });

  it('does not push a long CONTENT-artifact ask into the code pipeline', () => {
    // 20 pages, but the authored classifier does not read it as content the
    // pipeline can plan — sending it there would plan a PROGRAM for prose, the
    // original category error.
    expect(isAuthoredGoal('write a 20 page plan for my child')).toBe(false);
    expect(isLongFormDeliverable('write a 20 page plan for my child')).toBe(false);
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

  it('does NOT flag a non-coding artifact ask (plan/routine/schedule) as coding', () => {
    // Live incident: "Can you create plan to enable my child learn spoken
    // English" on WhatsApp ran the developer pipeline, whose planner produced a
    // Python program. "plan" here is a document, not a software deliverable.
    expect(hasCodingAction('Can you create plan to enable my child learn spoken English')).toBe(false);
    expect(hasCodingAction('create a study plan for class 4')).toBe(false);
    expect(hasCodingAction('Create a daily routine for my kid to learn English')).toBe(false);
    expect(hasCodingAction('create a workout plan')).toBe(false);
  });

  it('still flags a plan FOR code (a coding object keeps it a dev task)', () => {
    expect(hasCodingAction('create a plan for the ecommerce app')).toBe(true);
    expect(hasCodingAction('create a plan for the API migration')).toBe(true);
    expect(hasCodingAction('create a CLI tool')).toBe(true);
  });

  it('also clears prose/document deliverables (book, course, guide, list)', () => {
    // Same object-blindness one step out: the create verb alone put a BOOK on
    // the developer pipeline (observed 2026-09-21).
    expect(hasCodingAction("create a book which teaches math's devision for class 4 student")).toBe(false);
    expect(hasCodingAction('create a course on spoken english')).toBe(false);
    expect(hasCodingAction('make a weekly grocery list')).toBe(false);
    // …but a content noun PLUS a software deliverable is still coding.
    expect(hasCodingAction('create a book management API')).toBe(true);
    expect(hasCodingAction('create a course website')).toBe(true);
    expect(hasCodingAction('create a script to back up files')).toBe(true);
  });

  it('routes all THREE ambiguous asks to chat — the head noun decides', () => {
    // All three open with "Create a …" — only the object distinguishes them.
    // Live asks, 2026-09-21.
    expect(
      resolveAskKind('Create a plan for diet and exercise to loose weight by 10 KGs in 3 months , i have bad knee'),
    ).toBe('chat');
    // DECISION 2026-09-21: this one previously ran the pipeline, and failed
    // 0/7 steps, when the sender was asking for a plan. The head noun of the
    // requested artifact is `plan`; "project" is a MODIFIER of it (what the
    // plan covers), not a deliverable being requested — so it is answered in
    // chat like the other two. A software noun in a PURPOSE clause is still a
    // coding object: "create a plan for the ecommerce app" stays on the
    // pipeline (see the gate's "plan FOR code" case below).
    expect(
      resolveAskKind(
        'Create a project plan to develop a multiple screen calculator and unit converter , it should be GUI and cross platform for Windows and Linux',
      ),
    ).toBe('chat');
    expect(resolveAskKind("Create a book which teaches math's devision for class 4 student")).toBe('chat');
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
      'create a plan for the ecommerce app', // a plan FOR code is still a dev plan
    ]) {
      expect(resolveAskKind(g), g).toBe('pipeline');
    }
  });

  it('routes non-coding artifact asks (teaching/fitness/life plans) to chat', () => {
    for (const q of [
      'Can you create plan to enable my child learn spoken English',
      'Create a daily routine for my kid to learn English',
      'Create a study plan for class 4',
      'create a workout plan',
      'build a schedule for my week',
      'make a diet chart for me',
    ]) {
      expect(resolveAskKind(q), q).toBe('chat');
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
