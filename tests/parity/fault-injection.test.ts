/**
 * WS6 (#28) — fault injection.
 *
 * THREE LAYERS, and each answers a question the others cannot:
 *
 *   1. THE DECLARATION. `site:kind:times:match` parses, round-trips, and — the
 *      part that matters — THROWS on a typo rather than running unfaulted. A
 *      declaration that silently injects nothing is a test that measures nothing
 *      while reporting success, which is the exact shape this repo's truthfulness
 *      workstream exists to remove.
 *
 *   2. THE SEAM. `withFaultInjection` is off by default (the provider object it
 *      is handed comes back UNCHANGED), spends its allowance exactly once per
 *      declared call, and does not invent a `generateTools` on a provider that
 *      has none — that method's presence is how the loop picks the native tool
 *      transport over the JSON fallback, so adding it would silently change what a
 *      run was measured on.
 *
 *   3. THE ROWS. The three fault scenarios are driven on all five REAL surfaces
 *      through the same harness `nuvira parity run` uses. Two are served by the
 *      harness's own stub (so the REAL adapter's error mapping runs and the model
 *      call still happens); one is declared to the running agent (so the seam is
 *      proven, the forked child included). Cross-surface agreement is the
 *      harness's verdict; the per-observation assertions below are what make the
 *      row mean something — "every surface agreed" would also be true of five
 *      surfaces that all swallowed the fault.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

import type { InferenceProvider } from '../../src/inference/interface.js';
import { ProviderFactory } from '../../src/inference/factory.js';
import {
  FAULT_ENV,
  activeFaultInjector,
  createFaultInjector,
  faultAt,
  formatFaultPlan,
  parseFaultPlan,
  resetFaultInjector,
  withFaultInjection,
} from '../../src/runtime/fault-injection.js';
import { reportParityFailure } from '../../src/parity/observation.js';
import { runParityScenario, type ParityScenario } from '../../src/parity/scenarios.js';
import { PARITY_SCENARIOS } from '../../src/cli/parity.js';
import { createParityHarness, type ParityHarness } from './drivers.js';

/** A provider with only the members a model call needs, so the seam can be exercised without a socket. */
function fakeProvider(over: Partial<InferenceProvider> = {}): InferenceProvider {
  return {
    name: 'fake',
    generate: async () => 'generated',
    ...over,
  } as unknown as InferenceProvider;
}

const scenarioById = (id: string) => {
  const found = PARITY_SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`no parity scenario declared with id ${id}`);
  return found;
};

// ─── 1. The declaration ────────────────────────────────────────────────────

