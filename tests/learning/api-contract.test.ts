/**
 * The spec is the one document a stranger's tooling trusts without reading the code.
 *
 * Measured 2026-10-27: the winning arm shipped a 42-path OpenAPI document and verified
 * it ("0 unresolved `$ref`s"); this one had no way to tell whether a spec it wrote
 * described the routes it registered. These tests pin the three checks that matter —
 * dangling refs, documented-but-unserved paths, served-but-undocumented routes — and the
 * mounting resolution that makes the comparison meaningful (`/` in a router file is
 * really `/api/v1/tasks`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  joinMount,
  normalizePath,
  readSpec,
  registeredRoutes,
  unresolvedRefs,
  verifyApiContract,
} from '../../src/learning/api-contract.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'api-contract-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/** A real express mount: the prefix lives in app.ts, the paths live in the router file. */
function service(): void {
  put(
    'apps/api/src/app.ts',
    [
      "import express from 'express';",
      "import { tasksRouter } from './modules/tasks/routes.js';",
      "import { authRouter } from './modules/auth/routes.js';",
      'const app = express();',
      "app.use('/api/v1/tasks', tasksRouter);",
      "app.use('/api/v1/auth', authRouter);",
      '',
    ].join('\n'),
  );
  put(
    'apps/api/src/modules/tasks/routes.ts',
    [
      'export const tasksRouter = Router();',
      "tasksRouter.get('/', list);",
      "tasksRouter.post('/', create);",
      "tasksRouter.get('/:id', one);",
      "tasksRouter.patch('/:id', update);",
      '',
    ].join('\n'),
  );
  put(
    'apps/api/src/modules/auth/routes.ts',
    [
      'export const authRouter = Router();',
      "authRouter.post('/login', login);",
      "authRouter.post('/refresh', refresh);",
      '',
    ].join('\n'),
  );
}

const SPEC = [
  'openapi: 3.0.3',
  'info:',
  '  title: Platform',
  'paths:',
  '  /api/v1/tasks:',
  '    get:',
  '      responses:',
  "        '200':",
  "          $ref: '#/components/schemas/TaskList'",
  '    post:',
  '      responses:',
  "        '201':",
  '          description: created',
  '  /api/v1/tasks/{id}:',
  '    get:',
  '      responses:',
  "        '200':",
  '          description: one',
  '    patch:',
  '      responses:',
  "        '200':",
  '          description: patched',
  '  /api/v1/auth/login:',
  '    post:',
  '      responses:',
  "        '200':",
  '          description: token',
  '  /api/v1/ghosts:',
  '    get:',
  '      responses:',
  "        '200':",
  '          description: nothing serves this',
  'components:',
  '  schemas:',
  '    Task:',
  '      type: object',
  '    TaskList:',
  '      type: array',
  '',
].join('\n');

describe('path normalisation and mounts', () => {
  it('collapses express, openapi, and angle-bracket parameters to one spelling', () => {
    expect(normalizePath('/api/tasks/:id')).toBe('/api/tasks/{}');
    expect(normalizePath('/api/tasks/{taskId}')).toBe('/api/tasks/{}');
    expect(normalizePath('/api/tasks/<id>/')).toBe('/api/tasks/{}');
    expect(normalizePath('/api//tasks/')).toBe('/api/tasks');
  });

  it('joins a mount prefix to a router path the way express does', () => {
    expect(joinMount('/api/v1/tasks', '/')).toBe('/api/v1/tasks');
    expect(joinMount('/api/v1', '/tasks')).toBe('/api/v1/tasks');
    expect(joinMount('/api/v1/', '/:id')).toBe('/api/v1/{}');
    expect(joinMount('', '/health')).toBe('/health');
  });
});

describe('registeredRoutes — the code, with its mounts resolved', () => {
  it('reads a router file at its mounted prefix', () => {
    service();
    const routes = registeredRoutes({ cwd: root });
    const paths = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(paths).toEqual([
      'GET /api/v1/tasks',
      'GET /api/v1/tasks/{}',
      'PATCH /api/v1/tasks/{}',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/refresh',
      'POST /api/v1/tasks',
    ]);
    // The evidence points at the file it was found in, so a finding can be acted on.
    expect(routes.find((r) => r.path === '/api/v1/tasks/{}')?.source).toContain('modules/tasks/routes.ts');
  });

  it('does not read a Map key as a route (measured false positive: `teamByKey.get(\'APOLLO\')`)', () => {
    service();
    put('apps/api/src/db/seed.ts', "const teamByKey = new Map();\nteamByKey.get('APOLLO');\nheaders.get('x-trace');\n");
    const routes = registeredRoutes({ cwd: root });
    expect(routes.some((r) => r.source.includes('seed.ts'))).toBe(false);
  });

  it('ignores test files and never counts one route twice', () => {
    service();
    put('apps/api/tests/integration/tasks.test.ts', "request(app).get('/api/v1/tasks');");
    const routes = registeredRoutes({ cwd: root });
    // The test file's `request(app).get('/api/v1/tasks')` is not a registration.
    expect(routes.some((r) => r.source.includes('tests/'))).toBe(false);
    expect(routes.filter((r) => r.method === 'GET' && r.path === '/api/v1/tasks')).toHaveLength(1);
  });
});

