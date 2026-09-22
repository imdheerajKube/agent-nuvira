/**
 * Telemetry provenance — the view must be able to tell synthetic from live.
 *
 * WHY. A test suite used to drive the real pipeline with a fake model, and one
 * phantom model (`local/nonexistent-fast-fail`) became **2,110 of the 3,436
 * lines** in "Learned from real usage" — the largest row on the dashboard, for a
 * model that exists nowhere in `src/`. The leak is now fixed at the source
 * (`tests/setup/hermetic-env.ts`); this is the second layer.
 *
 * The action log is HASH-CHAINED (`verifyChain`), so the honest fix is not to
 * rewrite history — it is to label the records and exclude them from the numbers
 * while SAYING how many were excluded. Deliberately not hidden.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aggregateActionTelemetry,
  getModelRegistry,
  readActionTelemetryFile,
  resetModelRegistry,
  telemetryOrigin,
  ACTION_LOG_FILENAME,
  type ActionTelemetryEntry,
} from '../../src/learning/model-registry.js';

/** A minimal telemetry record. */
function event(
  action: string,
  outcome: ActionTelemetryEntry['outcome'],
  origin?: 'live' | 'test',
): ActionTelemetryEntry {
  return {
    timestamp: Date.now(),
    action,
    provider: 'gemini',
    model: 'm1',
    outcome,
    ...(origin ? { origin } : {}),
  };
}

let dir = '';
let originalDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-telemetry-'));
  originalDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = dir;
  resetModelRegistry();
});

afterEach(() => {
  resetModelRegistry();
  delete process.env.TELEMETRY_ORIGIN;
  if (originalDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = originalDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('telemetryOrigin — detect the runner, fail closed to "live"', () => {
  it('reports "test" under a test runner (vitest sets VITEST)', () => {
    expect(telemetryOrigin()).toBe('test');
  });

  it('honours an explicit override in both directions', () => {
    process.env.TELEMETRY_ORIGIN = 'live';
    expect(telemetryOrigin()).toBe('live');
    process.env.TELEMETRY_ORIGIN = 'test';
    expect(telemetryOrigin()).toBe('test');
  });

  it('treats an unrecognised value as no override', () => {
    process.env.TELEMETRY_ORIGIN = 'banana';
    // Falls through to the runner check — which, under vitest, is still `test`.
    expect(telemetryOrigin()).toBe('test');
  });
});

describe('aggregateActionTelemetry — exclude synthetic records, and say so', () => {
  it('drops test-origin events from every number in the view', () => {
    const insights = aggregateActionTelemetry([
      event('chat', 'verified', 'live'),
      event('chat', 'unavailable', 'test'),
      event('chat', 'unavailable', 'test'),
    ]);
    expect(insights.total).toBe(1);
    expect(insights.synthetic).toBe(2);
    expect(insights.actions[0].verified).toBe(1);
    expect(insights.actions[0].killed).toBe(0);
  });

  it('treats a record with no origin as live (old data keeps working)', () => {
    const insights = aggregateActionTelemetry([event('execute', 'verified')]);
    expect(insights.total).toBe(1);
    expect(insights.synthetic).toBe(0);
    expect(insights.actions[0].verified).toBe(1);
  });

  it('can still include everything on request, and then reports nothing hidden', () => {
    const insights = aggregateActionTelemetry(
      [event('chat', 'verified', 'live'), event('chat', 'verified', 'test')],
      { includeSynthetic: true },
    );
    expect(insights.total).toBe(2);
    expect(insights.synthetic).toBe(0);
  });

  it('a phantom model from a test process cannot become the biggest row', () => {
    const entries: ActionTelemetryEntry[] = [
      ...Array.from({ length: 100 }, () =>
        event('chat', 'unavailable', 'test'),
      ).map((e) => ({ ...e, model: 'nonexistent-fast-fail' })),
      event('chat', 'verified', 'live'),
    ];
    const insights = aggregateActionTelemetry(entries);
    expect(insights.actions[0].killedModels.map((m) => m.model)).not.toContain('nonexistent-fast-fail');
    expect(insights.actions[0].killed).toBe(0);
    expect(insights.synthetic).toBe(100);
  });
});

describe('the write path stamps provenance itself', () => {
  it('marks a record written from a test process as origin:test', () => {
    const registry = getModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'telemetry', 120, 'chat');

    const logged = readActionTelemetryFile(join(dir, ACTION_LOG_FILENAME));
    const newest = logged[logged.length - 1];
    expect(newest?.origin).toBe('test');
  });

  it('keeps the raw record on disk (a tamper-evident chain is not silently rewritten)', () => {
    const registry = getModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'telemetry', 120, 'chat');

    // The record exists in the chain...
    const logged = readActionTelemetryFile(join(dir, ACTION_LOG_FILENAME));
    expect(logged.length).toBeGreaterThan(0);
    // ...and the dashboard view still excludes it.
    expect(registry.getActionTelemetry().total).toBe(0);
    expect(registry.getActionTelemetry().synthetic).toBeGreaterThan(0);
  });
});

describe('an empty log', () => {
  it('reports zero, not NaN', () => {
    const insights = aggregateActionTelemetry([]);
    expect(insights.total).toBe(0);
    expect(insights.synthetic).toBe(0);
    expect(insights.enabled).toBe(false);
  });
});
