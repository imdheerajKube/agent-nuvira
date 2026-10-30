/**
 * PERF PROBE — name the three measurements an assessment is allowed to be silent
 * about, and the exact bounded command for each.
 *
 * WHY THIS EXISTS (R12, the head-to-head audit, 2026-10-16). Startup time, memory
 * and throughput were the ONE class of claim NOBODY measured: the report that
 * compared the two agents lists them as UNMEASURED on both sides, and on the
 * repository under review every finding about them was an inference. A gap that
 * both sides share is not a fair comparison — it is a blind spot in the rubric,
 * and it is the cheapest one to close because the measurements are mechanical.
 *
 * THE THREE MEASUREMENTS, and why these three:
 *
 *   1. IMPORT / COLD-START COST — the import profiler, which names the individual
 *      expensive imports rather than one aggregate number. For a desktop app this
 *      is the user-visible "it takes N seconds to open".
 *   2. PEAK ALLOCATION — `tracemalloc`. Stated honestly: it traces PYTHON
 *      allocations and does NOT see a native/CUDA/driver allocation, so a probe
 *      reporting 40 MB for a model loader is not a bug in the probe — it is the
 *      boundary of what this measurement can see, and the block says so.
 *   3. WALL CLOCK OF THE HEAVIEST REALISTIC OPERATION — the one number a user
 *      actually feels. Deliberately NOT templated with a guessed input: the
 *      command is the project's own entry point or e2e script, because a
 *      synthetic input measures the synthetic input.
 *
 * EVERY TEMPLATE HERE WAS MEASURED AGAINST A REAL MACHINE, and two of the first
 * drafts were wrong because of it:
 *
 *   - `timeout` is ABSENT on macOS and `gtimeout` is not installed by default, so
 *     a template that assumed GNU `timeout` emitted commands that fail on the
 *     machine this was written on. The bound is therefore chosen from what the
 *     host HAS: the coreutils wrapper when present, else the interpreter's own
 *     `signal.alarm` — which is a real bound, not a comment (measured: the process
 *     is killed, and nothing after the alarm prints).
 *   - `python` is ABSENT on macOS too (only `python3` exists), so the interpreter
 *     name is detected rather than assumed. A probe block whose commands do not
 *     run is worse than no probe block, because it reads as one that ran.
 *
 * THE IMPORT PROFILER IS REACHED TWO WAYS for the same reason: `-X importtime`
 * when the wrapper can bound the whole command, and `PYTHONPROFILEIMPORTTIME=1`
 * when the bound has to come from inside the interpreter (so the `-X` flag has to
 * give way to the env var). Measured: the env var produces the same profile.
 *
 * HARD TIMEOUTS, OR AN HONEST REFUSAL. When neither mechanism exists (Windows, in
 * practice) the command is emitted UNBOUNDED and the block states plainly that the
 * bound must come from the operator and that an unbound number is tagged
 * UNMEASURED — the discipline rules 3 and 9 already apply to hang claims, moved
 * one step earlier, to the place the numbers come from.
 *
 * WHY IT ONLY NAMES COMMANDS AND NEVER RUNS THEM — same reason as
 * `self-check-discovery.ts`: these run the project's own code, which is exactly
 * the thing that must pass the normal tool gate. Naming the command keeps the run
 * as one consented tool call with a stated timeout; executing it here would hand
 * any cloned repository arbitrary code execution at prompt-assembly time. This
 * module is READ-ONLY over the filesystem, by design.
 *
 * DETERMINISTIC AND LLM-FREE, like everything else in `learning/`: no model
 * decides what a project's startup cost is. Detection that finds nothing to probe
 * yields an EMPTY string, so that turn's prompt is byte-identical to a build
 * without this module.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

import { detectMachineFacts, type MachineFacts } from './machine-facts.js';

/** Which runtime to probe. `none` means nothing detectable — emit nothing. */
export type PerfRuntime = 'python' | 'node' | 'none';

/** Everything the renderer needs, so it can be tested with no filesystem at all. */
export interface PerfProbeInput {
  runtime: PerfRuntime;
  /** Importable module/package name to time, e.g. `ai_voice_studio`. */
  pythonModule?: string;
  /** The python executable THIS machine has (`python3` on macOS, `python` on Windows). */
  pythonCommand?: string;
  /** Entry file to require/run for a cold-start number, repo-relative. */
  nodeEntry?: string;
  /** Timeout wrapper present on this machine (`timeout`, `gtimeout`), or ''. */
  timeoutCommand?: string;
  /** Host platform — decides whether the runtime's own alarm is available. */
  platform?: string;
  /** Which `/usr/bin/time` flavour exists, for the RSS probe. */
  nativePerfTool?: 'bsd' | 'gnu' | 'none';
}

