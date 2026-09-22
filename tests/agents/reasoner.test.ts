/**
 * Tests for the ReasonerAgent — technical decision layer.
 *
 * Verifies:
 * - Reasoner parses valid JSON responses correctly
 * - Reasoner handles malformed LLM responses gracefully
 * - Technical decisions are stored in vault.context.metadata
 * - Reasoner injects decisions into planner prompt
 * - Greenfield vs existing project detection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReasonerAgent } from '../../src/agents/agents/reasoner.js';
import type { AgentContext, LLMCallFn } from '../../src/agents/agent.js';
import { ContextVault } from '../../src/agents/context-vault.js';

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  const vault = new ContextVault();
  return {
    goal: 'create a snake and ladder game for windows GUI',
    workingDirectory: '/tmp/test',
    fileChanges: [],
    metadata: vault.context.metadata,
    vault,
    ...overrides,
  };
}

function makeCallLLM(response: string): LLMCallFn {
  return vi.fn().mockResolvedValue(response);
}

describe('ReasonerAgent', () => {
  let agent: ReasonerAgent;

  beforeEach(() => {
    agent = new ReasonerAgent();
  });

  it('parses a valid JSON response and stores technical decision', async () => {
    const llmResponse = JSON.stringify({
      language: 'python',
      framework: 'tkinter',
      platform: 'windows-gui',
      architecture: 'single-file',
      dependencies: ['pyinstaller'],
      buildCommand: 'pyinstaller --onefile game.py',
      deliverable: 'executable (.exe)',
      constraints: ['must run on Windows', 'must have GUI'],
      isGreenfield: true,
      confidence: 0.9,
      reasoning: 'Python+tkinter is the simplest cross-platform GUI option for a board game',
    });

    const context = makeContext();
    const result = await agent.execute(context, makeCallLLM(llmResponse));

    expect(result.success).toBe(true);
    expect(result.summary).toContain('python');
    expect(result.summary).toContain('tkinter');

    // Verify the decision was stored in metadata
    const decision = context.metadata.technicalDecision;
    expect(decision).toBeDefined();
    expect(decision.language).toBe('python');
    expect(decision.framework).toBe('tkinter');
    expect(decision.platform).toBe('windows-gui');
    expect(decision.architecture).toBe('single-file');
    expect(decision.dependencies).toEqual(['pyinstaller']);
    expect(decision.buildCommand).toBe('pyinstaller --onefile game.py');
    expect(decision.deliverable).toBe('executable (.exe)');
    expect(decision.constraints).toEqual(['must run on Windows', 'must have GUI']);
    expect(decision.isGreenfield).toBe(true);
    expect(decision.confidence).toBe(0.9);
  });

  it('handles markdown-wrapped JSON response', async () => {
    const llmResponse = '```json\n' + JSON.stringify({
      language: 'typescript',
      framework: 'react',
      platform: 'web',
      architecture: 'multi-file',
      dependencies: ['react', 'react-dom'],
      deliverable: 'web-app',
      constraints: [],
      isGreenfield: true,
      confidence: 0.8,
      reasoning: 'React is best for web UIs',
    }) + '\n```';

    const context = makeContext({ goal: 'create a web app' });
    const result = await agent.execute(context, makeCallLLM(llmResponse));

    expect(result.success).toBe(true);
    const decision = context.metadata.technicalDecision;
    expect(decision.language).toBe('typescript');
    expect(decision.framework).toBe('react');
    expect(decision.platform).toBe('web');
  });

  it('handles malformed JSON gracefully', async () => {
    const llmResponse = 'I think we should use Python because...';
    const context = makeContext();
    const result = await agent.execute(context, makeCallLLM(llmResponse));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not parse');
  });

  it('handles JSON with missing required fields', async () => {
    const llmResponse = JSON.stringify({
      language: 'python',
      // missing framework and platform
    });

    const context = makeContext();
    const result = await agent.execute(context, makeCallLLM(llmResponse));

    expect(result.success).toBe(false);
  });

  it('handles LLM errors gracefully', async () => {
    const failingLLM = vi.fn().mockRejectedValue(new Error('API error'));
    const context = makeContext();
    const result = await agent.execute(context, failingLLM);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Reasoning failed');
  });

  it('provides defaults for optional fields', async () => {
    const llmResponse = JSON.stringify({
      language: 'python',
      framework: 'tkinter',
      platform: 'windows-gui',
    });

    const context = makeContext();
    const result = await agent.execute(context, makeCallLLM(llmResponse));

    expect(result.success).toBe(true);
    const decision = context.metadata.technicalDecision;
    expect(decision.architecture).toBe('single-file'); // default
    expect(decision.dependencies).toEqual([]); // default
    expect(decision.deliverable).toBe('unknown'); // default
    expect(decision.isGreenfield).toBe(false); // default
    expect(decision.confidence).toBe(0.5); // default
  });
});

describe('Technical decision injection into planner prompt', () => {
  it('reasoner decision is accessible via context.metadata', () => {
    const vault = new ContextVault();
    const decision = {
      language: 'python',
      framework: 'tkinter',
      platform: 'windows-gui',
      architecture: 'single-file',
      dependencies: ['pyinstaller'],
      buildCommand: 'pyinstaller --onefile game.py',
      deliverable: 'executable (.exe)',
      constraints: ['must run on Windows'],
      isGreenfield: true,
      confidence: 0.9,
      reasoning: 'Best for GUI board games',
    };

    vault.setMeta('technicalDecision', decision);

    const retrieved = vault.getMeta<typeof decision>('technicalDecision');
    expect(retrieved).toBeDefined();
    expect(retrieved.language).toBe('python');
    expect(retrieved.framework).toBe('tkinter');
  });
});

/**
 * G7 — the authored-deliverable gate.
 *
 * Live failure: for "write a 100-page story" the reasoner emitted
 *   { "language": "python", "framework": "none", "deliverable": "markdown_file",
 *     "reasoning": "…a Python script is the most efficient way to read existing
 *                   chapters, process the outline, and update the target file…" }
 * and the planner dutifully turned that into a plan with no prose steps.
 * A weak model must not be able to reintroduce that category error, so the
 * classifier's verdict is enforced after parsing.
 */
