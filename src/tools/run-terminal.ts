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
import { existsSync } from 'node:fs';
import type { ToolContext } from './registry.js';
import { maskSenderId } from '../utils/mask.js';
import { decideStateChange } from '../learning/autonomy-policy.js';
import { envelopeCoversAction } from '../learning/intent-envelope.js';
import { applyProjectEnvironment, guardCommandEnvironment } from '../utils/project-env.js';
import { formatEffectVerdict, isBuildCommand, verifyBuildEffect } from '../utils/effect-verification.js';

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
  // Read-only PARSE checks. These execute nothing — they parse the file and
  // report a syntax error. They were absent from this allowlist, so the model's
  // cheapest verification (`node -c script.js`, the one a small project always
  // reaches for) classified as CONFIRM, the tool refused, and the refusal said
  // "call ask_user, then retry". A live turn produced exactly that loop: four
  // permission questions in one turn, all for a syntax check that cannot change
  // anything. A check that cannot mutate state must never generate a prompt.
  'node -c', 'node --check',
  // Git read-only.
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git rev-parse',
  // Basic read-only shell.
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'pwd', 'echo', 'wc', 'printf', 'which',
  // Read-only path helpers. Listed because a verify command routinely embeds
  // them in a substitution (`npx vitest run tests/$(basename x).test.ts`) and the
  // segment splitter cannot tell a helper from a real command.
  'basename', 'dirname', 'realpath',
];

/**
 * Read-only PROBES — `<cmd> --version` / `--help`, and package-metadata reads.
 *
 * WHY THIS EXISTS (2026-10-04). A version/help probe changes nothing, but it
 * was not on the verify allowlist, so the classifier scored it `confirm`, the
 * gate refused it as `external` ("has an effect outside this machine"), and a
 * live trace (`trace-1791118650644-d73hyr`) burned five steps on `cargo
 * --version` before stalling and failing over to a tiny local model. The old
 * `npm view …` refusal in `trace-1791037551766-gznlyy` is the same bug. A
 * command that cannot mutate state must never generate a prompt.
 *
 * Deliberately narrow: the LAST token must BE the probe flag (so `--version`
 * as a value, e.g. `echo --version`, still classifies by `echo`), and the
 * info commands listed all read remote metadata without writing anything.
 */
const READ_ONLY_PROBE_RE = /(?:^|\s)(?:--version|-V|--help|-h)$/;
const READ_ONLY_INFO_PREFIXES: string[] = [
  'npm view', 'npm info', 'npm ls', 'npm list', 'npm ping', 'npm outdated',
  'cargo search', 'cargo metadata', 'pip show', 'pip list', 'command -v',
  'go version', 'go env', 'java -version',
];

/**
 * Recoverable WORKSPACE commands — the state-changing operations a requested
 * build/development task legitimately needs, and that cannot strand the user
 * (a dependency uninstalls, a directory removes, a staged file unstages).
 *
 * They run without confirmation when the request authorized the work. That is
 * the case a build task hits on every single run: `npm install` was a mandatory
 * human round trip before this, which is the manual cadence in its purest form.
 *
 * Deliberately NOT here, so they keep the confirm gate:
 *   - anything global (`npm install -g`), which mutates the machine, not the repo;
 *   - anything fetched and executed (`curl … | bash`);
 *   - publishing, deploying, pushing (denied outright anyway);
 *   - arbitrary code (`node -e`, `python -c`) and unknown commands — the
 *     deny-first default is unchanged, so this list is the ONLY new autonomy;
 *   - **a command that ADDS a dependency** (`npm install bcrypt`, `yarn add x`,
 *     `cargo add y`) — see {@link addsDependency}.
 *
 * That last carve-out is the fix for a live incident: `bcrypt@^6.0.0` and
 * `express-jwt@^8.5.1` appeared in this repo's `package.json` and
 * `package-lock.json` mid-release, during a run in which the release pipeline
 * was between its commit and its publish phase — one `git add -A` from being
 * committed and published, with no code referencing either package. A
 * dependency is not a build step: "install what the manifest declares" is
 * setup (recoverable), while "declare a new dependency" is a supply-chain
 * decision, and that is a human's to make.
 */
