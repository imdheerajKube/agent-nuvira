/**
 * P0.4 — `run_terminal` — the verify tool (`src/tools/run-terminal.ts`).
 *
 * The ask (master-plan P0.4): *"test not only by scripts but by actual
 * invocation"* — the agent must run a single test file, a typecheck, a git
 * diff, and see the REAL output in the conversation, not a black-box
 * summary. This is the tool that turns "the tests pass" into verifiable
 * truth the agent can iterate on: run → read failure → edit → re-run.
 *
 * Security model — deny-first, three classes:
 *
 * 1. **deny** — NEVER runs, regardless of confirm. Destructive/system-level
 *    commands outside the loop's business: `sudo`, `git push`, `git reset
 *    --hard`, `git clean`, `git checkout -- .`, `rm -rf` at dangerous
 *    targets, mkfs/dd/shutdown/kill -9, fork bombs. The deny regexes scan
 *    the ENTIRE command string — so `echo $(rm -rf /)` and piped variants
 *    are caught too, not just a leading command.
 * 2. **verify** — read-only check commands run WITHOUT confirmation:
 *    typecheck/test/lint/build runners and git read-only + basic shell
 *    reads. This is a POSITIVE allowlist of leading-token prefixes —
 *    anything not listed falls through to confirm (deny-first default).
 * 3. **confirm** — everything else (state-changing: installs, mutations,
 *    network, arbitrary code) requires `confirm: true`, which the model
 *    only has after the user approved via ask_user — the same gate as
 *    edit_file/write_file and run_cli.
 *
 * Also: a leading `buff`/`agent-nuvira` command is routed to run_cli (the
 * manifest resolver) instead — no double execution paths for CLI control.
 *
 * Output: capped (a 40MB log must not flood context) and masked
 * (maskSenderId — phone numbers never echo back in full).
 */

import { spawn } from 'node:child_process';
import type { ToolContext } from './registry.js';
import { maskSenderId } from '../utils/mask.js';

/** Cap on how much terminal output is fed back to the model. */
const MAX_OUTPUT_CHARS = 6000;
/** Default timeout for a terminal command (tests/builds are slow). */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Hard ceiling — the tool loop bounds the whole turn anyway. */
const MAX_TIMEOUT_MS = 300_000;

/** ─── Command classification (deny-first) ───────────────────────────────── */

/**
 * Absolute denials — scanned against the WHOLE command string (so `$(...)`
 * substitutions and pipes of denied commands are caught), never run even
 * with confirm:true. These are outside what the loop may do, full stop.
 */
const DENY_PATTERNS: RegExp[] = [
  // Privilege escalation.
  /\bsudo\b/,
  // Remote mutation — pushing is a human decision (deny-first, like the
  // agent's own git rules: never push from an autonomous loop).
  /\bgit\s+push\b/,
  // Irreversible working-tree destruction.
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+checkout\s+--\s*(\.|--)/,
  /\bgit\s+checkout\s+\.\s*$/,
  // System-level destruction.
  /\b(mkfs|fdisk|dd|shutdown|reboot|halt|poweroff|init|killall)\b/,
  /\bkill\s+-9\b/,
  // `rm -rf` at dangerous targets (absolute roots, home, system dirs, globs).
  // NOTE: tested against the LOWERCASED command, so targets are lowercase.
  /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-f[a-z]*r[a-z]*)\s+(\/|~|\*|\.|\.\/|\$home|\/home|\/etc|\/usr|\/var|\/bin|\/sbin|\/boot|\/opt|\/root|\/system|\/windows)/,
  // Fork bombs.
  /:\s*\(\s*\)\s*\{/,
];

/**
 * Verify-class leading-token prefixes — run WITHOUT confirmation. Positive
 * allowlist = deny-first: anything not listed here is confirm-class.
 * Each prefix is compared against the command's leading tokens, so
 * `npx vitest run tests/x.test.ts` matches "npx vitest".
 */
