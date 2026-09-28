/**
 * Example agent tests — written the way the SDK's testing utilities are meant to
 * be used: a typed mock context, a canned LLM, and the result assertions.
 *
 * Run with `npm test` inside examples/sdk, or from the repo root with
 * `npm run examples:verify`.
 */

import { describe, it, expect } from 'vitest';
import {
  createMockContext,
  createMockLLM,
  runAgentTest,
  assertAgentSuccess,
  assertAgentFailure,
} from '@agent-nuvira/sdk/testing';

import { ConventionalCommitAgent, agentDescriptor } from '../src/index.js';

describe('ConventionalCommitAgent', () => {
  const agent = new ConventionalCommitAgent();

  it('drafts a valid subject and keeps the full message in details', async () => {
    const context = createMockContext({
      goal: 'Add pagination to the issues endpoint',
      artifacts: [{ path: 'src/api/issues.ts', content: '+page, +perPage', description: 'diff' }],
    });
    const callLLM = createMockLLM('feat(api): add pagination to issues endpoint\n\nAdds page/per_page query params.');

    const result = await runAgentTest(agent, context, callLLM);

    assertAgentSuccess(result);
    expect(result.summary).toBe('feat(api): add pagination to issues endpoint');
    expect(result.details).toContain('Adds page/per_page query params.');
  });

  it('asks the model for a low-temperature, short answer', async () => {
    const context = createMockContext({ goal: 'Fix a typo in the README' });
    const callLLM = createMockLLM('docs: fix typo in README');

    await runAgentTest(agent, context, callLLM);

    expect(callLLM.prompts[0].options?.temperature).toBe(0.2);
    expect(callLLM.prompts[0].options?.maxTokens).toBe(200);
    // The prompt carries the goal and the Conventional Commits rules.
    expect(callLLM.prompts[0].prompt).toContain('Fix a typo in the README');
    expect(callLLM.prompts[0].prompt).toContain('Conventional Commits');
  });

  it('rejects model output that is not a Conventional Commits subject', async () => {
    const context = createMockContext({ goal: 'Tidy up the parser' });
    const callLLM = createMockLLM('I tidied up the parser for you.');

    const result = await runAgentTest(agent, context, callLLM);

    assertAgentFailure(result, 'Invalid subject');
  });

  it('fails when the model returns nothing', async () => {
    const context = createMockContext({ goal: 'Anything' });
    const result = await runAgentTest(agent, context, createMockLLM('   '));
    assertAgentFailure(result);
  });

  it('refuses to run with no description and no artifacts', async () => {
    const context = createMockContext({ goal: '   ' });
    const result = await runAgentTest(agent, context, createMockLLM('feat: x'));
    assertAgentFailure(result, 'Provide a change description');
  });

  it('exposes a descriptor whose agentType is derived from the class name', () => {
    expect(agentDescriptor.name).toBe('ConventionalCommit');
    expect(agentDescriptor.agentType).toBe('conventional-commit');
    expect(agentDescriptor.tags).toBe('git, commit, example');
  });
});