const RECOVERABLE_PREFIXES: string[] = [
  // Dependency lifecycle — the requested build's own setup. The ADD forms are
  // filtered out by `addsDependency` (a new dependency is a decision).
  'npm install', 'npm i', 'npm ci', 'npm add', 'npm init',
  'pnpm install', 'pnpm i', 'pnpm add',
  'yarn install', 'yarn add',
  'bun install', 'bun add',
  'pip install', 'pip3 install', 'python -m pip install', 'uv pip install', 'uv add',
  'poetry add', 'poetry install',
  'cargo add', 'cargo build', 'go get', 'go mod tidy', 'composer require',
  // Workspace-local filesystem mutations.
  'mkdir', 'touch', 'cp', 'mv', 'ln -s',
  // Workspace-local git staging.
  'git add', 'git stage', 'git stash',
];

/**
 * Shell composition (`a && b`, `a | b`, `a > f`, `$(…)`) makes the effect
 * impossible to attribute to a single prefix, so a recoverable prefix never
 * gets autonomy inside a composed command: `npm install x && rm -rf src` is not
 * an install.
 */
const COMPOSED_COMMAND_RE = /[;&|<>`]|\$\(/;

/**
 * Package managers whose `<cmd> <pkg>` form WRITES a new dependency into a
 * manifest or lockfile. These always add, whatever the arguments look like.
 * (`npm ci` is absent on purpose: it installs the lockfile and accepts no
 * package arguments, so an argument passed to it is already out of contract —
 * it is handled by the generic rule below.)
 */
const ADD_COMMAND_PREFIXES: string[] = [
  // Only the forms that REQUIRE a package name. `npm i` is an alias of
  // `npm install` and is handled by the argument check below, so the bare
  // `npm i` (setup) stays recoverable while `npm i bcrypt` does not.
  'npm add', 'yarn add', 'pnpm add', 'bun add',
  'cargo add', 'go get', 'composer require', 'poetry add', 'uv add',
];

/**
 * Installers that are RECOVERABLE when they read a manifest and become an ADD
 * when they name a package (`npm install bcrypt`).
 */
const INSTALL_COMMAND_PREFIXES: string[] = [
  'npm install', 'npm i', 'npm ci', 'pnpm install', 'pnpm i',
  'yarn install', 'bun install',
  'pip install', 'pip3 install', 'python -m pip install', 'uv pip install',
  'poetry install',
];

/** Flags whose VALUE is the declared set (a requirements file, a local path). */
const DECLARED_INSTALL_FLAGS = new Set(['-r', '--requirement', '-e', '--editable']);

/** Bare arguments that mean "install what is already declared", not "install this". */
const DECLARED_INSTALL_ARGS = new Set(['.', '-d', '--dev']);

/**
 * Does this command ADD a dependency (rather than install what is declared)?
 *
 * This is the line between setup and a supply-chain decision, and it is drawn
 * from the command text alone: `npm install` reads the manifest, `npm install
 * bcrypt` writes to it. A command that cannot be read this way (composed,
 * global) is already excluded from autonomy by the callers' other gates.
 */
export function addsDependency(command: string): boolean {
  const lower = normalize(command).toLowerCase();
  if (!lower) return false;

  const hasPrefix = (prefixes: string[]): boolean => {
    const toks = leadingTokens(lower, 2);
    return prefixes.some((p) => {
      const pt = p.split(' ');
      return pt.length <= toks.length && toks.slice(0, pt.length).join(' ') === p;
    });
  };

  if (hasPrefix(ADD_COMMAND_PREFIXES)) return true;
  if (!hasPrefix(INSTALL_COMMAND_PREFIXES)) return false;
  // Reached only for an install form: decide from its arguments.

  const rest = lower.split(' ').slice(2);
  // `-r requirements.txt` / `-e .` ARE the declared set — the file/list that
  // follows the flag is not a package name, so the flag itself settles it.
  if (rest.some((a) => DECLARED_INSTALL_FLAGS.has(a))) return false;
  // Otherwise an installer WITH a package argument declares that package.
  const args = rest.filter((a) => !a.startsWith('-'));
  return args.some((arg) => !DECLARED_INSTALL_ARGS.has(arg));
}



/** A global install mutates the machine, not the repo — never recoverable. */
const GLOBAL_INSTALL_RE = /(?:^|\s)(?:-g|--global)(?:\s|$)/;

/**
 * Is this a recoverable workspace command the agent may run on its own when the
 * request authorized the work?
 */
export function isRecoverableWorkspaceCommand(command: string): boolean {
  const lower = normalize(command).toLowerCase();
  if (!lower) return false;
  if (COMPOSED_COMMAND_RE.test(lower)) return false;
  if (GLOBAL_INSTALL_RE.test(lower)) return false;
  // Declaring a NEW dependency is a human decision, not a build step (see the
  // docstring above and `addsDependency`). The bare install forms stay
  // recoverable: they introduce nothing the manifest did not already declare.
  if (addsDependency(lower)) return false;

  const toks = leadingTokens(lower, 3);
  return RECOVERABLE_PREFIXES.some((prefix) => {
    const pt = prefix.split(' ');
    return pt.length <= toks.length && toks.slice(0, pt.length).join(' ') === prefix;
  });
}

type CommandClass = 'deny' | 'verify' | 'confirm';

/** Severity order — a chain is only as safe as its WORST segment. */
const CLASS_SEVERITY: Record<CommandClass, number> = { deny: 3, confirm: 2, verify: 1 };

/** Normalize a command for classification (trim + collapse whitespace). */
function normalize(command: string): string {
  return String(command ?? '').trim().replace(/\s+/g, ' ');
}

function leadingTokens(lower: string, n: number): string[] {
  return lower.split(' ').slice(0, n);
}

/**
 * Split a command into the pieces a shell would run separately.
 *
 * AUDIT FIX (G17): the classifier used to score the WHOLE string against the
 * verify allowlist, so a verify prefix granted the entire line its safety —
 * `npm run build && rm -rf src/` was classified `verify` and ran with no
 * confirmation at all. Now each segment is classified and the chain takes the
 * WORST class. `npx tsc --noEmit && npx vitest run` (both verify) still runs
 * freely, which is the chained form the loop actually uses.
 *
 * Substitutions are split on too, so a body is classified as the command it is;
 * an unrecognised body falls through to `confirm` (the safe direction).
 */
function splitSegments(lower: string): string[] {
  return lower
    .split(/&&|\|\||;|\n|\||\$\(|`/)
    .map((s) => s.replace(/\)+/g, ' ').trim())
    .filter(Boolean);
}

