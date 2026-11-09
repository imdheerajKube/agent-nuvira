/**
 * Steering's default and rollback contract.
 *
 * The dashboard exposes guidance in the composer, so a default-off flag made a
 * normal deployment answer every mid-turn message with "steering is disabled".
 * It is now on by default; turning it off is still one config key or one env
 * value, and a disabled run must remain byte-identical to the pre-steering path.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../../src/config/manager.js';
import { steeringEnabled } from '../../src/steering/runtime.js';

const dirs: string[] = [];
const previous = process.env.NUVIRA_STEERING;

afterEach(() => {
  if (previous === undefined) delete process.env.NUVIRA_STEERING;
  else process.env.NUVIRA_STEERING = previous;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nuvira-steer-default-'));
  dirs.push(dir);
  return dir;
}

describe('steering default configuration', () => {
  it('is enabled for a fresh profile', () => {
    delete process.env.NUVIRA_STEERING;
    const cm = new ConfigManager(tempConfigDir());
    expect(cm.getAll().steering?.enabled).toBe(true);
    expect(steeringEnabled(cm)).toBe(true);
  });

  it('still turns off with one env value', () => {
    process.env.NUVIRA_STEERING = '0';
    const cm = new ConfigManager(tempConfigDir());
    expect(steeringEnabled(cm)).toBe(false);
  });
});
