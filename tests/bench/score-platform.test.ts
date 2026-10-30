/**
 * The Ultimate Agent Benchmark scorer.
 *
 * It must be honest about two things a naive counter gets wrong: an EMPTY
 * workspace scores near zero rather than crashing, and an aspect nobody exercised
 * (the hidden change events) is removed from the denominator instead of scored as
 * a failure — otherwise every clean run reads as "failed adaptability".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error — plain Node script, no type declarations (as the bench runs it).
import { scorePlatform } from '../../scripts/bench/platform/score-platform.mjs';

let empty: string;
let built: string;

beforeAll(() => {
  empty = mkdtempSync(join(tmpdir(), 'platform-empty-'));

  built = mkdtempSync(join(tmpdir(), 'platform-built-'));
  const write = (path: string, content: string): void => {
    const abs = join(built, path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  };

  write(
    'package.json',
    JSON.stringify({
      dependencies: { next: '14', express: '4', pg: '8', prisma: '5', zod: '3', jsonwebtoken: '9', bcrypt: '5', helmet: '7' },
      scripts: { test: 'vitest' },
    }),
  );
  write('docs/PRD.md', '# PRD\nGoals and non-goals.\n');
  write('docs/ARCHITECTURE.md', '# Architecture\nNext.js + Express + Postgres.\n');
  write('docs/ROADMAP.md', '# Roadmap\nPhase 1.\n');
  write('docs/RISK.md', '# Risks\nAuth risk.\n');
  write('todo.md', '- [x] scaffold\n- [ ] auth\n');
  write('progress.md', 'done: scaffold\n');
  write('issues.md', 'none yet\n');
  write('CHANGELOG.md', '## 0.1.0\n');
  write('README.md', `# Platform\n${'Deployment and API docs. '.repeat(120)}\n`);
  write('docs/API.md', '# API\n');
  write('docs/DEPLOYMENT.md', '# Deploy\nDocker compose.\n');
  write(
    'server/index.ts',
    `
    import express from 'express';
    import jwt from 'jsonwebtoken';
    import bcrypt from 'bcrypt';
    import { z } from 'zod';
    const app = express();
    app.use(helmet());
    app.use(rateLimit({ windowMs: 60_000, max: 100 }));
    const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
    app.post('/login', async (req, res) => {
      const { email, password } = loginSchema.parse(req.body);
      const hash = await bcrypt.hash(password, 12);
      const accessToken = jwt.sign({ email }, SECRET, { expiresIn: '15m' });
      const refreshToken = jwt.sign({ email }, REFRESH_SECRET, { expiresIn: '30d' });
      res.json({ hash, accessToken, refreshToken });
    });
    app.get('/projects', async (req, res, next) => {
      try {
        const page = Number(req.query.page ?? 1);
        const limit = Number(req.query.limit ?? 20);
        const rows = await prisma.project.findMany({ skip: (page - 1) * limit, take: limit });
        res.json(rows);
      } catch (err) { next(err); }
    });
    app.use((err, req, res, next) => res.status(500).json({ error: 'internal' }));
    export default app;
    `,
  );
  write('prisma/schema.prisma', 'model Project { id String @id }\n');
  write('db/migrations/001.sql', 'CREATE UNIQUE INDEX projects_name ON projects(name);\n');
  write(
    'tests/unit/projects.test.ts',
    Array.from({ length: 40 }, (_, i) => `it('case ${i}', () => { expect(1).toBe(1); });`).join('\n'),
  );
  write('tests/integration/api.test.ts', "it('integration', () => { expect(1).toBe(1); });\n");
  write('tests/e2e/flow.spec.ts', "it('e2e', () => { expect(1).toBe(1); });\n");
});

afterAll(() => {
  rmSync(empty, { recursive: true, force: true });
  rmSync(built, { recursive: true, force: true });
});

describe('scorePlatform', () => {
  it('scores an empty workspace at (almost) zero without throwing', () => {
    const result = scorePlatform({ workspace: empty, log: '' });
    expect(result.counts.files).toBe(0);
    expect(result.aspects.planning).toBe(0);
    expect(result.aspects.development).toBe(0);
    expect(result.overall).toBe(0);
  });

  it('credits a workspace that actually contains the requested product', () => {
    const result = scorePlatform({ workspace: built, log: '' });
    expect(result.evidence.planning).toMatchObject({ prd: true, architecture: true, roadmap: true, risk: true, taskList: true });
    expect(result.evidence.taskManagement).toMatchObject({ todo: true, progress: true, issues: true, changelog: true, live: true });
    expect(result.evidence.development.stack).toMatchObject({ next: true, backend: true, postgres: true, typescript: true });
    expect(result.evidence.testing.kinds).toMatchObject({ unit: true, integration: true, e2e: true });
    expect(result.evidence.security.jwt).toBe(true);
    expect(result.evidence.security.hashing).toBe(true);
    expect(result.evidence.security.rateLimit).toBe(true);
    expect(result.evidence.performance.indexes).toBe(true);
    expect(result.subScores.security).toBeGreaterThan(80);
    expect(result.overall).toBeGreaterThan(55);
  });

  it('leaves adaptability out of the denominator when no event was delivered', () => {
    const notExercised = scorePlatform({ workspace: built, log: '' });
    expect(notExercised.evidence.adaptability.eventDelivered).toBe(false);
    expect(notExercised.aspects.adaptability).toBe(0);

    // A delivered event makes the aspect COUNT — but credit is per-event and
    // needs evidence in the code. A log line quoting the request is not adapting.
    const quoted = scorePlatform({ workspace: built, log: 'Requirement change: users now need Teams' });
    expect(quoted.evidence.adaptability.eventDelivered).toBe(true);
    expect(quoted.aspects.adaptability).toBe(0);
    expect(quoted.evidence.adaptability.adaptDetail.teams).toBe(false);

    // The same event with a real `team_id` column earns the event's credit.
    const adapted = mkdtempSync(join(tmpdir(), 'platform-adapted-'));
    try {
      mkdirSync(join(adapted, 'db'), { recursive: true });
      writeFileSync(join(adapted, 'db/schema.ts'), 'export const teams = table("teams", { id: text("id") });\nexport const tasks = table("tasks", { teamId: text("team_id") });\n');
      const result = scorePlatform({ workspace: adapted, log: 'Requirement change: projects become Teams' });
      expect(result.evidence.adaptability.adaptDetail.teams).toBe(true);
      expect(result.aspects.adaptability).toBeGreaterThan(0);
    } finally {
      rmSync(adapted, { recursive: true, force: true });
    }
  });

  /**
   * MEASURED (2026-10-25): the Express-only detector scored agent-nuvira 70 on
   * problem solving while the repo held a Next.js-shaped boundary — a domain
   * error hierarchy carrying status codes plus a `fail()` mapper called from
   * every route handler. A thrown error that is mapped to a status is an error
   * boundary whether or not `app.use((err` exists.
   */
  it('credits a framework error boundary, not only Express middleware', () => {
    const framework = mkdtempSync(join(tmpdir(), 'platform-framework-'));
    try {
      const write = (path: string, content: string): void => {
        const abs = join(framework, path);
        mkdirSync(join(abs, '..'), { recursive: true });
        writeFileSync(abs, content);
      };
      write('src/server/errors.ts', `export class AppError extends Error { constructor(readonly status: number) { super('x'); } }\nexport function toErrorResponse(e: unknown) { return { status: 500, body: { error: String(e) } }; }\n`);
      write('src/server/http.ts', `import { toErrorResponse } from './errors';\nexport const fail = (e: unknown) => toErrorResponse(e);\n`);
      write('app/api/health/route.ts', `import { fail } from '../../../src/server/http';\nexport const GET = () => { throw new Error('boom'); };\n`);
      write('app/error.tsx', 'export default function Error() { return null; }\n');

      const result = scorePlatform({ workspace: framework, log: '' });
      expect(result.evidence.problemSolving.expressMiddleware).toBe(false);
      expect(result.evidence.problemSolving.frameworkBoundary).toBe(true);
      expect(result.evidence.problemSolving.errorMiddleware).toBe(true);

      // An error module with no status mapping and no boundary is not one.
      const bare = mkdtempSync(join(tmpdir(), 'platform-bare-'));
      try {
        mkdirSync(join(bare, 'src'), { recursive: true });
        writeFileSync(join(bare, 'src/errors.ts'), 'export const oops = 1;\n');
        const none = scorePlatform({ workspace: bare, log: '' });
        expect(none.evidence.problemSolving.errorMiddleware).toBe(false);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    } finally {
      rmSync(framework, { recursive: true, force: true });
    }
  });

  it('counts tool usage from the log, and excludes it when no log was captured', () => {
    // No log at all is NO EVIDENCE, not "zero calls": the aspect leaves the
    // denominator instead of deleting 20 % of the agent's score.
    const noLog = scorePlatform({ workspace: built, log: '' });
    expect(noLog.evidence.toolUsage.measured).toBe(false);
    expect(noLog.aspects.toolUsage).toBeNull();

    const proseLog = 'the agent answered in prose and ran nothing\n';
    const idle = scorePlatform({ workspace: built, log: proseLog });
    expect(idle.evidence.toolUsage.measured).toBe(true);
    expect(idle.aspects.toolUsage).toBe(0);
    expect(noLog.overall).toBeGreaterThan(idle.overall);

    const busyLog = Array.from({ length: 160 }, (_, i) =>
      i % 2 === 0 ? 'ℹ ⚙ run_terminal({command: ls})' : 'ℹ ⚙ write_file({path: x})',
    ).join('\n');
    const busy = scorePlatform({ workspace: built, log: busyLog });
    expect(busy.aspects.toolUsage).toBeGreaterThan(60);
  });
});
