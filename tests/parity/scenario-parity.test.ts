/**
 * WS0 (#22) — one scenario, every surface that can be driven, one verdict.
 *
 * Two halves, and both matter:
 *
 *   1. THE RUNNER'S RULES, with fake drivers. A parity harness that cannot fail,
 *      or that fails without saying which surface diverged, is worse than none —
 *      it produces confidence. So the refusal rules are tested directly: depth
 *      mismatch, insufficient coverage, and a blocked surface never being
 *      silently dropped or accidentally invoked.
 *
 *   2. THE REAL CASE, on the real engine. `cli-chat` calls `answerOnce` directly;
 *      `dashboard-chat` goes through `ChatConsole.answer` with no injected engine,
 *      so the console lazily loads the same real `ChatCommand` and its own turn
 *      plumbing runs. The stub sits at the provider, so everything above it is
 *      genuine — which is the only way a comparison means anything.
 *
 * The regression this is built on is dated and real: on 2026-09-20 the dashboard
 * resolved one concrete provider with auto mode off while the CLI got auto
 * routing, so the same prompt answered on the CLI and failed on the dashboard.
 * See tests/cli/chat-answer-once-auto-parity.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/cli/model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/model.js')>();
  return {
    ...actual,
    // The developer's `nuvira model switch` state must not decide the verdict.
    applyActiveModel: (options: { provider?: string; model?: string }) => options,
  };
});

import { resetModelRegistry } from '../../src/learning/model-registry.js';
import { reportParityFailure, type TurnObservation } from '../../src/parity/observation.js';
import {
  runParityScenario,
  type ParityDriver,
  type ParityScenario,
  type StubDepth,
} from '../../src/parity/scenarios.js';
import type { SurfaceId } from '../../src/parity/surfaces.js';
import {
  blockedDriver,
  parityDrivers,
  providerDepthDrivers,
  transportDepthDrivers,
} from './drivers.js';

// ─── 1. The runner's rules ─────────────────────────────────────────────────

const SCENARIO: ParityScenario = { id: 'runner-rules', message: 'hello', answer: 'ok' };

/** A driver that returns a fixed observation, for testing the runner rather than a surface. */
function fakeDriver(
  surface: SurfaceId,
  observation: Partial<TurnObservation> = {},
  over: { depth?: StubDepth; available?: boolean; blockedBy?: string } = {},
): ParityDriver {
  return {
    surface,
    depth: over.depth ?? 'provider',
    available: over.available ?? true,
    ...(over.blockedBy ? { blockedBy: over.blockedBy } : {}),
    run: async (): Promise<TurnObservation> => ({
      surface,
      engine: 'loop',
      status: 'completed',
      // One model call: the fake driver stands for a real turn, and rule 4
      // refuses to compare a turn that never reached a model.
      modelCalls: 1,
      provider: 'groq',
      toolCalls: [],
      answer: 'ok',
      ...observation,
    }),
  };
}

