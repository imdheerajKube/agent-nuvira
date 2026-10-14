/**
 * fix_model_routing P7 — TERMINAL HYGIENE (RC8).
 *
 * Live evidence from the run the user reported, read out of the session debug
 * log: three back-to-back `run_terminal` failures inside one 5-minute turn —
 * 120.07s, 13s, then 120.01s — after which the agent called `suggest_followups`
 * and gave up. Roughly four of those five minutes were the tool waiting on
 * commands that could never finish, and the model learned nothing from any of
 * them: a bare "⏱ timed out after 120000ms" is indistinguishable from a wrong
 * command, so the honest next move (narrow it) was never taken.
 *
 * These tests pin the three fixes: a timeout carries SPECIFIC guidance, the same
 * command cannot be re-run forever, and a turn in front of a person waits less.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getTool, type ToolContext } from '../../src/tools/registry.js';
import {
  assessCommandTime,
  hangReapMs,
  resetDetachedRuns,
  resetTerminalFailureStreaks,
  resolveWaitMs,
  sampleMonitoredRuns,
  waitBudgetGuidance,
} from '../../src/tools/run-terminal.js';
import { runToolLoop, type StepResponse } from '../../src/tools/tool-loop.js';
import { loadRuns } from '../../src/tools/run-registry.js';
import { killProcessTree, lookupProcess } from '../../src/tools/process-liveness.js';

const runTerminal = getTool('run_terminal')!;

let root: string;

/**
 * The liveness knobs are GLOBAL env, so every test starts from a clean slate and
 * restores whatever the developer had. A threshold leaking out of one test would
 * silently change what another one measures.
 */
const HANG_ENV = [
  'NUVIRA_HANG_POLL_MS',
  'NUVIRA_HANG_QUIET_MS',
  'NUVIRA_STALL_QUIET_MS',
  'NUVIRA_HANG_CPU_MS',
  'NUVIRA_HANG_REAP_MS',
] as const;
const savedHangEnv: Record<string, string | undefined> = {};
let savedConfigDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'buff-term-'));
  // The durable run registry lives under the config dir. Pointing it at this
  // test's temp dir keeps the tests hermetic AND keeps them from recovering the
  // developer's real monitored runs (`hydrateMonitoredRuns` now runs on every call).
  savedConfigDir = process.env.NUVIRA_CONFIG_DIR;
  process.env.NUVIRA_CONFIG_DIR = join(root, 'config');
  resetTerminalFailureStreaks();
  resetDetachedRuns();
  for (const name of HANG_ENV) {
    savedHangEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of HANG_ENV) {
    const previous = savedHangEnv[name];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  if (savedConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = savedConfigDir;
});

/** The monitored id out of a `still running` result (that is the handle the model gets). */
function monitoredId(out: string): string {
  const m = /run_terminal\(action:'poll', process_id:'([^']+)'\)/.exec(out);
  if (!m) throw new Error(`no monitored id in: ${out}`);
  return m[1];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    configManager: {},
    cwd: root,
    // The commands below are deliberately arbitrary (`sleep`, `node -e`), which
    // the autonomy gate classifies as confirm-class. This turn's request
    // AUTHORIZES the work, so the gate proceeds and the test exercises the
    // timeout/streak logic rather than the permission path.
    writesAuthorized: { authorized: true, reason: 'the request asked for this' },
    ...extra,
  } as ToolContext;
}

