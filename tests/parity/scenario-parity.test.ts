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
 *   2. THE REAL CASE, on the real surfaces. Every driver runs the REAL turn code
 *      (the real ChatCommand, the real console, the real gateway registry, the
 *      real execute command and a real forked child) against a loopback
 *      OpenAI-compatible stub at transport depth — the providers are real adapter
 *      objects, only the server is a stub. The drivers live in
 *      `src/parity/drivers.ts` and are the SAME ones `nuvira parity run` uses, so
 *      the CLI verdict and the test verdict cannot drift apart.
 *
 * The regression this is built on is dated and real: on 2026-09-20 the dashboard
 * resolved one concrete provider with auto mode off while the CLI got auto
 * routing, so the same prompt answered on the CLI and failed on the dashboard.
 * See tests/cli/chat-answer-once-auto-parity.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';

import { compare, noDebugLog, reportParityFailure, type TurnObservation } from '../../src/parity/observation.js';
import {
  runParityScenario,
  type ParityDriver,
  type ParityScenario,
  type StubDepth,
} from '../../src/parity/scenarios.js';
import type { SurfaceId } from '../../src/parity/surfaces.js';
import {
  blockedDriver,
  createParityHarness,
  PARITY_DRIVER_SURFACES,
  type ParityHarness,
} from './drivers.js';
// The scenarios `nuvira parity run` drives, imported rather than re-typed: the
// CLI and this suite must prove the SAME cases, and a copy here is how the two
// would drift into covering different things while both staying green.
import { PARITY_SCENARIOS } from '../../src/cli/parity.js';
import { readLatestDebugLog } from '../../src/observability/debug-log.js';

// ─── 1. The runner's rules ─────────────────────────────────────────────────

const SCENARIO: ParityScenario = { id: 'runner-rules', message: 'hello', answer: 'ok' };

/**
 * One fixed observation shape, so a differential case varies exactly one field.
 *
 * `modelCalls: 1` on purpose: the fake stands for a real turn, and rule 4
 * refuses to compare a turn that never reached a model.
 */