describe('WS0 parity runner — verdict rules', () => {
  it('reports at-par when two surfaces agree', async () => {
    const run = await runParityScenario(SCENARIO, [
      fakeDriver('cli-chat'),
      fakeDriver('dashboard-chat'),
    ]);
    expect(run.verdict).toBe('at-par');
    expect(run.differences).toEqual([]);
    expect(run.depth).toBe('provider');
  });

  it('reports divergent and names the surface and the field', async () => {
    const run = await runParityScenario(SCENARIO, [
      fakeDriver('cli-chat'),
      fakeDriver('dashboard-chat', { answer: 'something else', toolCalls: [{ tool: 'read_file' }] }),
    ]);
    expect(run.verdict).toBe('divergent');
    const text = run.differences.join('\n');
    expect(text).toContain('cli-chat');
    expect(text).toContain('dashboard-chat');
    expect(text).toContain('answer');
    expect(text).toContain('read_file');
  });

  it('refuses to compare across stub depths instead of returning a meaningless verdict', async () => {
    // The surface with an ENGINE stub has had the behaviour under test replaced;
    // a pass here would be evidence of nothing, and a fail would be misleading.
    const run = await runParityScenario(SCENARIO, [
      fakeDriver('cli-chat', {}, { depth: 'provider' }),
      fakeDriver('dashboard-chat', {}, { depth: 'engine' }),
    ]);
    expect(run.verdict).toBe('not-run');
    expect(run.refusal?.kind).toBe('depth-mismatch');
    expect(run.differences).toEqual([]);
    expect(run.refusal && 'message' in run.refusal ? run.refusal.message : '').toContain(
      'ENGINE depth',
    );
  });

  it('compares a provider stub with a transport stub, because both run the real turn code', async () => {
    // R2 — the fold that makes the forked subagent readable against the
    // in-process surfaces: a stub provider OBJECT and a real provider talking to
    // a stub SERVER both leave the turn code itself intact, so they are one
    // comparable class. Only the ENGINE depth (the behaviour under test, faked)
    // is refused. The verdict here is a real comparison — and it diverges on a
    // fact (the provider), which is exactly the point: a divergence a reader can
    // act on, not a refusal on a technicality.
    const run = await runParityScenario(SCENARIO, [
      fakeDriver('cli-chat', { provider: 'groq', transport: 'native' }, { depth: 'provider' }),
      fakeDriver('subagent', { provider: 'local', transport: 'none' }, { depth: 'transport' }),
    ]);
    expect(run.verdict).toBe('divergent');
    expect(run.refusal).toBeUndefined();
    // Mixed comparable depths have no single depth to report — stated, not guessed.
    expect(run.depth).toBeNull();
    const text = run.differences.join('\n');
    expect(text).toContain('subagent');
    expect(text).toContain('provider');
    expect(text).toContain('transport');
  });

  it('still refuses an engine stub even against another engine stub', async () => {
    // An engine stub has replaced the behaviour under test, so it is no more
    // comparable with its own kind than with a provider stub.
    const run = await runParityScenario(SCENARIO, [
      fakeDriver('cli-chat', {}, { depth: 'engine' }),
      fakeDriver('dashboard-chat', {}, { depth: 'engine' }),
    ]);
    expect(run.verdict).toBe('not-run');
    expect(run.refusal?.kind).toBe('depth-mismatch');
  });

  it('will not call one surface a parity run', async () => {
    const run = await runParityScenario(SCENARIO, [
      fakeDriver('cli-chat'),
      fakeDriver('gateway-chat', {}, { available: false, blockedBy: 'no driver yet' }),
    ]);
    expect(run.verdict).toBe('not-run');
    expect(run.refusal?.kind).toBe('insufficient-coverage');
    expect(run.observations).toEqual([]);
  });

  it('never silently drops a surface it could not drive', async () => {
    const run = await runParityScenario(SCENARIO, [
      fakeDriver('cli-chat'),
      fakeDriver('dashboard-chat'),
      fakeDriver('subagent', {}, { available: false, blockedBy: 'separate process' }),
    ]);
    expect(run.verdict).toBe('at-par');
    expect(run.skipped).toEqual([{ surface: 'subagent', reason: 'separate process' }]);
  });

  it('refuses a turn that never reached a model instead of calling it agreement', async () => {
    // THE DEFECT THIS CLOSES, found by measurement on 2026-09-28: the response
    // cache is shared and on by default (`chat.ts:690`), so the second surface of
    // a run was served from the first one's entry — same answer, no model call,
    // no tool lifecycle — and the run reported at-par. Two replays agreeing is
    // not parity; it is two surfaces doing nothing, twice.
    const run = await runParityScenario(SCENARIO, [
      fakeDriver('cli-chat', { modelCalls: 1, answer: 'Listed.' }),
      fakeDriver('dashboard-chat', { modelCalls: 0, answer: 'Listed.' }),
    ]);
    expect(run.verdict).toBe('not-run');
    expect(run.refusal?.kind).toBe('unreached-model');
    expect(run.differences).toEqual([]);
    expect(run.refusal && 'surfaces' in run.refusal ? run.refusal.surfaces : []).toEqual([
      'dashboard-chat',
    ]);
    expect(run.refusal && 'message' in run.refusal ? run.refusal.message : '').toContain(
      'no model call',
    );
  });

  it('records a reason for every skipped surface, even when the driver forgot one', async () => {
    const run = await runParityScenario(SCENARIO, [
      fakeDriver('cli-chat'),
      fakeDriver('dashboard-chat'),
      fakeDriver('gateway-chat', {}, { available: false }),
    ]);
    expect(run.skipped[0]?.reason).toBe('no reason recorded');
  });
});

// ─── 2. The real case, on the real engine ──────────────────────────────────