describe('ReasonerAgent — authored deliverables (G7)', () => {
  const storyGoal = 'write a 100 page story about magic and suspense like Harry Potter';

  /** The exact decision shape the live run produced for the story ask. */
  const MISFRAMED = JSON.stringify({
    language: 'python',
    framework: 'none',
    platform: 'cli',
    architecture: 'multi-file',
    dependencies: ['os'],
    buildCommand: 'none',
    deliverable: 'markdown_file',
    constraints: ['Must append content to story.md'],
    isGreenfield: false,
    confidence: 0.95,
    reasoning: 'The project already uses Python; a script is the most efficient way.',
  });

  it('overrides a code-framed decision for an authored goal', async () => {
    const agent = new ReasonerAgent();
    const context = makeContext({ goal: storyGoal });

    const result = await agent.execute(context, makeCallLLM(MISFRAMED));
    expect(result.success).toBe(true);

    const decision = context.metadata.technicalDecision as Record<string, unknown>;
    expect(decision.deliverableClass).toBe('creative');
    // No programming language can be involved in writing a novel.
    expect(decision.language).toBe('none');
    expect(decision.framework).toBe('none');
    expect(decision.platform).toBe('document');
    expect(decision.architecture).toBe('sections');
    expect(decision.dependencies).toEqual([]);
    expect(decision.buildCommand).toBeUndefined();
  });

  it('tells the model the class up front and forbids a generator', async () => {
    const agent = new ReasonerAgent();
    const callLLM = makeCallLLM(MISFRAMED);
    await agent.execute(makeContext({ goal: storyGoal }), callLLM);

    const prompt = (callLLM as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(prompt).toContain('DELIVERABLE CLASS: creative writing');
    expect(prompt).toMatch(/MUST NOT plan a script, tool, or generator/);
  });

  it('leaves a normal software goal completely untouched', async () => {
    const agent = new ReasonerAgent();
    const context = makeContext({ goal: 'build a react dashboard for sales' });
    const softwareDecision = JSON.stringify({
      language: 'typescript',
      framework: 'react',
      platform: 'web',
      architecture: 'multi-file',
      dependencies: ['react'],
      deliverable: 'web-app',
      constraints: [],
      isGreenfield: true,
      confidence: 0.9,
      reasoning: 'Standard web stack',
    });

    await agent.execute(context, makeCallLLM(softwareDecision));
    const decision = context.metadata.technicalDecision as Record<string, unknown>;
    expect(decision.language).toBe('typescript');
    expect(decision.framework).toBe('react');
    expect(decision.deliverableClass).toBe('code');
  });
});
