/**
 * Bundle 44 — the requirement pre-flight.
 *
 * "This will need `gh`, and it is not installed" must be knowable BEFORE a run
 * starts, not discovered when the run is already halfway through.
 *
 * The asymmetry these tests pin is the whole honesty of the module: a missing
 * BINARY is a fact and blocks, while a credential that is not an env var is only
 * "not visible in the environment" and never blocks — it may live in the vault.
 *
 * Hermetic: every probe is injected, so no PATH or env is consulted.
 */

import { describe, it, expect } from 'vitest';

import {
  probeRequirements,
  describeGap,
  describeReadiness,
  defaultRequirementProbe,
  type RequirementProbe,
} from '../../src/learning/requirement-probe.js';

/** A probe where only the named binaries/credentials exist. */
function probeWith(present: { binaries?: string[]; credentials?: string[] }): RequirementProbe {
  const bins = new Set(present.binaries ?? []);
  const creds = new Set(present.credentials ?? []);
  return { binary: (n) => bins.has(n), credential: (n) => creds.has(n) };
}

describe('probeRequirements — binaries block, credentials advise', () => {
  it('is ready with nothing declared', () => {
    const r = probeRequirements({}, probeWith({}));
    expect(r).toEqual({ ready: true, gaps: [], ask: [] });
  });

  it('is satisfied when ANY alternative is present', () => {
    const requires = { binaries: [{ anyOf: ['npm', 'pnpm', 'yarn'] }] };
    expect(probeRequirements(requires, probeWith({ binaries: ['yarn'] })).ready).toBe(true);
    expect(probeRequirements(requires, probeWith({})).ready).toBe(false);
  });

  it('is BLOCKED when no binary alternative is on PATH', () => {
    const r = probeRequirements({ binaries: [{ anyOf: ['npm', 'gh'] }] }, probeWith({ binaries: ['npm'] }));
    expect(r.ready).toBe(true);
    const blocked = probeRequirements({ binaries: [{ anyOf: ['gh'] }] }, probeWith({}));
    expect(blocked.ready).toBe(false);
    expect(blocked.gaps).toEqual([
      { kind: 'binary', anyOf: ['gh'], remedy: 'install one of: gh' },
    ]);
  });

  it('does NOT block on a credential, only reports it — it may be in the vault', () => {
    const r = probeRequirements(
      { credentials: [{ anyOf: ['NPM_TOKEN', 'GITHUB_TOKEN'] }] },
      probeWith({}),
    );
    expect(r.ready).toBe(true);
    expect(r.gaps).toEqual([{ kind: 'credential', anyOf: ['NPM_TOKEN', 'GITHUB_TOKEN'], remedy: 'set one of: NPM_TOKEN, GITHUB_TOKEN' }]);
  });

  it('stays blocked when a credential is ALSO missing, because the binary is the blocker', () => {
    const r = probeRequirements(
      { binaries: [{ anyOf: ['gh'] }], credentials: [{ anyOf: ['GITHUB_TOKEN'] }] },
      probeWith({}),
    );
    expect(r.ready).toBe(false);
    expect(r.gaps.map((g) => g.kind)).toEqual(['binary', 'credential']);
  });

  it('prefers a declared remedy over the generated one', () => {
    const r = probeRequirements(
      { credentials: [{ anyOf: ['NPM_TOKEN'], note: 'create an npm automation token' }] },
      probeWith({}),
    );
    expect(r.gaps[0]!.remedy).toBe('create an npm automation token');
  });

  it('carries the model-supplied inputs through untouched — they are not facts', () => {
    const r = probeRequirements({ inputs: ['bump type', 'which host'] }, probeWith({}));
    expect(r.ask).toEqual(['bump type', 'which host']);
    expect(r.ready).toBe(true);
  });
});

describe('describeGap — the two kinds are worded differently on purpose', () => {
  it('calls a missing binary missing, and a missing credential merely invisible', () => {
    expect(describeGap({ kind: 'binary', anyOf: ['gh'], remedy: 'install it' })).toBe(
      'missing executable: gh — install it',
    );
    expect(describeGap({ kind: 'credential', anyOf: ['NPM_TOKEN'], remedy: 'export it' })).toBe(
      'credential not visible in the environment: NPM_TOKEN — export it',
    );
  });

  it('summarizes a readiness result, and says nothing when there is nothing to say', () => {
    expect(describeReadiness({ ready: true, gaps: [], ask: [] })).toBe('');
    const one = describeReadiness({
      ready: false,
      gaps: [{ kind: 'binary', anyOf: ['gh'], remedy: 'install one of: gh' }],
      ask: [],
    });
    expect(one).toContain('missing executable: gh');
  });
});

describe('defaultRequirementProbe', () => {
  it('checks the injected env for credentials and never claims an unset var is present', () => {
    const probe = defaultRequirementProbe({ NPM_TOKEN: 'tok' } as NodeJS.ProcessEnv);
    expect(probe.credential('NPM_TOKEN')).toBe(true);
    expect(probe.credential('GITHUB_TOKEN')).toBe(false);
  });

  it('treats a blank value as absent, not as present', () => {
    const probe = defaultRequirementProbe({ NPM_TOKEN: '   ' } as NodeJS.ProcessEnv);
    expect(probe.credential('NPM_TOKEN')).toBe(false);
  });

  it('delegates binaries to the OS resolver', () => {
    // A binary that always exists next to the running process.
    const probe = defaultRequirementProbe({} as NodeJS.ProcessEnv);
    expect(typeof probe.binary(process.execPath)).toBe('boolean');
  });
});
