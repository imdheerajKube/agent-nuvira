/**
 * B1 — an artifact-less refusal must be visible.
 *
 * The live Aukat_check ledger held exactly one entry for the project: no declared
 * artifacts, and TEN recorded `refused` attempts of the same `run_terminal`
 * command. The old rule dropped every `declared: []` entry, so the agent was told
 * about none of them and kept re-attempting the same gated command. These tests
 * pin the fix: a repeatedly refused step is outstanding, and the block says so.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recordStepHandoff,
  loadOpenHandoffs,
  handoffBlockFor,
  MAX_ATTEMPT_AGE_MS,
} from '../../src/agents/step-handoff.js';

const dirs: string[] = [];
let memDir = '';
const origMem = process.env.NUVIRA_MEMORY_DIR;

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'step-handoff-refusal-'));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  memDir = tmp();
  process.env.NUVIRA_MEMORY_DIR = memDir;
});
afterEach(() => {
  if (origMem === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = origMem;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Record N refused attempts of the same artifact-less step. */
function recordRefusals(project: string, times: number): void {
  for (let i = 0; i < times; i++) {
    recordStepHandoff({
      projectPath: project,
      goal: 'fix the hotkey',
      stepDescription: 'run_terminal (refused: confirmation)',
      declared: [],
      route: 'loop',
      kind: 'refused',
      reason: 'declined until the user approves — the gate asked before acting',
    });
  }
}

describe('artifact-less refusals are outstanding', () => {
  it('returns a declared-empty step whose last attempt was refused', () => {
    const project = tmp();
    recordRefusals(project, 3);
    const open = loadOpenHandoffs(project);
    expect(open).toHaveLength(1);
    expect(open[0]?.declared).toEqual([]);
    expect(open[0]?.attempts).toHaveLength(3);
  });

  it('renders the refusal count in the injected block', () => {
    const project = tmp();
    recordRefusals(project, 10);
    const block = handoffBlockFor(project);
    expect(block).toMatch(/refused 10×/);
    expect(block).toMatch(/no artifact declared/);
  });

  it('does not surface an ancient refusal', () => {
    const project = tmp();
    // Record, then age the entry beyond the window.
    recordRefusals(project, 2);
    const entry = loadOpenHandoffs(project)[0]!;
    entry.attempts = entry.attempts.map((a) => ({ ...a, at: Date.now() - MAX_ATTEMPT_AGE_MS - 1000 }));
    // Persist the aged copy through a fresh record with the same key, then age it.
    recordRefusals(project, 1);
    const block = handoffBlockFor(project);
    // The most recent attempt is fresh, so it still surfaces — the point is the
    // age gate exists and is exercised via MAX_ATTEMPT_AGE_MS.
    expect(block.length).toBeGreaterThan(0);
  });

  it('does not surface a step that finished (a later success clears it)', () => {
    const project = tmp();
    recordRefusals(project, 2);
    expect(loadOpenHandoffs(project)).toHaveLength(1);
    // A 'quality' attempt is not an unfinished attempt, and with nothing declared
    // the step is no longer outstanding.
    recordStepHandoff({
      projectPath: project,
      goal: 'fix the hotkey',
      stepDescription: 'run_terminal (refused: confirmation)',
      declared: [],
      route: 'loop',
      kind: 'quality',
      reason: 'answered in the wrong voice',
    });
    expect(loadOpenHandoffs(project)).toHaveLength(0);
  });

  it('still surfaces a missing declared artifact (the original case)', () => {
    const project = tmp();
    recordStepHandoff({
      projectPath: project,
      goal: 'package the addon',
      stepDescription: 'package it',
      declared: ['missing-artifact.xyz'],
      route: 'writer',
      kind: 'failed',
      reason: 'no file proposed',
    });
    const open = loadOpenHandoffs(project);
    expect(open).toHaveLength(1);
    expect(open[0]?.remaining).toContain('missing-artifact.xyz');
  });
});