/**
 * Curated process-environment variables — the allowlist behind the dashboard's
 * Process Environment page.
 *
 * WHY AN ALLOWLIST. `~/.nuvira/.env` already has a general writer: the skill
 * secret editor, which accepts any well-formed NAME because a skill may declare
 * any name it likes. The process-behaviour switches are a different thing
 * entirely — they change how a RUN behaves rather than what a skill can read,
 * and several of them are tri-state (asked / declined / nobody said anything),
 * which a free-text NAME=VALUE box cannot express. So the dashboard does not
 * expose "write any variable"; it exposes a fixed, curated set of switches, and
 * the endpoint that writes them refuses every name on this list and no other.
 *
 * WHY THE RULES ARE HERE AND NOT IN THE UI. Every flag below is read somewhere
 * else in the codebase by a specific rule, and those rules are NOT the same:
 *
 *   - `envAsks` (worktree.ts) — `1`/`true`/`yes` ask; everything else, including
 *     unset, does not.
 *   - `resolveResumeRequest` (step-checkpoint.ts) — `1`/`true`/`yes` ask for the
 *     automatic record, `''`/`0`/`false` are off, and ANY OTHER VALUE IS A
 *     RECORD NAME, which is an active resume. Note what that means for `off` and
 *     `no`: unlike the two rules above, `NUVIRA_RESUME=no` is a resume, not a
 *     refusal. The page reports what the reader will really do rather than the
 *     tidier thing it looks like it should do, because a config page that lies
 *     about behaviour is worse than one that omits the variable.
 *   - `debugLoggingEnabled` (debug-log.ts) and `otelExportEnabled` (otel.ts) —
 *     anything except `0`/`false`/`off`/`no`/blank, so `NUVIRA_OTEL=false` in an
 *     `.env` means OFF rather than "a non-empty string".
 *   - `strictModelMode` (route-resolver.ts) — the literal `1`, and nothing else.
 *     `NUVIRA_STRICT_MODEL=true` does NOT enable it, which is exactly the kind of
 *     detail a config UI gets wrong by assuming.
 *
 * Because the readers disagree, the page must not write "whatever the user
 * typed" and then claim it took effect. It writes the canonical value the
 * reader understands (`1` for on, `0` for off) and says, per variable, what
 * leaving it unset means.
 */

/** The vocabulary a variable is declared for, which is also its UI grouping. */
export type ProcessEnvGroup = 'turn' | 'observability' | 'hooks';

/** How the reader that owns a switch decides it is ON. */
export type ProcessEnvFlagRule =
  /** `1`/`true`/`yes` ask for it; anything else is off. (`envAsks`) */
  | 'asks'
  /** Any value except `0`/`false`/`off`/`no`/blank. (`debugLoggingEnabled`, `otelExportEnabled`) */
  | 'truthy'
  /** The literal `1` and nothing else. (`strictModelMode`) */
  | 'strict-one'
  /** `1`/`true`/`yes` ask; `''`/`0`/`false` are off; any other value NAMES one. (`resolveResumeRequest`) */
  | 'asks-or-names';

/** One curated variable, in the shape both the endpoint and the page render. */
export interface ProcessEnvVarSpec {
  /** The exact environment name. `NUVIRA_*`; the `BUFF_*` aliases are legacy. */
  name: string;
  /** Short human name for the row. */
  label: string;
  /** Which section of the page the row belongs to. */
  group: ProcessEnvGroup;
  /**
   * `flag` renders on/off/unset, because the variable's meaning is a decision.
   * `text` renders a single-line value, because the variable IS a value.
   */
  kind: 'flag' | 'text';
  /** For `flag` only: the rule its reader uses. */
  rule?: ProcessEnvFlagRule;
  /**
   * For a `flag` that ALSO accepts a name — `NUVIRA_RESUME=1` asks for the
   * automatic record for this ask in this directory, while any other non-falsey
   * value names a specific checkpoint. Without this the page could only express
   * the boolean half of a variable that has two.
   */
  acceptsValue?: boolean;
  /** Label for the optional value box (only when `acceptsValue`). */
  valueLabel?: string;
  /** Placeholder for a `text` row or the optional value box. */
  placeholder?: string;
  /** What the variable does, in one line. */
  description: string;
  /**
   * What leaving it UNSET means. This is the state the row starts in and the
   * state a user has to be able to reason about, so it is written down per
   * variable rather than assumed to be "off" — for most of these it is, but
   * "nobody said anything" and "someone said no" are different for the two
   * tri-state switches, and the page must not blur them.
   */
  unsetMeans: string;
  /** Where the same switch is reachable without the dashboard. */
  cliEquivalent?: string;
}

