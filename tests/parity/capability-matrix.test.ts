/**
 * WS0 (#22) — the matrix must not flatter itself.
 *
 * The requirement from the tracker is that the experience and the execution are
 * the same on chat, execute, dashboard chat, the gateway and subagents. The way
 * that requirement fails in practice is never "someone deleted it" — it is a
 * capability landing on the surfaces that were convenient, believed to be
 * everywhere, and never checked. So this test does three things:
 *
 *   1. COMPLETENESS. Every capability has a cell for every surface, and every
 *      workstream points at a real tracker issue. A missing cell is a compile
 *      error (the row type is exhaustive); a missing issue number is this test.
 *
 *   2. CLAIM VERSUS PROOF. Every cell that says `supported` is either proven by
 *      the parity tests or named on the frozen debt list — and every debt entry
 *      has a reason on its own cell. The list can only shrink: proving a cell
 *      without deleting its entry fails, and adding an unprovable claim fails.
 *
 *   3. EXPLAINED EXCEPTIONS. A `scoped` cell is a deliberate difference, which is
 *      allowed — silently, it is not, so it must carry a note.
 */

import { describe, it, expect } from 'vitest';

import {
  CAPABILITIES,
  UNVERIFIED_SUPPORTED,
  WORKSTREAM_ISSUES,
  cellKey,
  declaredUnverifiedClaims,
  matrixCells,
  scopedExceptions,
  unverifiedClaims,
  type Workstream,
} from '../../src/parity/matrix.js';
import { SURFACES } from '../../src/parity/surfaces.js';
import { VERIFIED_CELLS, parityDrivers } from './drivers.js';

describe('WS0 capability matrix — completeness', () => {
  it('gives every capability a cell on every surface', () => {
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size, 'duplicate capability id').toBe(ids.length);

    for (const capability of CAPABILITIES) {
      expect(Object.keys(capability.cells).sort()).toEqual([...SURFACES.map((s) => s.id)].sort());
      expect(capability.label.trim()).not.toBe('');
    }
    expect(matrixCells()).toHaveLength(CAPABILITIES.length * SURFACES.length);
  });

  it('ties every capability to a tracker issue', () => {
    const known: Workstream[] = ['existing', 'WS0', 'WS1', 'WS2', 'WS3', 'WS4', 'WS5', 'WS6', 'WS7'];
    for (const [workstream, issue] of Object.entries(WORKSTREAM_ISSUES)) {
      expect(known).toContain(workstream as Workstream);
      if (workstream === 'existing') {
        expect(issue, 'pre-existing capability: no issue to point at').toBeNull();
      } else {
        // Every workstream must be a real issue, so a cell can be traced to work.
        expect(typeof issue, `${workstream} has no issue number`).toBe('number');
        expect(issue as number).toBeGreaterThan(0);
      }
    }
    for (const capability of CAPABILITIES) {
      expect(Object.keys(WORKSTREAM_ISSUES)).toContain(capability.workstream);
    }
  });

  it('has a driver entry for every surface, drivable or explicitly blocked', () => {
    // A surface missing from the driver list would be counted as neither
    // covered nor blocked — the silent hole this harness exists to prevent.
    expect(parityDrivers().map((d) => d.surface).sort()).toEqual(
      [...SURFACES.map((s) => s.id)].sort(),
    );
    for (const driver of parityDrivers()) {
      if (driver.available) continue;
      expect(driver.blockedBy?.trim(), `${driver.surface} is blocked with no reason`).toBeTruthy();
    }
  });
});

describe('WS0 capability matrix — claim versus proof', () => {
  it('proves exactly the cells it claims, and names the rest as debt', () => {
    // Both directions. A new unprovable claim fails here; so does a proven cell
    // whose debt entry was left behind.
    expect(unverifiedClaims(VERIFIED_CELLS)).toEqual(declaredUnverifiedClaims());
  });

  it('keeps the frozen debt list free of duplicates and sorted', () => {
    expect([...UNVERIFIED_SUPPORTED].sort()).toEqual([...UNVERIFIED_SUPPORTED]);
    expect(new Set(UNVERIFIED_SUPPORTED).size).toBe(UNVERIFIED_SUPPORTED.length);
  });

  it('explains every unproven claim on the cell it belongs to', () => {
    // The reason lives with the claim, so a reader never has to guess why a
    // surface is on the list.
    const byKey = new Map(matrixCells().map((c) => [cellKey(c.capability, c.surface), c.cell]));
    for (const key of UNVERIFIED_SUPPORTED) {
      const cell = byKey.get(key);
      expect(cell, `${key} is on the debt list but is not a cell`).toBeDefined();
      expect(cell!.status, `${key} is on the debt list but is not marked supported`).toBe('supported');
      expect(cell!.note?.trim(), `${key} has no reason recorded`).toBeTruthy();
    }
  });

  it('requires an explanation for every deliberate difference', () => {
    for (const exception of scopedExceptions()) {
      expect(exception.note.trim(), `${exception.capability}@${exception.surface} is scoped with no note`).not.toBe('');
    }
  });

  it('marks every unproven capability as planned rather than supported', () => {
    // The rows owned by a workstream that has not started must not claim
    // `supported` anywhere — that is the whole point of recording status
    // separately from proof.
    const notStarted: Workstream[] = ['WS1', 'WS2', 'WS3', 'WS4', 'WS5', 'WS6', 'WS7'];
    for (const capability of CAPABILITIES) {
      if (!notStarted.includes(capability.workstream)) continue;
      for (const surface of SURFACES) {
        expect(
          capability.cells[surface.id].status,
          `${capability.id}@${surface.id} claims support before ${capability.workstream} has landed`,
        ).toBe('planned');
      }
    }
  });
});
