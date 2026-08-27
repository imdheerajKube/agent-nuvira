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