describe('P7 — a command that outlives the wait is FOLLOWED, never killed', () => {
  it('reports it still running — not a failure, not killed — and says how to follow it', async () => {
    // `sleep 5` with a 1s wait budget. The old behaviour SIGTERMed it here and
    // reported "⏱ timed out"; the work was destroyed and the turn learned a
    // failure that never happened.
    const out = await runTerminal.run({ command: 'sleep 5', timeout_ms: 1000, confirm: true }, ctx());
    expect(out).not.toContain('Error:');
    expect(out).not.toContain('timed out');
    expect(out).toContain('still running');
    expect(out).toContain('NOT killed');
    expect(out).toContain('NOT a failure');
    expect(out).toContain("action:'poll'");
    expect(out).toContain('Do NOT re-run the identical command');
    // A `sleep` that has produced nothing yet is the no-output case, and the
    // diagnosis must name the most likely cause rather than shrug.
    expect(out).toContain('NO output at all yet');
    expect(out).toContain('interactive prompt');
  }, 30_000);

  it('the process really is alive: poll shows it running, then its REAL exit code', async () => {
    const out = await runTerminal.run({ command: 'sleep 3', timeout_ms: 1000, confirm: true }, ctx());
    const id = monitoredId(out);

    const whileRunning = await runTerminal.run({ action: 'poll', process_id: id, command: 'x' }, ctx());
    expect(whileRunning).toContain('still running');
    expect(whileRunning).toContain(id);

    // It finishes ON ITS OWN (nothing killed it) and the poll reports the result
    // the turn needs to verify with.
    await sleep(2600);
    const done = await runTerminal.run({ action: 'poll', process_id: id, command: 'x' }, ctx());
    expect(done).toContain('✅');
    expect(done).toContain('finished');
  }, 30_000);

  it('a command producing output is diagnosed as PROGRESS, with its tail', async () => {
    const out = await runTerminal.run(
      {
        command: 'node -e "console.log(\'started\'); setTimeout(() => console.log(\'done\'), 2500)"',
        timeout_ms: 1000,
        confirm: true,
      },
      ctx(),
    );
    expect(out).not.toContain('Error:');
    expect(out).toContain('still producing output');
    expect(out).toContain('started');
  }, 30_000);

  it('lists what is being monitored', async () => {
    const out = await runTerminal.run({ command: 'sleep 3', timeout_ms: 1000, confirm: true }, ctx());
    const id = monitoredId(out);
    const list = await runTerminal.run({ action: 'list', command: 'x' }, ctx());
    expect(list).toContain(id);
    expect(list).toContain('sleep 3');
  }, 30_000);

  it('the guidance names the command, the id and where to poll', () => {
    const text = waitBudgetGuidance('npx vitest run', 'run-1', 900_000, { why: 'a test suite / dependency install' }, 0, 0);
    expect(text).toContain('NOT killed');
    expect(text).toContain('npx vitest run');
    expect(text).toContain('run-1');
    expect(text).toContain('900s');
    expect(text).toContain('a test suite / dependency install');
  });
});

describe('P8 — the wait is assessed from the command, not fixed at 5 minutes', () => {
  it('gives a test suite / install the minutes it actually needs', () => {
    expect(assessCommandTime('npm test')?.budgetMs).toBe(900_000);
    expect(assessCommandTime('npx vitest run tests/foo.test.ts')?.budgetMs).toBe(900_000);
    expect(assessCommandTime('npm ci')?.budgetMs).toBe(900_000);
    expect(assessCommandTime('pytest -q')?.budgetMs).toBe(900_000);
    expect(assessCommandTime('npm run build')?.budgetMs).toBe(600_000);
    expect(assessCommandTime('tsc --noEmit')?.budgetMs).toBe(600_000);
    expect(assessCommandTime('docker build .')?.budgetMs).toBe(900_000);
    expect(assessCommandTime('pip install -r requirements.txt')?.budgetMs).toBe(600_000);
  });

  it('leaves a quick read on the short default', () => {
    expect(assessCommandTime('git status')).toBeNull();
    expect(assessCommandTime('ls -la')).toBeNull();
    expect(assessCommandTime('cat package.json')).toBeNull();
  });

  it('resolves explicit > assessed > room', () => {
    // Explicit wins even for a long class (the model may know it is nearly done).
    expect(resolveWaitMs('npm test', 2_000, false)).toBe(2_000);
    // Otherwise the class decides…
    expect(resolveWaitMs('npm test', undefined, false)).toBe(900_000);
    expect(resolveWaitMs('npm run build', undefined, true)).toBe(600_000);
    // …and only a command with no class falls back to the room: a person waits
    // less than an unattended run (P7 kept).
    expect(resolveWaitMs('echo hi', undefined, true)).toBe(60_000);
    expect(resolveWaitMs('echo hi', undefined, false)).toBe(120_000);
  });
});