describe('WS6 fault injection — the declaration', () => {
  it('parses the short forms, and round-trips the ones a scenario declares', () => {
    expect(parseFaultPlan(undefined)).toBeNull();
    expect(parseFaultPlan('')).toBeNull();
    expect(parseFaultPlan('  ')).toBeNull();
    // An easy way to switch a fault off from a script, without unsetting the var.
    expect(parseFaultPlan('off')).toBeNull();
    expect(parseFaultPlan('none')).toBeNull();

    expect(parseFaultPlan('provider:error')).toEqual({ site: 'provider', kind: 'error', times: 1 });
    expect(parseFaultPlan('provider:error:2')).toEqual({ site: 'provider', kind: 'error', times: 2 });
    expect(parseFaultPlan('provider:error:all')).toEqual({
      site: 'provider',
      kind: 'error',
      times: Number.POSITIVE_INFINITY,
    });
    // A non-numeric third part on a `tool` fault is the tool to match, so the
    // common case stays short.
    expect(parseFaultPlan('tool:error:list_dir')).toEqual({
      site: 'tool',
      kind: 'error',
      times: 1,
      match: 'list_dir',
    });
    expect(parseFaultPlan('tool:error:2:read_file')).toEqual({
      site: 'tool',
      kind: 'error',
      times: 2,
      match: 'read_file',
    });

    // The round trip is what lets the harness write a scenario's plan into the
    // environment and an operator copy a failure report back into a shell.
    for (const raw of ['provider:error', 'provider:error:3', 'tool:error:all:read_file', 'ipc:error']) {
      expect(formatFaultPlan(parseFaultPlan(raw)!)).toBe(raw);
    }
    for (const scenario of PARITY_SCENARIOS) {
      if (!scenario.fault) continue;
      const round = parseFaultPlan(formatFaultPlan(scenario.fault));
      expect(round, `scenario ${scenario.id} declares a fault that does not round-trip`).toEqual(
        scenario.fault,
      );
    }
  });

  it('refuses a declaration it cannot parse, instead of running unfaulted', () => {
    // The whole point: a typo must be loud. Ignoring it would let a demo or a
    // test "prove" failure handling while nothing ever failed.
    expect(() => parseFaultPlan('provdier:error')).toThrow(/Invalid NUVIRA_INJECT_FAULT/);
    expect(() => parseFaultPlan('provider:errorr')).toThrow(/Invalid NUVIRA_INJECT_FAULT/);
    expect(() => parseFaultPlan('provider:error:0')).toThrow(/times must be a positive integer/);
    expect(() => parseFaultPlan('provider:error:-1')).toThrow(/times must be a positive integer/);
    expect(() => parseFaultPlan('provider:error:x')).toThrow(/times must be a positive integer/);
    // A tool NAME is only meaningful on a tool fault.
    expect(() => parseFaultPlan('provider:error:1:groq')).toThrow(/only `tool` faults take a tool name/);
  });

  it('spends its allowance on matching calls only', () => {
    const injector = createFaultInjector({ site: 'tool', kind: 'error', times: 2, match: 'read_file' });
    expect(injector).not.toBeNull();

    // A site that does not match is never consumed — a provider call must not
    // spend a tool fault's allowance.
    expect(injector!.at('provider', 'generate')).toBeNull();
    // And neither is a tool the declaration did not name.
    expect(injector!.at('tool', 'list_dir')).toBeNull();
    expect(injector!.fired).toBe(0);

    const first = injector!.at('tool', 'read_file');
    expect(first?.kind).toBe('error');
    expect(first?.subject).toBe('read_file');
    // The message must NAME the declaration: an injected fault that could be
    // mistaken for a real outage would corrupt the evidence it was injected for.
    expect(first?.message).toContain('ON PURPOSE');
    expect(first?.message).toContain(`${FAULT_ENV}=tool:error:2:read_file`);
    expect(first?.message).toContain('not a real tool failure');

    expect(injector!.at('tool', 'read_file')).not.toBeNull();
    expect(injector!.fired).toBe(2);
    expect(injector!.exhausted).toBe(true);
    // The allowance is spent: every later call goes through.
    expect(injector!.at('tool', 'read_file')).toBeNull();
    expect(injector!.fired).toBe(2);
  });

  it('rebuilds the cached injector when the declaration changes', () => {
    const previous = process.env[FAULT_ENV];
    try {
      resetFaultInjector();
      delete process.env[FAULT_ENV];
      expect(activeFaultInjector()).toBeNull();

      process.env[FAULT_ENV] = 'tool:error:1';
      const first = activeFaultInjector();
      expect(first?.plan.site).toBe('tool');
      // Same declaration → the SAME injector, so `times` is spent across calls
      // rather than reset on every lookup.
      expect(activeFaultInjector()).toBe(first);
      first!.at('tool', 'anything');

      // A re-declaration (the harness does this once per surface) gets a fresh
      // allowance without the caller knowing the cache exists.
      process.env[FAULT_ENV] = 'tool:error:1';
      resetFaultInjector();
      expect(activeFaultInjector()!.fired).toBe(0);
    } finally {
      if (previous === undefined) delete process.env[FAULT_ENV];
      else process.env[FAULT_ENV] = previous;
      resetFaultInjector();
    }
  });
});

// ─── 2. The seam ───────────────────────────────────────────────────────────

describe('WS6 fault injection — the seam', () => {
  afterEach(() => {
    resetFaultInjector();
    delete process.env[FAULT_ENV];
  });

  it('is off by default, and hands back the very same provider', () => {
    const provider = fakeProvider();
    // Not a transparent copy: the SAME object, so a run that asked for nothing
    // cannot be affected by this module.
    expect(withFaultInjection(provider, null)).toBe(provider);
    expect(withFaultInjection(provider, createFaultInjector(null))).toBe(provider);
    // And a non-provider declaration does not wrap it either.
    expect(withFaultInjection(provider, createFaultInjector({ site: 'tool', kind: 'error', times: 1 }))).toBe(
      provider,
    );
  });

  it('fails the declared number of provider calls, then lets the rest through', async () => {
    const provider = fakeProvider();
    const injector = createFaultInjector({ site: 'provider', kind: 'error', times: 2 })!;
    const wrapped = withFaultInjection(provider, injector);
    expect(wrapped).not.toBe(provider);

    await expect(wrapped.generate('hi')).rejects.toThrow(/injected provider fault/);
    await expect(wrapped.generate('hi')).rejects.toThrow(/ON PURPOSE/);
    await expect(wrapped.generate('hi')).resolves.toBe('generated');
    expect(injector.fired).toBe(2);
  });

  it('leaves an absent optional method absent, so the transport cannot change', () => {
    // `generateTools` PRESENCE is how the loop picks the native transport
    // (`child-agent-runtime.ts:181`). A wrapper that added it would silently
    // change the transport a run was measured on — the same class of lie as
    // fabricating a tool result.
    const provider = fakeProvider();
    expect(typeof (provider as { generateTools?: unknown }).generateTools).toBe('undefined');
    const wrapped = withFaultInjection(
      provider,
      createFaultInjector({ site: 'provider', kind: 'error', times: 1 }),
    );
    expect(typeof (wrapped as { generateTools?: unknown }).generateTools).toBe('undefined');
  });

  it('fails a tool call the declaration names, and nothing else', () => {
    const previous = process.env[FAULT_ENV];
    try {
      process.env[FAULT_ENV] = 'tool:error:read_file';
      resetFaultInjector();
      expect(faultAt('tool', 'read_file')?.subject).toBe('read_file');
      expect(faultAt('tool', 'list_dir')).toBeNull();
    } finally {
      if (previous === undefined) delete process.env[FAULT_ENV];
      else process.env[FAULT_ENV] = previous;
      resetFaultInjector();
    }
  });

  it('reaches the real factory only when a fault is declared', () => {
    const config = { apiKey: 'x', model: 'parity-stub-model', baseUrl: 'http://127.0.0.1:1/v1' };
    const previous = process.env[FAULT_ENV];
    try {
      delete process.env[FAULT_ENV];
      resetFaultInjector();
      const plain = ProviderFactory.createProvider('groq', config as never);
      expect(typeof plain.generate).toBe('function');

      process.env[FAULT_ENV] = 'provider:error:all';
      resetFaultInjector();
      const faulted = ProviderFactory.createProvider('groq', config as never);
      expect(faulted).not.toBe(plain);
    } finally {
      if (previous === undefined) delete process.env[FAULT_ENV];
      else process.env[FAULT_ENV] = previous;
      resetFaultInjector();
    }
  });
});

