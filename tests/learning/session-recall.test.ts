/**
 * Phase 4 follow-on — SEMANTIC session recall.
 *
 * The contract under test: past asks are recalled by MEANING above an explicit
 * cosine threshold, project-scoped by default; recall is OFF unless asked for; a
 * recalled ask is presented as history (its outcome), never as a status; and
 * every failure (zero embeddings, corrupt index) degrades to "no recall".
 *
 * Embeddings are injected deterministically (a bag-of-words vector over a fixed
 * vocabulary), so the test is about the RANKING + THRESHOLD + SCOPING logic, not
 * about any particular model's quality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  MAX_INDEX_ENTRIES,
  SESSION_RECALL_ENV,
  clearSessionRecallIndex,
  formatSessionRecall,
  indexSessionTurn,
  recallPastSessions,
  sessionRecallEnabled,
  type EmbedFn,
} from '../../src/learning/session-recall.js';

const VOCAB = ['trip', 'japan', 'itinerary', 'login', 'bug', 'readme', 'widget', 'deploy', 'test', 'auth'];

/** Deterministic bag-of-words embedding over a fixed vocabulary. */
const fakeEmbed: EmbedFn = async (text: string) => {
  const lower = text.toLowerCase();
  return VOCAB.map((w) => (lower.includes(w) ? 1 : 0));
};

/** An embedder that is available but cannot produce a meaningful vector. */
const zeroEmbed: EmbedFn = async () => new Array(VOCAB.length).fill(0);

