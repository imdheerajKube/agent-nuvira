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
import {
  applyRemediationAutoFixes,
  diagnoseFailure,
  formatAutoApply,
  formatRemediation,
  remediationAutoApplyEnabled,
} from './remediation-ladder.js';
import type { ToolContext } from './registry.js';
import { maskSenderId } from '../utils/mask.js';
import { decideStateChange } from '../learning/autonomy-policy.js';
import { envelopeCoversAction } from '../learning/intent-envelope.js';
import { sessionGrantCovers, type SessionGrantCategory } from '../learning/session-grant.js';
import { applyProjectEnvironment, guardCommandEnvironment } from '../utils/project-env.js';
import { formatEffectVerdict, isBuildCommand, verifyBuildEffect } from '../utils/effect-verification.js';
import { lookupMemo, memoNotice, storeMemo } from './command-memo.js';

/** Cap on how much terminal output is fed back to the model. */
const MAX_OUTPUT_CHARS = 6000;
/** Default timeout for a terminal command (tests/builds are slow). */
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * P7 (fix_model_routing) — the default when a PERSON is watching.
 *
 * The live failure: three back-to-back 120-second `run_terminal` timeouts in one
 * turn (4 minutes of a 5-minute run) while the dashboard console showed nothing,
 * and then the agent gave up. Two minutes of silence in front of a person is not
 * patience, it is a bug. Sixty seconds still covers a real test/build on this
 * class of project, and an explicit `timeout_ms` (up to MAX_TIMEOUT_MS) still
 * buys the model as much time as the work genuinely needs.
 */
const INTERACTIVE_DEFAULT_TIMEOUT_MS = 60_000;
/** Hard ceiling — the tool loop bounds the whole turn anyway. */
const MAX_TIMEOUT_MS = 300_000;
/**
 * P7 — how many times the SAME command (at the SAME timeout) may fail before the
 * next call is refused.
 *
 * Two, measured from the live run: it ran a near-identical command three times
 * (120s, 13s, 120s) and learned nothing from any of them — so the third blind
 * repeat is exactly what must not happen. A flaky command still gets one retry
 * (transient failures are real: a held lock, a dead port, a cold cache). After
 * the second identical failure the refusal is returned in milliseconds with what
 * to do instead, rather than spending another 60–120 seconds to learn nothing.
 *
 * The streak key (see the call site) includes the EFFECTIVE TIMEOUT, so the
 * remedy this very tool advertises on a timeout — "re-call with an explicit
 * `timeout_ms`" — is a genuinely different attempt and is never blocked here.
 */
const IDENTICAL_FAILURE_CAP = 2;
/** Failures older than this do not count toward the cap — the world may have changed. */
const FAILURE_STREAK_WINDOW_MS = 10 * 60_000;
/** Bound on the streak table (a long session must not accumulate). */
const FAILURE_STREAK_MAX_ENTRIES = 50;

/** `key → {count, lastAt}` for the identical-command guard. */
const commandFailureStreaks = new Map<string, { count: number; lastAt: number }>();

/** Test/DI seam: forget every recorded failure streak. */
export function resetTerminalFailureStreaks(): void {
  commandFailureStreaks.clear();
}

/** Record a failure for this exact command in this directory; report the streak. */
function recordCommandFailure(key: string, now: number): number {
  const prev = commandFailureStreaks.get(key);
  const withinWindow = prev && now - prev.lastAt <= FAILURE_STREAK_WINDOW_MS;
  const count = (withinWindow ? prev.count : 0) + 1;
  commandFailureStreaks.set(key, { count, lastAt: now });
  if (commandFailureStreaks.size > FAILURE_STREAK_MAX_ENTRIES) {
    for (const [k, v] of commandFailureStreaks) {
      if (commandFailureStreaks.size <= FAILURE_STREAK_MAX_ENTRIES) break;
      if (now - v.lastAt > FAILURE_STREAK_WINDOW_MS) commandFailureStreaks.delete(k);
    }
    // Still too big (all recent) — drop the oldest half by insertion order.
    if (commandFailureStreaks.size > FAILURE_STREAK_MAX_ENTRIES) {
      const drop = Math.ceil(commandFailureStreaks.size / 2);
      let i = 0;
      for (const k of commandFailureStreaks.keys()) {
        if (i++ >= drop) break;
        commandFailureStreaks.delete(k);
      }
    }
  }
  return count;
}

