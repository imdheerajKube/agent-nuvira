/**
 * The requirement ledger is the mechanism the measured 2026-10-25 run lacked: it
 * turns what the REQUEST named into rows the loop can check, so "the model stopped"
 * is no longer the same event as "the ask is satisfied".
 *
 * These tests pin the two properties that decide whether it is useful or a nag:
 * it extracts exactly what the ask named (and nothing from a conversational ask),
 * and it only ever marks a row `unmet` when the evidence is a filesystem fact or a
 * command the turn actually ran — an unverifiable obligation stays reported.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildRequirementLedger,
  describeUnmet,
  ledgerSummary,
  resolveRequirementLedger,
} from '../../src/learning/requirement-ledger.js';

/** The measured ask (2026-10-25) — the one nuvira answered in 14 of its 30 minutes. */
const SPEC_ASK = [
  'Build the SaaS platform. It must run with npm run dev.',
  '',
  'Deliverables:',
  '- a working app with a database',
  '- unit tests, integration tests and e2e tests that pass',
  '- a README explaining how to run it',
  '- todo.md, progress.md, issues.md and changelog.md kept up to date',
  '',
  'Then run typecheck, lint and the build, and fix what fails.',
].join('\n');

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ledger-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, content = 'x'.repeat(60)): void {
  const abs = join(root, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

describe('buildRequirementLedger — extraction', () => {
  it('turns the ask\'s own list into named rows', () => {
    const rows = buildRequirementLedger(SPEC_ASK);
    const ids = rows.map((r) => r.id);
    // Named files the agent failed to produce on the measured run.
    expect(ids).toContain('todo');
    expect(ids).toContain('progress');
    expect(ids).toContain('issues');
    expect(ids).toContain('changelog');
    expect(ids).toContain('readme');
    // Named test classes.
    expect(ids).toContain('unit-tests');
    expect(ids).toContain('integration-tests');
    expect(ids).toContain('e2e-tests');
    // Named acceptance checks ("… and fix what fails").
    expect(ids).toContain('check-tests');
    expect(ids).toContain('check-typecheck');
    expect(ids).toContain('check-lint');
    expect(ids).toContain('check-build');
  });

  it('keeps enumerated obligations as reportable rows, never as work', () => {
    const rows = buildRequirementLedger(SPEC_ASK);
    const behaviour = rows.filter((r) => r.kind === 'behaviour');
    expect(behaviour.length).toBeGreaterThan(0);
    // "a working app with a database" has no checkable resolution.
    expect(behaviour.some((r) => /working app/i.test(r.label))).toBe(true);
  });

  it('extracts NOTHING from a conversational ask', () => {
    expect(buildRequirementLedger('why is the build slow?')).toEqual([]);
    expect(buildRequirementLedger('explain this function to me')).toEqual([]);
    expect(buildRequirementLedger('the tests are failing, what could it be?')).toEqual([]);
    expect(buildRequirementLedger('')).toEqual([]);
  });

  it('is idempotent and bounded', () => {
    const rows = buildRequirementLedger(SPEC_ASK);
    expect(buildRequirementLedger(SPEC_ASK).map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(rows.length).toBeLessThanOrEqual(14);
  });
});

describe('resolveRequirementLedger — evidence', () => {
  it('marks a named artifact satisfied only when it exists with content', () => {
    put('README.md');
    put('todo.md');
    const ledger = resolveRequirementLedger(buildRequirementLedger(SPEC_ASK), { cwd: root, checks: [] });
    const readme = ledger.rows.find((r) => r.id === 'readme')!;
    const issues = ledger.rows.find((r) => r.id === 'issues')!;
    expect(readme.status).toBe('satisfied');
    expect(issues.status).toBe('unmet');
    expect(ledger.unmet.map((r) => r.id)).toContain('issues');
  });

  it('marks a check satisfied by the command that passed, and unmet by the one that failed', () => {
    const ledger = resolveRequirementLedger(buildRequirementLedger(SPEC_ASK), {
      cwd: root,
      checks: [
        { kinds: ['tests'], ok: true, command: 'npm test' },
        { kinds: ['typecheck'], ok: false, command: 'npx tsc --noEmit' },
      ],
    });
    const tests = ledger.rows.find((r) => r.id === 'check-tests')!;
    const typecheck = ledger.rows.find((r) => r.id === 'check-typecheck')!;
    const lint = ledger.rows.find((r) => r.id === 'check-lint')!;
    expect(tests.status).toBe('satisfied');
    expect(tests.evidence).toContain('npm test');
    expect(typecheck.status).toBe('unmet');
    expect(typecheck.evidence).toContain('FAILED');
    // Never run at all is also unmet — the difference is in the evidence.
    expect(lint.status).toBe('unmet');
    expect(lint.evidence).toContain('no such check ran');
  });

  it('never puts an unverifiable obligation in the enforced set', () => {
    const ledger = resolveRequirementLedger(buildRequirementLedger(SPEC_ASK), { cwd: root, checks: [] });
    expect(ledger.unknown.length).toBeGreaterThan(0);
    expect(ledger.unmet.every((r) => r.kind !== 'behaviour')).toBe(true);
  });

  it('describes the outstanding rows for the model, and counts for the report', () => {
    const ledger = resolveRequirementLedger(buildRequirementLedger(SPEC_ASK), { cwd: root, checks: [] });
    const lines = describeUnmet(ledger.unmet);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => /todo\.md/i.test(l))).toBe(true);
    expect(ledgerSummary(ledger)).toMatch(/requirement\(s\) satisfied/);
    expect(ledgerSummary(ledger)).toContain('unmet');
  });
});
