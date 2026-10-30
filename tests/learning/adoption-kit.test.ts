/**
 * THE ADOPTION KIT — the documents a stranger needs to USE the service.
 *
 * Measured 2026-10-27, the head-to-head that asked "who builds the better product":
 * both arms were green, and Cline's advantage was 69 endpoints + an OpenAPI contract
 * with 40 paths + an operations runbook + a threat model + ADRs, against nuvira's 51
 * endpoints and none of the four. The duties that existed covered a README and a
 * deployment artefact; nothing covered integration or operation.
 *
 * These tests pin the three properties that make such a duty safe:
 *   1. It fires only for a SERVICE the ask is building (a CLI owes no contract).
 *   2. It is silent the moment the document exists, in any honest form.
 *   3. It states the evidence it looked at, so the model can act instead of guess.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adoptionKitNudge, missingAdoptionItems } from '../../src/learning/adoption-kit.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adoption-kit-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

const BUILD_ASK =
  'Build a production-ready SaaS platform with a Next.js frontend and an Express API, ' +
  'JWT auth, PostgreSQL and multi-tenant projects. Write a README, ADRs and a deployment guide.';

/** A real Express service: `app.listen` plus four registered routes. */
const SERVER = [
  "import express from 'express';",
  'const app = express();',
  "app.get('/api/projects', listProjects);",
  "app.post('/api/projects', createProject);",
  "app.get('/api/tasks/:id', getTask);",
  "app.patch('/api/tasks/:id', updateTask);",
  'app.listen(3000);',
  '',
].join('\n');

/** A README that is genuinely followable, used to keep the README duty out of the way. */
const README = [
  '# Platform',
  '',
  '## Run',
  '',
  '```bash',
  'npm install',
  'npm run dev',
  '```',
  '',
  '## Environment variables',
  '',
  '`DATABASE_URL` points at Postgres; `JWT_SECRET` signs access tokens.',
  '',
  ...Array.from({ length: 30 }, (_, i) => `Detail line ${i}: the service starts on port 3000.`),
  '',
].join('\n');

const ids = (gaps: ReturnType<typeof missingAdoptionItems>): string[] => gaps.map((g) => g.id);

describe('missingAdoptionItems — only for a service the ask is building', () => {
  it('reports the contract, the runbook, the threat model and the records', () => {
    put('apps/api/src/server.ts', SERVER);
    const gaps = missingAdoptionItems({ ask: BUILD_ASK, cwd: root });
    expect(ids(gaps)).toEqual(['api-contract', 'operations', 'security', 'decisions']);
    // The evidence is the tree's own route count, not a guess about the ask.
    expect(gaps[0].evidence).toContain('4 route registration(s) found in the files read');
    expect(gaps[0].evidence).toContain('apps/api/src/server.ts');
    expect(adoptionKitNudge(gaps).toString()).toContain('evidence:');
  });

  it('stays silent for a CLI: no HTTP server, no contract is owed', () => {
    put('src/index.ts', "#!/usr/bin/env node\nconsole.log('hi');\n");
    const gaps = missingAdoptionItems({ ask: 'Build a CLI tool that formats JSON.', cwd: root });
    expect(gaps).toEqual([]);
  });

  it('stays silent for a toy API with fewer than three routes', () => {
    put(
      'src/server.ts',
      "const app = express();\napp.get('/health', ok);\napp.listen(3000);\n",
    );
    const gaps = missingAdoptionItems({ ask: BUILD_ASK, cwd: root });
    expect(ids(gaps)).not.toContain('api-contract');
  });

  it('never fires on a question or a narrow fix', () => {
    put('apps/api/src/server.ts', SERVER);
    expect(missingAdoptionItems({ ask: 'What does the Express API expose?', cwd: root })).toEqual([]);
    expect(
      missingAdoptionItems({ ask: 'Explain how the JWT auth middleware works in this service.', cwd: root }),
    ).toEqual([]);
  });
});

