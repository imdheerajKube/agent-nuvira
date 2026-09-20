/**
 * Gateway heartbeat — liveness must be OBSERVABLE.
 *
 * The gateway is a foreground process, so a crash (or the machine sleeping, or
 * the launching shell being killed) used to leave every channel silently dead
 * while `gateway status` still listed the platforms as "configured ✅". These
 * tests pin the contract that makes that impossible: a fresh beat = running, an
 * old beat = dead, no beat = down, and a clean shutdown says "down" rather than
 * leaving a misleading stale beat behind.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GatewayHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_AFTER_MS,
  formatDuration,
  type AdapterHealth,
} from '../../src/gateway/heartbeat.js';

let cfgDir = '';

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'buff-beat-'));
});

afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true });
});

const health: AdapterHealth[] = [
  { platform: 'whatsapp', configured: true, started: true, restarts: 0 },
  { platform: 'telegram', configured: true, started: false, restarts: 2, lastError: 'ETIMEDOUT' },
];

describe('GatewayHeartbeat', () => {
  it('reports DOWN when no gateway has ever beat (the silent-failure state)', () => {
    const status = new GatewayHeartbeat(cfgDir).status();
    expect(status.state).toBe('down');
    expect(status.beat).toBeNull();
    expect(status.path).toContain('heartbeat.json');
  });

  it('reports RUNNING for a fresh beat, with the adapter health it carried', () => {
    const beat = new GatewayHeartbeat(cfgDir);
    beat.beat({ startedAt: Date.now() - 60_000, beats: 4, supervised: true, supervisorPid: 42, adapters: health });
    const status = beat.status();
    expect(status.state).toBe('running');
    expect(status.beat?.pid).toBe(process.pid);
    expect(status.beat?.supervised).toBe(true);
    expect(status.beat?.supervisorPid).toBe(42);
    expect(status.beat?.adapters.filter((a) => a.started).map((a) => a.platform)).toEqual(['whatsapp']);
    expect(status.beat?.adapters.find((a) => a.platform === 'telegram')?.lastError).toBe('ETIMEDOUT');
  });

  it('reports STALE once the beat stops (a killed process leaves a stale file)', () => {
    const beat = new GatewayHeartbeat(cfgDir);
    beat.beat({ startedAt: Date.now(), beats: 1, supervised: false, adapters: health });
    // Simulate a process that died 10 minutes ago: rewrite the beat's `at`.
    const file = beat.beatPath;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    parsed.at = Date.now() - 10 * 60_000;
    writeFileSync(file, JSON.stringify(parsed), 'utf-8');

    const status = beat.status();
    expect(status.state).toBe('stale');
    expect(status.ageMs).toBeGreaterThan(HEARTBEAT_STALE_AFTER_MS);
  });

  it('the staleness threshold is several missed beats, never one slow tick', () => {
    expect(HEARTBEAT_STALE_AFTER_MS).toBeGreaterThanOrEqual(HEARTBEAT_INTERVAL_MS * 2);
  });

  it('clear() on a clean shutdown leaves "down" — not a misleading stale beat', () => {
    const beat = new GatewayHeartbeat(cfgDir);
    beat.beat({ startedAt: Date.now(), beats: 1, supervised: false, adapters: health });
    expect(existsSync(beat.beatPath)).toBe(true);
    beat.clear();
    expect(existsSync(beat.beatPath)).toBe(false);
    expect(beat.status().state).toBe('down');
  });

  it('a corrupt beat reads as DOWN rather than throwing', () => {
    const beat = new GatewayHeartbeat(cfgDir);
    mkdirSync(join(beat.beatPath, '..'), { recursive: true });
    writeFileSync(beat.beatPath, '{not json', 'utf-8');
    expect(beat.read()).toBeNull();
    expect(beat.status().state).toBe('down');
  });

  it('formatDuration renders the operator-facing ages', () => {
    expect(formatDuration(3_000)).toBe('3s');
    expect(formatDuration(4 * 60_000 + 5_000)).toBe('4m 5s');
    expect(formatDuration(2 * 3_600_000 + 7 * 60_000)).toBe('2h 7m');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('never');
  });
});
