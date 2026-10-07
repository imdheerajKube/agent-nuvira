/**
 * C3 — ONE PROBE PER FACT PER RUN, and one idempotent setup step per run.
 *
 * THE MEASURED DEFECT. Run A asked the same three facts twice inside a single
 * turn: proxy-log line 3 is ONE combined probe (`python3 --version; node --version;
 * npm --version`) and lines 4–6 are the same three probes issued INDIVIDUALLY — 4
 * shell invocations for 3 facts. The same run then issued
 * `python3 -m venv backend/.venv` at line 222 and again at line 232, and both
 * `/tmp/test/.venv` and `/tmp/test/backend/.venv` exist on disk. Every repeat
 * costs a round trip, a tool slot in the context window, and a step of the model's
 * attention on a question it has already had answered.
 *
 * WHY THE HARNESS MUST FIX IT. The model cannot remember what it already ran
 * across a long thread — that is what a context window is for, and prompts get
 * trimmed. The harness CAN: it is the thing that ran the command and holds its
 * output. So the discipline lives here, in the tool layer, not in a prompt.
 *
 * ─── WHAT MAY BE MEMOIZED (deliberately narrow) ─────────────────────────────
 *
 * Two classes, both decided from the command text alone:
 *
 *   1. **PURE PROBES** — version/identity questions whose answer cannot change
 *      during a run: `node --version`, `python3 --version`, `which uv`, `pwd`,
 *      `uname -a`. Re-asking these is always waste.
 *   2. **IDEMPOTENT SETUP** — commands whose second execution does nothing new
 *      and has no external side effect: `python3 -m venv <dir>`, `mkdir -p <dir>`,
 *      `touch <file>`. These are the measured repeats.
 *
 * Deliberately NOT memoized, and each for a reason:
 *   - anything with a pipe, a redirect, a substitution, a subshell or a glob
 *     (`splitCommandChain` refuses to decompose those, so they are never split
 *     into facts that could be wrongly reused);
 *   - `npm/pip install` — repeating is harmless, SKIPPING is not: a second run
 *     after an edit to `package.json` is exactly when a re-install is needed, and
 *     the tool cannot see the difference. A saved round trip is not worth a stale
 *     dependency tree;
 *   - `git add`/`cp`/`mv`/`rm` — arguably idempotent, but they interact with files
 *     created in between, so the second call is not the same question;
 *   - anything classified `confirm`/`deny` by the command gate. Memoization suits
 *     facts, not actions; an action the user authorized stays explicit.
 *
 * FAILURES ARE NEVER MEMOIZED. A command that exited non-zero is retryable by
 * definition (the model may have fixed the cause), so only a successful result is
 * remembered.
 *
 * The memo is PER RUN and in-memory: `RunCommandMemo` hangs off the tool context,
 * which lives exactly as long as the run does. Nothing is written to disk, so a
 * fresh run re-probes everything — a workspace that changed between turns must be
 * seen with fresh eyes.
 */

/** The pure-probe / idempotent-setup classification for one command part. */
export type CommandMemoKind = 'probe' | 'idempotent';

/** Tools whose `--version` is a fact about this run's environment, not a state. */
const PROBE_TOOLS = [
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
  'python', 'python3', 'pip', 'pip3', 'uv', 'poetry', 'conda',
  'git', 'java', 'javac', 'mvn', 'gradle',
  'go', 'rustc', 'cargo', 'ruby', 'gem', 'php', 'dotnet', 'swift',
  'docker', 'podman', 'kubectl', 'terraform',
  'gcc', 'g++', 'clang', 'make', 'cmake', 'ffmpeg', 'ollama', 'sqlite3',
] as const;

/** Whole commands that answer a fact about the machine and never change in a run. */
const PROBE_COMMANDS = new Set(['pwd', 'uname -a', 'uname -m', 'whoami', 'arch', 'nproc', 'hostname']);

/** Lower-case, trimmed, inner whitespace collapsed. `"X"`/`'X'` quoting removed. */
function normalize(part: string): string {
  return part
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .replace(/\s+/g, ' ');
}

/**
 * Split a command chain into its parts, or `null` when the command must not be
 * decomposed.
 *
 * Refuses anything whose parts are not independent: a pipe (including `||`), a
 * redirect, a command substitution, a subshell or a glob means the parts feed
 * each other or depend on files, so treating them as separate facts would be
 * wrong. Refusing is always safe — the command simply runs as before.
 */