describe('WS0 parity — CLI chat vs dashboard chat, real engine, provider-depth stub', () => {
  let tempDir: string;
  let origMemory: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-parity-scenario-'));
    // Hermetic: a fresh config dir still defaults to `defaultProvider: 'auto'`,
    // which is the configuration the 2026-09-20 divergence happened under.
    origMemory = process.env.NUVIRA_MEMORY_DIR;
    origConfigDir = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (origMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = origMemory;
    if (origConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = origConfigDir;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('answers the same message the same way, and attributes it the same way', async () => {
    const scenario: ParityScenario = {
      id: 'plain-completion',
      message: 'reply with the single word: parity',
      answer: 'Answered.',
    };

    // The provider-depth group: every surface whose stub replaces the provider
    // OBJECT, so the real turn code runs everywhere and the results compare.
    // The gateway is here because its own registry handler lazy-imports the same
    // real ChatCommand — if that ever stopped being true, this goes red.
    const run = await runParityScenario(scenario, providerDepthDrivers());

    // Failures must name the divergence, not just "expected x to be y".
    expect(run.verdict, reportParityFailure(run.observations, run.differences)).toBe('at-par');
    expect(run.depth).toBe('provider');
    // All four provider-depth surfaces, including cli-execute: it runs the
    // surface's declared loop entry against the shared provider factory now, so
    // the same message produces the same turn there too.
    expect(run.observations.map((o) => o.surface)).toEqual([
      'cli-chat',
      'dashboard-chat',
      'gateway-chat',
      'cli-execute',
    ]);

    for (const observation of run.observations) {
      expect(observation.status).toBe('completed');
      expect(observation.answer).toBe('Answered.');
      // Attribution, not merely "it ran": every surface must name the backend
      // that served the turn — the full triple, not just the provider. Each
      // driver reads it from THAT SURFACE's own report (the engine's return, the
      // console's result, the command's result, the gateway's `runInboundChat`
      // return), so agreeing here is the surface handing the attribution on, not
      // the engine happening to know it.
      expect(observation.provider).toBe('groq');
      expect(observation.model).toBe('parity-stub-model');
      expect(observation.transport).toBe('native');
      // NON-VACUOUS BY ASSERTION: a cache replay would satisfy every check above.
      expect(
        observation.modelCalls,
        `${observation.surface} answered without reaching a model`,
      ).toBeGreaterThan(0);
    }

    // Every declared surface is drivable, so nothing is skipped — and if a
    // driver ever regresses, this stops being empty and names the surface and
    // the reason rather than quietly shrinking the run.
    expect(run.skipped).toEqual([]);
  }, 60_000);

  it('reports the same tool call, with the same outcome, on every provider-depth surface', async () => {
    const scenario: ParityScenario = {
      id: 'single-tool-call',
      message: 'list the working directory, then answer',
      toolCall: { tool: 'list_dir', args: { path: '.' } },
      answer: 'Listed.',
    };

    // ALL FOUR provider-depth surfaces are included now. The gateway used to be
    // excluded because it wired no onToolCall, and cli-execute because its loop
    // entry reported tool NAMES beside a separate error set — no per-call
    // outcome. Both report the call and its outcome now, so there is nothing to
    // filter out; the non-vacuity assertions below are what stop a surface from
    // passing with an empty list.
    const run = await runParityScenario(scenario, providerDepthDrivers());
    expect(run.verdict, reportParityFailure(run.observations, run.differences)).toBe('at-par');
    expect(run.observations.map((o) => o.surface)).toEqual([
      'cli-chat',
      'dashboard-chat',
      'gateway-chat',
      'cli-execute',
    ]);

    for (const observation of run.observations) {
      // NON-VACUOUS BY ASSERTION: if either collector silently failed, its
      // toolCalls would be empty and 'at-par' would mean nothing. The call and
      // its outcome must be observed on BOTH surfaces.
      expect(
        observation.toolCalls.map((call) => call.tool),
        `${observation.surface} did not report the executed tool call`,
      ).toEqual(['list_dir']);
      expect(observation.toolCalls[0]?.ok, `${observation.surface} reported no outcome`).toBe(true);
      expect(observation.answer).toBe('Listed.');
      // Exactly two model calls: one to ask for the tool, one to close the turn.
      // A cache replay is 0, and a loop that skipped the second call is 1 — both
      // of which would otherwise hide behind a matching answer.
      expect(observation.modelCalls, `${observation.surface} model calls`).toBe(2);
    }
  }, 60_000);

  it('runs a real turn on every surface even when the same message was answered before', async () => {
    // The regression test for the shared-cache trap, at the level it bit: run the
    // identical scenario twice in one process. Without isolation the second run is
    // a pure replay on both surfaces — the first run's entry is keyed by
    // provider:model:prompt, and both surfaces use the same message. Each run must
    // therefore reach the model on each surface, on BOTH passes.
    const scenario: ParityScenario = {
      id: 'repeatable-turn',
      message: 'reply with the single word: repeatable',
      answer: 'Repeated.',
    };

    const first = await runParityScenario(scenario, providerDepthDrivers());
    const second = await runParityScenario(scenario, providerDepthDrivers());

    for (const run of [first, second]) {
      expect(run.verdict, reportParityFailure(run.observations, run.differences)).toBe('at-par');
      expect(run.observations.map((o) => o.modelCalls)).toEqual([1, 1, 1, 1]);
      for (const observation of run.observations) {
        expect(observation.answer).toBe('Repeated.');
      }
    }
  }, 90_000);

  it('drives the real forked subagent and reads the identity the child reported', async () => {
    // Transport depth: the child builds a real provider and talks to a stub
    // Groq-compatible server. Nothing here is simulated — the fork, the provider
    // construction, the loop and the tool executor are the child`s own.
    const [driver] = transportDepthDrivers();
    expect(driver.surface).toBe('subagent');
    expect(driver.available).toBe(true);

    const observation = await driver.run({
      id: 'subagent-plain',
      message: 'reply with the single word: parity',
      answer: 'Answered.',
    });

    // NON-VACUOUS: a child that never reached the model would report 0 calls.
    expect(observation.modelCalls).toBeGreaterThan(0);
    expect(observation.status).toBe('completed');
    expect(observation.answer).toBe('Answered.');
    // The attribution under test in WS1: the child reports what actually served it.
    // A no-tool child announces `none` — the honest answer for a run that asked
    // for no tools — on the same provider id the in-process surfaces report.
    expect(observation.provider).toBe('groq');
    expect(observation.model).toBe('parity-stub-model');
    expect(observation.transport).toBe('none');
  }, 90_000);

  it('reports the subagent`s tool call and its outcome, and folds its transport depth into the comparison', async () => {
    const [driver] = transportDepthDrivers();
    const observation = await driver.run({
      id: 'subagent-tool',
      message: 'list the working directory, then answer',
      toolCall: { tool: 'list_dir', args: { path: '.' } },
      answer: 'Listed.',
    });

    // The child reports the call AND its outcome — `tool_call` then
    // `tool_result` — so the driver records both, the same call+outcome shape
    // the in-process chat surfaces report through their own seams. This is the
    // evidence for tool-call-lifecycle@subagent.
    expect(observation.toolCalls).toEqual([{ tool: 'list_dir', ok: true }]);
    expect(observation.modelCalls).toBe(2);
    expect(observation.transport).toBe('native');

    // And the child is folded into the SAME comparison as the chat surfaces. The
    // child still resolves its own provider in its own process — the isolation
    // boundary — but the parity run configures that provider on the SAME id
    // (`groq`) and transport (`native`) the in-process surfaces report, so the
    // comparison lands at-par instead of diverging on identity. This is the
    // evidence for turn-parity@subagent.
    const mixed = await runParityScenario(
      {
        id: 'mixed-depths',
        message: 'list the working directory, then answer',
        toolCall: { tool: 'list_dir', args: { path: '.' } },
        answer: 'Listed.',
      },
      [...providerDepthDrivers(), ...transportDepthDrivers()],
    );
    expect(mixed.verdict, reportParityFailure(mixed.observations, mixed.differences)).toBe('at-par');
    expect(mixed.refusal).toBeUndefined();
    // Comparable depths were mixed (provider + transport), so there is no single
    // depth to report — stated, not guessed.
    expect(mixed.depth).toBeNull();
    expect(mixed.observations.map((o) => o.surface)).toEqual([
      'cli-chat',
      'dashboard-chat',
      'gateway-chat',
      'cli-execute',
      'subagent',
    ]);
  }, 90_000);

  it('drives every declared surface, and still refuses to invoke a blocked driver', async () => {
    // The real list needs no blocks today — all five surfaces are driven — so the
    // guard is pinned with the factory that builds one, and removing the last
    // block can never quietly remove the check with it.
    expect(parityDrivers().filter((driver) => !driver.available)).toEqual([]);
    const blocked = blockedDriver('gateway-chat', 'kept for this guard');
    await expect(blocked.run(SCENARIO)).rejects.toThrow(/must never be invoked/);
  });
});