describe('readSpec — YAML by indentation, JSON by parser', () => {
  it('reads paths, methods, components and refs from YAML', () => {
    service();
    put('docs/openapi.yaml', SPEC);
    const spec = readSpec(root, 'docs/openapi.yaml')!;
    expect(spec.parsed).toBe(true);
    expect(spec.operations.map((o) => `${o.method} ${o.path}`)).toEqual([
      'GET /api/v1/tasks',
      'POST /api/v1/tasks',
      'GET /api/v1/tasks/{}',
      'PATCH /api/v1/tasks/{}',
      'POST /api/v1/auth/login',
      'GET /api/v1/ghosts',
    ]);
    expect([...spec.components.schemas]).toEqual(['Task', 'TaskList']);
    expect(spec.refs).toContain('#/components/schemas/TaskList');
  });

  it('reads a JSON document properly', () => {
    put(
      'docs/openapi.json',
      JSON.stringify({
        openapi: '3.0.0',
        paths: { '/health': { get: {} }, '/api/tasks': { get: {}, post: {} } },
        components: { schemas: { Task: { type: 'object' } } },
      }),
    );
    const spec = readSpec(root, 'docs/openapi.json')!;
    expect(spec.parsed).toBe(true);
    expect(spec.operations).toHaveLength(3);
    expect([...spec.components.schemas]).toEqual(['Task']);
  });

  it('does not mistake a file with no paths for an empty spec', () => {
    put('docs/openapi.yaml', 'openapi: 3.0.0\ninfo:\n  title: Platform\n');
    expect(readSpec(root, 'docs/openapi.yaml')!.parsed).toBe(false);
  });

  it('finds a dangling ref and accepts a defined one', () => {
    put('docs/openapi.yaml', SPEC);
    const spec = readSpec(root, 'docs/openapi.yaml')!;
    expect(unresolvedRefs(spec)).toEqual([]);
    put(
      'docs/openapi.yaml',
      SPEC.replace("'200':\n          description: one", "'200':\n          $ref: '#/components/schemas/Comment'"),
    );
    expect(unresolvedRefs(readSpec(root, 'docs/openapi.yaml')!)).toEqual(['#/components/schemas/Comment']);
  });
});

describe('verifyApiContract — the document against the server', () => {
  it('reports the phantom path and the undocumented route, and nothing else', () => {
    service();
    put('docs/openapi.yaml', SPEC);
    const verdict = verifyApiContract({ cwd: root });
    expect(verdict.specPath).toBe('docs/openapi.yaml');
    expect(verdict.documented).toBe(6);
    expect(verdict.registered).toBe(6);
    const kinds = verdict.problems.map((p) => `${p.kind}:${p.claim}`).sort();
    expect(kinds).toEqual([
      'documented-not-implemented:GET /api/v1/ghosts',
      'implemented-not-documented:POST /api/v1/auth/refresh',
    ]);
    expect(verdict.problems.find((p) => p.claim.includes('refresh'))?.problem).toContain(
      'modules/auth/routes.ts',
    );
  });

  it('says nothing about a document that matches the code', () => {
    service();
    put(
      'docs/openapi.yaml',
      SPEC.replace(
        '  /api/v1/ghosts:\n    get:\n      responses:\n        \'200\':\n          description: nothing serves this\n',
        '  /api/v1/auth/refresh:\n    post:\n      responses:\n        \'200\':\n          description: rotated\n',
      ),
    );
    const verdict = verifyApiContract({ cwd: root });
    expect(verdict.problems).toEqual([]);
    expect(verdict.total).toBe(0);
  });

  it('reports a dangling ref as a contract problem', () => {
    service();
    put('docs/openapi.yaml', SPEC.replace('$ref: \'#/components/schemas/TaskList\'', "$ref: '#/components/schemas/Nope'"));
    const verdict = verifyApiContract({ cwd: root });
    expect(verdict.problems.some((p) => p.kind === 'unresolved-ref' && p.claim.includes('Nope'))).toBe(true);
  });

  it('returns quietly when there is no spec at all', () => {
    service();
    const verdict = verifyApiContract({ cwd: root });
    expect(verdict.specPath).toBeUndefined();
    expect(verdict.problems).toEqual([]);
  });
});
