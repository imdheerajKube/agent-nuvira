/**
 * PRODUCTION-READINESS DUTY — the last documentation gap, closed as a RULE, not a filename.
 *
 * Measured 2026-10-26 (final bench): the "production-ready SaaS platform" ask produced a 9.5 KB
 * README, a PRD, an architecture document and 21 ADRs, and still lost the documentation row to
 * Cline — 75 vs 100 — because nothing in the tree said how the service reaches a server. Cline
 * shipped a compose file, two Dockerfiles and a deploy workflow.
 *
 * Checked BEFORE adding the gate, because \"add a gate\" is not automatically right: neither
 * competitor has a documentation gate at all (Cline: three tools, no README/deploy check in its
 * shipped code; Freebuff failed the same README instruction in both rounds). So this is a
 * compensation for a place the model is unreliable, and it earns its keep only if it states a
 * FACT about the tree and accepts every honest form of satisfying it.
 *
 * That is what these tests pin: one artefact of ANY accepted form is enough, a CI workflow only
 * counts when it actually deploys, and an ask that never claims production owes nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { productionReadinessDuty, productionDutyNudge } from '../../src/learning/doc-claims.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'production-duty-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, content = 'x'): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const ASK = 'Build a production-ready SaaS platform with a Next.js frontend and a Node API.';
const WROTE = ['package.json'];

describe('productionReadinessDuty — a production ask owes an operational artefact', () => {
  it('fires when the ask says production-ready and only source exists', () => {
    put('package.json', '{"scripts":{"start":"node index.js"}}');
    const duty = productionReadinessDuty({ ask: ASK, cwd: root, writtenPaths: WROTE });
    expect(duty.needed).toBe(true);
    expect(duty.asked).toBe('production-ready');
    expect(productionDutyNudge(duty)).toContain('Dockerfile');
  });

  it.each([
    ['docker-compose.yml'],
    ['Dockerfile'],
    ['apps/api/Dockerfile'],
    ['deploy/k8s/api.yaml'],
    ['docs/DEPLOYMENT.md'],
    ['docs/runbook.md'],
  ])('is satisfied by %s', (path) => {
    put('package.json', '{"scripts":{"start":"node index.js"}}');
    put(path, path.endsWith('.md') ? '# Deployment\n' : 'services: {}\n');
    expect(productionReadinessDuty({ ask: ASK, cwd: root, writtenPaths: WROTE }).needed).toBe(false);
  });

  it('counts a CI workflow ONLY when it deploys, not when it merely tests', () => {
    put('package.json', '{"scripts":{"start":"node index.js"}}');
    put('.github/workflows/ci.yml', 'jobs:\n  test:\n    steps:\n      - run: npm test\n');
    expect(productionReadinessDuty({ ask: ASK, cwd: root, writtenPaths: WROTE }).needed).toBe(true);

    put('.github/workflows/deploy.yml', 'jobs:\n  ship:\n    steps:\n      - run: docker push ghcr.io/acme/app\n');
    expect(productionReadinessDuty({ ask: ASK, cwd: root, writtenPaths: WROTE }).needed).toBe(false);
  });

  it('asks for a POINTER when the story is only an unnamed directory', () => {
    // Measured 2026-10-27 across ten real benchmark trees: `infra/`, `ops/`, `helm/` and
    // `terraform/` are the four accepted forms a path scan cannot recognise, and
    // `ops/init-test-db.sql` is not "how it ships". The artefact exists, so the ask is not
    // "build one" — it is "say where it lives", one paragraph a person would want anyway.
    put('package.json', '{"scripts":{"start":"node index.js"}}');
    put('infra/main.tf', 'resource "aws_ecs_service" "api" {}\n');
    const duty = productionReadinessDuty({ ask: ASK, cwd: root, writtenPaths: WROTE });
    expect(duty.needed).toBe(true);
    expect(duty.pointerTo).toBe('infra');
    const nudge = productionDutyNudge(duty);
    expect(nudge).toContain('infra');
    expect(nudge).toContain('docs/DEPLOYMENT.md');

    // …and one findable artefact settles it, without asking anyone to change tooling.
    put('docs/DEPLOYMENT.md', '# Deployment\n\nTerraform in infra/ applies the ECS service.\n');
    expect(productionReadinessDuty({ ask: ASK, cwd: root, writtenPaths: WROTE }).needed).toBe(false);
  });

  it('never fires on an ask that does not claim production', () => {
    put('package.json', '{"scripts":{"start":"node index.js"}}');
    for (const ask of [
      'Build a small CLI that converts CSV to JSON and write tests for it.',
      'Fix the off-by-one bug in the paginator.',
      'What does this project do?',
    ]) {
      expect(productionReadinessDuty({ ask, cwd: root, writtenPaths: WROTE }).needed).toBe(false);
    }
  });

  it('never fires when the turn did not make the project runnable', () => {
    expect(productionReadinessDuty({ ask: ASK, cwd: root, writtenPaths: ['notes.md'] }).needed).toBe(false);
  });
});