/** Classify ONE segment by its leading tokens. */
function classifySegment(segment: string): CommandClass {
  const toks = leadingTokens(segment, 3);
  for (const prefix of VERIFY_PREFIXES) {
    const pt = prefix.split(' ');
    if (pt.length <= toks.length && toks.slice(0, pt.length).join(' ') === prefix) {
      return 'verify';
    }
  }
  // Read-only probes (`<cmd> --version` / `--help`) and metadata reads — they
  // cannot change state, so they never need confirmation (see the constants).
  if (READ_ONLY_PROBE_RE.test(segment)) return 'verify';
  for (const prefix of READ_ONLY_INFO_PREFIXES) {
    const pt = prefix.split(' ');
    if (pt.length <= toks.length && toks.slice(0, pt.length).join(' ') === prefix) {
      return 'verify';
    }
  }
  return 'confirm';
}

/** Classify a command — deny regexes on the FULL string, worst-class on segments. */
export function classifyCommand(command: string): CommandClass {
  const c = normalize(command);
  const lower = c.toLowerCase();
  if (!lower) return 'deny';
  // Deny-first on the WHOLE string — a denied command cannot hide behind a
  // substitution or a pipe (this is what keeps `echo $(rm -rf /)` denied).
  for (const d of DENY_PATTERNS) {
    if (d.test(lower)) return 'deny';
  }
  let worst: CommandClass = 'verify';
  for (const segment of splitSegments(lower)) {
    const cls = classifySegment(segment);
    if (CLASS_SEVERITY[cls] > CLASS_SEVERITY[worst]) worst = cls;
  }
  return worst;
}

/** ─── The tool ───────────────────────────────────────────────────────────── */