/**
 * The set — deliberately small, and every entry is a switch this codebase
 * actually reads. A variable that nothing consumes would be a control that
 * silently does nothing, which is worse than no control at all.
 */
export const PROCESS_ENV_VARS: readonly ProcessEnvVarSpec[] = [
  {
    name: 'NUVIRA_ISOLATE',
    label: 'Isolate every turn',
    group: 'turn',
    kind: 'flag',
    rule: 'asks',
    description:
      'Run each turn in its own git worktree of the project and return the diff against the commit it started from.',
    unsetMeans: 'A turn runs in the project directory itself.',
    cliEquivalent: 'nuvira chat --worktree',
  },
  {
    name: 'NUVIRA_RESUME',
    label: 'Replay recorded steps',
    group: 'turn',
    kind: 'flag',
    rule: 'asks-or-names',
    acceptsValue: true,
    valueLabel: '…or a checkpoint id',
    placeholder: 'blank = this ask, in this directory',
    description:
      'Replay the model calls of this ask whose whole input is unchanged instead of paying for them again.',
    unsetMeans: 'Nothing is replayed; every step is paid for.',
    cliEquivalent: 'nuvira chat --resume [id]',
  },
  {
    name: 'NUVIRA_STRICT_MODEL',
    label: 'Refuse model substitution',
    group: 'turn',
    kind: 'flag',
    rule: 'strict-one',
    description:
      'Fail instead of substituting a model when a pinned one is unavailable, so "it ran on something else" cannot happen silently.',
    unsetMeans: 'A dead pin is repaired by substituting an available model, and the swap is announced.',
  },
  {
    name: 'NUVIRA_DEBUG_LOG',
    label: 'Write a session debug log',
    group: 'observability',
    kind: 'flag',
    rule: 'truthy',
    description:
      'Write one redacted, bounded log file per turn to <config dir>/debug-logs, ready to attach to a bug report.',
    unsetMeans: 'No log is written.',
  },
  {
    name: 'NUVIRA_OTEL',
    label: 'Export OTLP spans',
    group: 'observability',
    kind: 'flag',
    rule: 'truthy',
    description:
      'Export a span tree per turn (nuvira.turn with one child per tool call that really ran) over OTLP/HTTP.',
    unsetMeans: 'Nothing is built and the OpenTelemetry SDK is never even imported.',
  },
  {
    name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    label: 'OTLP collector endpoint',
    group: 'observability',
    kind: 'text',
    placeholder: 'http://localhost:4318',
    description:
      'Where spans are shipped. The OTLP spec appends /v1/traces to this; set OTEL_EXPORTER_OTLP_TRACES_ENDPOINT instead to give the full path.',
    unsetMeans: 'NUVIRA_OTEL builds spans and then drops them, because there is nowhere to send them.',
  },
  {
    name: 'NUVIRA_TOOL_HOOK_BEFORE',
    label: 'Before a tool call',
    group: 'hooks',
    kind: 'text',
    placeholder: 'node ~/deny-shell.mjs',
    description:
      'A command run before each tool call. The call arrives as JSON on stdin; silence means allow, and {"decision":"deny","reason":"…"} stops the call.',
    unsetMeans: 'No before-hook. A hook declared in tools.hooks (buffconfig.json) still runs.',
    cliEquivalent: 'tools.hooks in buffconfig.json',
  },
  {
    name: 'NUVIRA_TOOL_HOOK_AFTER',
    label: 'After a tool call',
    group: 'hooks',
    kind: 'text',
    placeholder: 'node ~/audit.mjs',
    description:
      'A command run after each tool call, with the call and a bounded preview of its result on stdin. It cannot veto — the call already happened.',
    unsetMeans: 'No after-hook. A hook declared in tools.hooks (buffconfig.json) still runs.',
    cliEquivalent: 'tools.hooks in buffconfig.json',
  },
  {
    name: 'NUVIRA_TOOL_HOOK_FAILED',
    label: 'After a failed tool call',
    group: 'hooks',
    kind: 'text',
    placeholder: 'node ~/on-failure.mjs',
    description: 'A command run when a tool call fails, with the failure on stdin.',
    unsetMeans: 'No failed-hook. A hook declared in tools.hooks (buffconfig.json) still runs.',
    cliEquivalent: 'tools.hooks in buffconfig.json',
  },
];