function fakeObservation(over: Partial<TurnObservation> = {}): TurnObservation {
  return {
    surface: 'cli-chat',
    engine: 'loop',
    status: 'completed',
    modelCalls: 1,
    provider: 'groq',
    toolCalls: [],
    findings: [],
    // WS2 — a log DOES exist here, so the differential cases can vary it while
    // still testing the runner rather than a surface.
    debugLog: { written: true, provider: 'groq', model: 'stub', transport: 'native' },
    answer: 'ok',
    ...over,
  };
}

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
    run: async (): Promise<TurnObservation> => fakeObservation({ surface, ...observation }),
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

  it('treats a surface that wrote NO debug log as divergent, and names the field', async () => {
    // WS2 — the load-bearing half. With logging ON, a surface that produces no
    // attachable log has not delivered the capability, and "both wrote nothing"
    // must never read as agreement either. The difference has to NAME which part
    // of the header failed, because "no log" and "a different model in the
    // header" are different bugs.
    const differences = compare(
      fakeObservation(),
      fakeObservation({ surface: 'dashboard-chat', debugLog: noDebugLog() }),
    );
    expect(differences.join('\n')).toContain('debugLog.written');
    expect(differences.join('\n')).toContain('dashboard-chat');

    // And a header that names a DIFFERENT backend is a difference too, field by
    // field — so a misattributed log cannot slip through as "a log exists".
    const modelDiff = compare(
      fakeObservation(),
      fakeObservation({
        surface: 'gateway-chat',
        debugLog: { written: true, provider: 'groq', model: 'some-other-model', transport: 'native' },
      }),
    );
    expect(modelDiff.join('\n')).toContain('debugLog.model');
    expect(modelDiff.join('\n')).not.toContain('debugLog.written');
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

// ─── 2. The real case, on the real surfaces ────────────────────────────────

describe('WS0 parity — every surface, real provider, transport-depth stub', () => {
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

  it('answers the same message the same way, and attributes it the same way', async () => {
    const scenario: ParityScenario = {
      id: 'plain-completion',
      message: 'reply with the single word: parity',
      answer: 'Answered.',
    };

    // EVERY surface, including the forked child: the driver list is one depth, so
    // there is nothing to exclude and nothing to fold. The gateway is here because
    // its own registry handler lazy-imports the same real ChatCommand — if that
    // ever stopped being true, this goes red.
    const run = await runParityScenario(scenario, harness.drivers);

    // Failures must name the divergence, not just "expected x to be y".
    expect(run.verdict, reportParityFailure(run.observations, run.differences)).toBe('at-par');
    expect(run.depth).toBe('transport');
    expect(run.observations.map((o) => o.surface)).toEqual([
      'cli-chat',
      'dashboard-chat',
      'gateway-chat',
      'cli-execute',
      'subagent',
    ]);

    for (const observation of run.observations) {
      expect(observation.status).toBe('completed');
      expect(observation.answer).toBe('Answered.');
      // Attribution, not merely "it ran": every surface must name the backend
      // that served the turn — the full triple. Each driver reads it from THAT
      // SURFACE's own report (the engine's return, the console's result, the
      // command's result, the gateway's `inbound.chat` log), so agreeing here is
      // the surface handing the attribution on, not the engine happening to know.
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

  it('reports the same tool call, with the same outcome, on every surface', async () => {
    const scenario: ParityScenario = {
      id: 'single-tool-call',
      message: 'list the working directory, then answer',
      toolCall: { tool: 'list_dir', args: { path: '.' } },
      answer: 'Listed.',
    };

    const run = await runParityScenario(scenario, harness.drivers);
    expect(run.verdict, reportParityFailure(run.observations, run.differences)).toBe('at-par');
    expect(run.observations.map((o) => o.surface)).toEqual([
      'cli-chat',
      'dashboard-chat',
      'gateway-chat',
      'cli-execute',
      'subagent',
    ]);

    for (const observation of run.observations) {
      // NON-VACUOUS BY ASSERTION: if either collector silently failed, its
      // toolCalls would be empty and 'at-par' would mean nothing. The call and
      // its outcome must be observed on EVERY surface.
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
  }, 90_000);

  it('reports a tool call that FAILED as failed, on every surface', async () => {
    // A failing call is where the surfaces are most likely to disagree — one can
    // carry the outcome and another can carry only the fact that the tool ran.
    const scenario = PARITY_SCENARIOS.find((s) => s.id === 'failing-tool-call');
    expect(scenario, 'the CLI no longer drives a failing-tool-call scenario').toBeDefined();

    const run = await runParityScenario(scenario!, harness.drivers);
    expect(run.verdict, reportParityFailure(run.observations, run.differences)).toBe('at-par');
    expect(run.observations.map((o) => o.surface)).toEqual([
      'cli-chat',
      'dashboard-chat',
      'gateway-chat',
      'cli-execute',
      'subagent',
    ]);

    for (const observation of run.observations) {
      // THE ASSERTION THAT MATTERS, and the reason `toEqual` is used rather than a
      // name comparison: `compare` treats an ABSENT outcome as equal to an absent
      // outcome, so five surfaces that all reported the call without saying
      // whether it worked would read as 'at-par' too. Demanding `false` — not
      // merely agreement — is what makes this evidence that the failure survived
      // the trip from the tool loop to the surface's own report.
      expect(
        observation.toolCalls,
        `${observation.surface} did not report the failed call as failed`,
      ).toEqual([{ tool: 'run_terminal', ok: false }]);
      // The turn itself still completes: a failed tool is not a failed turn, and
      // conflating the two is the other way this case could be reported wrongly.
      expect(observation.status).toBe('completed');
      expect(observation.answer).toBe('Command failed.');
      expect(observation.modelCalls, `${observation.surface} model calls`).toBe(2);
    }
  }, 90_000);

  it('reports a recorded finding with the verdict the gate EARNED, on every surface', async () => {
    // WS1 (#23). The stub asks for the `finding` tool with a usable evidence
    // reference, so the gate promotes the claim. Demanding the CONFIRMED verdict
    // AND the evidence behind it — rather than only that the surfaces agree — is
    // what makes this evidence that the verdict travelled as content, not as a
    // label each surface invented for itself.
    const scenario = PARITY_SCENARIOS.find((s) => s.id === 'finding-confirmed');
    expect(scenario, 'the CLI no longer drives a finding-confirmed scenario').toBeDefined();

    const run = await runParityScenario(scenario!, harness.drivers);
    expect(run.verdict, reportParityFailure(run.observations, run.differences)).toBe('at-par');
    expect(run.observations.map((o) => o.surface)).toEqual([
      'cli-chat',
      'dashboard-chat',
      'gateway-chat',
      'cli-execute',
      'subagent',
    ]);

    for (const observation of run.observations) {
      expect(
        observation.findings,
        `${observation.surface} did not report the recorded finding`,
      ).toEqual([
        {
          claim: 'the parity harness can drive every surface',
          verdict: 'CONFIRMED',
          outcome: 'checked by running the harness',
          evidence: [{ kind: 'observation', ref: 'all five surfaces reported the same verdict' }],
          source: 'agent',
        },
      ]);
      // The turn itself still completes, and the tool call is still reported:
      // a finding is an addition to the lifecycle, not a replacement for it.
      expect(observation.status).toBe('completed');
      expect(observation.answer).toBe('Recorded.');
      expect(observation.modelCalls, `${observation.surface} model calls`).toBe(2);
      expect(observation.toolCalls).toEqual([{ tool: 'finding', ok: true }]);
    }
  }, 120_000);

  it('reports an UNEARNED claim as PLAUSIBLE on every surface — the gate holds', async () => {
    // The load-bearing half of WS1. The same tool, with a blank evidence
    // reference, must NOT be promoted: `confirmFinding` refuses, so every surface
    // has to report PLAUSIBLE with the reason in the outcome. Five surfaces
    // agreeing on a CONFIRMED verdict that no evidence earned would be the
    // false-success defect with a nicer name, and this case is what makes that
    // disagreement a test failure rather than a quiet pass.
    const scenario = PARITY_SCENARIOS.find((s) => s.id === 'finding-refused');
    expect(scenario, 'the CLI no longer drives a finding-refused scenario').toBeDefined();

    const run = await runParityScenario(scenario!, harness.drivers);
    expect(run.verdict, reportParityFailure(run.observations, run.differences)).toBe('at-par');
    expect(run.observations.map((o) => o.surface)).toEqual([
      'cli-chat',
      'dashboard-chat',
      'gateway-chat',
      'cli-execute',
      'subagent',
    ]);

    for (const observation of run.observations) {
      const [finding] = observation.findings;
      expect(finding, `${observation.surface} reported no finding at all`).toBeDefined();
      expect(finding!.claim).toBe('this claim was never checked');
      expect(finding!.verdict, `${observation.surface} promoted a claim with no evidence`).toBe('PLAUSIBLE');
      // The blank reference is dropped rather than carried: a renderer must never
      // be able to show a check that did not happen.
      expect(finding!.evidence).toEqual([]);
      expect(finding!.outcome).toContain('no usable evidence');
      expect(observation.status).toBe('completed');
    }
  }, 120_000);

  it('writes a session debug log whose header names the backend, on every surface', async () => {
    // WS2 (#24). The harness turns logging ON for the run, so "this surface
    // produced an attachable log" is an ASSERTION — and the assertion is made on
    // the VALUES (the real triple), not merely on the surfaces agreeing. Two
    // surfaces both reporting an unnamed backend would agree and prove nothing,
    // so `written: true` plus `groq/parity-stub-model/native` is what the case
    // demands. Read back from disk, because the capability is "a file you can
    // attach to a bug report" — the artifact IS the evidence.
    const scenario = PARITY_SCENARIOS.find((s) => s.id === 'plain-completion');
    expect(scenario, 'the CLI no longer drives a plain-completion scenario').toBeDefined();

    const run = await runParityScenario(scenario!, harness.drivers);
    expect(run.verdict, reportParityFailure(run.observations, run.differences)).toBe('at-par');

    for (const observation of run.observations) {
      expect(
        observation.debugLog,
        `${observation.surface} produced no session debug log`,
      ).toEqual({
        written: true,
        provider: 'groq',
        model: 'parity-stub-model',
        transport: 'native',
      });
      // The FILE itself, not just the reduced fields: the header must name the
      // surface it belongs to, and must carry the human-readable first line a
      // reader attaching it to a bug report sees.
      const log = readLatestDebugLog(observation.surface);
      expect(log, `${observation.surface} wrote no log file for this turn`).not.toBeNull();
      expect(log!.header.surface).toBe(observation.surface);
      expect(log!.text).toContain('nuvira session debug log');
      expect(log!.text).toContain('# backend.provider: groq');
    }
  }, 120_000);

  it('reports a FAILED READ as failed on every surface — the false-success regression', async () => {
    // MEASURED, before the fix: `read_file` on a missing path produced a message
    // with no `Error:` prefix, and the loop's accounting is
    // `ok: !result.startsWith('Error:')` (`tool-loop.ts:1526`; the child has the
    // same rule at `child-agent-runtime.ts:405`). So every surface reported
    // `{ tool: 'read_file', ok: true }` for a read that never happened — a claim
    // that travelled as fact with nothing behind it, which is the defect this
    // repo has a tracker for (`tool-refusal.ts`).
    //
    // This asserts `ok: false` rather than "the surfaces agree", and the
    // difference is the whole point: agreement on a wrong answer is still wrong,
    // and an ABSENT outcome would compare equal to an absent outcome.
    const scenario = PARITY_SCENARIOS.find((s) => s.id === 'failing-read');
    expect(scenario, 'the CLI no longer drives a failing-read scenario').toBeDefined();

    const run = await runParityScenario(scenario!, harness.drivers);
    expect(run.verdict, reportParityFailure(run.observations, run.differences)).toBe('at-par');
    expect(run.observations.map((o) => o.surface)).toEqual([
      'cli-chat',
      'dashboard-chat',
      'gateway-chat',
      'cli-execute',
      'subagent',
    ]);

    for (const observation of run.observations) {
      expect(
        observation.toolCalls,
        `${observation.surface} reported a failed read as a successful call`,
      ).toEqual([{ tool: 'read_file', ok: false }]);
      // The turn still completes: a failed read is not a failed turn.
      expect(observation.status).toBe('completed');
      expect(observation.modelCalls, `${observation.surface} model calls`).toBe(2);
    }
  }, 90_000);

  it('runs a real turn on every surface even when the same message was answered before', async () => {
    // The regression test for the shared-cache trap, at the level it bit: run the
    // identical scenario twice in one process. Each driver clears the response
    // cache before its turn regardless, but this pins the OUTCOME — without it,
    // the second run would be a pure replay and the runner would refuse it.
    const scenario: ParityScenario = {
      id: 'repeatable-turn',
      message: 'reply with the single word: repeatable',
      answer: 'Repeated.',
    };

    const first = await runParityScenario(scenario, harness.drivers);
    const second = await runParityScenario(scenario, harness.drivers);

    for (const run of [first, second]) {
      expect(run.verdict, reportParityFailure(run.observations, run.differences)).toBe('at-par');
      expect(run.observations.map((o) => o.modelCalls)).toEqual([1, 1, 1, 1, 1]);
      for (const observation of run.observations) {
        expect(observation.answer).toBe('Repeated.');
      }
    }
  }, 120_000);

  it('drives the real forked subagent and reads the identity the child reported', async () => {
    // Transport depth: the child builds a real provider and talks to the same
    // stub server. Nothing here is simulated — the fork, the provider
    // construction, the loop and the tool executor are the child`s own.
    const [driver] = harness.subagent;
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
    // The child reports what actually served it. The harness offers it the same
    // tool the in-process surfaces always have available (the stub only ASKS for
    // the tool when the scenario does), so its transport attribution is
    // comparable rather than an artefact of having no tools installed.
    expect(observation.provider).toBe('groq');
    expect(observation.model).toBe('parity-stub-model');
    expect(observation.transport).toBe('native');
  }, 90_000);

  it('reports the subagent`s tool call and its outcome, and folds it into the same comparison', async () => {
    const [driver] = harness.subagent;
    const observation = await driver.run({
      id: 'subagent-tool',
      message: 'list the working directory, then answer',
      toolCall: { tool: 'list_dir', args: { path: '.' } },
      answer: 'Listed.',
    });

    // The child reports the call AND its outcome — `tool_call` then
    // `tool_result` — so the driver records both. This is the evidence for
    // tool-call-lifecycle@subagent.
    expect(observation.toolCalls).toEqual([{ tool: 'list_dir', ok: true }]);
    expect(observation.modelCalls).toBe(2);
    expect(observation.transport).toBe('native');

    // And the child is folded into the SAME comparison as the other four. The
    // child still resolves its own provider in its own process — the isolation
    // boundary — but the harness points that provider at the SAME id (`groq`) and
    // transport (`native`), so the comparison lands at-par instead of diverging on
    // identity. This is the evidence for turn-parity@subagent.
    const mixed = await runParityScenario(
      {
        id: 'mixed-depths',
        message: 'list the working directory, then answer',
        toolCall: { tool: 'list_dir', args: { path: '.' } },
        answer: 'Listed.',
      },
      harness.drivers,
    );
    expect(mixed.verdict, reportParityFailure(mixed.observations, mixed.differences)).toBe('at-par');
    expect(mixed.refusal).toBeUndefined();
    // One depth across every driver, so it is reported rather than left null.
    expect(mixed.depth).toBe('transport');
    expect(mixed.observations.map((o) => o.surface)).toEqual([
      'cli-chat',
      'dashboard-chat',
      'gateway-chat',
      'cli-execute',
      'subagent',
    ]);
  }, 90_000);

  it('drives every declared surface, and still refuses to invoke a blocked driver', async () => {
    // Every declared surface has a driver, so nothing is silently uncovered —
    // and the guard that a blocked driver is never invoked is pinned with the
    // factory that builds one, so removing the last block can never quietly
    // remove the check with it.
    expect([...PARITY_DRIVER_SURFACES].length).toBeGreaterThan(0);
    const blocked = blockedDriver('gateway-chat', 'kept for this guard');
    await expect(blocked.run(SCENARIO)).rejects.toThrow(/must never be invoked/);
  });
});