// ─── 3. The rows, on every real surface ────────────────────────────────────

describe('WS6 fault injection — every surface, real provider, declared fault', () => {
  let harness: ParityHarness;

  beforeAll(async () => {
    harness = await createParityHarness();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('reports a provider that fails every call as failed, and fabricates no answer', async () => {
    const scenario = scenarioById('fault-provider-error');
    const run = await runParityScenario(scenario, harness.drivers);
    expect(run.verdict, reportParityFailure(run.observations, run.differences)).toBe('at-par');
    expect(run.observations).toHaveLength(5);

    for (const observation of run.observations) {
      // The fault reached this surface and its turn shows it...
      expect(observation.fault.asked).toBe(true);
      expect(observation.fault.took, `${observation.surface} did not act on the declared fault`).toBe(true);
      // ...because the turn did not complete. A surface that answered anyway
      // would be the false success this row exists to catch.
      expect(observation.status).toBe('failed');
      expect(observation.answer).not.toBe('Listed.');
      // The model call still HAPPENED (the stub served the 500), so the row is
      // not vacuous and the harness's "reached a model" rule is satisfied.
      expect(observation.modelCalls).toBeGreaterThan(0);
    }
  }, 120_000);

  it('reports a response nothing can parse as a failure, not as an empty answer', async () => {
    const scenario = scenarioById('fault-provider-malformed');
    const run = await runParityScenario(scenario, harness.drivers);
    expect(run.verdict, reportParityFailure(run.observations, run.differences)).toBe('at-par');
    expect(run.observations).toHaveLength(5);

    for (const observation of run.observations) {
      expect(observation.fault.took, `${observation.surface} did not act on the declared fault`).toBe(true);
      expect(observation.status).toBe('failed');
      expect(observation.modelCalls).toBeGreaterThan(0);
    }
  }, 120_000);

  it('reports a forked child that dies before it works as a FAILED run, not a hang and not a result', async () => {
    // The `ipc` site has no parity row — only one surface has a process boundary,
    // so the runner would refuse it as insufficient coverage, correctly. Driven
    // directly instead, because what it proves is the thing a fault at that site is
    // for: a child that dies WITHOUT A FRAME must be reported as a failed run, not
    // waited on for ever and not given a synthesised result.
    const scenario: ParityScenario = {
      id: 'fault-ipc-exit',
      message: 'list the working directory, then answer',
      toolCall: { tool: 'list_dir', args: { path: '.' } },
      answer: 'Listed.',
      fault: { site: 'ipc', kind: 'error', times: 1 },
    };
    const observation = await harness.subagent[0].run(scenario);
    expect(observation.status, 'a dead child must not be reported as a completed run').toBe('failed');
    expect(observation.fault.took).toBe(true);
    // It died before it could work, so it reached no model and produced no answer —
    // and that zero is the honest reading here (a turn that WAS served without a
    // model would be refused by the runner, which is the rule that catches replays).
    expect(observation.modelCalls).toBe(0);
    expect(observation.answer).toBeUndefined();
  }, 60_000);

  it('reports an injected TOOL fault as a failed call on every surface, the forked child included', async () => {
    const scenario = scenarioById('fault-tool-error');
    const run = await runParityScenario(scenario, harness.drivers);
    expect(run.verdict, reportParityFailure(run.observations, run.differences)).toBe('at-par');
    expect(run.observations).toHaveLength(5);

    for (const observation of run.observations) {
      // The declaration crossed the process boundary for the child — this is the
      // assertion that makes the seam's reach a measured fact rather than a claim.
      expect(observation.fault.took, `${observation.surface} never reported the injected failure`).toBe(true);
      const call = observation.toolCalls.find((c) => c.tool === 'read_file');
      expect(call, `${observation.surface} never called the faulted tool`).toBeDefined();
      expect(call!.ok, `${observation.surface} reported an injected failure as success`).toBe(false);
    }
  }, 120_000);
});
