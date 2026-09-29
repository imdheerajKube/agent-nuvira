/**
 * WS4 (#26) — tool lifecycle hooks an operator can subscribe to.
 *
 * WHY AN OPERATOR-FACING HOOK, AND WHY IT REUSES THE REGISTRY. The registry
 * (`src/gateway/hooks.ts`) already existed and already had a `post_tool_call`
 * event — wired to the event bus and installed by NOTHING in production, so it
 * reached the gateway and nowhere else, and could not stop a call even where it
 * did fire. This module is the missing half: it lets an operator DECLARE hooks in
 * config or in the environment, and binds them into that same registry, so the
 * seam has one subscription model instead of a second, parallel system.
 *
 * DECLARED, NOT PROGRAMMED. A hook is a COMMAND with three phases to choose from
 * (`before` / `after` / `failed`), because the operator of a CLI is a person with
 * a shell — not someone who edits this repository to install a callback. The call
 * is written to the command's STDIN as JSON and its decision is read from STDOUT
 * as JSON, so a tool argument can never change which program runs: nothing is
 * interpolated into a command line, only passed as data.
 *
 * CONFIG, WITH THE ENVIRONMENT WINNING. `tools.hooks` in `buffconfig.json` is the
 * durable, reviewable declaration; `NUVIRA_TOOL_HOOK_BEFORE` / `_AFTER` /
 * `_FAILED` declare one hook for a single run. For a given phase the environment
 * REPLACES the configured hooks — "the environment wins" has to mean one list per
 * phase, or the effective hooks are not knowable from reading either source. That
 * also makes the variables the way a forked subagent is covered with no extra
 * plumbing: it inherits its parent's environment, and reads its own config.
 *
 * A BROKEN HOOK DOES NOT VETO. This is the rule the rest of this codebase already
 * follows for its own instruments (the debug log, the OTLP tracer): a hook that
 * crashes, times out, or prints something unparseable is REPORTED and the call
 * proceeds. The alternative is worse than it looks — one bad hook would stop
 * every tool call in the process, and it would do so silently, because the hook
 * that was supposed to report problems is the one that is broken. A veto must be
 * explicit and well-formed (`{"decision":"deny","reason":"…"}`), so a hook can
 * only stop work by saying so.
 *
 * Hooks see LOCAL data and it is NOT redacted, unlike the debug log and the trace:
 * those leave the machine, this is the operator's own command on their own
 * machine. The result preview is bounded so a huge tool result cannot be handed
 * over in full on every call.
 */

import { spawn } from 'node:child_process';

import type { ToolHookConfig } from '../config/types.js';
import { hooks, type HookDecision } from '../gateway/hooks.js';

/** The phase a hook is declared for, in the order a call goes through them. */
export const TOOL_HOOK_PHASES = ['before', 'after', 'failed'] as const;
export type ToolHookPhase = (typeof TOOL_HOOK_PHASES)[number];

/** The environment variable that declares one hook for a single phase. */
export const TOOL_HOOK_ENV: Record<ToolHookPhase, string> = {
  before: 'NUVIRA_TOOL_HOOK_BEFORE',
  after: 'NUVIRA_TOOL_HOOK_AFTER',
  failed: 'NUVIRA_TOOL_HOOK_FAILED',
};

/** How long a hook may take before it is killed and reported. */
export const TOOL_HOOK_TIMEOUT_MS = 5_000;
/** Cap on what we read back from a hook, so a runaway command cannot fill memory. */
export const TOOL_HOOK_OUTPUT_LIMIT_CHARS = 8_000;
/** Cap on the tool result a hook receives — a preview, not the payload. */
export const TOOL_HOOK_RESULT_PREVIEW_CHARS = 4_000;

/** The minimum of a config manager this module needs (`tools.hooks`). */
export interface ToolHooksConfigManager {
  getAll?(): { tools?: { hooks?: ToolHookConfig[] } };
}

/** One resolved declaration: with its phase and command guaranteed present. */
export interface ToolHookDeclaration extends ToolHookConfig {
  phase: ToolHookPhase;
  command: string;
}