export interface RunTerminalArgs {
  command: string;
  confirm?: boolean;
  timeout_ms?: number;
}

export async function runTerminalTool(args: RunTerminalArgs, ctx: ToolContext): Promise<string> {
  const command = normalize(args.command);
  // NOTE: every refusal below is prefixed `Error: ` on purpose. The tool-result
  // convention treats that prefix as "this did not run", and the loop's honest
  // accounting (successfulToolCalls → mutation/verification classification)
  // depends on it. Without the prefix, a no-op `run_terminal` (empty command,
  // denied, awaiting confirmation) counted as a SUCCESSFUL verification — a live
  // run produced exactly that: the model emitted `run_terminal` with no command
  // after the verification nudge and the turn read as verified.
  if (!command) return 'Error: run_terminal: empty command — supply the `command` to run.';

  // Route `buff`/`agent-nuvira` control to the manifest resolver — run_cli —
  // so CLI control has exactly one execution path (no double execution).
  const first = command.split(' ')[0].toLowerCase();
  if (first === 'buff' || first === 'agent-nuvira' || first === 'nuvira') {
    return (
      `Error: run_terminal: "${command}" looks like an agent-nuvira CLI command. Use the ` +
      `run_cli tool instead (it resolves the plain-English ask against the command ` +
      `manifest and applies its own confirmation rules).`
    );
  }

  const cls = classifyCommand(command);
  if (cls === 'deny') {
    return (
      `Error: run_terminal: command DENIED — "${command}" is outside what the agent may run. ` +
      `Tell the user, and suggest the safe alternative (or that they run it themselves).`
    );
  }
  // ── Project interpreter canonicalization + pre-run environment guard ──────
  // The live Aukat_check failure: a build ran against an interpreter that did
  // NOT have the project's own dependencies (PyQt6), produced a broken bundle,
  // and still reported success. Before running, pin this project's virtualenv
  // and refuse the two mistakes that caused it — installing Python packages
  // outside the project env, and building/running against an interpreter that
  // is missing the declared dependencies. See src/utils/project-env.ts.
  let runEnv: Record<string, string | undefined> | undefined;
  let envNote = '';
  const envVerdict = guardCommandEnvironment(command, ctx.cwd || process.cwd());
  if (envVerdict.action === 'refuse') {
    return (
      `Error: run_terminal: ${envVerdict.reason}. ${envVerdict.hint} ` +
      `(Guard: NUVIRA_ENV_GUARD=off bypasses this if the project genuinely uses a system interpreter.)`
    );
  }
  if (envVerdict.action === 'proceed' && envVerdict.venv) {
    runEnv = applyProjectEnvironment({ ...process.env }, envVerdict.venv);
    if (envVerdict.note) envNote = `\n🔒 ${envVerdict.note}`;
  }

  // ── G16: the gate consults the request before it consults the model ───────
  // A recoverable workspace command (dependency install, mkdir/cp/mv, git add)
  // on a run that authorized the work is the build's own setup, not a surprise
  // — `npm install` used to be a mandatory human round trip on every build
  // task. Everything else stays exactly where it was: classified `external`, so
  // it asks no matter what the request said.
  let decidedAutonomously = false;
  let autonomyReason = '';
  if (cls === 'confirm' && !args.confirm) {
    const recoverable = isRecoverableWorkspaceCommand(command);
    // The durable grant is consulted first. It can only cover `local-state` —
    // `external` is refused by the envelope itself, so this cannot widen what
    // may run: it only makes an already-authorized class stay authorized across
    // turns instead of being forgotten at the turn boundary.
    const envVerdict = envelopeCoversAction(ctx.envelope, {
      tool: 'run_terminal',
      changeClass: recoverable ? 'local-state' : 'external',
    });
    const verdict = envVerdict.covered
      ? { action: 'proceed' as const, reason: envVerdict.reason }
      : decideStateChange({
          tool: 'run_terminal',
          action: `running "${command}"`,
          changeClass: recoverable ? 'local-state' : 'external',
          recoverable,
          authorizedByRequest: ctx.writesAuthorized?.authorized === true,
        });
    if (verdict.action !== 'proceed') {
      // Mark the pending confirmation so ask_user does NOT suppress the very
      // question this refusal asks for (see ToolContext.pendingConfirmation).
      ctx.pendingConfirmation = { tool: 'run_terminal', command };
      return (
        `Error: run_terminal: "${command}" changes state and needs explicit confirmation ` +
        `(${verdict.reason}). Call ask_user (yes/no, one-line reason), then re-call run_terminal ` +
        `with the SAME command plus confirm:true only if the user agreed.`
      );
    }
    decidedAutonomously = true;
    autonomyReason = verdict.reason;
    ctx.emit?.('autonomy:write-applied', {
      tool: 'run_terminal',
      command,
      reason: verdict.reason,
      authorization: ctx.writesAuthorized?.reason,
    }, 'tool-loop');
  }

  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(args.timeout_ms ?? DEFAULT_TIMEOUT_MS)));
  const startedAt = Date.now();
  const output = await execCommand(command, ctx.cwd, timeoutMs, runEnv);

  // ── A1: effect verification — a BUILD is not done until its artifact is
  // OBSERVED to launch. The live Aukat_check run reported "successfully built
  // and functional" for a bundle that crashed on import; exit code 0 is not
  // proof. Only a build whose artifact crashes turns the whole command into a
  // failure (with the launch stderr), so the model cannot keep narrating success.
  let effectNote = '';
  if (!output.startsWith('Error:') && isBuildCommand(command)) {
    const verdict = await verifyBuildEffect(command, ctx.cwd || process.cwd(), {
      sinceMs: startedAt,
      ...(runEnv ? { env: runEnv } : {}),
    });
    if (verdict.status === 'failed') {
      return (
        `Error: run_terminal: \`${maskSenderId(command)}\` exited 0, but ` +
        `${formatEffectVerdict(verdict)} Fix the artifact and re-run the build — do NOT ` +
        `report this as working. (NUVIRA_EFFECT_VERIFY=off disables this launch check.)`
      );
    }
    if (verdict.status === 'verified') effectNote = `\n${formatEffectVerdict(verdict)}`;
  }

  if (!decidedAutonomously) return output + effectNote + envNote;
  // Reported, never silent — a judgment call the user cannot see is
  // indistinguishable from a bug.
  return (
    `${output}${effectNote}\n💡 Ran without asking: ${autonomyReason}. State what you ran in your answer — ` +
    'do not ask for permission to do work the user already asked for.' +
    envNote
  );
}