export function splitCommandChain(command: string): string[] | null {
  const raw = command.trim();
  if (!raw) return null;
  if (/[|><`$(){}*?[\]~]/.test(raw)) return null;
  const parts = raw
    .split(/\s*(?:;|&&)\s*|\n/)
    .map(normalize)
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

/** How a single command part may be memoized, or `null` for "never memoize". */
export function commandMemoKind(part: string): CommandMemoKind | null {
  const cmd = normalize(part);
  if (!cmd) return null;
  if (PROBE_COMMANDS.has(cmd)) return 'probe';

  // `<tool> --version` / `-v` / `-V`, with an optional `sudo`-free path prefix.
  const version = /^([a-z0-9_.+-]+)\s+(?:--version|-v|-V)$/i.exec(cmd);
  if (version && (PROBE_TOOLS as readonly string[]).includes(version[1].toLowerCase())) return 'probe';

  // `which X` / `command -v X` — an identity question about the machine.
  const which = /^(?:which|command -v|type)\s+([a-z0-9_.+-]+)$/i.exec(cmd);
  if (which) return 'probe';

  // Idempotent setup. `mkdir -p` is the recursive form on purpose: a bare
  // `mkdir` FAILS on the second call, so memoizing it would change an error the
  // model may be relying on into a silent success.
  if (/^(?:python3?|py)\s+-m\s+venv\s+\S+$/.test(cmd)) return 'idempotent';
  if (/^mkdir\s+-p\s+\S+$/.test(cmd)) return 'idempotent';
  if (/^touch\s+\S+$/.test(cmd)) return 'idempotent';
  return null;
}

/** What a memoized command's result was, and which command produced it. */
export interface CommandMemoEntry {
  /** The command (as normalized) whose output answers the key. */
  command: string;
  output: string;
}

/**
 * A key scoped to the directory the command ran in.
 *
 * The scope matters because the run's working directory can CHANGE mid-run:
 * `clone_repo` sets `ctx.cwd` to the freshly cloned tree. A fact learned in one
 * directory is not a fact about another (`pwd` most obviously, and
 * `python3 -m venv .venv` would answer for the wrong project), so the scope is
 * part of every key that is read or written.
 */
function scoped(where: string, key: string): string {
  return where ? `${where}::${key}` : key;
}

/**
 * The per-run memo. Held on the tool context, so its lifetime IS the run's.
 *
 * Two indexes, because the same fact can be asked as part of a chain or on its
 * own: `commands` answers "this exact command again", and `parts` answers "this
 * fact was already established by SOME command this run" (the measured shape:
 * one combined probe, then the three facts individually). Keys are scoped by the
 * directory the command ran in — see {@link scoped}.
 */
export interface RunCommandMemo {
  commands: Map<string, CommandMemoEntry>;
  parts: Map<string, string>;
}

/** A fresh memo for a run. */
export function createRunCommandMemo(): RunCommandMemo {
  return { commands: new Map(), parts: new Map() };
}

/** The key a whole command is remembered under, or `null` when it must not be. */
export function memoKeyFor(command: string): string | null {
  const key = normalize(command);
  if (!key) return null;
  const parts = splitCommandChain(key);
  if (!parts) {
    // Not decomposable: memoizable only when the whole thing is a single
    // classified command (e.g. `python3 -m venv .venv`).
    return commandMemoKind(key) ? `whole:${key}` : null;
  }
  if (!parts.every((p) => commandMemoKind(p) !== null)) return null;
  return `whole:${parts.join('; ')}`;
}

/**
 * The result this run already has for `command`, or `null`.
 *
 * A hit requires EVERY part of the incoming command to be covered by the SAME
 * earlier command — otherwise the earlier output cannot honestly answer the whole
 * question, and the command runs (its own output is then stored for every part).
 */
export function lookupMemo(
  memo: RunCommandMemo | undefined,
  command: string,
  where = '',
): { entry: CommandMemoEntry; parts: string[] } | null {
  if (!memo) return null;
  const key = normalize(command);
  if (!key) return null;

  const exact = memo.commands.get(scoped(where, `whole:${key}`));
  if (exact) return { entry: exact, parts: splitCommandChain(key) ?? [key] };

  const parts = splitCommandChain(key) ?? [key];
  const covered = parts.map((p) => memo.parts.get(scoped(where, `part:${p}`)));
  if (covered.some((c) => c === undefined)) return null;
  const commands = new Set(covered as string[]);
  if (commands.size !== 1) return null;
  const entry = memo.commands.get(commands.values().next().value as string);
  return entry ? { entry, parts } : null;
}

/**
 * Remember a SUCCESSFUL command's output for its whole key and every part.
 *
 * `where` is the directory the command ran in (the run's `cwd`); it scopes both
 * keys, so a fact learned in one directory can never answer a question asked in
 * another after the run changed directory.
 */
export function storeMemo(
  memo: RunCommandMemo | undefined,
  command: string,
  output: string,
  where = '',
): void {
  if (!memo) return;
  const key = memoKeyFor(command);
  if (!key) return;
  const parts = splitCommandChain(normalize(command)) ?? [normalize(command)];
  const entry: CommandMemoEntry = { command: normalize(command), output };
  memo.commands.set(scoped(where, key), entry);
  for (const p of parts) memo.parts.set(scoped(where, `part:${p}`), scoped(where, key));
}

/**
 * The line returned instead of re-running. It NAMES what was already answered and
 * reproduces the earlier output, so the model gets the fact it asked for (without
 * a round trip) and can see that it did not just run.
 */
export function memoNotice(command: string, hit: { entry: CommandMemoEntry; parts: string[] }): string {
  const what = hit.parts.length > 1 ? `${hit.parts.length} facts` : `\`${hit.parts[0]}\``;
  return (
    `↺ run_terminal: not re-run — ${what} already answered in THIS run by \`${hit.entry.command}\`. ` +
    `Do not ask the same question twice; use the output below.\n\n${hit.entry.output}`
  );
}
