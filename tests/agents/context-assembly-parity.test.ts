/**
 * P5 (scoped) — ONE cross-session context composer, shared across engines.
 *
 * The claim: the cross-session memory block a project yields is composed by a
 * single function (`learning/context-assembly.ts`), so the LOOP engine (chat /
 * execute / subagent) and the ORCHESTRATOR engine (`assessProject`) show the
 * SAME history for the same project. This is the golden test the plan's Phase 3c
 * acceptance called for: identical inputs → identical block, whichever surface
 * asks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatCrossSessionMemorySync } from '../../src/learning/context-assembly.js';
import { formatSessionDigest, recordSessionTurn } from '../../src/learning/session-digest.js';
import { buildLoopProjectContext } from '../../src/tools/loop-project-context.js';
import { assemblePrompt, assessProject } from '../../src/agents/prompt-assembly.js';

const dirs: string[] = [];
const origMem = process.env.NUVIRA_MEMORY_DIR;
const origRecall = process.env.NUVIRA_SESSION_RECALL;

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'context-parity-'));
  dirs.push(d);
  return d;
}

/** A directory that `looksLikeProject` recognises (a project marker). */
function project(): string {
  const d = tmp();
  writeFileSync(join(d, 'package.json'), '{"name":"parity-fixture"}', 'utf-8');
  return d;
}

beforeEach(() => {
  process.env.NUVIRA_MEMORY_DIR = tmp();
  delete process.env.NUVIRA_SESSION_RECALL;
});
afterEach(() => {
  if (origMem === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = origMem;
  if (origRecall === undefined) delete process.env.NUVIRA_SESSION_RECALL;
  else process.env.NUVIRA_SESSION_RECALL = origRecall;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('context assembly — one composer for cross-session memory', () => {
  it('the sync composer IS the session digest (single source)', () => {
    const dir = project();
    recordSessionTurn({ projectPath: dir, goal: 'fix the hotkey', outcome: 'acted', tools: ['edit_file'], verified: true });
    expect(formatCrossSessionMemorySync(dir)).toBe(formatSessionDigest(dir));
    expect(formatCrossSessionMemorySync(dir)).toContain('fix the hotkey');
  });

  it('the loop block embeds exactly the shared composer output', async () => {
    const dir = project();
    recordSessionTurn({ projectPath: dir, goal: 'build the widget', outcome: 'incomplete', tools: ['write_file'] });
    const memory = formatCrossSessionMemorySync(dir);
    const block = await buildLoopProjectContext(dir);
    expect(block).toContain(memory);
  });

  it('the same project yields the SAME cross-session block on the orchestrator surface', () => {
    const dir = project();
    recordSessionTurn({ projectPath: dir, goal: 'deploy the service', outcome: 'acted', tools: ['run_terminal'] });
    const memory = formatCrossSessionMemorySync(dir);

    const assessment = assessProject(dir);
    expect(assessment.crossSessionMemory).toBe(memory);
  });

  it('a prompt assembled from the assessment carries the block through', () => {
    const dir = project();
    recordSessionTurn({ projectPath: dir, goal: 'write the readme', outcome: 'acted', tools: ['write_file'] });
    const memory = formatCrossSessionMemorySync(dir);
    const prompt = assemblePrompt('You are Nuvira.', assessProject(dir), 'do the task', 'writer');
    expect(prompt).toContain(memory);
  });

  it('the loop surface is deterministic across calls (chat == execute inputs)', async () => {
    const dir = project();
    recordSessionTurn({ projectPath: dir, goal: 'fix the bug', outcome: 'failed', tools: [] });
    const [a, b] = await Promise.all([buildLoopProjectContext(dir), buildLoopProjectContext(dir)]);
    expect(a).toBe(b);
  });

  it('a pristine project adds no cross-session block anywhere', async () => {
    const dir = project();
    expect(formatCrossSessionMemorySync(dir)).toBe('');
    expect(assessProject(dir).crossSessionMemory).toBeUndefined();
    const block = await buildLoopProjectContext(dir);
    expect(block).not.toContain('Recent sessions');
  });

  it('recall is off by default, so the composer is exactly the digest', async () => {
    const dir = project();
    mkdirSync(process.env.NUVIRA_MEMORY_DIR!, { recursive: true });
    await import('../../src/learning/session-recall.js');
    // No NUVIRA_SESSION_RECALL — the async composer must equal the sync digest.
    const { formatCrossSessionMemory } = await import('../../src/learning/context-assembly.js');
    const full = await formatCrossSessionMemory(dir, { goal: 'anything at all' });
    expect(full).toBe(formatCrossSessionMemorySync(dir));
  });
});
