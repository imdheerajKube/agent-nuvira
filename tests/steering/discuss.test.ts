/**
 * Discuss mode answers from the run's own record.
 *
 * The state this pins: a completed step said images were wired into all
 * surfaces, but the answer context showed only the description, so the model
 * answered "not known from the supplied context". Step notes, acceptance
 * criteria and guidance history are facts the model must see.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { discussContext, discussRun } from '../../src/steering/discuss.js';
import { ensureRun } from '../../src/steering/store.js';
import { commitInitialPlan, createInitialPlan } from '../../src/steering/plan.js';

function freshRun(goal = 'Make the site more appealing with food images'): string {
  const runId = `test-discuss-${randomUUID()}`;
  ensureRun({ runId, goal, cwd: '/tmp/test', engine: 'loop', surface: 'cli' });
  commitInitialPlan(
    createInitialPlan({
      runId,
      goal,
      steps: [
        {
          id: 'step-1',
          description: 'Add food images to the appropriate web page components.',
          status: 'done',
          dependsOn: [],
          acceptanceCriteria: ['Images are responsive and include alt text.'],
          priority: 'normal',
          note: 'Food photos wired into all surfaces (wizard, day cards, plate grid).',
        },
      ],
      constraints: ['Do not change the checkout flow.'],
      createdBy: 'engine',
      reason: 'test fixture',
    }),
  );
  return runId;
}

describe('discuss mode', () => {
  it('includes step notes and acceptance criteria, so coverage is answerable', () => {
    const runId = freshRun();

    const context = discussContext(runId);
    expect(context).toContain('note: Food photos wired into all surfaces');
    expect(context).toContain('acceptance: Images are responsive and include alt text.');
    expect(context).toContain('Do not change the checkout flow.');
  });

  it('reports which source produced the answer and gives the model the step notes', async () => {
    const runId = freshRun();
    let prompt = '';
    const answered = await discussRun({
      runId,
      question: 'Are images in every section?',
      generate: async (messages) => {
        prompt = messages.map((message) => String(message.content)).join('\n');
        return 'The step note says all surfaces were covered.';
      },
    });
    expect(answered.source).toBe('model');
    expect(answered.answer).toContain('all surfaces');
    expect(prompt).toContain('note: Food photos wired into all surfaces');

    const fallback = await discussRun({ runId, question: 'Are images in every section?' });
    expect(fallback.source).toBe('deterministic');
    expect(fallback.answer).toContain('read-only answer');
  });
});
