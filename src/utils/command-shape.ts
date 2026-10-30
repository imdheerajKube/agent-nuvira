/**
 * Command SHAPE — what a shell segment actually RUNS, once the decorations a
 * model wraps around it are peeled off.
 *
 * WHY THIS EXISTS (measured, 2026-10-27). The gates that read a command judged
 * its raw text, so a model that wrote fluent shell was punished for it. On one
 * scored bench turn (`DEV-FEATURE`, `deepseek-flash`, 28 model steps against
 * Cline's 17) the same intent — "run the project's test suite" — was refused
 * three different ways:
 *
 *   `cd <repo> && ls`                        → confirm (no `cd` rule)
 *   `python3 -m unittest tests.x -v`         → guard refusal (missing deps)
 *   `NUVIRA_ENV_GUARD=off python3 -m unittest …` → confirm (unknown command,
 *                                                 because the assignment and
 *                                                 the interpreter are one string)
 *
 * The last one is the tell: the documented escape hatch was unusable from
 * inside a command, and the model could not tell why. Every refusal was a
 * correct reading of a WRONG parse.
 *
 * So the parse happens in one place, on the shape:
 *   `FOO=1 sudo -E python3 -m unittest` is the command `python3 -m unittest`,
 *   with one assignment in its environment and one wrapper around it.
 *
 * Deliberately NOT a classifier of its own: this module says what a segment IS,
 * and the callers (the environment guard, the confirmation classifier) decide
 * what that means. Nothing here is a command allowlist.
 */

/** `NAME=value` with the value either bare or quoted. */
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=('[^']*'|"[^"]*"|\S*)\s+/;

/**
 * Prefixes that RUN the rest of the segment rather than being the program.
 * `time python x` runs python; `sudo -E python x` runs python as root.
 */
const WRAPPER_RE = /^(?:(?:sudo|doas|env|exec|builtin|nohup|time|stdbuf)\s+|command\s+(?!-v\b))/;

/** Flags that belong to a wrapper, not to the command it wraps. */
const WRAPPER_FLAG_RE = /^(?:-{1,2}[A-Za-z][\w-]*(?:=\S+)?\s+)+/;

export interface CommandShape {
  /** Assignments the segment makes for the command it runs. */
  env: Record<string, string>;
  /** The command with its decorations removed (`python3 -m unittest -q`). */
  text: string;
  /** `text` split on whitespace. */
  argv: string[];
}

function unquote(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Peel assignments and runners off one segment and report what is left.
 * Idempotent and bounded (a decoration chain is never eight deep).
 */
export function unwrapCommand(input: string): CommandShape {
  let text = String(input ?? '').trim();
  const env: Record<string, string> = {};
  for (let i = 0; i < 8; i += 1) {
    const before = text;
    const assign = text.match(ASSIGNMENT_RE);
    if (assign) {
      env[assign[1]] = unquote(assign[2]);
      text = text.slice(assign[0].length).trim();
    }
    if (/^export\s+/.test(text)) text = text.replace(/^export\s+/, '');
    const wrapper = text.match(WRAPPER_RE);
    if (wrapper) {
      text = text.slice(wrapper[0].length).trim();
      // `sudo -E cmd`, `env -i cmd`, `stdbuf -oL cmd` — the flags are the
      // wrapper's, so the next token is the real program.
      text = text.replace(WRAPPER_FLAG_RE, '');
    }
    if (text === before) break;
  }
  return { env, text, argv: text.split(/\s+/).filter(Boolean) };
}

/**
 * Assignments made anywhere in a chain — the ones that matter are the ones a
 * child process would SEE, and a leading assignment on the segment that runs it
 * is the only place the shell applies one.
 */
export function leadingAssignments(command: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const segment of String(command ?? '').split(/&&|\|\||;|\n|\|/)) {
    Object.assign(out, unwrapCommand(segment).env);
  }
  return out;
}

/** Split a chain into segments and report the command each one runs. */
export function unwrappedSegments(command: string): string[] {
  // QUOTE-AWARE, and that is the point. The naive split cut a `grep -E
  // '^(FAIL|ERROR):|^Ran |^OK'` filter at every `|` inside the pattern, leaving
  // fragments like `ERROR):` that matched no known command — so a test run piped
  // through grep scored `confirm` and was refused in a headless turn. Measured on
  // the bench build of 2026-10-28: four of that turn's steps went to re-running
  // the same suite through a different filter.
  return splitChain(command)
    .map((segment) => segment.text.replace(/\)+/g, ' ').trim())
    .filter(Boolean)
    .map((segment) => unwrapCommand(segment).text)
    .filter(Boolean);
}

