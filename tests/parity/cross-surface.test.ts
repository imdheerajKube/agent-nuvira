/**
 * WS0 (#22) — cross-surface parity, enforced from the first commit.
 *
 * Three things are checked here, and each one exists because of a measured
 * failure mode, not out of tidiness:
 *
 *   1. THE REGISTRY IS COMPLETE. Every declared module exists, every surface
 *      declares a shared turn entry, and every surface can name how a test
 *      drives it headlessly. Without this the registry is a comment.
 *
 *   2. THE REGISTRY MATCHES THE CODE. `classifySurface` reads the real imports
 *      and its verdict must EQUAL the declaration. This is what stops the
 *      registry from describing an architecture we no longer have — the same
 *      class of bug as the hand-maintained dashboard bundle that silently
 *      missed a whole tab.
 *
 *   3. THE DEBT RATCHET ONLY SHRINKS. The set of surfaces that build their own
 *      provider, or drive the pipeline engine without the wrapper, must equal a
 *      frozen list. A new bypass fails; fixing one without deleting its entry
 *      fails too, so no stale entry can hide the next bypass.
 *
 * Plus the comparison itself: the parity projection must pass for noise-only
 * differences and fail, BY NAME, for the differences a user would notice.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SURFACES,
  SURFACE_DEBT,
  TURN_ENTRIES,
  parityMatrix,
  surfaceModulePaths,
  turnEntryModulePaths,
} from '../../src/parity/surfaces.js';
import {
  classifyAllSurfaces,
  classifySurface,
  declaredSurfaceDebt,
  extractSpecifiers,
  observedSurfaceDebt,
  resolveSpecifier,
} from '../../src/parity/graph.js';
import {
  compare,
  isAtPar,
  reportParityFailure,
  type TurnObservation,
} from '../../src/parity/observation.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ─── 1. The registry is complete ────────────────────────────────────────────

describe('WS0 surface registry — completeness', () => {
  it('declares every surface exactly once, with a headless way to drive it', () => {
    const ids = SURFACES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const surface of SURFACES) {
      expect(surface.modules.length, `${surface.id} declares no module`).toBeGreaterThan(0);
      expect(surface.turnEntries.length, `${surface.id} declares no turn entry`).toBeGreaterThan(0);
      expect(surface.engines.length, `${surface.id} declares no engine`).toBeGreaterThan(0);
      expect(surface.headless.trim(), `${surface.id} has no headless path`).not.toBe('');
    }
  });

  it('points only at modules that exist', () => {
    // A registry naming a deleted or renamed module would otherwise pass every
    // check by finding nothing to classify.
    for (const modulePath of [...surfaceModulePaths(), ...turnEntryModulePaths()]) {
      expect(existsSync(join(REPO_ROOT, modulePath)), `${modulePath} does not exist`).toBe(true);
    }
  });

  it('declares every turn entry the surfaces reference', () => {
    for (const surface of SURFACES) {
      for (const entry of surface.turnEntries) {
        expect(TURN_ENTRIES[entry], `${surface.id} names unknown entry ${entry}`).toBeDefined();
        expect(surface.engines, `${surface.id} uses ${entry} but does not declare its engine`).toEqual(
          expect.arrayContaining([...TURN_ENTRIES[entry].engines]),
        );
      }
    }
  });

  it('exercises both engines across the matrix', () => {
    // The whole point of the matrix is that a capability cannot work under
    // `loop` and quietly fail under `pipeline`.
    const engines = new Set(parityMatrix().map((cell) => cell.engine));
    expect([...engines].sort()).toEqual(['loop', 'pipeline']);
    expect(parityMatrix().length).toBe(SURFACES.reduce((n, s) => n + s.engines.length, 0));
  });
});

// ─── 2. The registry matches the code ───────────────────────────────────────

describe('WS0 surface registry — matches the real import graph', () => {
  it('sees imports at all, so a blind classifier cannot pass as compliance', () => {
    // If the extractor silently broke, every surface would look like it reaches
    // nothing and the equality assertions below would fail loudly — but this
    // test names the cause instead of leaving a confusing diff.
    expect(extractSpecifiers("import { a } from '../x.js';")).toEqual(['../x.js']);
    expect(extractSpecifiers("await import('../y.js');")).toEqual(['../y.js']);
    expect(resolveSpecifier(REPO_ROOT, 'src/tools/registry.ts', '../utils/logger.js')).toBe(
      'src/utils/logger.ts',
    );

    const reaches = classifyAllSurfaces(REPO_ROOT);
    expect(reaches.length).toBe(SURFACES.length);
    for (const reach of reaches) {
      expect(reach.entries.length, `${reach.surface} reaches no shared entry`).toBeGreaterThan(0);
    }
  });

  it('finds exactly the turn entries each surface declares', () => {
    // MEASURED, and worth stating because it is the good news: the dashboard
    // reaches the chat engine through `chat-console.ts` (`import('../cli/chat.js')`)
    // and the gateway reaches BOTH `pipeline-tool` and the chat engine, so those
    // two surfaces already share the interactive engine. `cli-execute` reaches
    // three shared entries and — since it stopped importing the Orchestrator —
    // picks between them through shared wrappers rather than by driving an
    // engine itself.
    for (const surface of SURFACES) {
      const reach = classifySurface(REPO_ROOT, surface);
      expect(
        reach.entries,
        `${surface.id} declares [${surface.turnEntries.join(', ')}] but its modules reach [${reach.entries.join(', ')}]`,
      ).toEqual([...surface.turnEntries].sort());
    }
  });
});

// ─── 3. The debt ratchet ────────────────────────────────────────────────────

describe('WS0 anti-silo ratchet', () => {
  it('has exactly the surface debt that is declared, no more and no less', () => {
    // Both directions matter. Growth means a new silo was added; a stale entry
    // means one was fixed and the list still claims it, which would let the
    // next real bypass hide behind a line everyone has learned to ignore.
    expect(observedSurfaceDebt(REPO_ROOT)).toEqual(declaredSurfaceDebt());
  });

  it('keeps both rules declared, and the debt at zero', () => {
    // The keys stay present with EMPTY arrays: the point is that both rules are
    // still measured. An absent key would silently stop the check, and the next
    // surface that built its own provider or bypassed the wrapper would be
    // invisible instead of a one-line diff here.
    expect(SURFACE_DEBT['provider-factory']).toEqual([]);
    expect(SURFACE_DEBT['pipeline-wrapper-bypass']).toEqual([]);
    // The ratchet's two directions on a now-clean tree: the observed debt is
    // empty, and a hypothetical new bypass would still fail the equality above
    // (that is what `observedSurfaceDebt` reports, asserted in the test before
    // this one).
    expect(observedSurfaceDebt(REPO_ROOT)).toEqual(declaredSurfaceDebt());
  });
});

// ─── 4. The comparison itself ───────────────────────────────────────────────

const observation = (over: Partial<TurnObservation> = {}): TurnObservation => ({
  surface: 'cli-chat',
  engine: 'loop',
  status: 'completed',
  provider: 'groq',
  model: 'qwen/qwen3.8-27b',
  transport: 'native',
  toolCalls: [{ tool: 'read_file' }, { tool: 'str_replace' }],
  // WS1 — findings are part of the projection; `[]` is the honest "none".
  findings: [],
  answer: 'done',
  ...over,
});

describe('WS0 parity projection', () => {
  it('ignores identity and timing', () => {
    const a = observation({
      noise: { turnId: 'aaa', at: 1, durationMs: 10, cwd: '/one', tokens: 100 },
    });
    const b = observation({
      surface: 'gateway-chat',
      noise: { turnId: 'bbb', at: 2, durationMs: 99, cwd: '/two', tokens: 900 },
    });
    expect(isAtPar(a, b)).toBe(true);
    expect(compare(a, b)).toEqual([]);
  });

  it('names the surfaces and the field when behaviour differs', () => {
    const chat = observation();
    const gateway = observation({
      surface: 'gateway-chat',
      toolCalls: [{ tool: 'read_file' }],
      transport: 'json',
    });
    const differences = compare(chat, gateway);
    expect(differences.length).toBeGreaterThan(0);
    // Every difference must be actionable: which two surfaces, which field.
    for (const difference of differences) {
      expect(difference).toContain('cli-chat');
      expect(difference).toContain('gateway-chat');
    }
    expect(differences.join('\n')).toContain('transport');
    expect(differences.join('\n')).toContain('str_replace');
  });

  it('treats a call that FAILED on one surface as a difference, not as agreement', () => {
    // The whole reason a tool call is a record and not a bare name: a call that
    // succeeded on one surface and failed on another is not the same experience,
    // and comparing names alone would report it as a pass.
    const succeeded = observation({ toolCalls: [{ tool: 'read_file', ok: true }] });
    const failed = observation({ surface: 'cli-execute', toolCalls: [{ tool: 'read_file', ok: false }] });
    const differences = compare(succeeded, failed);
    expect(differences.join('\n')).toContain('read_file');
    expect(differences.join('\n')).toContain('FAILED');

    // An absent outcome is not a failure either: it is absence.
    const unknown = observation({ surface: 'gateway-chat', toolCalls: [{ tool: 'read_file' }] });
    expect(compare(succeeded, unknown).length).toBeGreaterThan(0);
  });

  it('treats a missing attribution as a difference, not as noise', () => {
    // A surface that cannot say which model served the turn is not "equivalent"
    // to one that can — that attribution is the point of the run recording.
    const attributed = observation();
    const silent = observation({ surface: 'dashboard-chat', model: undefined });
    expect(compare(attributed, silent).join('\n')).toContain('model');
  });

  it('renders a failure report a human can act on', () => {
    const chat = observation();
    const execute = observation({ surface: 'cli-execute', status: 'failed', errorCode: 'no_provider' });
    const report = reportParityFailure([chat, execute], compare(chat, execute));
    expect(report).toContain('cross-surface parity FAILED');
    expect(report).toContain('cli-execute');
    expect(report).toContain('status');
    expect(report).toContain('no_provider');
  });
});