/**
 * The JSON document a hook command receives on stdin.
 *
 * Deliberately flat and stable: the phase, the call, and — for the phases that
 * come after the fact — what happened. `result` is a bounded preview with
 * `resultTruncated` saying so, so a hook can tell "the result was short" from "I
 * was handed a cut one".
 */
export interface ToolHookPayload {
  phase: ToolHookPhase;
  tool: string;
  arguments?: Record<string, unknown>;
  callId?: string;
  surface?: string;
  cwd?: string;
  hook: string;
  /** `after` / `failed` only. */
  ok?: boolean;
  result?: string;
  resultTruncated?: boolean;
  error?: string;
  durationMs?: number;
}

/** What a hook said about a call it was asked about. */
export interface ToolHookVerdict {
  /** True when a `before` hook DENIED the call, so it must not run. */
  denied: boolean;
  /** Why, when the hook said. Reported to the model and the turn's trace. */
  reason?: string;
  /** Which hook decided. */
  by?: string;
  /**
   * Hooks that failed to run or to answer, in order. REPORTED, never a veto —
   * see the fail-open rule in the module header.
   */
  problems: string[];
}

/** The honest "no hook had anything to say" value. Fresh each call. */
function allow(): ToolHookVerdict {
  return { denied: false, problems: [] };
}

/** The label a problem/decision is reported under. */
function labelOf(decl: ToolHookDeclaration): string {
  return decl.label?.trim() || decl.command;
}

/**
 * The declarations in effect: config first, then each phase REPLACED by its
 * environment variable when one is set.
 *
 * Exported because the precedence rule is the part worth testing on its own: a
 * caller cannot see which list won by watching a hook run.
 */
export function resolveToolHookDeclarations(
  cm?: ToolHooksConfigManager,
  env: NodeJS.ProcessEnv = process.env,
): ToolHookDeclaration[] {
  let configured: ToolHookConfig[] = [];
  try {
    const raw = cm?.getAll?.()?.tools?.hooks;
    if (Array.isArray(raw)) configured = raw;
  } catch {
    // A config read that fails means no configured hooks — never a throw on the
    // path that runs before every tool call.
    configured = [];
  }

  const declarations: ToolHookDeclaration[] = [];
  for (const phase of TOOL_HOOK_PHASES) {
    const fromEnv = env[TOOL_HOOK_ENV[phase]]?.trim();
    if (fromEnv) {
      // The environment WINS for its phase, and it is one command: an operator
      // setting a variable is overriding, not appending — otherwise the effective
      // list would depend on a merge order invisible from both sources.
      declarations.push({ phase, command: fromEnv, label: `${TOOL_HOOK_ENV[phase]} (env)` });
      continue;
    }
    for (const entry of configured) {
      if (!entry || entry.phase !== phase) continue;
      const command = typeof entry.command === 'string' ? entry.command.trim() : '';
      if (!command) continue;
      declarations.push({ ...entry, phase, command });
    }
  }
  return declarations;
}

/** Does this declaration apply to this tool? Absent/empty `tools` = every tool. */
export function hookAppliesTo(decl: ToolHookDeclaration, tool: string): boolean {
  if (!Array.isArray(decl.tools) || decl.tools.length === 0) return true;
  return decl.tools.some((name) => typeof name === 'string' && name.trim() === tool);
}

// ─── The command bridge ─────────────────────────────────────────────────────

/** One hook's raw result, before it is interpreted. */
interface HookRun {
  stdout: string;
  /** null when the command was killed by us (a timeout). */
  code: number | null;
  timedOut: boolean;
  /** Anything that makes this run unusable — reported, never fatal. */
  failure?: string;
}