/** A command that just SUCCEEDED has nothing to retry — clear its streak. */
function clearCommandFailure(key: string): void {
  commandFailureStreaks.delete(key);
}

/** The guidance a timed-out command gets instead of a bare "timed out". */
export function timeoutGuidance(command: string, timeoutMs: number, repeated: boolean): string {
  const seconds = Math.round(timeoutMs / 1000);
  return (
    `\n\n⏱ TIMEOUT — that command was killed after ${seconds}s without finishing. A timeout does NOT mean the project is broken; ` +
    `it means this command is too slow or is waiting for something that will not come. ` +
    `Do NOT re-run the identical command${repeated ? ' — it has already timed out here' : ''}. Instead: ` +
    `(a) narrow it (a single test file, \`--reporter=dot\`, \`-x\`, one target rather than the whole suite), ` +
    `(b) make it non-interactive (it may be waiting on a prompt or a server), or ` +
    `(c) if the work is genuinely long, re-call with an explicit \`timeout_ms\` up to ${MAX_TIMEOUT_MS} (${Math.round(MAX_TIMEOUT_MS / 1000)}s). ` +
    `Tell the user what was slow rather than repeating \`${maskSenderId(command)}\` as-is.`
  );
}

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
  'test', '[',
  // Read-only path helpers. Listed because a verify command routinely embeds
  // them in a substitution (`npx vitest run tests/$(basename x).test.ts`) and the
  // segment splitter cannot tell a helper from a real command.
  'basename', 'dirname', 'realpath',
  // Text processors. `awk` READS by default — inspecting a file's headers is a
  // read-only check the loop reaches for constantly. Its WRITE form is rejected
  // separately (`isTextProcessorWrite`), so `awk '{print}'` verifies while
  // `awk '{print > "f"}'` keeps the confirm gate. A command that cannot mutate
  // state must never generate a prompt (see the misfire below).
  'awk',
];

/** Text processors that READ by default but can WRITE when told to. */
const TEXT_PROCESSOR_PREFIXES = new Set(['awk']);

/**
 * Shell GRAMMAR keywords — the structure of a compound command, not a command.
 *
 * WHY THIS EXISTS (2026-10-08). A live chat turn
 * (`trace-1791390325578-4968th`) inspected its own output with a pure read-only
 * chain:
 *   grep -n '^#' NOTES.md && echo --- && wc -w NOTES.md &&
 *     for i in Introduction Design Operations; do printf "%s: " "$i"; done; echo
 * Every command in it reads a file, but the `for`/`do`/`done` segments were not
 * on the verify allowlist, so the WHOLE chain scored `confirm`, the gate refused
 * it as "state-changing", and the model burned a step declaring "the command
 * guard misfired on a read-only check" and reading the file a second way.
 *
 * A loop is judged by its BODY: the structural segments contribute nothing, and
 * a body-prefixing keyword (`do printf …`) is stripped so the real command is
 * classified. `for f in *; do rm -rf $f; done` still scores confirm (`rm`), so
 * the autonomy is bounded by what the body actually runs.
 */
const SHELL_STRUCTURAL_KEYWORDS = new Set(['for', 'done', 'fi', 'esac', 'case', '{', '}', '!', 'time', 'function']);
/** Keywords that PREFIX the real command within their own segment. */
const SHELL_BODY_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'while', 'until', 'if']);

/**
 * Does a text processor's segment WRITE? Over-rejects on purpose: a `>` in an
 * `awk` program may be a comparison inside quotes, but reading it as a write
 * only costs a confirmation, while missing a real `print > "file"` would let a
 * state change run unprompted (the safe direction is confirm).
 */