/** Seconds every emitted probe is bounded to. Long enough for a real import. */
export const PROBE_TIMEOUT_SECONDS = 60;

/** Hard cap on rendered probe lines — the block shares the context budget. */
export const MAX_PROBE_LINES = 26;

/** The one-line honesty rule, repeated in the block: no bound, no number. */
const UNMEASURED_RULE =
  'If a number cannot be produced on this machine, tag it `UNMEASURED` and name the platform constraint — never estimate it.';

/**
 * A module name that is safe to place inside a shell template. The name is
 * derived from the REPOSITORY (a `pyproject.toml` field or a directory name), and
 * a template that interpolates repo-controlled text into a shell command is an
 * injection the harness would be performing on the user's behalf. Anything outside
 * the identifier charset is dropped; an empty result means "no probe".
 */
export function safeIdentifier(name: string): string {
  return String(name ?? '').replace(/[^A-Za-z0-9_.-]/g, '');
}

/**
 * A repo-relative path safe inside a shell template — same reasoning as
 * {@link safeIdentifier}, with `/` allowed. Quotes, backticks, `$` and newlines
 * are refused outright rather than escaped, because a legitimate entry path never
 * contains them.
 */
export function safeRelativePath(p: string): string {
  const value = String(p ?? '').trim().replace(/^\.\//, '');
  return /^[A-Za-z0-9_./@\- ]+$/.test(value) ? value : '';
}

/**
 * The names a bare program name can have on Windows.
 *
 * WHY THE EXTENSIONS ARE TRIED (measured 2026-10-30, windows-latest):
 * `executableOnPath('node')` returned false on every Windows runner, because the
 * file on PATH is `node.EXE` and a bare `node` is not a file there. The probe then
 * reported no Node runtime and no `timeout`/`gtimeout`, so every Windows probe
 * claimed `runtime: none` and its numbers were refused as unmeasured — a fact
 * about the search, reported as a fact about the machine. `PATHEXT` is the
 * platform's own answer to "which extensions does a bare name expand to", so it is
 * read first and the standard list is the fallback.
 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Does this executable exist anywhere on PATH? (Never spawns a process.) */
export function executableOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!name) return false;
  const extensions =
    process.platform === 'win32' && !extname(name)
      ? (env.PATHEXT || DEFAULT_PATHEXT)
          .split(';')
          .map((ext) => ext.trim())
          .filter(Boolean)
      : [];
  const candidates = [name, ...extensions.map((ext) => `${name}${ext}`)];
  const dirs = (env.PATH || '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of candidates) {
      try {
        const path = join(dir, candidate);
        // A DIRECTORY named `node` is not an executable, and `existsSync` alone
        // would call it one.
        if (existsSync(path) && !statSync(path).isDirectory()) return true;
      } catch {
        // An unreadable PATH entry tells us nothing — keep looking.
      }
    }
  }
  return false;
}