const VERIFY_PREFIXES: string[] = [
  // Typecheck / test / lint runners (the verify use cases) — both direct and
  // via npx (the model's default for local dev tools).
  'tsc', 'npx tsc', 'vitest', 'npx vitest', 'jest', 'npx jest', 'mocha', 'eslint', 'npx eslint',
  'npm test', 'npm run typecheck', 'npm run lint', 'npm run check', 'npm run build',
  'npm run test', 'npm run verify', 'npm run test:unit', 'npm run type-check',
  // Git read-only.
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git rev-parse',
  // Basic read-only shell.
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'pwd', 'echo', 'wc', 'printf', 'which',
];

type CommandClass = 'deny' | 'verify' | 'confirm';

/** Normalize a command for classification (trim + collapse whitespace). */
function normalize(command: string): string {
  return String(command ?? '').trim().replace(/\s+/g, ' ');
}

function leadingTokens(lower: string, n: number): string[] {
  return lower.split(' ').slice(0, n);
}

/** Classify a command — deny regexes on the FULL string, prefix match on tokens. */
export function classifyCommand(command: string): CommandClass {
  const c = normalize(command);
  const lower = c.toLowerCase();
  if (!lower) return 'deny';
  for (const d of DENY_PATTERNS) {
    if (d.test(lower)) return 'deny';
  }
  const toks = leadingTokens(lower, 3);
  for (const prefix of VERIFY_PREFIXES) {
    const pt = prefix.split(' ');
    if (pt.length <= toks.length && toks.slice(0, pt.length).join(' ') === prefix) {
      return 'verify';
    }
  }
  return 'confirm';
}

/** ─── The tool ───────────────────────────────────────────────────────────── */

export interface RunTerminalArgs {
  command: string;
  confirm?: boolean;
  timeout_ms?: number;
}

export async function runTerminalTool(args: RunTerminalArgs, ctx: ToolContext): Promise<string> {
  const command = normalize(args.command);
  if (!command) return 'run_terminal: empty command.';

  // Route `buff`/`agent-nuvira` control to the manifest resolver — run_cli —
  // so CLI control has exactly one execution path (no double execution).
  const first = command.split(' ')[0].toLowerCase();
  if (first === 'buff' || first === 'agent-nuvira' || first === 'nuvira') {
    return (
      `run_terminal: "${command}" looks like an agent-nuvira CLI command. Use the ` +
      `run_cli tool instead (it resolves the plain-English ask against the command ` +
      `manifest and applies its own confirmation rules).`
    );
  }

  const cls = classifyCommand(command);
  if (cls === 'deny') {
    return (
      `run_terminal: command DENIED — "${command}" is outside what the agent may run. ` +
      `Tell the user, and suggest the safe alternative (or that they run it themselves).`
    );
  }
  if (cls === 'confirm' && !args.confirm) {
    return (
      `run_terminal: "${command}" changes state and needs explicit confirmation. ` +
      `Call ask_user (yes/no, one-line reason), then re-call run_terminal with the SAME ` +
      `command plus confirm:true only if the user agreed.`
    );
  }

  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(args.timeout_ms ?? DEFAULT_TIMEOUT_MS)));
  return execCommand(command, ctx.cwd, timeoutMs);
}

/** Spawn the command (shell-interpreted — pipes, &&, substitutions work). */
function execCommand(command: string, cwd: string | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: cwd || process.cwd(),
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
    }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf-8');
      if (out.length > MAX_OUTPUT_CHARS * 2) out = out.slice(-MAX_OUTPUT_CHARS * 2);
    });
    child.stderr?.on('data', (b: Buffer) => {
      err += b.toString('utf-8');
      if (err.length > MAX_OUTPUT_CHARS) err = err.slice(-MAX_OUTPUT_CHARS);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(`run_terminal: failed to spawn — ${e.message}`);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const body = (out || err).trim().slice(0, MAX_OUTPUT_CHARS);
      const masked = maskSenderId(body);
      const timedOut = code === null;
      const status = timedOut
        ? `⏱ timed out after ${timeoutMs}ms`
        : code === 0
          ? '✅ succeeded'
          : `❌ failed (exit ${code ?? '?'})`;
  resolve(
    `run_terminal: \`${maskSenderId(command)}\` ${status}.\n` +
      (masked ? `Output:\n${masked}` : '(no output)'),
  );
    });
  });
}
