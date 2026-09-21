/**
 * THE PLAN → BUILD SEQUENCE — the two halves of the flow a user actually
 * performs when they want software built by the agent, and the routing each
 * half must get.
 *
 * Motivation (two live defects, one per direction):
 *
 *  1. "Create a project plan to develop a multiple screen calculator and unit
 *     converter …" ran the developer pipeline and failed 0/7 steps, when the
 *     sender was asking for a PLAN. Fixed by reading the artifact phrase's HEAD
 *     noun (`project` only MODIFIES `plan`).
 *  2. The natural follow-up then went the other way: "Develop the calculator as
 *     per the plan created by agent-nuvira" answered in CHAT, because `plan`
 *     matched the content-artifact list even though it sits in a BACKWARD
 *     REFERENCE to the previous turn — the requested deliverable is the
 *     calculator. A user who asks for a plan and then says "now build it"
 *     cannot be told, politely, that their develop request was answered in
 *     prose.
 *
 * Both halves are pinned here, together with the genuine DEVELOPMENT asks
 * (`build an api`, `write a test`, `create a test for the login function`) that
 * must never be starved of the pipeline by an over-eager content guard — the
 * regression the guard work could plausibly cause.
 */

import { describe, it, expect } from 'vitest';
import { resolveAskKind } from '../../src/nlu/conversation-gate.js';
import { isContentArtifactAsk, stripArtifactReferences } from '../../src/nlu/intent.js';

/** Asks whose deliverable is CONTENT — answered in chat. */
const CHAT_ASKS = [
  // The plan half of the sequence.
  'Get me a plan for a calculator',
  'Give me a plan for a calculator app',
  'create a plan for calculator',
  'get me a plan of calculator',
  'Create a project plan to develop a multiple screen calculator and unit converter, it should be GUI and cross platform for Windows and Linux',
  // Unrelated content asks the same guards cover.
  'Create a plan for diet and exercise to lose weight by 10 KGs in 3 months, i have bad knee',
  'Create a book which teaches maths division for class 4 student',
  'write an essay about my village',
  'make a table of contents',
  // A question that mentions a fix must stay a question.
  'so, what is the fix for this error?',
];

/**
 * The subset that the SHARED content guard itself recognises — as opposed to
 * reaching chat through the NLU action map ("Give me a plan for a calculator
 * app" is a chat ask whose purpose clause names an `app`, so the guard leaves
 * it alone and the action map decides). Both are correct routings; they are
 * asserted separately so a change in either mechanism is attributed to the
 * right one.
 */
const CONTENT_GUARD_ASKS = CHAT_ASKS.filter(
  (a) => !/^give me a plan for a calculator app$/i.test(a) && !/fix for this error/i.test(a),
);

/** Asks whose deliverable is SOFTWARE — the coding pipeline. */
const PIPELINE_ASKS = [
  // The BUILD half of the sequence: the plan is a reference, not the artifact.
  'Develop the calculator as per the plan created by agent-nuvira',
  'Build the calculator now as per the plan you created',
  'Now implement the calculator per the plan',
  'Following the plan, implement the unit converter screen',
  'create the calculator app from the plan',
  // A plan FOR software is a dev plan.
  'create a plan for the ecommerce app',
  'create a test plan for the new module',
  // Genuine development asks, whatever the phrasing.
  'build an api',
  'write a test',
  'fix the failing test',
  'create a test for the login function',
  'create a course website',
  'create a book management API',
  'Then fix the login bug',
];

describe('plan → build sequence routing', () => {
  it.each(CHAT_ASKS)('answers in chat: %s', (ask) => {
    expect(resolveAskKind(ask)).toBe('chat');
  });

  it.each(CONTENT_GUARD_ASKS)('is recognised by the shared content guard: %s', (ask) => {
    expect(isContentArtifactAsk(ask)).toBe(true);
  });

  it.each(PIPELINE_ASKS)('runs the coding pipeline (software deliverable): %s', (ask) => {
    expect(resolveAskKind(ask)).toBe('pipeline');
    expect(isContentArtifactAsk(ask)).toBe(false);
  });

  it('a user can ask for a plan and then have that plan BUILT', () => {
    // The exact flow the reported defect broke, end to end at the routing
    // layer: the plan is answered, and the follow-up is a pipeline job.
    const plan = 'Get me a plan for a calculator';
    const build = 'Develop the calculator as per the plan created by agent-nuvira';
    expect(resolveAskKind(plan)).toBe('chat');
    expect(resolveAskKind(build)).toBe('pipeline');
  });
});

describe('stripArtifactReferences — backward references only', () => {
  it('removes the reference to an earlier artifact, leaving the request intact', () => {
    const stripped = stripArtifactReferences(
      'Develop the calculator as per the plan created by agent-nuvira',
    );
    expect(stripped).not.toMatch(/as per the plan/i);
    expect(stripped).toContain('Develop the calculator');
  });

  it('leaves the artefact the user is actually asking for in place', () => {
    // The words after the reference are the request — stripping a whole
    // sentence would hide the verb and invert the verdict.
    expect(stripArtifactReferences('Following the plan, create a worksheet')).toContain(
      'create a worksheet',
    );
    expect(isContentArtifactAsk('Following the plan, create a worksheet')).toBe(true);
  });

  it('does not touch a NON-artifact noun after the same marker', () => {
    const t = 'generate a report from the data';
    expect(stripArtifactReferences(t)).toBe(t);
    expect(isContentArtifactAsk(t)).toBe(true);
  });
});