/** `[project] name` from a pyproject.toml, without a TOML parser. */
function pythonNameFromToml(text: string): string {
  const section = /\[project\]([\s\S]*?)(?:\n\[|$)/.exec(text)?.[1] ?? '';
  const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(section)?.[1] ?? '';
  return name.trim();
}

/**
 * A python one-liner, bounded by the best mechanism this host has.
 *
 * Returns `bounded: false` only when there is genuinely no way to bound it, and
 * the caller then refuses to present the probe as if it were safe.
 */
export function pythonProbe(input: PerfProbeInput, program: string): { command: string; bounded: boolean } {
  const py = safeIdentifier(input.pythonCommand || 'python');
  if (input.timeoutCommand) {
    return { command: `${input.timeoutCommand} ${PROBE_TIMEOUT_SECONDS} ${py} -c "${program}"`, bounded: true };
  }
  if (input.platform !== 'win32') {
    // The interpreter's own alarm — a real bound, and the reason the probe works
    // at all on a machine without coreutils (measured on macOS: it kills the run).
    return { command: `${py} -c "import signal; signal.alarm(${PROBE_TIMEOUT_SECONDS}); ${program}"`, bounded: true };
  }
  return { command: `${py} -c "${program}"`, bounded: false };
}

/**
 * The import-cost probe: `-X importtime` under the coreutils wrapper, or the
 * equivalent env var when the bound has to come from inside the interpreter.
 * Measured: both produce the same `import time: ... imported package` profile.
 */
export function pythonImportProbe(
  input: PerfProbeInput,
  moduleName: string,
): { command: string; bounded: boolean } {
  const py = safeIdentifier(input.pythonCommand || 'python');
  const mod = safeIdentifier(moduleName);
  if (input.timeoutCommand) {
    return {
      command: `${input.timeoutCommand} ${PROBE_TIMEOUT_SECONDS} ${py} -X importtime -c "import ${mod}" 2>&1 | tail -15`,
      bounded: true,
    };
  }
  if (input.platform !== 'win32') {
    return {
      command: `PYTHONPROFILEIMPORTTIME=1 ${py} -c "import signal; signal.alarm(${PROBE_TIMEOUT_SECONDS}); import ${mod}" 2>&1 | tail -15`,
      bounded: true,
    };
  }
  return { command: `${py} -X importtime -c "import ${mod}" 2>&1 | tail -15`, bounded: false };
}

/**
 * Render the probe section for the prompt. Returns '' when there is nothing to
 * probe, which is what keeps such a turn byte-identical to a build without this.
 *
 * Deliberately SHORT and imperative: three measurements, the boundary of each, and
 * the rule for a platform that forbids one. It is not a methodology essay — the
 * model already has rules 1, 3 and 9 for how to report.
 */
export function buildPerfProbeBlock(input: PerfProbeInput): string {
  if (input.runtime === 'none') return '';
  const lines: string[] = [
    '',
    '## Performance probes — this class of claim went UNMEASURED last time',
    'Every performance claim ("slow to start", "eats memory", "takes forever")',
    'needs one of these numbers, produced by the command beside it:',
    '',
  ];

  let unbounded = false;

  if (input.runtime === 'python') {
    const mod = safeIdentifier(input.pythonModule || '');
    const named = mod ? `\`${mod}\`` : 'the project\'s top-level package';
    const importProbe = pythonImportProbe(input, mod || 'PACKAGE');
    const memProbe = pythonProbe(
      input,
      `import tracemalloc; tracemalloc.start(); import ${mod || 'PACKAGE'}; cur, peak = tracemalloc.get_traced_memory(); print(f'peak {peak/1e6:.1f} MB python-alloc')`,
    );
    unbounded = !importProbe.bounded || !memProbe.bounded;
    lines.push(
      `- Cold import cost of ${named}:  \`${importProbe.command}\``,
      `- Peak PYTHON allocation:  \`${memProbe.command}\``,
      '  (tracemalloc sees Python allocations only — a native/CUDA allocation is',
      '  outside it. Report that boundary rather than calling the number total.)',
      input.timeoutCommand
        ? `- Wall clock of the heaviest realistic operation: the project's own entry point or e2e script, run as \`${input.timeoutCommand} ${PROBE_TIMEOUT_SECONDS} python <its-own-entry>\`.`
        : `- Wall clock of the heaviest realistic operation: the project's own entry point or e2e script, and bound it yourself.`,
    );
  } else {
    const entry = safeRelativePath(input.nodeEntry || '');
    const named = entry ? `\`${entry}\`` : 'the project\'s own main entry';
    const startProbe = entry
      ? pythonProbeStyleNode(input, entry)
      : { command: 'node <the project\'s entry>', bounded: false };
    unbounded = !startProbe.bounded;
    const wrap = input.timeoutCommand ? `${input.timeoutCommand} ${PROBE_TIMEOUT_SECONDS} ` : '';
    const rss =
      input.nativePerfTool === 'bsd'
        ? `\`${wrap}/usr/bin/time -l node ${entry || '<entry>'} 2>&1 | grep -i "maximum resident" | tail -2\``
        : input.nativePerfTool === 'gnu'
          ? `\`${wrap}/usr/bin/time -v node ${entry || '<entry>'} 2>&1 | grep -i "maximum resident" | tail -2\``
          : 'no `/usr/bin/time` on this platform — tag it `UNMEASURED`.';
    lines.push(
      `- Cold require / startup of ${named}:  \`${startProbe.command}\``,
      `- Peak RSS:  ${rss}`,
      '- Wall clock of the heaviest realistic operation: the project\'s own largest',
      '  command or test, bounded the same way.',
    );
  }

  if (unbounded) {
    lines.push(
      '',
      `No \`timeout\`/\`gtimeout\` on this machine and no interpreter-side bound`,
      `available, so the commands above are bounded only by you: if one has not`,
      `finished in ~${PROBE_TIMEOUT_SECONDS} s, interrupt it and tag the measurement UNMEASURED.`,
      `Do not report a number you had to kill to get.`,
    );
  }
  lines.push('', UNMEASURED_RULE, 'Report each number next to the command that produced it.');
  return lines.slice(0, MAX_PROBE_LINES).join('\n');
}

/** The node cold-require one-liner, bounded where the host allows (no Windows path). */
function pythonProbeStyleNode(input: PerfProbeInput, entry: string): { command: string; bounded: boolean } {
  const program = `const t = Date.now(); require('./${entry}'); console.log((Date.now() - t) + ' ms cold require')`;
  if (input.timeoutCommand) {
    return { command: `${input.timeoutCommand} ${PROBE_TIMEOUT_SECONDS} node -e "${program}"`, bounded: true };
  }
  // No coreutils and no interpreter alarm for node: node's own `--eval` has no
  // watchdog flag, so the bound is the caller's. Stated, not hidden.
  return { command: `node -e "${program}"`, bounded: false };
}

/**
 * Detect what this project can be probed for.
 *
 * Deliberately shallow and cheap: two files read, one directory listing. The
 * Python module name comes from `pyproject.toml`, else from a top-level package
 * directory that has an `__init__.py` (the importable shape). The Node entry comes
 * from `package.json`'s `main`, else its first `bin`. Best-effort by contract: any
 * failure yields `runtime: 'none'`.
 */
export function detectPerfProbeInput(dir: string, facts?: MachineFacts): PerfProbeInput {
  const machine = facts ?? detectMachineFacts();
  const platform = machine.platform;
  const timeoutCommand = executableOnPath('timeout') ? 'timeout' : executableOnPath('gtimeout') ? 'gtimeout' : '';
  const pythonCommand = executableOnPath('python') ? 'python' : executableOnPath('python3') ? 'python3' : 'python';
  const nativePerfTool: PerfProbeInput['nativePerfTool'] =
    platform === 'darwin' ? 'bsd' : platform === 'linux' && existsSync('/usr/bin/time') ? 'gnu' : 'none';
  const base = { timeoutCommand, platform, pythonCommand, nativePerfTool };

  if (!dir) return { runtime: 'none', ...base };
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return { runtime: 'none', ...base };

    // ── Python ────────────────────────────────────────────────────────────────
    let pythonModule = '';
    const pyproject = join(dir, 'pyproject.toml');
    if (existsSync(pyproject)) {
      try {
        pythonModule = pythonNameFromToml(readFileSync(pyproject, 'utf8'));
      } catch {
        // Unreadable pyproject — fall through to the directory heuristic.
      }
    }
    if (!pythonModule) {
      try {
        const packages = readdirSync(dir, { withFileTypes: true })
          .filter(
            (e) =>
              e.isDirectory() &&
              !e.name.startsWith('.') &&
              !/^(tests?|docs?|build|dist|node_modules|venv|\.venv)$/i.test(e.name),
          )
          .map((e) => e.name)
          .filter((name) => existsSync(join(dir, name, '__init__.py')))
          .sort((a, b) => a.localeCompare(b));
        if (packages.length > 0) pythonModule = packages[0]!;
      } catch {
        // Unreadable directory — no python module.
      }
    }

    // ── Node ─────────────────────────────────────────────────────────────────
    let nodeEntry = '';
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          main?: string;
          bin?: string | Record<string, string>;
        };
        if (typeof pkg.main === 'string' && pkg.main.trim()) nodeEntry = pkg.main.trim();
        else if (typeof pkg.bin === 'string' && pkg.bin.trim()) nodeEntry = pkg.bin.trim();
        else if (pkg.bin && typeof pkg.bin === 'object') {
          const first = Object.keys(pkg.bin).sort((a, b) => a.localeCompare(b))[0];
          if (first) nodeEntry = String(pkg.bin[first]);
        }
      } catch {
        // Malformed package.json — not a probe candidate.
      }
    }

    // WHICH RUNTIME IS THIS PROJECT'S. A top-level directory holding an
    // `__init__.py` is NOT enough on its own: measured on this very repository,
    // a stray fixture directory (`addon/__init__.py`) made a TypeScript project
    // probe as Python, and the block would have told the model to time the import
    // of a directory that is not the shipped program. Python therefore needs a
    // PROJECT MARKER behind it — the same discipline `self-check-discovery.ts`
    // applies before it calls something a check. A Python project that also has
    // Node tooling is probed as Python: the runtime whose startup a user waits on
    // is what matters, and a desktop app's is Python.
    let hasPythonMarker = false;
    for (const marker of ['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile']) {
      if (existsSync(join(dir, marker))) hasPythonMarker = true;
    }
    if (!hasPythonMarker) {
      try {
        hasPythonMarker = readdirSync(dir).some((n) => /^requirements.*\.txt$/i.test(n));
      } catch {
        // Unreadable directory — no marker.
      }
    }

    const safeModule = safeIdentifier(pythonModule);
    const safeEntry = safeRelativePath(nodeEntry);
    if (safeModule && (hasPythonMarker || !safeEntry)) {
      return { runtime: 'python', pythonModule: safeModule, ...base };
    }
    if (safeEntry) return { runtime: 'node', nodeEntry: safeEntry, ...base };
    return { runtime: 'none', ...base };
  } catch {
    return { runtime: 'none', ...base };
  }
}