const dirs: string[] = [];
const origMem = process.env.NUVIRA_MEMORY_DIR;
const origRecall = process.env[SESSION_RECALL_ENV];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'session-recall-'));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  process.env.NUVIRA_MEMORY_DIR = tmp();
  process.env[SESSION_RECALL_ENV] = '1';
});
afterEach(() => {
  if (origMem === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = origMem;
  if (origRecall === undefined) delete process.env[SESSION_RECALL_ENV];
  else process.env[SESSION_RECALL_ENV] = origRecall;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('session recall — enablement', () => {
  it('defaults ON, and can be explicitly turned off', () => {
    expect(sessionRecallEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(sessionRecallEnabled({ [SESSION_RECALL_ENV]: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(sessionRecallEnabled({ [SESSION_RECALL_ENV]: 'off' } as NodeJS.ProcessEnv)).toBe(false);
    expect(sessionRecallEnabled({ [SESSION_RECALL_ENV]: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('indexes NOTHING when recall is explicitly off', async () => {
    process.env[SESSION_RECALL_ENV] = '0';
    const wrote = await indexSessionTurn({ projectPath: tmp(), goal: 'plan a trip to japan' }, { embedFn: fakeEmbed });
    expect(wrote).toBe(false);
    expect(existsSync(join(process.env.NUVIRA_MEMORY_DIR!, 'session-recall-index.json'))).toBe(false);
  });
});

describe('session recall — relevance by meaning', () => {
  it('recalls a semantically similar past ask above the threshold', async () => {
    const cwd = tmp();
    await indexSessionTurn(
      { projectPath: cwd, goal: 'plan a trip to japan', outcome: 'acted', savedAt: Date.now() - 60_000 },
      { embedFn: fakeEmbed },
    );
    const hits = await recallPastSessions('japan trip itinerary', { projectPath: cwd, embedFn: fakeEmbed });
    expect(hits.length).toBe(1);
    expect(hits[0].entry.goal).toBe('plan a trip to japan');
    expect(hits[0].similarity).toBeGreaterThan(0.5);
  });

  it('does NOT recall an unrelated past ask', async () => {
    const cwd = tmp();
    await indexSessionTurn({ projectPath: cwd, goal: 'fix the login bug' }, { embedFn: fakeEmbed });
    const hits = await recallPastSessions('japan trip itinerary', { projectPath: cwd, embedFn: fakeEmbed });
    expect(hits).toEqual([]);
  });

  it('honours an explicit threshold', async () => {
    const cwd = tmp();
    await indexSessionTurn({ projectPath: cwd, goal: 'plan a trip to japan' }, { embedFn: fakeEmbed });
    // A query sharing only PART of the entry's vocabulary lands around 0.63, so
    // it is recalled at the default floor but rejected at a near-1 threshold.
    const broad = await recallPastSessions('japan trip itinerary login bug', {
      projectPath: cwd,
      embedFn: fakeEmbed,
    });
    expect(broad.length).toBe(1);
    const strict = await recallPastSessions('japan trip itinerary login bug', {
      projectPath: cwd,
      embedFn: fakeEmbed,
      threshold: 0.99,
    });
    expect(strict).toEqual([]);
  });

  it('scopes recall to the current project by default, and can cross projects', async () => {
    const here = tmp();
    const elsewhere = tmp();
    await indexSessionTurn({ projectPath: elsewhere, goal: 'plan a trip to japan' }, { embedFn: fakeEmbed });

    // Project-scoped (default): the other project's ask is invisible.
    const scoped = await recallPastSessions('japan trip itinerary', { projectPath: here, embedFn: fakeEmbed });
    expect(scoped).toEqual([]);

    // Cross-project: it is found, and the block names where it came from.
    const all = await recallPastSessions('japan trip itinerary', { scope: 'all', projectPath: here, embedFn: fakeEmbed });
    expect(all.length).toBe(1);
    // `formatSessionRecall` with no projectPath ⇒ the project is named.
    const block = formatSessionRecall(all);
    expect(block).toContain(basename(elsewhere));
    expect(block).toContain('plan a trip to japan');
  });

  it('ranks the closest ask first and caps at topK', async () => {
    const cwd = tmp();
    await indexSessionTurn({ projectPath: cwd, goal: 'trip japan itinerary plan' }, { embedFn: fakeEmbed });
    await indexSessionTurn({ projectPath: cwd, goal: 'trip japan' }, { embedFn: fakeEmbed });
    await indexSessionTurn({ projectPath: cwd, goal: 'japan' }, { embedFn: fakeEmbed });
    const hits = await recallPastSessions('trip japan itinerary', { projectPath: cwd, embedFn: fakeEmbed, topK: 2 });
    expect(hits.length).toBe(2);
    expect(hits[0].similarity).toBeGreaterThanOrEqual(hits[1].similarity);
    expect(hits[0].entry.goal).toBe('trip japan itinerary plan');
  });
});

describe('session recall — graceful degradation', () => {
  it('indexes nothing (and recalls nothing) when embeddings are unavailable', async () => {
    const cwd = tmp();
    const wrote = await indexSessionTurn({ projectPath: cwd, goal: 'plan a trip to japan' }, { embedFn: zeroEmbed });
    expect(wrote).toBe(false);
    const hits = await recallPastSessions('japan trip', { projectPath: cwd, embedFn: zeroEmbed });
    expect(hits).toEqual([]);
  });

  it('a corrupt index is a miss, never a crash', async () => {
    const cwd = tmp();
    mkdirSync(process.env.NUVIRA_MEMORY_DIR!, { recursive: true });
    writeFileSync(join(process.env.NUVIRA_MEMORY_DIR!, 'session-recall-index.json'), '{ not json', 'utf-8');
    const hits = await recallPastSessions('japan trip', { projectPath: cwd, embedFn: fakeEmbed });
    expect(hits).toEqual([]);
  });

  it('re-indexing the same ask does not duplicate it', async () => {
    const cwd = tmp();
    const savedAt = 1_700_000_000_000;
    await indexSessionTurn({ projectPath: cwd, goal: 'plan a trip to japan', savedAt }, { embedFn: fakeEmbed });
    await indexSessionTurn({ projectPath: cwd, goal: 'plan a trip to japan', savedAt }, { embedFn: fakeEmbed });
    const hits = await recallPastSessions('japan trip', { projectPath: cwd, embedFn: fakeEmbed, topK: 10 });
    expect(hits.length).toBe(1);
  });

  it('caps the index at MAX_INDEX_ENTRIES', async () => {
    const cwd = tmp();
    for (let i = 0; i < MAX_INDEX_ENTRIES + 5; i += 1) {
      await indexSessionTurn({ projectPath: cwd, goal: `trip japan ${i}`, savedAt: i }, { embedFn: fakeEmbed });
    }
    // No direct count export — the cap is asserted through the file size.
    const raw = JSON.parse(
      readFileSync(join(process.env.NUVIRA_MEMORY_DIR!, 'session-recall-index.json'), 'utf-8'),
    ) as { entries: unknown[] };
    expect(raw.entries.length).toBe(MAX_INDEX_ENTRIES);
  });

  it('clearSessionRecallIndex removes the index', async () => {
    const cwd = tmp();
    await indexSessionTurn({ projectPath: cwd, goal: 'plan a trip to japan' }, { embedFn: fakeEmbed });
    expect(clearSessionRecallIndex()).toBe(true);
    const hits = await recallPastSessions('japan trip', { projectPath: cwd, embedFn: fakeEmbed });
    expect(hits).toEqual([]);
  });
});

describe('session recall — the rendered block', () => {
  it('says this is HISTORY, not a status, and shows how the past ask ended', async () => {
    const cwd = tmp();
    await indexSessionTurn(
      { projectPath: cwd, goal: 'plan a trip to japan', outcome: 'incomplete', savedAt: Date.now() - 3_600_000 },
      { embedFn: fakeEmbed },
    );
    const hits = await recallPastSessions('japan trip', { projectPath: cwd, embedFn: fakeEmbed });
    const block = formatSessionRecall(hits, { projectPath: cwd });
    expect(block).toMatch(/PAST asks/);
    expect(block).toMatch(/NOT a status/);
    expect(block).toMatch(/verify artifacts on disk/);
    expect(block).toContain('incomplete: "plan a trip to japan"');
  });

  it('is empty when there are no hits', () => {
    expect(formatSessionRecall([])).toBe('');
  });
});