/** One separately-run piece of a shell line, with its offsets in the original. */
export interface ChainSegment {
  text: string;
  start: number;
  end: number;
}

/**
 * Split a shell line into the pieces the shell runs in sequence, respecting
 * quotes.
 *
 * WHY OFFSETS, not just strings: a caller that wants to put a flag on ONE piece
 * has to edit the original line, and rebuilding it from joined strings loses the
 * author's spacing, quoting and quoting-inside-expansion. Splitting on a quote
 * boundary also keeps `echo "a && b"` from being read as two commands.
 */
export function splitChain(command: string): ChainSegment[] {
  const src = String(command ?? '');
  const out: ChainSegment[] = [];
  let quote: string | null = null;
  let start = 0;
  const cut = (end: number): void => {
    const text = src.slice(start, end);
    if (text.trim()) out.push({ text, start, end });
    start = end + 1;
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if ((ch === '&' || ch === '|') && src[i + 1] === ch) {
      cut(i);
      i += 1;
      start = i + 1;
      continue;
    }
    // `2>&1`, `&>log`, `>&2` are REDIRECTIONS, not a background job: cutting
    // there leaves a fragment of the fd number (`1`), which classifies as an
    // unknown command and turns a plain test run into a confirmation prompt.
    if (ch === '&' && (src[i - 1] === '>' || src[i + 1] === '>')) continue;
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') cut(i);
  }
  const tail = src.slice(start);
  if (tail.trim()) out.push({ text: tail, start, end: src.length });
  return out;
}

/**
 * Where a segment's own arguments END and the shell's redirection begins.
 *
 * `pytest tests -q 2>&1 | tail -20` — flags belong after `-q` and before `2>&1`.
 * A blind append at the end of the line puts them on `tail`, which is the bug this
 * whole module exists to stop repeating: measured, the GUI guard's `--ignore=`
 * suffix landed on the `tail` of a pipeline several times in one bench turn, so
 * the turn watched its verification fail for a reason unrelated to the code.
 */
function redirectionStart(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '>' || ch === '<') {
      // `2>&1` / `&>log` / `2>err.log` — the fd prefix belongs to the redirect,
      // so the flags go BEFORE it, not between the digit and the bracket (which
      // is what produced `pytest -q 2 --ignore=x >&1`).
      const prev = text[i - 1];
      if (prev === '&') return i - 1;
      if (prev !== undefined && /[0-9]/.test(prev) && (i - 1 === 0 || /\s/.test(text[i - 2] ?? ' '))) return i - 1;
      return i;
    }
  }
  return text.length;
}

/**
 * Put `args` on the segment that runs the program `predicate` accepts, and
 * nowhere else. Returns null when no segment matches — the caller then keeps the
 * command EXACTLY as the model wrote it, because a wrong edit here is worse than
 * no edit: it makes the turn re-run a command it can no longer read.
 */
export function insertProgramArgs(
  command: string,
  args: readonly string[],
  predicate: (shape: CommandShape) => boolean,
): string | null {
  if (args.length === 0) return null;
  for (const segment of splitChain(command)) {
    const shape = unwrapCommand(segment.text);
    if (shape.argv.length === 0 || !predicate(shape)) continue;
    const at = redirectionStart(segment.text);
    const before = command.slice(segment.start, segment.start + at).replace(/\s+$/, '');
    const after = command.slice(segment.start + at);
    return (
      command.slice(0, segment.start) +
      before +
      ' ' +
      args.join(' ') +
      (after && !/^\s/.test(after) ? ' ' : '') +
      after
    );
  }
  return null;
}

/** `python3`, `/usr/bin/python3.11`, `py` — the interpreter, not a path. */
function isPythonInterpreter(token: string): boolean {
  return /^(?:python|py)(?:\d+(?:\.\d+)?)?$/.test(token.replace(/\\/g, '/').split('/').pop() ?? '');
}