function isTextProcessorWrite(segment: string): boolean {
  return (
    /(?:^|\s)(?:-i\S*|--in-place)\b/.test(segment) ||
    />>?/.test(segment) ||
    /\b(?:system|close)\s*\(/.test(segment) ||
    /\bprintf?\s+>/.test(segment)
  );
}

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
  // `verify` is the LOWEST severity, so returning it is how a segment stays
  // NEUTRAL: it cannot raise the chain's worst class.
  const head = leadingTokens(segment, 1)[0] ?? '';
  if (SHELL_STRUCTURAL_KEYWORDS.has(head)) return 'verify';
  let body = segment;
  if (SHELL_BODY_KEYWORDS.has(head)) {
    body = segment.slice(head.length).trim();
    if (!body) return 'verify';
  }
  const toks = leadingTokens(body, 3);
  for (const prefix of VERIFY_PREFIXES) {
    const pt = prefix.split(' ');
    if (pt.length <= toks.length && toks.slice(0, pt.length).join(' ') === prefix) {
      // A text processor may WRITE; only its read form is verify.
      if (TEXT_PROCESSOR_PREFIXES.has(prefix) && isTextProcessorWrite(body)) return 'confirm';
      return 'verify';
    }
  }
  // Read-only probes (`<cmd> --version` / `--help`) and metadata reads — they
  // cannot change state, so they never need confirmation (see the constants).
  if (READ_ONLY_PROBE_RE.test(body)) return 'verify';
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

  // ── C3: ONE PROBE PER FACT PER RUN ────────────────────────────────────────
  // The measured defect (see src/tools/command-memo.ts): a single run asked the
  // same three facts twice — a combined probe and then the three individually —
  // and created `backend/.venv` twice. The model cannot remember what it already
  // ran; the harness can, because it ran it. So before spending a round trip,
  // ask the memo.
  //
  // The consult sits after the DENY check (a denied command never ran, so it can
  // never be in the memo) and BEFORE every other gate, and that ordering is the
  // point: the memo only holds commands that ALREADY ran successfully in THIS
  // run, under these same gates and this same context — so there is nothing left
  // for the confirm gate to decide. The one thing this must never do is let a
  // memo hit stand in for a command that would have been refused: it cannot, for
  // the reason just given. Failures are never stored (a non-zero exit is
  // retryable by definition), so a repaired project is never told "already done".
  // Scoped to the directory the run is in: `clone_repo` changes `ctx.cwd`
  // mid-run, and a fact learned in one tree is not a fact about another.
  const memoWhere = ctx.cwd || process.cwd();
  const memoHit = lookupMemo(ctx.commandMemo, command, memoWhere);
  if (memoHit) {
    ctx.emit?.('terminal:memoized', {
      command,
      answeredBy: memoHit.entry.command,
      parts: memoHit.parts,
    }, 'tool-loop');
    return memoNotice(command, memoHit);
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
    // The SESSION grant is consulted next, and WHICH category it is depends on
    // the command: a recoverable workspace command needs `terminal`, while an
    // off-machine one (network fetch, global/system install like winget) needs
    // the user to have explicitly granted `external`. The absolute DENY patterns
    // ran ABOVE, so nothing here can unlock sudo / rm -rf / / git push.
    const grantCategory: SessionGrantCategory = recoverable ? 'terminal' : 'external';
    const grantCovers = sessionGrantCovers(ctx.planStore, grantCategory);
    const verdict = envVerdict.covered || grantCovers
      ? {
          action: 'proceed' as const,
          reason: envVerdict.covered
            ? envVerdict.reason
            : 'allowed for this session by the user',
        }
      : decideStateChange({
          tool: 'run_terminal',
          action: `running "${command}"`,
          changeClass: recoverable ? 'local-state' : 'external',
          recoverable,
          authorizedByRequest: ctx.writesAuthorized?.authorized === true,
        });
    if (verdict.action !== 'proceed') {
      // Mark the pending confirmation so ask_user does NOT suppress the very
      // question this refusal asks for (see ToolContext.pendingConfirmation),
      // and so the ask can offer the matching session grant.
      ctx.pendingConfirmation = { tool: 'run_terminal', command, category: grantCategory };
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

  // P7 — the DEFAULT timeout follows the room: a person watching a chat gets a
  // shorter one (see INTERACTIVE_DEFAULT_TIMEOUT_MS). An explicit `timeout_ms`
  // always wins, so a genuinely long build still gets its time.
  const defaultTimeoutMs = ctx.interactive ? INTERACTIVE_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(args.timeout_ms ?? defaultTimeoutMs)));
  // P7 — the IDENTICAL-COMMAND guard. A command that has already failed twice at
  // this timeout in this directory will fail a third time the same way; the live
  // run spent two 120-second timeouts proving that. Refusing costs milliseconds
  // and says what to change instead of quietly spending another two minutes of
  // the user's time. Bounded, self-expiring, and reset by a success.
  //
  // The effective timeout is part of the key on purpose: the guidance a timeout
  // carries tells the model to re-call with a longer `timeout_ms` when the work
  // is genuinely long, and that advice must not be refused by this guard.
  const streakKey = `${ctx.cwd ?? process.cwd()}|${command}|${timeoutMs}`;
  const priorStreak = commandFailureStreaks.get(streakKey);
  if (
    priorStreak &&
    Date.now() - priorStreak.lastAt <= FAILURE_STREAK_WINDOW_MS &&
    priorStreak.count >= IDENTICAL_FAILURE_CAP
  ) {
    return (
      `Error: run_terminal: \`${maskSenderId(command)}\` has already failed ${priorStreak.count} times at this timeout ` +
      `and would fail the same way again — refusing to spend another run on it. Change the command before calling ` +
      `run_terminal again: fix the underlying cause, narrow the scope, raise \`timeout_ms\` if the work is simply long, ` +
      `or run a different check entirely.`
    );
  }
  const startedAt = Date.now();
  const output = await execCommand(command, ctx.cwd, timeoutMs, runEnv);
  // P7 — a TIMEOUT is its own, specific signal: the command was killed, so
  // "it timed out" is not "the project is broken", and the ONE thing the model
  // must not do is re-run the identical command. The guidance says what to do
  // instead (narrow it, make it non-interactive, or pass a longer timeout_ms).
  const timedOut = /run_terminal: `[^`]*` ⏱ timed out after \d+ms/.test(output);
  const failureStreak = timedOut
    ? recordCommandFailure(streakKey, Date.now())
    : output.startsWith('Error:')
      ? recordCommandFailure(streakKey, Date.now())
      : 0;
  if (!timedOut && !output.startsWith('Error:')) clearCommandFailure(streakKey);
  const outputWithNotes = timedOut ? output + timeoutGuidance(command, timeoutMs, failureStreak > 1) : output;

  // A4 — a KNOWN toolchain failure gets its known fix appended, so the model
  // repairs instead of re-trying the identical command. Advisory only: the note
  // names the bounded, project-local step; it never mutates the workspace.
  const remediation = output.startsWith('Error:')
    ? diagnoseFailure(command, output, ctx.cwd)
    : null;
  const remediationNote = remediation ? `\n\n${formatRemediation(remediation)}` : '';
  // Auto-apply (opt-in, NUVIRA_REMEDIATE=auto): take the safe, idempotent
  // project-local step now instead of asking the model to transcribe it, and
  // report exactly what changed. Off by default — advisory stays the norm.
  const autoApplyNote =
    remediation?.autoFix?.length && remediationAutoApplyEnabled()
      ? (() => {
          const result = applyRemediationAutoFixes(remediation);
          ctx.emit?.('remediation:auto-applied', {
            id: remediation.id,
            applied: result.applied,
            skipped: result.skipped,
          }, 'tool-loop');
          return `\n\n${formatAutoApply(result)}`;
        })()
      : '';

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

  // C3 — remember what a SUCCESSFUL run answered (whole command + every fact it
  // established), so the same question in the same run is answered from the
  // output above instead of a second spawn. A timeout is a failure like any
  // other, and `Error:`-prefixed output is a refusal or a crash — neither is a
  // fact worth remembering.
  if (!timedOut && !output.startsWith('Error:')) storeMemo(ctx.commandMemo, command, output, memoWhere);

  if (!decidedAutonomously) return outputWithNotes + effectNote + envNote + remediationNote + autoApplyNote;
  // Reported, never silent — a judgment call the user cannot see is
  // indistinguishable from a bug.
  return (
    `${outputWithNotes}${effectNote}\n💡 Ran without asking: ${autonomyReason}. State what you ran in your answer — ` +
    'do not ask for permission to do work the user already asked for.' +
    envNote +
    remediationNote +
    autoApplyNote
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
