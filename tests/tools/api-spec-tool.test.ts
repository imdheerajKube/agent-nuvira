/**
 * `api_spec` refuses to destroy a real document, and says why.
 *
 * The interesting behaviour is not the write — it is the refusal. Hand-written
 * descriptions, schemas and examples are worth more than a generated skeleton, so on an
 * existing spec the tool reports the CONTRACT PROBLEMS instead: a model that reaches for
 * it on a stale document is pointed at the drift, and `force: true` stays the explicit,
 * rare choice.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runApiSpec } from '../../src/tools/api-spec-tool.js';
import { verifyApiContract } from '../../src/learning/api-contract.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'api-spec-tool-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

function service(): void {
  put(
    'apps/api/src/app.ts',
    [
      "import express from 'express';",
      "import { tasksRouter } from './modules/tasks/routes.js';",
      'const app = express();',
      "app.use('/api/v1/tasks', tasksRouter);",
      '',
    ].join('\n'),
  );
  put(
    'apps/api/src/modules/tasks/routes.ts',
    [
      'export const tasksRouter = Router();',
      "tasksRouter.get('/', list);",
      "tasksRouter.post('/', create);",
      '',
    ].join('\n'),
  );
}

const ctx = () => ({ cwd: root, configManager: {} }) as never;

describe('runApiSpec', () => {
  it('writes the document and reports what it derived', () => {
    service();
    const result = runApiSpec({}, ctx());
    expect(result).toContain('✅');
    expect(result).toContain('2 operation(s)');
    expect(readFileSync(join(root, 'docs/openapi.yaml'), 'utf-8')).toContain('paths:');
    // The generated document verifies against the code it came from.
    expect(verifyApiContract({ cwd: root }).problems).toEqual([]);
  });

  it('refuses to overwrite a real spec, and names the drift instead', () => {
    service();
    put(
      'docs/openapi.yaml',
      [
        'openapi: 3.0.3',
        'info:',
        '  title: Platform',
        '  version: 1.0.0',
        'paths:',
        '  /api/v1/tasks:',
        '    get:',
        '      responses:',
        "        '200':",
        '          description: OK',
        '  /api/v1/ghosts:',
        '    get:',
        '      responses:',
        "        '200':",
        '          description: Nothing serves this',
        '',
      ].join('\n'),
    );
    const before = readFileSync(join(root, 'docs/openapi.yaml'), 'utf-8');
    const result = runApiSpec({}, ctx());
    expect(result.startsWith('Error:')).toBe(true);
    expect(result).toContain('already exists');
    // It names the actual contradiction rather than just refusing.
    expect(result).toContain('documented-not-implemented');
    expect(result).toContain('/api/v1/ghosts');
    // …and it did not touch the file.
    expect(readFileSync(join(root, 'docs/openapi.yaml'), 'utf-8')).toBe(before);
  });

  it('replaces a stub only when force is explicit', () => {
    service();
    put('docs/openapi.yaml', 'openapi: 3.0.3\n');
    const result = runApiSpec({ force: true }, ctx());
    expect(result).toContain('✅');
    expect(readFileSync(join(root, 'docs/openapi.yaml'), 'utf-8')).toContain('/api/v1/tasks');
  });

  it('writes to the path it was given', () => {
    service();
    runApiSpec({ path: 'spec/contract.yaml' }, ctx());
    expect(existsSync(join(root, 'spec/contract.yaml'))).toBe(true);
  });

  it('says plainly when there are no routes to document', () => {
    put('src/index.ts', "console.log('a CLI');");
    const result = runApiSpec({}, ctx());
    expect(result.startsWith('Error:')).toBe(true);
    expect(result).toContain('no HTTP routes');
    expect(existsSync(join(root, 'docs/openapi.yaml'))).toBe(false);
  });
});