describe('P7 — the identical-command retry storm is capped', () => {
  it('allows ONE blind retry and refuses the 3rd identical failing command', async () => {
    const args = { command: 'node -e "process.exit(3)"', timeout_ms: 5_000, confirm: true };
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push(await runTerminal.run(args, ctx()));
    }
    // The first two really ran (a flaky command keeps its single retry)…
    expect(seen[0]).toContain('Error:');
    expect(seen[1]).toContain('Error:');
    expect(seen[1]).not.toContain('refusing to spend another run');
    // …and the third never spawned: it is refused, in milliseconds, with the
    // one thing the model must do instead. The live run's 120s/13s/120s pattern
    // (three identical failures) is therefore impossible.
    expect(seen[2]).toContain('refusing to spend another run on it');
    expect(seen[2]).toContain('Change the command before calling run_terminal again');
  }, 30_000);

  it('does NOT refuse a DIFFERENT command — the cap is per command, not per directory', async () => {
    const fail = { command: 'node -e "process.exit(3)"', confirm: true };
    for (let i = 0; i < 3; i++) await runTerminal.run(fail, ctx());
    const other = await runTerminal.run({ command: 'echo still-fine', confirm: true }, ctx());
    expect(other).toContain('still-fine');
    expect(other).not.toContain('refusing to spend another run');
  }, 30_000);

  it('does NOT refuse a genuinely long class — it is assessed, not failed', async () => {
    // The old tool spent three 1s budgets refusing `sleep 5`; now `sleep 5` is not
    // a failure at all, so nothing accumulates and the tool stays usable.
    const args = { command: 'sleep 5', timeout_ms: 1000, confirm: true };
    const first = await runTerminal.run(args, ctx());
    expect(first).not.toContain('Error:');
    expect(first).not.toContain('refusing to spend another run');
  }, 30_000);

  it('refuses to START the same work twice while it is still running — and points at the live one', async () => {
    const args = { command: 'sleep 4', timeout_ms: 1000, confirm: true };
    const first = await runTerminal.run(args, ctx());
    const id = monitoredId(first);
    // The second call must not spawn a competing copy of the same work.
    const second = await runTerminal.run(args, ctx());
    expect(second).toContain('Error:');
    expect(second).toContain('ALREADY RUNNING');
    expect(second).toContain(id);
    expect(second).toContain('Starting it again would do the same work twice');
    // …and once that run ENDS, the same command runs again cleanly (a re-run
    // after a real repair or a re-check is still possible).
    await sleep(3200);
    const third = await runTerminal.run({ command: 'echo after', confirm: true }, ctx());
    expect(third).toContain('after');
  }, 30_000);

  it('a SUCCESS on the SAME command clears the streak, so a repaired command is not held against it', async () => {
    const script = join(root, 'check.js');
    // Quote the path: an UNQUOTED Windows path (`node C:\Users\...\check.js`) has its
    // backslashes eaten as shell escapes, so the command fails for the wrong reason.
    const args = { command: `node "${script}"`, confirm: true };
    const fail = async () => {
      writeFileSync(script, 'process.exit(3)');
      return runTerminal.run(args, ctx());
    };
    // One failure — the single blind retry is still available.
    expect(await fail()).toContain('Error:');
    // A repair makes the SAME command succeed. That must clear the streak, or a
    // fixed project could never run its own check again. (The loop ALSO
    // invalidates the streak on the write itself — see the integration test
    // below — so this success is reachable even at the cap.)
    writeFileSync(script, 'process.exit(0)');
    expect(await runTerminal.run(args, ctx())).toContain('✅ succeeded');
    // The streak restarted at zero: two more failures are still allowed to run.
    // (Without the reset these would be calls 3 and 4 — refused.)
    expect(await fail()).not.toContain('refusing to spend another run');
    expect(await fail()).not.toContain('refusing to spend another run');
  }, 30_000);

  it('does NOT count a still-running command toward the streak — it did not fail', async () => {
    const args = { command: 'sleep 5', timeout_ms: 1000, confirm: true };
    const out = await runTerminal.run(args, ctx());
    expect(out).toContain('still running');
    // Counting a LIVE run as a failure is what made the old tool report a run
    // that never finished as broken. The duplicate guard, not the failure cap, is
    // what stops the repeat — and it says so.
    const again = await runTerminal.run(args, ctx());
    expect(again).toContain('ALREADY RUNNING');
    expect(again).not.toContain('refusing to spend another run on it');
  }, 30_000);
});

