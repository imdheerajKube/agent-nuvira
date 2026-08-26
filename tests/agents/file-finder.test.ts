import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextGathererAgent } from '../../src/agents/agents/context-gatherer.js';
import type { AgentContext, LLMCallFn } from '../../src/agents/agent.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ContextGathererAgent — file-finding', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'test-gatherer-'));
    // Create some test files
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'index.ts'), 'export const x = 1');
    writeFileSync(join(tempDir, 'package.json'), '{"name": "test"}');
    writeFileSync(join(tempDir, 'README.md'), '# Test');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses fileFinderCallLLM from metadata when available', async () => {
    const agent = new ContextGathererAgent();
    const fileFinderCalled = { current: false };

    const fileFinderLLM: LLMCallFn = async (prompt) => {
      fileFinderCalled.current = true;
      // Return file paths in Codebuff style (one per line)
      return 'src/index.ts\npackage.json';
    };

    const mainLLM: LLMCallFn = async () => {
      throw new Error('Main LLM should not be called for file selection');
    };

    const context: AgentContext = {
      goal: 'Add error handling to index.ts',
      workingDirectory: tempDir,
      taskPlan: [],
      artifacts: [],
      conversations: [],
      metadata: {
        fileFinderCallLLM: fileFinderLLM,
      },
    };

    const result = await agent.execute(context, mainLLM);

    expect(result.success).toBe(true);
    expect(fileFinderCalled.current).toBe(true);
    // Should have read the files
    expect(context.artifacts.length).toBeGreaterThan(0);
  });

  it('falls back to main LLM when fileFinderCallLLM is not in metadata', async () => {
    const agent = new ContextGathererAgent();
    const mainLLMCalled = { current: false };

    const mainLLM: LLMCallFn = async (prompt) => {
      mainLLMCalled.current = true;
      return '["src/index.ts"]';
    };

    const context: AgentContext = {
      goal: 'Add error handling',
      workingDirectory: tempDir,
      taskPlan: [],
      artifacts: [],
      conversations: [],
      metadata: {},
    };

    const result = await agent.execute(context, mainLLM);

    expect(result.success).toBe(true);
    expect(mainLLMCalled.current).toBe(true);
  });

  it('parses line-per-file format (Codebuff style)', async () => {
    const agent = new ContextGathererAgent();

    const fileFinderLLM: LLMCallFn = async () => {
      return 'src/index.ts\npackage.json\nREADME.md';
    };

    const mainLLM: LLMCallFn = async () => {
      throw new Error('Should not be called');
    };

    const context: AgentContext = {
      goal: 'Read all files',
      workingDirectory: tempDir,
      taskPlan: [],
      artifacts: [],
      conversations: [],
      metadata: {
        fileFinderCallLLM: fileFinderLLM,
      },
    };

    const result = await agent.execute(context, mainLLM);

    expect(result.success).toBe(true);
    // Should have found 3 files
    const paths = context.artifacts.map(a => a.path);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('package.json');
  });

  it('parses JSON array format (legacy)', async () => {
    const agent = new ContextGathererAgent();

    const fileFinderLLM: LLMCallFn = async () => {
      return '["src/index.ts", "package.json"]';
    };

    const mainLLM: LLMCallFn = async () => {
      throw new Error('Should not be called');
    };

    const context: AgentContext = {
      goal: 'Read files',
      workingDirectory: tempDir,
      taskPlan: [],
      artifacts: [],
      conversations: [],
      metadata: {
        fileFinderCallLLM: fileFinderLLM,
      },
    };

    const result = await agent.execute(context, mainLLM);

    expect(result.success).toBe(true);
    const paths = context.artifacts.map(a => a.path);
    expect(paths).toContain('src/index.ts');
  });
});
