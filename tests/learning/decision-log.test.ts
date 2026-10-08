/**
 * Bundle 36 — the project decision log.
 *
 * A must-ask decision must survive the terminal: recorded machine-readably, made
 * readable, revisable with history kept, and never storing a pasted secret.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recordDecision,
  readDecisions,
  reviseDecision,
  recallDecisions,
  recallDecisionBlock,
  redactDecisionText,
  decisionsRecordingEnabled,
  decisionLogPath,
  decisionsDocPath,
} from '../../src/learning/decision-log.js';

describe('decision log', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buff-decisions-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a decision to JSONL and a readable doc', () => {
    const rec = recordDecision({
      question: 'Which database should the service use?',
      answer: 'Postgres',
      choices: ['Postgres', 'SQLite'],
      source: 'ask_user',
      dir,
      now: 1000,
    });
    expect(rec).not.toBeNull();
    expect(existsSync(decisionLogPath(dir))).toBe(true);

    const rows = readDecisions(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      question: 'Which database should the service use?',
      answer: 'Postgres',
      source: 'ask_user',
      status: 'decided',
    });

    const doc = readFileSync(decisionsDocPath(dir), 'utf-8');
    expect(doc).toMatch(/# Decisions/);
    expect(doc).toContain('Which database should the service use?');
    expect(doc).toContain('Postgres');
  });

  it('redacts secrets before they reach disk', () => {
    expect(redactDecisionText('use sk-abcdefghijklmnop123456')).not.toMatch(/sk-abcdef/);
    expect(redactDecisionText('api_key: supersecretvalue')).toBe('api_key: ***');
    expect(redactDecisionText('authorization: Bearer aaaaaaaaaaaaaaaa')).toMatch(/Bearer \*\*\*/);

    recordDecision({
      question: 'paste your key',
      answer: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      dir,
    });
    const stored = readFileSync(decisionLogPath(dir), 'utf-8');
    expect(stored).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(readDecisions(dir)[0].answer).toBe('ghp_***');
  });

  it('revises a decision and keeps the previous answer in history', () => {
    const rec = recordDecision({ question: 'Which port?', answer: '3000', dir, now: 1 })!;
    const revised = reviseDecision(dir, rec.id, '8080', 'collided with another service', 2);
    expect(revised).not.toBeNull();
    expect(revised!.answer).toBe('8080');
    expect(revised!.status).toBe('revised');
    expect(revised!.revisions).toHaveLength(1);
    expect(revised!.revisions![0]).toMatchObject({ answer: '8080', note: 'collided with another service' });

    // Persisted, and the doc shows the change.
    expect(readDecisions(dir)[0].answer).toBe('8080');
    const doc = readFileSync(decisionsDocPath(dir), 'utf-8');
    expect(doc).toContain('8080');
    expect(doc).toMatch(/Status:\*\* revised/);
    expect(doc).toContain('collided with another service');
  });

  it('returns null when revising an unknown id, and never invents one', () => {
    expect(reviseDecision(dir, 'dec-nope', 'x')).toBeNull();
  });

  it('surfaces decisions relevant to a later ask, by shared tokens', () => {
    recordDecision({ question: 'Which database should the service use?', answer: 'Postgres', dir });
    recordDecision({ question: 'What colour should the logo be?', answer: 'blue', dir });
    const hits = recallDecisions(dir, 'add an index to the service database');
    expect(hits.map((h) => h.answer)).toContain('Postgres');
    expect(hits.map((h) => h.answer)).not.toContain('blue');
    expect(recallDecisions(dir, '')).toHaveLength(0);
  });

  it('renders a labelled advisory block for a related later ask, and nothing otherwise', () => {
    recordDecision({ question: 'Which database should the service use?', answer: 'Postgres', dir });

    const block = recallDecisionBlock(dir, 'add an index to the service database');
    expect(block.startsWith('[Previously decided')).toBe(true);
    expect(block).toContain('Which database should the service use?');
    expect(block).toContain('Postgres');
    // The block says what it is AND that a changed situation may still ask:
    // nothing here suppresses a must-ask.
    expect(block).toContain('skip a must-ask');
    // No shared significant token → no block at all (inert, not noisy).
    expect(recallDecisionBlock(dir, 'write a haiku about the sea')).toBe('');
  });

  it('marks a revised decision in the recall block', () => {
    const rec = recordDecision({ question: 'Which port should the API use?', answer: '3000', dir })!;
    reviseDecision(dir, rec.id, '8080');
    const block = recallDecisionBlock(dir, 'the API port is wrong');
    expect(block).toContain('8080');
    expect(block).toContain('(revised)');
  });

  it('skips a corrupt line rather than throwing', () => {
    recordDecision({ question: 'Keep it simple?', answer: 'yes', dir });
    writeFileSync(decisionLogPath(dir), '{not json}\n' + readFileSync(decisionLogPath(dir), 'utf-8'), 'utf-8');
    expect(readDecisions(dir)).toHaveLength(1);
  });

  it('is OFF under a test runner — an injected renderer is not a person deciding', () => {
    expect(decisionsRecordingEnabled()).toBe(false);
  });

  it('can be force-enabled for a round-trip test (NUVIRA_DECISION_LOG=on)', () => {
    const orig = process.env.NUVIRA_DECISION_LOG;
    try {
      process.env.NUVIRA_DECISION_LOG = 'on';
      expect(decisionsRecordingEnabled()).toBe(true);
      process.env.NUVIRA_DECISION_LOG = 'off';
      expect(decisionsRecordingEnabled()).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.NUVIRA_DECISION_LOG;
      else process.env.NUVIRA_DECISION_LOG = orig;
    }
  });
});