/** Runner names that TEST or CHECK, whatever the language. */
const VERIFY_PROGRAM_RE = [
  // Python
  /^(?:pytest|py\.test|tox|nox|nosetests3?|mypy|pyright|ruff|flake8|pylint|bandit|black|isort)\b/,
  /^py\.?test$/,
  // Rust / Go / .NET / JVM / Swift / C / Ruby / PHP / Elixir / Deno
  /^(?:cargo\s+(?:test|check|clippy|fmt)|go\s+(?:test|vet)|dotnet\s+(?:test|build)|mvnw?\s+(?:test|verify)|gradlew?\s+(?:test|check|assemble)|swift\s+(?:test|build)|ctest|rspec|phpunit|bats|cabal\s+test|stack\s+test|mix\s+test|deno\s+(?:test|check|lint|bench)|node\s+--test|rake\s+(?:test|spec))\b/,
  // JS runners invoked directly (`npx vitest run`, `jest --ci`, `tsc --noEmit`).
  /^(?:vitest|jest|mocha|ava|tap|uvu|jasmine)(?:\s|$)/,
  /^(?:playwright|cypress)\s+(?:test|run)\b/,
  /^(?:tsc|eslint|stylelint|biome\s+(?:check|ci)|prettier\s+--check)\b/,
  // The JS package managers' declared scripts (a manifest target, not a payload).
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|test:[\w:-]+|lint|check|typecheck|type-check|verify)\b/,
  /^make\s+(?:test|tests|check|lint)\b/,
];
/** `python -m <module>` where the module is a runner or a static checker. */
const PYTHON_MODULE_VERIFY_RE = /^(?:pytest|py\.test|unittest|tox|nose2?|doctest|mypy|pyright|ruff|flake8|pylint|black|isort|compileall|py_compile|coverage)\b/;

/** Path segments that name a test suite rather than a program. */
const TEST_PATH_RE = /(?:^|[\s/'"])(?:tests?|specs?)\/|(?:^|[/\s'"])(?:test_[\w]+\.py|[\w]+_test\.py|[\w.]+\.(?:test|spec)\.[jt]sx?)\b/;

/**
 * Does this segment RUN VERIFICATION (tests, a typecheck, a lint)?
 *
 * The criterion is EFFECT, not language: a test or check runner reports a
 * verdict and writes nothing that a human must approve (its caches live inside
 * the workspace). Such a command must never generate a confirmation prompt —
 * that was four live refusals in one turn for a `pytest` run.
 *
 * Read from the SHAPE (`python3 -m unittest`, not the literal spelling) and
 * from a runner's own name, so `uv run pytest`, `poetry run pytest` and
 * `/usr/bin/python3 -m pytest` all land here without being listed.
 */
export function isVerificationInvocation(input: string): boolean {
  const shape = unwrapCommand(input);
  const argv = shape.argv;
  if (argv.length === 0) return false;
  const lower = shape.text.toLowerCase();

  // `tox`/`nox` can be told to run an arbitrary command after `--`; that body is
  // not the runner's business, so the whole segment keeps the confirm gate.
  if (/^(?:tox|nox)\b/.test(lower) && /\s--\s/.test(lower)) return false;

  for (const re of VERIFY_PROGRAM_RE) {
    if (re.test(lower)) return true;
  }

  const head = (argv[0].replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase();
  if (isPythonInterpreter(head)) {
    // `python -m pytest|unittest|mypy …` — the module decides.
    if (argv[1] === '-m' && argv[2] && PYTHON_MODULE_VERIFY_RE.test(argv[2].toLowerCase())) return true;
    // `python3 -m pip` is an install, never verification.
    if (argv[1] === '-m' && argv[2] === 'pip') return false;
    // `python3 tests/test_x.py` runs a test file — the path is the evidence.
    const args = argv.slice(1);
    if (args.some((a) => TEST_PATH_RE.test(a))) return true;
    return false;
  }
  // `uv run pytest`, `poetry run pytest`, `pipenv run pytest`
  const runAt = /^(?:uv|poetry|pipenv|hatch)\s+run\b/.test(lower) ? 2 : -1;
  if (runAt > 0 && argv.length > runAt) {
    const inner = argv.slice(runAt).join(' ');
    return inner !== lower && isVerificationInvocation(inner);
  }
  // A bare test runner invoked through npx/bunx/pnpm dlx (`npx vitest run`).
  const launched = lower.match(/^(?:npx|bunx|pnpm\s+dlx)\s+(.+)$/);
  if (launched) return isVerificationInvocation(launched[1]);
  return false;
}
