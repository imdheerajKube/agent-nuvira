/**
 * WS4 (#26) — the operator's tool lifecycle hooks.
 *
 * The seams worth testing on their own, without a loop around them:
 *
 *   · RESOLUTION — config declares hooks, the environment REPLACES them per
 *     phase, and nothing on the pre-call path can throw. Asserted directly
 *     because a caller cannot see which list won by watching a hook run.
 *   · THE CONTRACT — what a hook is handed on stdin, and what its stdout can
 *     mean. The decision parser is the whole surface between an operator's
 *     script and whether work stops, so every shape it accepts and refuses is
 *     pinned here rather than inferred from the loop's behaviour.
 *   · FAIL OPEN — a hook that crashes, times out, or prints prose is REPORTED and
 *     the call proceeds. This is the rule that keeps one broken policy from
 *     stopping every tool call in the process, silently.
 *
 * The commands below are REAL processes (`node <script>`), because that is what
 * an operator declares: the test that would pass against a stubbed spawn is the
 * test that would not notice the pipe, the timeout, or the exit code.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TOOL_HOOK_ENV,
  hookAppliesTo,
  installDeclaredToolHooks,
  parseToolHookDecision,
  resolveToolHookDeclarations,
  runBeforeToolHooks,
  runToolOutcomeHooks,
  toolHookRefusalText,
  type ToolHookPayload,
} from '../../src/tools/tool-hooks.js';

const dir = mkdtempSync(join(tmpdir(), 'tool-hooks-'));
const scripts = new Map<string, string>();

/** Write a hook body to disk and return the command that runs it. */
function hookCommand(name: string, body: string): string {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, body);
  scripts.set(name, file);
  return `node ${file}`;
}

/** A hook that writes the payload it received into `<name>.input.json`. */
function recordingHook(name: string, extra = ''): string {
  return hookCommand(
    name,
    `import { appendFileSync } from 'node:fs';\n` +
      `let raw = '';\n` +
      `process.stdin.setEncoding('utf8');\n` +
      `for await (const chunk of process.stdin) raw += chunk;\n` +
      `appendFileSync(${JSON.stringify(join(dir, `${name}.input.json`))}, raw + '\\n');\n` +
      extra,
  );
}