describe('missingAdoptionItems — silent the moment the document exists', () => {
  it('accepts an OpenAPI spec with paths — and a generated skeleton counts', () => {
    put('apps/api/src/server.ts', SERVER);
    put('openapi.yaml', 'openapi: 3.0.0\ninfo:\n  title: Platform\npaths:\n  /api/projects:\n    get: {}\n');
    expect(ids(missingAdoptionItems({ ask: BUILD_ASK, cwd: root }))).not.toContain('api-contract');
  });

  it('still asks for the derived document when the only reference is prose', () => {
    put('apps/api/src/server.ts', SERVER);
    put(
      'docs/API.md',
      [
        '# API',
        '',
        'All routes require `Authorization: Bearer <token>`.',
        '',
        '- `GET /api/projects` — list projects',
        '- `POST /api/projects` — create a project',
        '- `GET /api/tasks/{id}` — one task',
        '',
      ].join('\n'),
    );
    const gaps = missingAdoptionItems({ ask: BUILD_ASK, cwd: root });
    const gap = gaps.find((g) => g.id === 'api-contract');
    // The routes ARE documented — so the ask is not "write something", it is
    // "derive it", and it cites the prose that will drift.
    expect(gap).toBeDefined();
    expect(gap?.missing).toContain('docs/API.md');
    expect(gap?.missing).toContain('written by hand');
    expect(adoptionKitNudge([gap!])).toContain('api_spec');
  });

  it('reads an endpoint reference written as a markdown table', () => {
    put('apps/api/src/server.ts', SERVER);
    put(
      'docs/API.md',
      [
        '# API',
        '',
        '| Method | Path | Notes |',
        '| --- | --- | --- |',
        '| GET | /api/projects | list |',
        '| POST | /api/projects | create |',
        '| GET | /api/tasks | list |',
        '',
      ].join('\n'),
    );
    const gap = missingAdoptionItems({ ask: BUILD_ASK, cwd: root }).find((g) => g.id === 'api-contract');
    // Recognised as a real reference — the ask is to derive the document, not "write one".
    expect(gap?.missing).toContain('docs/API.md');
    expect(gap?.missing).toContain('written by hand');
  });

  it('does NOT accept a spec-shaped file with no paths (an empty stub is not a contract)', () => {
    put('apps/api/src/server.ts', SERVER);
    put('openapi.yaml', 'openapi: 3.0.0\ninfo:\n  title: Platform\n');
    expect(ids(missingAdoptionItems({ ask: BUILD_ASK, cwd: root }))).toContain('api-contract');
  });

  it('accepts an operations section inside the README', () => {
    put('apps/api/src/server.ts', SERVER);
    put('README.md', README);
    expect(ids(missingAdoptionItems({ ask: BUILD_ASK, cwd: root }))).not.toContain('operations');
  });

  it('does NOT accept a heading with nothing under it', () => {
    put('apps/api/src/server.ts', SERVER);
    put('README.md', '# Platform\n\n## Environment\n\nTBD\n');
    expect(ids(missingAdoptionItems({ ask: BUILD_ASK, cwd: root }))).toContain('operations');
  });

  it('accepts a SECURITY.md and a docs/adr directory', () => {
    put('apps/api/src/server.ts', SERVER);
    put('SECURITY.md', '# Security\n\nTokens are verified per request; tenants are isolated by `tenant_id`.\n');
    put('docs/adr/0001-postgres-over-sqlite.md', '# Postgres over SQLite\n\n## Decision\n\nPostgres.\n');
    const gaps = ids(missingAdoptionItems({ ask: BUILD_ASK, cwd: root }));
    expect(gaps).not.toContain('security');
    expect(gaps).not.toContain('decisions');
  });

  it('does not owe a threat model just because the ask IMPLEMENTS auth', () => {
    // Measured 2026-10-30 (GREENFIELD-API, the head-to-head): the ask said "JSON
    // HTTP API … with token auth", the run passed every contract check — and was
    // told "security is missing: nothing in the tree lets a stranger operate it",
    // so it wrote 61 lines of SECURITY.md nobody asked for. Implementing
    // authentication is not commissioning a threat model; posture is.
    put('apps/api/src/server.ts', SERVER);
    const gaps = ids(
      missingAdoptionItems({
        ask: 'Build a small notes service: a JSON HTTP API over sqlite with token auth, a CLI and a unittest suite.',
        cwd: root,
      }),
    );
    expect(gaps).not.toContain('security');
  });

  it('still owes it for a production-shaped ask, and says which word asked', () => {
    put('apps/api/src/server.ts', SERVER);
    const gaps = missingAdoptionItems({
      ask: 'Build a multi-tenant SaaS API with token auth.',
      cwd: root,
    });
    const security = gaps.find((g) => g.id === 'security');
    expect(security).toBeTruthy();
    expect(security?.evidence).toMatch(/production-shaped/);
  });

  it('does not ask for decisions or a threat model when the ask never mentions them', () => {
    put('apps/api/src/server.ts', SERVER);
    const gaps = ids(
      missingAdoptionItems({
        ask: 'Build a small notes service with an Express API and a README.',
        cwd: root,
      }),
    );
    expect(gaps).toEqual(['api-contract', 'operations']);
  });
});

describe('adoptionKitNudge', () => {
  it('names one item mid-build, with what was looked for and what would satisfy it', () => {
    put('apps/api/src/server.ts', SERVER);
    const gaps = missingAdoptionItems({ ask: BUILD_ASK, cwd: root }).slice(0, 1);
    const text = adoptionKitNudge(gaps);
    expect(text).toContain('The tree is a working service');
    expect(text).toContain('API contract');
    expect(text).toContain('api_spec');
    expect(text).toContain('docs/openapi.yaml');
    // Mid-build it does not recite the whole checklist...
    expect(text).not.toContain('threat-model');
  });

  it('lists the whole remaining set at the close, as one handover', () => {
    put('apps/api/src/server.ts', SERVER);
    const gaps = missingAdoptionItems({ ask: BUILD_ASK, cwd: root });
    const text = adoptionKitNudge(gaps, { closing: true });
    expect(text).toContain('4 documents are missing');
    expect(text).toContain('API contract');
    expect(text).toContain('operations');
    expect(text).toContain('security');
    expect(text).toContain('decision records');
    // The honesty rule travels with the ask: describe what exists, not what does not.
    expect(text).toContain('do not describe features that are not there');
  });
});
