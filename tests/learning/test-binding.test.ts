/**
 * Test binding is the answer to the measured gap nobody asked about: nuvira shipped
 * 22 route handlers and seven domain modules behind TWO test files, and every gate
 * it owned was satisfied. These tests pin that the question is asked of the modules
 * the TURN wrote, that a test reaches its module through a relative path, an alias
 * or a bare path specifier, and that a config/type/barrel file is never counted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bindWrittenModulesToTests,
  isSourceModule,
  testBindingApplies,
  unboundModulesNudge,
} from '../../src/learning/test-binding.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'binding-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

const MODULE = (name: string) => `export function ${name}() {\n  return ${JSON.stringify(name)};\n}\n`;

describe('isSourceModule', () => {
  it('accepts behaviour-bearing sources and refuses config, types, docs and tests', () => {
    expect(isSourceModule('src/modules/documents/service.ts')).toBe(true);
    expect(isSourceModule('app/api/checkout/route.ts')).toBe(true);
    expect(isSourceModule('src/types.d.ts')).toBe(false);
    expect(isSourceModule('vite.config.ts')).toBe(false);
    expect(isSourceModule('src/modules/a/service.test.ts')).toBe(false);
    expect(isSourceModule('docs/architecture.md')).toBe(false);
    expect(isSourceModule('src/modules/a/service.ts', root)).toBe(true);
  });
});

describe('bindWrittenModulesToTests', () => {
  it('binds through a relative import, an alias import and a bare path — and names the rest', () => {
    put('src/modules/orders/service.ts', MODULE('createOrder'));
    put('src/modules/billing/service.ts', MODULE('charge'));
    put('src/modules/reports/service.ts', MODULE('weekly'));
    put('tests/orders.test.ts', "import { createOrder } from '../src/modules/orders/service';\n");
    put('tests/billing.test.ts', "import { charge } from '@/modules/billing/service';\n");

    const report = bindWrittenModulesToTests({
      cwd: root,
      writtenPaths: [
        'src/modules/orders/service.ts',
        'src/modules/billing/service.ts',
        'src/modules/reports/service.ts',
      ],
    });

    expect(report.written).toHaveLength(3);
    expect(report.bound).toEqual(['src/modules/orders/service.ts', 'src/modules/billing/service.ts']);
    expect(report.unbound).toEqual(['src/modules/reports/service.ts']);
    expect(report.ratio).toBeCloseTo(2 / 3);
    expect(report.testFiles).toBe(2);
  });

  it('does not count a module with no export, and returns no verdict for an empty turn', () => {
    put('src/plain.ts', 'const internal = 1;\n');
    const none = bindWrittenModulesToTests({ cwd: root, writtenPaths: ['src/plain.ts'] });
    expect(none.written).toEqual([]);
    expect(none.ratio).toBeNull();

    expect(bindWrittenModulesToTests({ cwd: root, writtenPaths: [] })).toEqual({
      written: [],
      bound: [],
      unbound: [],
      testFiles: 0,
      ratio: null,
    });
  });

  it('counts a spec file that imports its module by path, not only relative', () => {
    put('src/server/session.ts', MODULE('session'));
    put('e2e/login.spec.ts', "import { session } from 'src/server/session';\n");
    const report = bindWrittenModulesToTests({ cwd: root, writtenPaths: ['src/server/session.ts'] });
    expect(report.bound).toEqual(['src/server/session.ts']);
    expect(report.unbound).toEqual([]);
  });
});

describe('testBindingApplies — narrow on purpose', () => {
  it('asks only on a build-shaped turn that wrote at least two modules', () => {
    expect(testBindingApplies({ buildShapedAsk: true, moduleCount: 2 })).toBe(true);
    expect(testBindingApplies({ buildShapedAsk: true, moduleCount: 1 })).toBe(false);
    expect(testBindingApplies({ buildShapedAsk: false, moduleCount: 9 })).toBe(false);
  });
});

describe('unboundModulesNudge', () => {
  it('names the cheapest gaps and states the coverage it measured', () => {
    const text = unboundModulesNudge(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      6,
    );
    expect(text).toContain('2/6');
    expect(text).toContain('`src/a.ts`');
    expect(text).toContain('`src/c.ts`');
    expect(text).not.toContain('`src/d.ts`'); // capped at three
    expect(text).toContain('…and 1 more');
    expect(text).toContain('FAILS if the module is broken');
  });
});