/** Look up a spec by its exact name. */
export function processEnvVarSpec(name: string): ProcessEnvVarSpec | undefined {
  return PROCESS_ENV_VARS.find((v) => v.name === name);
}

/**
 * Is this name on the allowlist?
 *
 * The write endpoints call this FIRST, before touching the file, so a request
 * cannot append an arbitrary name to the credential `.env` through a page that
 * claims to be curated.
 */
export function isCuratedProcessEnvVar(name: string): boolean {
  return processEnvVarSpec(name) !== undefined;
}

/** The words that mean ON / OFF, as the readers themselves accept them. */
const ON_WORDS = new Set(['1', 'true', 'yes', 'on']);
const OFF_WORDS = new Set(['0', 'false', 'off', 'no']);

/** Why a value was refused — a stable code the page turns into copy. */
export type ProcessEnvValueError = 'unknown-name' | 'empty' | 'multiline' | 'too-long' | 'not-a-flag';

/** Bound on a stored value. A hook command is a command, not a script. */
export const PROCESS_ENV_VALUE_MAX_CHARS = 512;

/**
 * Normalize a value to the single spelling its reader understands.
 *
 * `flag` rows are canonicalized to `1`/`0` rather than stored as typed, because
 * `NUVIRA_STRICT_MODEL=true` reads as OFF (`strictModelMode` compares to `'1'`).
 * Storing the user's word would let the page show "on" while the run disagrees —
 * the failure this whole module exists to prevent.
 *
 * A `flag` with `acceptsValue` keeps any other non-falsey string: that is the
 * checkpoint-id half of `NUVIRA_RESUME`, and it is the reader's own rule
 * (`resolveResumeRequest`) that "anything else names one".
 */
export function normalizeProcessEnvValue(
  name: string,
  raw: string,
): { ok: true; value: string } | { ok: false; reason: ProcessEnvValueError } {
  const spec = processEnvVarSpec(name);
  if (!spec) return { ok: false, reason: 'unknown-name' };

  // A newline would smuggle a second variable into the file, so it is refused
  // rather than stripped: silently dropping half a pasted value is how a config
  // ends up containing something the user never wrote.
  if (/[\r\n]/.test(raw)) return { ok: false, reason: 'multiline' };

  const value = raw.trim();
  if (value === '') return { ok: false, reason: 'empty' };
  if (value.length > PROCESS_ENV_VALUE_MAX_CHARS) return { ok: false, reason: 'too-long' };

  if (spec.kind === 'text') return { ok: true, value };

  const word = value.toLowerCase();
  if (ON_WORDS.has(word)) return { ok: true, value: '1' };
  if (OFF_WORDS.has(word)) return { ok: true, value: '0' };
  if (spec.acceptsValue) return { ok: true, value };
  return { ok: false, reason: 'not-a-flag' };
}

/**
 * Is this stored value ON, by the rule its own reader uses?
 *
 * Deliberately not `normalize(...).value === '1'`: a value written by hand —
 * `NUVIRA_OTEL=anything`, which IS on — must be reported as it will really
 * behave, not as the page wishes it were spelled.
 */
export function processEnvFlagIsOn(rule: ProcessEnvFlagRule | undefined, value: string | null): boolean {
  if (value === null) return false;
  const word = value.trim().toLowerCase();
  switch (rule) {
    case 'truthy':
      return word !== '' && word !== '0' && word !== 'false' && word !== 'off' && word !== 'no';
    case 'asks':
      return word === '1' || word === 'true' || word === 'yes';
    case 'strict-one':
      return value.trim() === '1';
    case 'asks-or-names':
      // `resolveResumeRequest` in full: only blank, `0` and `false` decline.
      // `off` and `no` are NOT refusals here — they name a record.
      return word !== '' && word !== '0' && word !== 'false';
    default:
      // A `text` row has no on/off reading; callers only ask this for flags.
      return false;
  }
}