/** What a recording hook was handed, one entry per invocation. */
function received(name: string): ToolHookPayload[] {
  return readFileSync(join(dir, `${name}.input.json`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ToolHookPayload);
}

afterEach(() => {
  for (const file of scripts.values()) rmSync(file, { force: true });
  scripts.clear();
  for (const name of ['record', 'deny', 'crash', 'prose', 'hang', 'after-record']) {
    rmSync(join(dir, `${name}.input.json`), { force: true });
  }
  // Uninstall whatever this file declared, so the singleton registry is left as
  // the rest of the suite expects it: no hooks declared.
  installDeclaredToolHooks(undefined, {});
});

/** A config manager stub exposing the `tools.hooks` section the module reads. */
const configWith = (hooks: unknown[]): { getAll: () => { tools: { hooks: unknown[] } } } => ({
  getAll: () => ({ tools: { hooks } }),
});

describe('WS4 hook resolution — config, with the environment winning', () => {
  it('reads declarations from config, in phase order', () => {
    const declarations = resolveToolHookDeclarations(
      configWith([
        { phase: 'after', command: 'record-after', label: 'audit' },
        {
          phase: 'before',
          command: 'policy',
          tools: ['edit_file'],
          timeoutMs: 250,
        },
      ]),
      {},
    );
    expect(declarations.map((d) => `${d.phase}:${d.command}`)).toEqual([
      'before:policy',
      'after:record-after',
    ]);
    expect(declarations[0]!.tools).toEqual(['edit_file']);
    expect(declarations[0]!.timeoutMs).toBe(250);
    expect(declarations[1]!.label).toBe('audit');
  });

  it('lets the environment REPLACE the configured hooks for its phase only', () => {
    // One list per phase, not a merge: otherwise the effective policy depends on
    // a merge order that is invisible from both sources.
    const env = { [TOOL_HOOK_ENV.before]: 'env-policy' };
    const declarations = resolveToolHookDeclarations(
      configWith([
        { phase: 'before', command: 'config-policy' },
        { phase: 'after', command: 'config-audit' },
      ]),
      env,
    );
    expect(declarations.map((d) => `${d.phase}:${d.command}`)).toEqual([
      'before:env-policy',
      'after:config-audit',
    ]);
    expect(declarations[0]!.label).toContain('(env)');
  });

  it('ignores a blank environment variable and unusable config entries', () => {
    const declarations = resolveToolHookDeclarations(
      configWith([
        { phase: 'before', command: '   ' },
        { phase: 'nonsense', command: 'x' },
        { phase: 'after', command: 'audit' },
        null,
      ]),
      { [TOOL_HOOK_ENV.before]: '   ' },
    );
    expect(declarations.map((d) => `${d.phase}:${d.command}`)).toEqual(['after:audit']);
  });

  it('never throws when the config cannot be read — hooks are not worth a failed turn', () => {
    const cm = {
      getAll: () => {
        throw new Error('config is corrupt');
      },
    };
    expect(resolveToolHookDeclarations(cm, {})).toEqual([]);
    expect(resolveToolHookDeclarations(undefined, {})).toEqual([]);
  });

  it('applies a scoped hook only to the tools it names', () => {
    const [scoped, global] = resolveToolHookDeclarations(
      configWith([
        { phase: 'before', command: 'policy', tools: ['edit_file'] },
        { phase: 'after', command: 'audit' },
      ]),
      {},
    );
    expect(hookAppliesTo(scoped!, 'edit_file')).toBe(true);
    expect(hookAppliesTo(scoped!, 'read_file')).toBe(false);
    // Absent or empty = every tool: an operator who declares a hook but no list
    // has said "all of them", not "none of them".
    expect(hookAppliesTo(global!, 'anything')).toBe(true);
    expect(hookAppliesTo({ ...global!, tools: [] }, 'anything')).toBe(true);
  });
});

describe('WS4 decision contract — what a hook`s stdout may mean', () => {
  it('treats silence as ALLOW, not as a problem', () => {
    // A hook that only records something has nothing to decide.
    expect(parseToolHookDecision('', 'audit')).toEqual({ decision: null });
    expect(parseToolHookDecision('   \n', 'audit')).toEqual({ decision: null });
    expect(parseToolHookDecision('{"decision":"allow"}', 'audit')).toEqual({ decision: null });
  });

  it('reads a well-formed denial, naming the hook that made it', () => {
    expect(parseToolHookDecision('{"decision":"deny","reason":"  no writes  "}', 'policy')).toEqual({
      decision: { deny: true, reason: 'no writes', by: 'policy' },
    });
    // A denial with no reason is still a denial — the operator does not owe prose
    // for the call to stop, only a decision.
    expect(parseToolHookDecision('{"decision":"deny"}', 'policy')).toEqual({
      decision: { deny: true, by: 'policy' },
    });
  });

  it('REFUSES to guess a decision out of loose text', () => {
    // Guessing one from prose is how an operator ends up with a veto they never
    // asked for; the honest answer is "this hook did not decide", reported.
    for (const output of ['yes', 'DENY', '{"decision":"maybe"}', '[]', 'null', '{"reason":"no"}']) {
      const parsed = parseToolHookDecision(output, 'policy');
      expect(parsed.decision, `${output} was read as a decision`).toBeNull();
      expect(parsed.problem, `${output} produced no problem`).toBeTruthy();
    }
  });
});

describe('WS4 hook execution — a real command, on a real pipe', () => {
  it('hands the before phase the call as JSON, with no outcome fields', async () => {
    const command = recordingHook('record');
    const verdict = await runBeforeToolHooks({
      tool: 'list_dir',
      args: { path: '.' },
      callId: 'call_1',
      surface: 'cli-chat',
      cwd: '/tmp',
      env: { [TOOL_HOOK_ENV.before]: command },
    });

    expect(verdict).toEqual({ denied: false, problems: [] });
    const [payload] = received('record');
    expect(payload).toMatchObject({
      phase: 'before',
      tool: 'list_dir',
      arguments: { path: '.' },
      callId: 'call_1',
      surface: 'cli-chat',
      cwd: '/tmp',
    });
    // The payload names the declaration that is being run (the env variable's own
    // label here), so a hook can tell itself from the other hooks an operator has.
    expect(payload!.hook).toBe(`${TOOL_HOOK_ENV.before} (env)`);
    // `before` runs BEFORE the call, so it cannot be told an outcome.
    expect(payload!.ok).toBeUndefined();
    expect(payload!.result).toBeUndefined();
  });

  it('stops the call when a hook denies it, and says who and why', async () => {
    const command = hookCommand(
      'deny',
      `import { appendFileSync } from 'node:fs';\n` +
        `let raw='';process.stdin.setEncoding('utf8');\n` +
        `for await (const c of process.stdin) raw += c;\n` +
        `appendFileSync(${JSON.stringify(join(dir, 'deny.input.json'))}, raw + '\\n');\n` +
        `process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'no writes before review' }));\n`,
    );
    const verdict = await runBeforeToolHooks({
      tool: 'edit_file',
      env: { [TOOL_HOOK_ENV.before]: command },
    });

    expect(verdict.denied).toBe(true);
    expect(verdict.reason).toBe('no writes before review');
    // WHO decided is part of the verdict, not a nicety: an operator with several
    // hooks needs to know which one stopped the call.
    expect(verdict.by).toBe(`${TOOL_HOOK_ENV.before} (env)`);
    expect(toolHookRefusalText(verdict)).toContain(verdict.by!);
    expect(verdict.problems).toEqual([]);
    expect(received('deny')).toHaveLength(1);
  });

  it('FAILS OPEN on a non-zero exit, and reports it', async () => {
    const command = hookCommand('crash', `process.stderr.write('policy is broken');process.exit(3);`);
    const verdict = await runBeforeToolHooks({
      tool: 'edit_file',
      env: { [TOOL_HOOK_ENV.before]: command },
    });
    expect(verdict.denied).toBe(false);
    expect(verdict.problems.join('\n')).toContain('exited with code 3');
    expect(verdict.problems.join('\n')).toContain('policy is broken');
    // The report has to say the call went through, or a broken policy reads
    // exactly like one that approved everything.
    expect(verdict.problems.join('\n')).toContain('allowed');
  });

  it('FAILS OPEN when a hook prints prose instead of a decision', async () => {
    const command = hookCommand('prose', `process.stdout.write('looks fine to me');`);
    const verdict = await runBeforeToolHooks({
      tool: 'edit_file',
      env: { [TOOL_HOOK_ENV.before]: command },
    });
    expect(verdict.denied).toBe(false);
    expect(verdict.problems.join('\n')).toContain('not JSON');
  });

  it('FAILS OPEN when a hook hangs, and kills it', async () => {
    const command = hookCommand('hang', `setTimeout(() => {}, 60_000);`);
    // The bound comes from the declaration, so the test sets it there rather than
    // waiting the real 5s default: the rule under test is that there IS a bound.
    const verdict = await runBeforeToolHooks({
      tool: 'edit_file',
      configManager: configWith([{ phase: 'before', command, timeoutMs: 200 }]),
      env: {},
    });

    expect(verdict.denied).toBe(false);
    expect(verdict.problems.join('\n')).toContain('timed out after 200ms');
  }, 10_000);

  it('reports the outcome to the phase that matches it, and only that one', async () => {
    const afterCommand = recordingHook('after-record');
    const env = {
      [TOOL_HOOK_ENV.after]: afterCommand,
      [TOOL_HOOK_ENV.failed]: afterCommand,
    };

    const succeeded = await runToolOutcomeHooks({
      tool: 'list_dir',
      ok: true,
      result: 'two files',
      durationMs: 4,
      env,
    });
    expect(succeeded.problems).toEqual([]);
    let payloads = received('after-record');
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      phase: 'after',
      tool: 'list_dir',
      ok: true,
      result: 'two files',
      resultTruncated: false,
      durationMs: 4,
    });

    const failed = await runToolOutcomeHooks({
      tool: 'list_dir',
      ok: false,
      error: 'permission denied',
      env,
    });
    expect(failed.problems).toEqual([]);
    payloads = received('after-record');
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toMatchObject({ phase: 'failed', ok: false, error: 'permission denied' });
  });

  it('never hands the failed phase a blank reason', async () => {
    const command = recordingHook('after-record');
    await runToolOutcomeHooks({
      tool: 'list_dir',
      ok: false,
      env: { [TOOL_HOOK_ENV.failed]: command },
    });
    const [payload] = received('after-record');
    expect(payload!.error).toBeTruthy();
    expect(payload!.phase).toBe('failed');
  });

  it('runs nothing when no hook is declared for the phase', async () => {
    const command = recordingHook('after-record');
    const before = await runBeforeToolHooks({
      tool: 'list_dir',
      env: { [TOOL_HOOK_ENV.after]: command },
    });
    expect(before).toEqual({ denied: false, problems: [] });
    const outcome = await runToolOutcomeHooks({
      tool: 'list_dir',
      ok: true,
      env: { [TOOL_HOOK_ENV.after]: command },
    });
    expect(outcome.problems).toEqual([]);
    expect(received('after-record')).toHaveLength(1);
  });

  it('re-installs when the declarations change and removes them when they go away', async () => {
    const command = recordingHook('record');
    const env = { [TOOL_HOOK_ENV.before]: command };
    // Installed twice with the same declarations: one handler, not two, so a hook
    // with an external side effect cannot run twice per call.
    installDeclaredToolHooks(undefined, env);
    installDeclaredToolHooks(undefined, env);
    await runBeforeToolHooks({ tool: 'list_dir', env });
    expect(received('record')).toHaveLength(1);

    // Declarations gone: the previous handler is unregistered, not left installed.
    installDeclaredToolHooks(undefined, {});
    await runBeforeToolHooks({ tool: 'list_dir', env: {} });
    expect(received('record')).toHaveLength(1);
  });
});

describe('WS4 refusal text — shaped like every other failed call', () => {
  it('carries the hook and the reason, and stays an Error: result', () => {
    const withReason = toolHookRefusalText({ denied: true, reason: 'no writes', by: 'policy', problems: [] });
    expect(withReason).toContain('Error:');
    expect(withReason).toContain('policy');
    expect(withReason).toContain('no writes');

    const bare = toolHookRefusalText({ denied: true, problems: [] });
    expect(bare).toContain('Error:');
    expect(bare).toContain('tool hook');
  });
});
