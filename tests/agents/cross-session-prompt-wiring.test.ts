/**
 * Cross-session memory in the ORCHESTRATOR prompts (followup a).
 *
 * `assessProject` has carried `crossSessionMemory` since the scoped P5 work, and
 * `assemblePrompt` rendered it — but the deliverable `writer` / `reasoner` /
 * tool-calling-writer prompts, which build their own system text, did NOT. So an
 * orchestrator turn's coding agents saw less history than a loop turn for the
 * same project. These tests pin that the block now reaches each of those prompts,
 * and — just as important — that a project with no recorded sessions adds
 * nothing (no prompt weight).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WriterAgent } from '../../src/agents/agents/writer.js';
import { ReasonerAgent } from '../../src/agents/agents/reasoner.js';
import type { AgentContext, LLMCallFn } from '../../src/agents/agent.js';
import { assessProject } from '../../src/agents/prompt-assembly.js';
import { formatCrossSessionMemorySync } from '../../src/learning/context-assembly.js';
import { recordSessionTurn } from '../../src/learning/session-digest.js';

const dirs: string[] = [];
const origMem = process.env.NUVIRA_MEMORY_DIR;

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'xsession-prompt-'));
  dirs.push(d);
  return d;
}

/** A directory `looksLikeProject` recognises (a project marker). */
function project(): string {
  const d = tmp();
  writeFileSync(join(d, 'package.json'), '{"name":"xsession-fixture"}', 'utf-8');
  return d;
}

function makeContext(workingDirectory: string): AgentContext {
  return {
    goal: 'fix the flaky test',
    workingDirectory,
    taskPlan: [{ id: 'step-01', agentType: 'writer', description: 'Update auth logic', dependsOn: [], status: 'running' }],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {},
  };
}

beforeEach(() => {
  process.env.NUVIRA_MEMORY_DIR = tmp();
  delete process.env.NUVIRA_SESSION_RECALL;
});
afterEach(() => {
  if (origMem === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = origMem;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('cross-session memory reaches the orchestrator writer prompt', () => {
  it('renders the block in the writer system prompt when the project has history', () => {
    const dir = project();
    recordSessionTurn({ projectPath: dir, goal: 'wire up the router', outcome: 'acted', tools: ['edit_file'] });
    const memory = formatCrossSessionMemorySync(dir);
    expect(memory).toContain('wire up the router');

    const prompt = (new WriterAgent() as any).buildPrompt(makeContext(dir), false) as string;
    expect(prompt).toContain(memory);
  });

  it('adds nothing for a pristine project (no prompt weight)', () => {
    const dir = project();
    const prompt = (new WriterAgent() as any).buildPrompt(makeContext(dir), false) as string;
    expect(prompt).not.toContain('Recent sessions in THIS project');
  });
});

describe('cross-session memory reaches the reasoner prompt', () => {
  it('renders the block after the project state when the project has history', async () => {
    const dir = project();
    recordSessionTurn({ projectPath: dir, goal: 'deploy the service', outcome: 'acted', tools: ['run_terminal'] });
    const memory = formatCrossSessionMemorySync(dir);

    let seen = '';
    const callLLM: LLMCallFn = async (prompt) => {
      seen = prompt;
      return '{"approach":"x","decisions":[],"rationale":"y"}';
    };

    await new ReasonerAgent().execute(makeContext(dir), callLLM);
    expect(seen).toContain(memory);
  });

  it('adds nothing for a pristine project', async () => {
    const dir = project();
    let seen = '';
    const callLLM: LLMCallFn = async (prompt) => {
      seen = prompt;
      return '{"approach":"x","decisions":[],"rationale":"y"}';
    };

    await new ReasonerAgent().execute(makeContext(dir), callLLM);
    expect(seen).not.toContain('Recent sessions in THIS project');
  });
});

describe('assessment still carries the block (no regression)', () => {
  it('assessProject exposes the same string the prompts render', () => {
    const dir = project();
    recordSessionTurn({ projectPath: dir, goal: 'write the readme', outcome: 'incomplete', tools: ['write_file'] });
    const memory = formatCrossSessionMemorySync(dir);
    expect(assessProject(dir).crossSessionMemory).toBe(memory);
  });
});
