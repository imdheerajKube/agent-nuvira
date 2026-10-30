/**
 * A contract generated from the routes cannot drift from them.
 *
 * Verifying a spec catches a contract that has already gone stale. This pins the stronger
 * property: the document is DERIVED from the same route scanner the verifier uses, so
 * regenerating it after the code changes always describes the code — and the round trip
 * (generate → verify) is the proof, not a hope.
 *
 * It also pins what the generator must NOT do: invent operation meaning. Every summary is
 * a TODO carrying the method, path and source file, because a guessed summary is a lie a
 * client author builds against.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateOpenApi, openApiPath } from '../../src/learning/api-spec.js';
import { readSpec, verifyApiContract } from '../../src/learning/api-contract.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'api-spec-'));
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
  put('package.json', JSON.stringify({ name: 'platform', version: '2.1.0' }));
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
      "tasksRouter.get('/:taskId', one);",
      "tasksRouter.delete('/:taskId', remove);",
      '',
    ].join('\n'),
  );
}

describe('openApiPath', () => {
  it('turns express and angle-bracket parameters into OpenAPI parameters', () => {
    expect(openApiPath('/api/tasks/:taskId')).toBe('/api/tasks/{taskId}');
    expect(openApiPath('/api/tasks/<id>/')).toBe('/api/tasks/{id}');
    expect(openApiPath('/health')).toBe('/health');
  });
});

describe('generateOpenApi', () => {
  it('emits the routes the code registers, with their parameter names', () => {
    service();
    const generated = generateOpenApi({ cwd: root });
    expect(generated.path).toBe('docs/openapi.yaml');
    expect(generated.operations).toBe(4);
    expect(generated.paths).toBe(2);
    expect(generated.yaml).toContain("  '/api/v1/tasks/{}':".replace('{}', '{taskId}'));
    expect(generated.yaml).toContain('    delete:');
    // Metadata comes from package.json, and the summary is honestly unfinished.
    expect(generated.yaml).toContain("title: 'platform'");
    expect(generated.yaml).toContain("version: '2.1.0'");
    expect(generated.yaml).toContain('summary: TODO');
    expect(generated.yaml).toContain('modules/tasks/routes.ts');
  });

  it('round-trips: the generated document verifies against the code with no problems', () => {
    service();
    const generated = generateOpenApi({ cwd: root });
    put(generated.path, generated.yaml);
    const verdict = verifyApiContract({ cwd: root });
    expect(verdict.parsed).toBe(true);
    expect(verdict.documented).toBe(4);
    expect(verdict.registered).toBe(4);
    expect(verdict.problems).toEqual([]);
  });

  it('is deterministic, so regenerating an unchanged project produces no diff', () => {
    service();
    expect(generateOpenApi({ cwd: root }).yaml).toBe(generateOpenApi({ cwd: root }).yaml);
  });

  it('reports zero operations when nothing registers a route', () => {
    put('src/index.ts', "console.log('a CLI');");
    expect(generateOpenApi({ cwd: root }).operations).toBe(0);
  });

  it('keeps a path the spec cannot infer (a mounted router with a parameter)', () => {
    service();
    put('docs/openapi.yaml', generateOpenApi({ cwd: root }).yaml);
    const spec = readSpec(root, 'docs/openapi.yaml')!;
    expect(spec.operations.map((o) => `${o.method} ${o.path}`).sort()).toEqual([
      'DELETE /api/v1/tasks/{}',
      'GET /api/v1/tasks',
      'GET /api/v1/tasks/{}',
      'POST /api/v1/tasks',
    ]);
  });
});
