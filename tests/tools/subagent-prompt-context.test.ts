/**
 * P1 — a subagent inherits the project context (and the durable hand-off) from
 * its working directory.
 *
 * Before this, `child-agent-runtime`'s system prompt was terse and the thread
 * carried only the goal: a delegated run was CONTEXT-BLIND, and it would
 * rediscover (or worse, redo) unfinished work a previous attempt had left in the
 * same directory. These tests pin the fix — the SAME `buildLoopProjectContext`
 * block the chat/execute loops inject, including its hand-off section.
 *
 * No fork is needed: `runSubagent` is driven with an injected provider that
 * captures the messages it is handed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSubagent } from '../../src/tools/child-agent-runtime.js';
import { recordStepHandoff } from '../../src/agents/step-handoff.js';
import type { InferenceProvider, ToolCallResponse, ToolMessage, ToolSchema } from '../../src/inference/interface.js';

let dir: string;
let workDir: string;
let originalMemoryDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buff-subagent-ctx-'));
  workDir = mkdtempSync(join(tmpdir(), 'buff-subagent-work-'));
  originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
  // The hand-off ledger reads NUVIRA_MEMORY_DIR, so a recorded entry in the test
  // is visible to the child's context builder and nothing lands in ~/.nuvira.
  process.env.NUVIRA_MEMORY_DIR = dir;
  // `buildLoopProjectContext` returns '' for a directory with no project marker,
  // so the fixture must look like a project (this also mirrors a real subagent
  // cwd, which is always a checkout).
  writeFileSync(join(workDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  writeFileSync(join(workDir, 'README.md'), '# project\n');
});

afterEach(() => {
  if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
  rmSync(dir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

function capturingProvider(captured: { messages: ToolMessage[] }): InferenceProvider {
  return {
    name: 'Scripted',
    async isAvailable(): Promise<boolean> {
      return true;
    },
    async generate(): Promise<string> {
      return 'done';
    },
    async generateTools(messages: ToolMessage[], _tools: ToolSchema[]): Promise<ToolCallResponse> {
      captured.messages = [...messages];
      return { content: 'done', toolCalls: [] };
    },
  } as unknown as InferenceProvider;
}

describe('P1 — subagent project context + hand-off', () => {
  it('injects the project context into a tool-capable subagent', async () => {
    const captured: { messages: ToolMessage[] } = { messages: [] };
    const outcome = await runSubagent(
      { goal: 'read the readme', tools: ['read_file'], cwd: workDir },
      { createProvider: async () => ({ provider: capturingProvider(captured), type: 'scripted' }) },
    );

    expect(outcome.result).toBe('done');
    const ctx = captured.messages.find((m) => m.role === 'user' && m.content.includes('[Project context]'));
    expect(ctx, `expected a [Project context] message, got: ${JSON.stringify(captured.messages)}`).toBeTruthy();
  });

  it('carries the durable hand-off for unfinished work in the working directory', async () => {
    recordStepHandoff({
      projectPath: workDir,
      goal: 'build the addon',
      stepDescription: 'package the addon',
      declared: ['out.nvda-addon'],
      route: 'primary:model',
      kind: 'failed',
      reason: 'the earlier attempt did not finish',
    });

    const captured: { messages: ToolMessage[] } = { messages: [] };
    await runSubagent(
      { goal: 'build the addon', tools: ['read_file'], cwd: workDir },
      { createProvider: async () => ({ provider: capturingProvider(captured), type: 'scripted' }) },
    );

    const ctx = captured.messages.find((m) => m.role === 'user' && m.content.includes('[Project context]'));
    expect(ctx).toBeTruthy();
    expect(ctx!.content).toContain('Hand-off');
    expect(ctx!.content).toContain('out.nvda-addon');
  });

  it('injects the project context into a plain (no-tools) completion too', async () => {
    let prompt = '';
    const provider = {
      name: 'Scripted',
      async isAvailable(): Promise<boolean> {
        return true;
      },
      async generate(p: string): Promise<string> {
        prompt = p;
        return 'done';
      },
    } as unknown as InferenceProvider;

    await runSubagent(
      { goal: 'summarize the project', cwd: workDir },
      { createProvider: async () => ({ provider, type: 'scripted' }) },
    );

    expect(prompt).toContain('[Project context]');
  });
});
