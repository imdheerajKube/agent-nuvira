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

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getTool, type ToolContext } from '../../src/tools/registry.js';
import { resetTerminalFailureStreaks, timeoutGuidance } from '../../src/tools/run-terminal.js';
import { runToolLoop, type StepResponse } from '../../src/tools/tool-loop.js';

const runTerminal = getTool('run_terminal')!;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'buff-term-'));
  resetTerminalFailureStreaks();
});

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

describe('P7 — a timeout is a specific, actionable signal', () => {
  it('tells the model it was killed, that the project is NOT broken, and what to do instead', async () => {
    // `sleep` with a 1s budget: killed, deterministically, with no output.
    const out = await runTerminal.run(
      { command: 'sleep 5', timeout_ms: 1000, confirm: true },
      ctx(),
    );
    expect(out).toContain('Error:');
    expect(out).toContain('timed out after 1000ms');
    expect(out).toContain('⏱ TIMEOUT');
    expect(out).toContain('does NOT mean the project is broken');
    expect(out).toContain('Do NOT re-run the identical command');
    expect(out).toContain('narrow it');
    expect(out).toContain('timeout_ms');
  }, 30_000);

  it('the guidance names the command and the ceiling, so the model can act on it', () => {
    const text = timeoutGuidance('npx vitest run', 60_000, false);
    expect(text).toContain('killed after 60s');
    expect(text).toContain('npx vitest run');
    expect(text).toContain('300s');
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

  it('does NOT refuse the SAME command with a LONGER timeout — the tool must not block its own advice', async () => {
    // `timeoutGuidance` tells the model to re-call with an explicit `timeout_ms`
    // when the work is genuinely long. The streak key includes the effective
    // timeout, so following that advice is a NEW attempt and is not refused.
    const short = { command: 'sleep 5', timeout_ms: 1000, confirm: true };
    for (let i = 0; i < 3; i++) await runTerminal.run(short, ctx());
    const longer = await runTerminal.run(
      { command: 'sleep 5', timeout_ms: 2000, confirm: true },
      ctx(),
    );
    expect(longer).not.toContain('refusing to spend another run');
    expect(longer).toContain('timed out after 2000ms');
  }, 30_000);

  it('a SUCCESS on the SAME command clears the streak, so a repaired command is not held against it', async () => {
    const script = join(root, 'check.js');
    const args = { command: `node ${script}`, confirm: true };
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

  it('counts a TIMEOUT toward the streak, so the 120s+120s pattern cannot repeat forever', async () => {
    const args = { command: 'sleep 5', timeout_ms: 1000, confirm: true };
    for (let i = 0; i < 2; i++) {
      const out = await runTerminal.run(args, ctx());
      expect(out).toContain('⏱ TIMEOUT');
    }
    const third = await runTerminal.run(args, ctx());
    expect(third).toContain('refusing to spend another run on it');
    // The second timeout's guidance is already the REPEATED form, and it names
    // the longer-timeout escape the guard honours (see the key).
    expect(third).not.toContain('⏱ TIMEOUT');
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
    const command = `node ${script}`;
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
    const args = { command: `cp ${absent} ${join(root, 'out.txt')}`, timeout_ms: 5_000 };
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

describe('P7 — an interactive turn waits less by default', () => {
  it('uses the shorter default when a person is watching, and the longer one unattended', async () => {
    // Both calls pass an explicit short timeout so the assertion is about the
    // DEFAULT the tool would have used, read off the message itself.
    const interactive = await runTerminal.run(
      { command: 'sleep 5', timeout_ms: 1000, confirm: true },
      ctx({ interactive: true }),
    );
    expect(interactive).toContain('timed out after 1000ms');
    // An explicit timeout_ms still wins in both directions — the interactive
    // default only changes what happens when the model does NOT ask for one.
    const explicitlyLong = timeoutGuidance('sleep 5', 300_000, false);
    expect(explicitlyLong).toContain('300s');
  }, 30_000);

  it('a successful command is never affected by the interactive flag', async () => {
    const out = await runTerminal.run({ command: 'echo hi' }, ctx({ interactive: true }));
    expect(out).toContain('hi');
    expect(out).not.toContain('TIMEOUT');
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