function runHookCommand(
  decl: ToolHookDeclaration,
  payload: ToolHookPayload,
  timeoutMs: number,
): Promise<HookRun> {
  return new Promise<HookRun>((resolve) => {
    let settled = false;
    const done = (run: HookRun): void => {
      if (settled) return;
      settled = true;
      resolve(run);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(decl.command, [], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      done({ stdout: '', code: null, timedOut: false, failure: err instanceof Error ? err.message : String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let overflowed = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      // `timedOut` is the flag `runOneHook` reads; a null exit code alone would
      // make a hung hook indistinguishable from one that printed nothing, and
      // silence means ALLOW.
      done({ stdout, code: null, timedOut: true });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length >= TOOL_HOOK_OUTPUT_LIMIT_CHARS) {
        overflowed = true;
        return;
      }
      stdout += chunk.toString('utf8').slice(0, TOOL_HOOK_OUTPUT_LIMIT_CHARS - stdout.length);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 500) stderr += chunk.toString('utf8').slice(0, 500);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ stdout, code: null, timedOut: false, failure: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // A hook that exits non-zero has not made a decision; only its stdout can
      // veto, so a non-zero exit is a problem to report, not a refusal.
      const failure =
        code === 0
          ? overflowed
            ? 'output exceeded the limit and was truncated'
            : undefined
          : `exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`;
      done({ stdout, code, timedOut: false, ...(failure ? { failure } : {}) });
    });

    try {
      child.stdin?.on('error', () => {
        /* the command closed stdin early — its exit code decides */
      });
      child.stdin?.end(JSON.stringify(payload));
    } catch (err) {
      clearTimeout(timer);
      done({ stdout, code: null, timedOut: false, failure: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * Read a hook's decision out of its stdout.
 *
 * Empty output is ALLOW, not a problem: a hook that only records something has
 * nothing to decide. Anything non-empty must be the documented object — a hook
 * that prints prose has not made a decision, and guessing one from loose text is
 * how an operator ends up with a veto they never asked for.
 */
export function parseToolHookDecision(
  stdout: string,
  by: string,
): { decision: HookDecision | null; problem?: string } {
  const text = stdout.trim();
  if (!text) return { decision: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { decision: null, problem: `printed output that is not JSON (${text.slice(0, 120)})` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { decision: null, problem: 'printed JSON that is not an object' };
  }
  const record = parsed as { decision?: unknown; reason?: unknown };
  if (record.decision === 'allow') return { decision: null };
  if (record.decision === 'deny') {
    return {
      decision: {
        deny: true,
        ...(typeof record.reason === 'string' && record.reason.trim() ? { reason: record.reason.trim() } : {}),
        by,
      },
    };
  }
  return { decision: null, problem: `printed a JSON object without a usable "decision" (${text.slice(0, 120)})` };
}

/** Run one declaration and interpret it. Never throws; failures come back as text. */
async function runOneHook(
  decl: ToolHookDeclaration,
  payload: ToolHookPayload,
): Promise<{ decision: HookDecision | null; problem?: string }> {
  const label = labelOf(decl);
  const timeoutMs =
    typeof decl.timeoutMs === 'number' && decl.timeoutMs > 0 ? decl.timeoutMs : TOOL_HOOK_TIMEOUT_MS;
  const run = await runHookCommand(decl, payload, timeoutMs);
  // The timeout is checked FIRST and on its own flag: a killed hook prints
  // nothing, so without this branch it would be read as a hook that ran and said
  // nothing — and silence means ALLOW.
  if (run.timedOut) {
    return { decision: null, problem: `hook '${label}' timed out after ${timeoutMs}ms` };
  }
  if (run.failure) {
    return { decision: null, problem: `hook '${label}' ${run.failure}` };
  }
  return parseToolHookDecision(run.stdout, label);
}

// ─── Installation into the registry ─────────────────────────────────────────

/** The declaration signature currently installed, so a change re-installs. */
let installedSignature: string | null = null;
let installed: Array<{ event: 'before_tool_call' | 'after_tool_call' | 'failed_tool_call'; handler: (...args: never[]) => unknown }> = [];

/**
 * Bind the declared hooks into the registry, if the declarations changed.
 *
 * Idempotent, and it REPLACES rather than accumulates: the registry is a
 * singleton for the process, so a signature change has to unregister what the
 * previous declarations installed — otherwise a hook that was removed from config
 * would go on vetoing calls for the life of the process, and a test that turns a
 * hook on could never turn it off.
 */
export function installDeclaredToolHooks(
  cm?: ToolHooksConfigManager,
  env: NodeJS.ProcessEnv = process.env,
): ToolHookDeclaration[] {
  const declarations = resolveToolHookDeclarations(cm, env);
  const signature = JSON.stringify(declarations);
  if (signature === installedSignature) return declarations;

  for (const entry of installed) hooks.unregister(entry.event, entry.handler as never);
  installed = [];

  try {
    const forPhase = (phase: ToolHookPhase): ToolHookDeclaration[] =>
      declarations.filter((decl) => decl.phase === phase);

    const before = forPhase('before');
    if (before.length > 0) {
      const handler = async (ctx: { tool: string; args?: Record<string, unknown>; callId?: string; surface?: string; cwd?: string; report?: (m: string) => void }): Promise<HookDecision | null> => {
        for (const decl of before) {
          if (!hookAppliesTo(decl, ctx.tool)) continue;
          const payload = buildPayload(decl, 'before', ctx);
          const run = await runOneHook(decl, payload);
          if (run.problem) {
            ctx.report?.(`${run.problem} (the call was allowed — a broken hook never vetoes)`);
            continue;
          }
          if (run.decision) return run.decision;
        }
        return null;
      };
      hooks.register('before_tool_call', handler as never);
      installed.push({ event: 'before_tool_call', handler: handler as never });
    }

    for (const [phase, event] of [
      ['after', 'after_tool_call'],
      ['failed', 'failed_tool_call'],
    ] as const) {
      const list = forPhase(phase);
      if (list.length === 0) continue;
      const handler = async (ctx: {
        tool: string;
        args?: Record<string, unknown>;
        callId?: string;
        surface?: string;
        cwd?: string;
        ok?: boolean;
        result?: string;
        error?: string;
        durationMs?: number;
        report?: (m: string) => void;
      }): Promise<void> => {
        for (const decl of list) {
          if (!hookAppliesTo(decl, ctx.tool)) continue;
          const run = await runOneHook(decl, buildPayload(decl, phase, ctx));
          // These phases observe; a decision here is not honoured, and a problem
          // is still worth saying out loud.
          if (run.problem) ctx.report?.(run.problem);
        }
      };
      hooks.register(event, handler as never);
      installed.push({ event, handler: handler as never });
    }
  } catch {
    // Never let installation break the turn: with nothing installed, behaviour is
    // exactly "no hooks declared".
  }

  installedSignature = signature;
  return declarations;
}

/** The payload for one hook invocation, with the result bounded to a preview. */
function buildPayload(
  decl: ToolHookDeclaration,
  phase: ToolHookPhase,
  ctx: {
    tool: string;
    args?: Record<string, unknown>;
    callId?: string;
    surface?: string;
    cwd?: string;
    ok?: boolean;
    result?: string;
    error?: string;
    durationMs?: number;
  },
): ToolHookPayload {
  const result = typeof ctx.result === 'string' ? ctx.result : undefined;
  const truncated = result !== undefined && result.length > TOOL_HOOK_RESULT_PREVIEW_CHARS;
  return {
    phase,
    tool: ctx.tool,
    ...(ctx.args ? { arguments: ctx.args } : {}),
    ...(ctx.callId ? { callId: ctx.callId } : {}),
    ...(ctx.surface ? { surface: ctx.surface } : {}),
    ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
    hook: labelOf(decl),
    ...(phase === 'before'
      ? {}
      : {
          ok: ctx.ok === true,
          ...(result !== undefined
            ? {
                result: truncated ? result.slice(0, TOOL_HOOK_RESULT_PREVIEW_CHARS) : result,
                resultTruncated: truncated,
              }
            : {}),
          ...(ctx.error ? { error: ctx.error } : {}),
          ...(typeof ctx.durationMs === 'number' ? { durationMs: ctx.durationMs } : {}),
        }),
  };
}

// ─── The seam the tool loops call ───────────────────────────────────────────

/** What a loop hands to the `before` phase. */
export interface BeforeToolCallRequest {
  tool: string;
  args?: Record<string, unknown>;
  callId?: string;
  surface?: string;
  cwd?: string;
  configManager?: ToolHooksConfigManager;
  env?: NodeJS.ProcessEnv;
}

/**
 * Ask the `before` hooks whether this call may run.
 *
 * ALWAYS RESOLVES: a hook that cannot answer never blocks the call, and the reason
 * it could not answer comes back in `problems` for the caller to report.
 */
export async function runBeforeToolHooks(req: BeforeToolCallRequest): Promise<ToolHookVerdict> {
  const env = req.env ?? process.env;
  const declarations = installDeclaredToolHooks(req.configManager, env);
  if (!declarations.some((decl) => decl.phase === 'before' && hookAppliesTo(decl, req.tool))) {
    return allow();
  }
  const problems: string[] = [];
  let decision: HookDecision | null = null;
  try {
    decision = await hooks.runBefore({
      tool: req.tool,
      ...(req.args ? { args: req.args } : {}),
      ...(req.callId ? { callId: req.callId } : {}),
      ...(req.surface ? { surface: req.surface } : {}),
      ...(req.cwd ? { cwd: req.cwd } : {}),
      report: (message) => problems.push(message),
    });
  } catch {
    // runBefore is documented never to throw; if it ever does, the call proceeds.
    return { denied: false, problems };
  }
  if (!decision) return { denied: false, problems };
  return {
    denied: true,
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.by ? { by: decision.by } : {}),
    problems,
  };
}

/** What a loop hands to the `after` / `failed` phase. */
export interface ToolOutcomeRequest extends BeforeToolCallRequest {
  ok: boolean;
  result?: string;
  error?: string;
  durationMs?: number;
}

/**
 * Tell the `after` / `failed` hooks what happened.
 *
 * One of the two fires, never both: a call either succeeded or it did not, and
 * firing `failed` for a success would make a hook that counts failures wrong.
 */
export async function runToolOutcomeHooks(req: ToolOutcomeRequest): Promise<{ problems: string[] }> {
  const env = req.env ?? process.env;
  const phase: ToolHookPhase = req.ok ? 'after' : 'failed';
  const declarations = installDeclaredToolHooks(req.configManager, env);
  if (!declarations.some((decl) => decl.phase === phase && hookAppliesTo(decl, req.tool))) {
    return { problems: [] };
  }
  const problems: string[] = [];
  const base = {
    tool: req.tool,
    ...(req.args ? { args: req.args } : {}),
    ...(req.callId ? { callId: req.callId } : {}),
    ...(req.surface ? { surface: req.surface } : {}),
    ...(req.cwd ? { cwd: req.cwd } : {}),
    ok: req.ok,
    ...(req.result !== undefined ? { result: req.result } : {}),
    ...(typeof req.durationMs === 'number' ? { durationMs: req.durationMs } : {}),
    report: (message: string) => problems.push(message),
  };
  try {
    if (phase === 'after') {
      await hooks.run('after_tool_call', base);
    } else {
      // `error` is required on this phase: a hook that is told a call failed is
      // owed a reason, and a tool that failed without saying why still has its
      // result text (or the plainest possible sentence) rather than a blank.
      await hooks.run('failed_tool_call', {
        ...base,
        error: req.error ?? req.result ?? 'the call did not succeed and said nothing about why',
      });
    }
  } catch {
    /* observe-only: a report is a courtesy, never a failure */
  }
  return { problems };
}

/**
 * The refusal text a vetoed call is fed back as.
 *
 * Shaped like the loop's other refusals (the `Error:` prefix is how a tool
 * result is recognised as a failure everywhere in this codebase), so a veto is
 * accounted as a failed call rather than as work that silently did not happen.
 */
export function toolHookRefusalText(verdict: ToolHookVerdict): string {
  const by = verdict.by ? ` (${verdict.by})` : '';
  return verdict.reason
    ? `Error: refused by a tool hook${by}: ${verdict.reason}`
    : `Error: refused by a tool hook${by}.`;
}