describe('P7 — a WRITE invalidates the guard, so a repaired project can re-run its own check', () => {
  const realExecute = async (
    name: string,
    args: Record<string, unknown>,
    c: ToolContext,
  ): Promise<string> => {
    const tool = getTool(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.run(args, c);
  };

  it('the tool loop drops the streak when a write is applied, but ignores run_terminal\'s own event', async () => {
    const script = join(root, 'check.js');
    // Padded so the repair below is a SURGICAL edit (≤50% of the file), which is
    // the realistic fix-inside-a-file the verify loop is built around — and the
    // one the autonomy gate lets the agent apply without a round trip.
    const padding = '// padding line so the fix stays a surgical edit\n'.repeat(12);
    writeFileSync(script, `${padding}process.exit(3)\n`);
    const command = `node "${script}"`;
    const args = { command, timeout_ms: 5_000, confirm: true };
    const call = (): StepResponse => ({
      content: '',
      toolCalls: [{ id: `c${Math.random()}`, name: 'run_terminal', arguments: args }],
    });
    const script2: StepResponse[] = [
      call(),
      call(),
      // The repair — a real edit through the loop's own context.
      {
        content: '',
        toolCalls: [
          {
            id: 'w1',
            name: 'edit_file',
            arguments: { path: script, old_string: 'process.exit(3)', new_string: 'process.exit(0)' },
          },
        ],
      },
      // The SAME command, now that the project changed: it must RUN (which the
      // guard would have refused at the cap) and succeed — the whole point.
      call(),
      { content: 'repaired', toolCalls: [] },
    ];
    const results: string[] = [];
    let i = 0;
    await runToolLoop({
      messages: [{ role: 'user', content: 'write the fix for the failing check script and re-run it' }],
      context: { configManager: {}, cwd: root },
      deps: {
        callModel: async () => script2[Math.min(i++, script2.length - 1)],
        executeTool: async (name, a, c) => {
          const out = await realExecute(name, a as Record<string, unknown>, c);
          results.push(`${name}: ${out}`);
          return out;
        },
      },
    });

    const terminal = results.filter((r) => r.startsWith('run_terminal:'));
    // Two identical failures really ran; the write between them cleared the
    // streak, so the third identical attempt is NOT refused and actually
    // executes (a repaired project must be able to re-run its own check).
    expect(terminal).toHaveLength(3);
    expect(terminal[2]).not.toContain('refusing to spend another run');
    // The edit really applied, and the re-run saw the repaired file.
    expect(readFileSync(script, 'utf8')).toContain('process.exit(0)');
    expect(terminal[2]).toContain('✅ succeeded');
  }, 30_000);

  it("run_terminal's own autonomy notice must NOT reset its own streak", async () => {
    // No `confirm: true` here on purpose: that is the path on which run_terminal
    // announces `autonomy:write-applied` for its OWN decision. If the loop let
    // that event invalidate the streak, the guard could never accumulate on the
    // exact commands it exists for.
    // `cp` is a RECOVERABLE, confirm-class command, so running it needs no
    // confirmation (the request authorized the work) — which is exactly the
    // branch that announces `autonomy:write-applied` for run_terminal itself.
    // It fails fast and deterministically (the source does not exist).
    const absent = join(root, 'does-not-exist.txt');
    const args = { command: `cp "${absent}" "${join(root, 'out.txt')}"`, timeout_ms: 5_000 };
    const step = (): StepResponse => ({
      content: '',
      toolCalls: [{ id: `c${Math.random()}`, name: 'run_terminal', arguments: args }],
    });
    const script2: StepResponse[] = [step(), step(), step(), { content: 'done', toolCalls: [] }];
    const results: string[] = [];
    const emitted: Array<{ event: string; tool?: string }> = [];
    let i = 0;
    await runToolLoop({
      messages: [{ role: 'user', content: 'write the fix for the failing check script and re-run it' }],
      context: {
        configManager: {},
        cwd: root,
        emit: (event: string, data: unknown) => {
          emitted.push({ event, tool: (data as { tool?: string } | undefined)?.tool });
        },
      },
      deps: {
        callModel: async () => script2[Math.min(i++, script2.length - 1)],
        executeTool: async (name, a, c) => {
          const out = await realExecute(name, a as Record<string, unknown>, c);
          results.push(out);
          return out;
        },
      },
    });
    // The autonomy notice really fired (so the exclusion is what saved the guard)…
    expect(
      emitted.some((e) => e.event === 'autonomy:write-applied' && e.tool === 'run_terminal'),
    ).toBe(true);
    // …and the streak still accumulated: the third identical attempt is refused.
    expect(results.some((r) => r.includes('refusing to spend another run'))).toBe(true);
  }, 30_000);
});

describe('P7 — an interactive turn still waits less (the room ranks BELOW the command class)', () => {
  it('an explicit wait budget wins, and the message reports the budget it used', async () => {
    const out = await runTerminal.run(
      { command: 'sleep 5', timeout_ms: 1000, confirm: true },
      ctx({ interactive: true }),
    );
    expect(out).toContain("this call's 1s wait budget");
  }, 30_000);

  it('a successful command is never affected by any of this', async () => {
    const out = await runTerminal.run({ command: 'echo hi' }, ctx({ interactive: true }));
    expect(out).toContain('hi');
    expect(out).not.toContain('still running');
    expect(out).not.toContain('TIMEOUT');
  }, 30_000);
});

describe('P9 — a HANG is identified from evidence, and acted on', () => {
  it('a hung command is reported as HUNG with its evidence — and is still NOT killed on the report', async () => {
    // Silence alone must never be a hang (see the next test): the proof is that
    // the process ALSO stopped using CPU. Both samples are driven directly, so
    // the test measures the decision rather than the wall clock.
    process.env.NUVIRA_HANG_POLL_MS = '600000'; // keep the real interval out of the way
    process.env.NUVIRA_STALL_QUIET_MS = '500';
    process.env.NUVIRA_HANG_QUIET_MS = '1000';
    process.env.NUVIRA_HANG_REAP_MS = '0'; // REPORT ONLY — nothing is stopped for us

    const out = await runTerminal.run({ command: 'sleep 30', timeout_ms: 1000, confirm: true }, ctx());
    const id = monitoredId(out);

    // First sample: there is no CPU baseline yet, so it is quiet (stalled), not hung.
    sampleMonitoredRuns(Date.now() + 10_000);
    // Second sample: the CPU did not move in between — THAT is the hang.
    sampleMonitoredRuns(Date.now() + 20_000);

    const polled = await runTerminal.run({ action: 'poll', process_id: id, command: 'x' }, ctx());
    expect(polled).toContain('HUNG');
    expect(polled).toContain('no CPU');
    expect(polled).toContain("action:'stop'");
    // Report-only mode still respects the never-kill rule: the work is alive.
    expect(polled).toContain('still running');

    const list = await runTerminal.run({ action: 'list', command: 'x' }, ctx());
    expect(list).toContain('HUNG');

    // The model can act on the diagnosis itself: stop it and re-run it properly.
    const stopped = await runTerminal.run({ action: 'stop', process_id: id, command: 'x' }, ctx());
    expect(stopped).toContain('SIGTERM');
    expect(stopped).toContain('Nothing else was touched');
    await sleep(400);
    const after = await runTerminal.run({ action: 'poll', process_id: id, command: 'x' }, ctx());
    expect(after).toContain('was STOPPED');
    expect(after).toContain('stopped on request');
    // A stopped run verified NOTHING, so collecting it must not read as a
    // successful check — the loop's accounting keys on this prefix.
    expect(after).toContain('Error:');
  }, 30_000);

  it('collecting a FAILED monitored run is not a success — the poll carries Error:', async () => {
    // The command outlives its wait budget (so it is handed to monitoring) and
    // then FAILS. The poll that collects that result is the only place the real
    // exit code arrives, so it is the only place the verdict can be right — and
    // a failing suite collected through `poll` must not be counted as a check
    // that passed.
    const out = await runTerminal.run({ command: 'sleep 1; exit 7', timeout_ms: 500, confirm: true }, ctx());
    const id = monitoredId(out);
    await sleep(1_600);
    const polled = await runTerminal.run({ action: 'poll', process_id: id, command: 'x' }, ctx());
    expect(polled).toContain('Error:');
    expect(polled).toContain('exit 7');
    expect(polled).not.toContain('✅');
  }, 30_000);

  it('the watchdog stops a confirmed hang by itself once the grace is over', async () => {
    process.env.NUVIRA_HANG_POLL_MS = '150';
    process.env.NUVIRA_STALL_QUIET_MS = '200';
    process.env.NUVIRA_HANG_QUIET_MS = '400';
    process.env.NUVIRA_HANG_REAP_MS = '400';

    const out = await runTerminal.run({ command: 'sleep 30', timeout_ms: 1000, confirm: true }, ctx());
    const id = monitoredId(out);

    // ~3s of "starting" + a hung confirmation + the 400ms grace, with room to spare.
    await sleep(5_000);
    const polled = await runTerminal.run({ action: 'poll', process_id: id, command: 'x' }, ctx());
    expect(polled).toContain('was STOPPED');
    expect(polled).toContain('hung');
    // The honesty rule: a stopped hang is not a failing test suite.
    expect(polled).toContain('NOT a test failure');
  }, 30_000);

  it('a command that keeps producing output is NEVER flagged — the false positive is the bug', async () => {
    // Identical, aggressive thresholds and an equally aggressive grace: if the
    // classifier used silence alone, this chatty command would be reaped. It must
    // not be — that is the difference between "hung" and "slow".
    process.env.NUVIRA_HANG_POLL_MS = '150';
    process.env.NUVIRA_STALL_QUIET_MS = '200';
    process.env.NUVIRA_HANG_QUIET_MS = '400';
    process.env.NUVIRA_HANG_REAP_MS = '400';

    const out = await runTerminal.run(
      {
        command: 'node -e "setInterval(() => console.log(\'tick\'), 80)"',
        timeout_ms: 1000,
        confirm: true,
      },
      ctx(),
    );
    const id = monitoredId(out);
    await sleep(4_000);

    const polled = await runTerminal.run({ action: 'poll', process_id: id, command: 'x' }, ctx());
    expect(polled).not.toContain('HUNG');
    expect(polled).not.toContain('was STOPPED');
    expect(polled).toContain('still running');
    // …and it reports WHY it believes the run is fine.
    expect(polled).toContain('Liveness: WORKING');

    // Clean up the ticker (also covers stopping a live run on request).
    await runTerminal.run({ action: 'stop', process_id: id, command: 'x' }, ctx());
  }, 30_000);

  it('the hand-off says the run is WATCHED, so a hang is not left running forever', async () => {
    const out = await runTerminal.run({ command: 'sleep 30', timeout_ms: 1000, confirm: true }, ctx());
    expect(out).toContain('WATCHED');
    expect(out).toContain('HUNG');
    // The default grace, stated in minutes as an operator would say it.
    expect(hangReapMs()).toBe(300_000);
    expect(out).toContain('5 minutes');
    expect(out).toContain('a slow-but-working command is never touched');
    await runTerminal.run({ action: 'stop', process_id: monitoredId(out), command: 'x' }, ctx());
  }, 30_000);

  it('stopping an id nobody is monitoring is refused, not silently ignored', async () => {
    const out = await runTerminal.run({ action: 'stop', process_id: 'nope', command: 'x' }, ctx());
    expect(out).toContain('Error:');
    expect(out).toContain('no monitored command with id');
  }, 30_000);
});

describe('P10 — a monitored run outlives the process that started it', () => {
  it('re-attaches after a restart: still pollable, and the HEAD of a long run is readable', async () => {
    // ~52KB of output — well past the in-memory buffer — from a process that then
    // sits idle, so it is monitored and still running when the "restart" happens.
    const command =
      `node -e "for (let i = 0; i < 400; i++) console.log('line-' + i + ' ' + 'x'.repeat(120)); ` +
      `setTimeout(() => {}, 30000)"`;
    const out = await runTerminal.run({ command, timeout_ms: 1000, confirm: true }, ctx());
    const id = monitoredId(out);
    await sleep(400);

    // RESTART: this process drops every handle it holds. The command does not
    // stop — and before the registry existed, nothing could follow it either.
    resetDetachedRuns();

    const listed = await runTerminal.run({ action: 'list', command: 'x' }, ctx());
    expect(listed).toContain(id);
    expect(listed).toContain('recovered from a previous process');

    const polled = await runTerminal.run({ action: 'poll', process_id: id, command: 'x' }, ctx());
    expect(polled).toContain('still running');
    expect(polled).toContain('recovered from a previous process');
    // THE POINT OF THE SPOOL: the beginning of the run, which the bounded
    // in-memory buffer had dropped, is still readable.
    expect(polled).toContain('line-0');

    // The pid was re-verified as ours, so it can still be stopped — and the stop
    // is reported against the real process.
    const stopped = await runTerminal.run({ action: 'stop', process_id: id, command: 'x' }, ctx());
    expect(stopped).toContain('SIGTERM');
    await sleep(600);
    const after = await runTerminal.run({ action: 'poll', process_id: id, command: 'x' }, ctx());
    expect(after).toContain('was STOPPED');
  }, 40_000);

  it('reports the REAL exit code of a run that finished before the restart', async () => {
    const out = await runTerminal.run({ command: 'sleep 1; exit 5', timeout_ms: 400, confirm: true }, ctx());
    const id = monitoredId(out);
    await sleep(1_400); // it finishes, and this process watches it finish
    resetDetachedRuns(); // …then the restart

    // The verdict is not lost with the process: "finished (exit 5)", still a
    // failure, so the turn cannot read it as a check that passed.
    const polled = await runTerminal.run({ action: 'poll', process_id: id, command: 'x' }, ctx());
    expect(polled).toContain('Error:');
    expect(polled).toContain('exit 5');
  }, 40_000);

  it('keeps no record for a run that finished inside its wait budget', async () => {
    // A quick command already delivered its result; a registry entry and a spool
    // for it would be litter that a later process could only misread.
    const before = loadRuns().filter((r) => r.command === 'echo quick').length;
    const out = await runTerminal.run({ command: 'echo quick', confirm: true }, ctx());
    expect(out).toContain('quick');
    expect(loadRuns().filter((r) => r.command === 'echo quick').length).toBe(before);
  }, 30_000);

  it('records the OS start token at hand-off — read while the process is certainly ours', async () => {
    // The token has to be captured BEFORE the restart, because afterwards the pid
    // may already be someone else's and asking it to identify itself is the very
    // thing the token is there to check.
    const out = await runTerminal.run({ command: 'sleep 25', timeout_ms: 400, confirm: true }, ctx());
    const id = monitoredId(out);
    const entry = loadRuns().find((r) => r.id === id);
    expect(entry, 'a handed-off run is in the registry').toBeDefined();

    const live = lookupProcess(entry!.pid)?.startedAtText ?? null;
    if (live === null) {
      // Honest: this platform's `ps` gave no `lstart`, so there is no second
      // witness here and the run falls back to the command line alone.
      expect(entry!.osStartedAt).toBeUndefined();
    } else {
      expect(entry!.osStartedAt).toBe(live);
    }

    await runTerminal.run({ action: 'stop', process_id: id, command: 'x' }, ctx());
  }, 30_000);

  it('refuses a recovered run whose pid was recycled by the SAME command line', async () => {
    // The new protection, and the one command matching cannot give: a pid that is
    // alive, running the command we recorded, but NOT the process we started. The
    // verdict has to come from the OS start token, and the consequence of refusing
    // is real — the command keeps running.
    const { saveRun } = await import('../../src/tools/run-registry.js');
    const { spawn } = await import('node:child_process');
    const stranger = spawn('sleep 30', { shell: true, stdio: 'ignore' });
    try {
      await sleep(300);
      const recordedLine = `sleep 30`;
      // A token from another moment entirely — exactly what a recycled pid looks
      // like: the same command line, a different process instance.
      const staleToken = 'Tue Jan 01 00:00:00 1980';
      expect(lookupProcess(stranger.pid!)?.startedAtText).not.toBe(staleToken);

      saveRun({
        id: 'recycled-same-command',
        command: recordedLine,
        cwd: root,
        pid: stranger.pid!,
        startedAt: Date.now(),
        status: 'running',
        exitCode: null,
        osStartedAt: staleToken,
      });
      resetDetachedRuns();

      const listed = await runTerminal.run({ action: 'list', command: 'x' }, ctx());
      expect(listed).toContain('recycled-same-command');

      const stopped = await runTerminal.run(
        { action: 'stop', process_id: 'recycled-same-command', command: 'x' },
        ctx(),
      );
      expect(stopped).toContain('Error:');
      expect(stopped).toContain('could not be re-verified');
      // The refusal names the witness, so an operator can act on it.
      expect(stopped.toLowerCase()).toContain('start time');

      // …and nothing was signalled: the stranger is still running.
      await sleep(300);
      expect(stranger.exitCode === null && stranger.signalCode === null).toBe(true);
    } finally {
      killProcessTree(stranger.pid!, 'SIGKILL', stranger);
    }
  }, 30_000);

  it('refuses to signal a recovered run whose pid it cannot re-verify', async () => {
    // The safety half: a pid that outlived the process table it came from may now
    // be someone else's. A record whose command does not match the live process
    // must be followed and reported, never signalled.
    const { saveRun } = await import('../../src/tools/run-registry.js');
    const { spawn } = await import('node:child_process');
    const stranger = spawn('sleep 30', { shell: true, stdio: 'ignore' });
    try {
      await sleep(300);
      saveRun({
        id: 'recycled-pid',
        command: 'node dist/index.js release:gate',
        cwd: root,
        pid: stranger.pid!,
        startedAt: Date.now(),
        status: 'running',
        exitCode: null,
      });
      resetDetachedRuns();

      const stopped = await runTerminal.run({ action: 'stop', process_id: 'recycled-pid', command: 'x' }, ctx());
      expect(stopped).toContain('Error:');
      expect(stopped).toContain('could not be re-verified');
      // …and it is still running: the refusal really does mean nothing was signalled.
      await sleep(300);
      expect(stranger.exitCode === null && stranger.signalCode === null).toBe(true);
    } finally {
      // The tree, so the `sleep` grandchild goes too — leaked children are the
      // measured cause of this suite's load-dependent flakiness.
      killProcessTree(stranger.pid!, 'SIGKILL', stranger);
    }
  }, 30_000);
});

// Keep the temp dir from leaking between files.
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
