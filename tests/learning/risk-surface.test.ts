/**
 * The static risk surface — leads, not findings.
 *
 * Measured 2026-11-05: the assessment protocol named the right seams and the same
 * model still missed them, because the advice was never a list of places to open.
 * These tests pin the properties that make the index useful rather than noisy:
 * it finds the generic sink classes, it ignores tests and dependencies, and it is
 * empty on a tree with no sinks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRiskLeadsBlock, scanRiskSurface } from '../../src/learning/risk-surface.js';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'risk-surface-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const put = (path: string, content: string): void => {
  const abs = join(root, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

describe('scanRiskSurface', () => {
  it('indexes the generic sink classes with file:line', () => {
    put('app/paths.py', 'def remove(p):\n    shutil.rmtree(p)\n');
    put('app/dl.py', 'if r.status_code == 206 and "Content-Length" in r.headers:\n    part.write(chunk)\n');
    put('app/settings.py', 'defaults.setdefault("theme", {})\n');
    put('cli.py', 'parser.add_argument("--worker", action="store_true")\n');

    const leads = scanRiskSurface(root);
    const categories = leads.map((l) => l.category);
    expect(categories).toContain('filesystem-delete');
    expect(categories).toContain('transfer-resume');
    expect(categories).toContain('config-mutation');
    expect(categories).toContain('flag-parse');
    const deleteLead = leads.find((l) => l.category === 'filesystem-delete')!;
    expect(deleteLead.file).toBe('app/paths.py');
    expect(deleteLead.line).toBe(2);
    expect(deleteLead.text).toContain('rmtree');
  });

  it('never reports a test file or a dependency as the shipped sink', () => {
    put('tests/test_paths.py', 'shutil.rmtree(tmp)\n');
    put('node_modules/pkg/index.js', 'rmSync(dir, { recursive: true });\n');
    put('app/paths.py', 'shutil.rmtree(p)\n');
    const leads = scanRiskSurface(root);
    expect(leads.every((l) => !l.file.startsWith('tests/'))).toBe(true);
    expect(leads.every((l) => !l.file.includes('node_modules'))).toBe(true);
  });

  it('is bounded and empty on a clean tree', () => {
    put('app/clean.py', 'def add(a, b):\n    return a + b\n');
    expect(scanRiskSurface(root)).toEqual([]);
    expect(buildRiskLeadsBlock([])).toBe('');
  });

  it('caps leads per category so one file cannot flood the prompt', () => {
    put(
      'app/many.py',
      Array.from({ length: 20 }, (_, i) => `shutil.rmtree(p${i})`).join('\n'),
    );
    const leads = scanRiskSurface(root);
    expect(leads.filter((l) => l.category === 'filesystem-delete')).toHaveLength(3);
    expect(leads.length).toBeLessThanOrEqual(15);
  });
});

describe('buildRiskLeadsBlock', () => {
  it('states that a lead must end as a defect or a safe verdict', () => {
    const block = buildRiskLeadsBlock([
      { file: 'app/paths.py', line: 2, category: 'filesystem-delete', text: 'shutil.rmtree(p)' },
    ]);
    expect(block).toContain('leads, not findings');
    expect(block).toContain('`app/paths.py:2`');
    expect(block).toContain('`safe`');
    expect(block).toContain('unexamined lead');
  });
});
