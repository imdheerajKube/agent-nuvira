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

  it('skips a corrupt line rather than throwing', () => {
    recordDecision({ question: 'Keep it simple?', answer: 'yes', dir });
    writeFileSync(decisionLogPath(dir), '{not json}\n' + readFileSync(decisionLogPath(dir), 'utf-8'), 'utf-8');
    expect(readDecisions(dir)).toHaveLength(1);
  });

  it('is OFF under a test runner — an injected renderer is not a person deciding', () => {
    expect(decisionsRecordingEnabled()).toBe(false);
  });
});