/** Spawn the command (shell-interpreted — pipes, &&, substitutions work). */
function execCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
  envOverride?: Record<string, string | undefined>,
): Promise<string> {
  return new Promise((resolve) => {
    // On Windows, use Git Bash for cross-platform shell commands (pwd, touch, etc.)
    const shellOptions: Record<string, unknown> = {
      cwd: cwd || process.cwd(),
      shell: true,
      // A pinned project venv (`envOverride`) wins for PATH/VIRTUAL_ENV; the
      // color/CI flags are always enforced on top so output stays parseable.
      env: { ...(envOverride ?? process.env), FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    };
    if (process.platform === 'win32') {
      const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
      if (existsSync(gitBash)) {
        shellOptions.shell = gitBash;
      }
    }
    const child = spawn(command, shellOptions as any);
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
      resolve(`Error: run_terminal: failed to spawn — ${e.message}`);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const body = (out || err).trim().slice(0, MAX_OUTPUT_CHARS);
      const masked = maskSenderId(body);
      const timedOut = code === null;
      const ok = !timedOut && code === 0;
      const status = timedOut
        ? `⏱ timed out after ${timeoutMs}ms`
        : ok
          ? '✅ succeeded'
          : `❌ failed (exit ${code ?? '?'})`;
      // Enterprise G1: a command that FAILED is not a verification. The loop's
      // honest accounting reads the `Error:` prefix, and the verification gate
      // counts a successful run_terminal as proof — so a non-zero exit (or a
      // timeout) MUST carry the prefix, or a failing test/build would mark the
      // turn "verified". The real output is preserved for diagnosis.
      resolve(
        `${ok ? '' : 'Error: '}run_terminal: \`${maskSenderId(command)}\` ${status}.\n` +
          (masked ? `Output:\n${masked}` : '(no output)'),
      );
    });
  });
}
