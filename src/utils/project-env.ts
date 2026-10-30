/**
 * Project interpreter canonicalization + pre-run environment guard.
 *
 * WHY THIS EXISTS (the live Aukat_check failure):
 * One chat session built a macOS app by running `python3 -m venv venv` and
 * `pip install …` against the SYSTEM interpreter, while a project virtualenv sat
 * in the same directory. A later rebuild therefore used an interpreter that did
 * not have the project's own dependencies, produced an app that crashed with
 * `ModuleNotFoundError: No module named 'PyQt6'`, and the run still reported
 * success. The root cause was not a missing dependency — it was that NOTHING
 * pinned "which interpreter is this project's" for the run, so each command
 * guessed and the guesses disagreed.
 *
 * This module makes the guess unnecessary, deterministically and LLM-free:
 *
 *   1. DISCOVER — find the project's virtualenv (`.venv` preferred, then
 *      `venv`/`env`), walking up a bounded number of parent directories.
 *   2. PIN — remember it for the whole process (keyed by directory), so every
 *      command in the run sees the SAME interpreter.
 *   3. APPLY — prepend its `bin/` to PATH and set `VIRTUAL_ENV`, so a bare
 *      `python`/`pip`/`pyinstaller` resolves to the project env.
 *   4. GUARD — refuse the two mistakes that caused the failure: installing
 *      Python packages into an interpreter OUTSIDE the project venv, and
 *      building/running with an interpreter that LACKS the project's declared
 *      dependencies.
 *
 * All checks are best-effort: a probe failure reports, it never breaks a run.
 * `NUVIRA_ENV_GUARD=off` disables the refusals (the escape hatch a deployment
 * with a deliberate system-Python setup needs).
 */

import { spawnSync } from 'node:child_process';
import { leadingAssignments, unwrappedSegments } from './command-shape.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

/** Where the project marker files that describe Python deps live. */
const PYTHON_MANIFESTS = [
  'requirements.txt',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'Pipfile.lock',
  'poetry.lock',
];

/** Names that appear in a dependency manifest but are not distributions. */
const NON_DISTRIBUTION_NAMES = new Set([
  'python',
  'python_version',
  'python_full_version',
  'requires-python',
  'requires_python',
]);

/**
 * Candidate virtualenv directory names, in PREFERENCE order. `.venv` first
 * because it is the modern convention (and the one a tool should create), and
 * a project that has drifted into two envs should converge on one.
 */
const VENV_DIR_NAMES = ['.venv', 'venv', 'env', '.virtualenv', 'virtualenv'];

/** How many parent directories to search for a project venv. */
const MAX_PARENT_SEARCH = 3;

/** A discovered project virtualenv. */
export interface ProjectVenv {
  /** Absolute path to the venv directory. */
  dir: string;
  /** Absolute path to the interpreter inside it. */
  python: string;
  /** `bin` (POSIX) or `Scripts` (Windows). */
  binDir: string;
}

/** Is `dir` a Python virtualenv directory? */
function isVenvDir(dir: string): boolean {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
    // Python 3 venvs carry pyvenv.cfg; older/edge cases still have an activate script.
    if (existsSync(join(dir, 'pyvenv.cfg'))) return true;
    return (
      existsSync(join(dir, 'bin', 'activate')) ||
      existsSync(join(dir, 'Scripts', 'activate.bat'))
    );
  } catch {
    return false;
  }
}

/** The interpreter path inside a venv dir, or null when none is present. */
function interpreterIn(dir: string, binDir: string): string | null {
  const candidates =
    binDir === 'Scripts'
      ? [join(dir, 'Scripts', 'python.exe')]
      : [join(dir, 'bin', 'python'), join(dir, 'bin', 'python3')];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Find the project's virtualenv, starting at `startDir` and walking up a
 * bounded number of parents (nearest wins, so a monorepo package's own env
 * beats the repo root's).
 */
export function findProjectVenv(startDir: string): ProjectVenv | null {
  let dir: string;
  try {
    dir = resolve(startDir);
  } catch {
    return null;
  }
  for (let depth = 0; depth <= MAX_PARENT_SEARCH; depth++) {
    for (const name of VENV_DIR_NAMES) {
      const candidate = join(dir, name);
      if (!isVenvDir(candidate)) continue;
      const binDir = existsSync(join(candidate, 'Scripts')) ? 'Scripts' : 'bin';
      const python = interpreterIn(candidate, binDir);
      if (python) return { dir: candidate, python, binDir: join(candidate, binDir) };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The pinned interpreter per directory, for the lifetime of the process.
 *
 * "Pin it for the whole run" is the whole point: without this, two commands in
 * the same turn can resolve different interpreters (which is exactly how one
 * session created `venv` and then built with `.venv`). Keyed by the directory
 * the command runs in, so different projects in one process stay separate.
 */
const PINNED = new Map<string, ProjectVenv | null>();

/** The project venv for `dir`, discovered once and reused for the run. */
export function getPinnedProjectVenv(dir: string): ProjectVenv | null {
  let key: string;
  try {
    key = resolve(dir);
  } catch {
    return null;
  }
  if (PINNED.has(key)) return PINNED.get(key) ?? null;
  const found = findProjectVenv(key);
  PINNED.set(key, found);
  return found;
}

/** Forget pinned interpreters (tests; also after creating a venv mid-run). */
export function clearPinnedProjectVenv(): void {
  PINNED.clear();
}

/** Name of the venv the sandbox creates when a project has none. */
export const SANDBOX_VENV_NAME = '.venv';

/** Injection point so tests can exercise provisioning without spawning Python. */
export type VenvProvisioner = (dir: string) => ProjectVenv | null;

/**
 * Provision a project-scoped virtualenv (`C3` install sandbox).
 *
 * The live failure's 4th finding: a project-scoped fix mutated the machine's
 * GLOBAL Python. Refusing such installs protects the machine but blocks the
 * work; the better answer is to give the install a sandbox to land in. When no
 * project venv exists, create `.venv` from the interpreter on PATH, PIN it for
 * the run, and hand it back — so the following `pip install` populates the
 * project env and the global interpreter is never touched.
 *
 * Returns null when the venv cannot be created (no base interpreter, or venv
 * creation failed) — the caller then refuses rather than falling back to a
 * global install.
 */
export function ensureProjectVenv(dir: string): ProjectVenv | null {
  const existing = getPinnedProjectVenv(dir);
  if (existing) return existing;

  const base = interpreterOnPath();
  if (!base) return null;

  let key: string;
  try {
    key = resolve(dir);
  } catch {
    return null;
  }
  const venvDir = join(key, SANDBOX_VENV_NAME);
  try {
    const res = spawnSync(base, ['-m', 'venv', venvDir], {
      encoding: 'utf-8',
      timeout: 120_000,
      windowsHide: true,
    });
    if (res.error || res.status !== 0) return null;
  } catch {
    return null;
  }

  const venv = findProjectVenv(key);
  if (!venv || !venv.python) return null;
  PINNED.set(key, venv);
  return venv;
}

/**
 * Apply the pinned interpreter to a command's environment: prepend its `bin/`
 * to PATH and set `VIRTUAL_ENV`, so a bare `python`/`pip`/`pyinstaller`
 * resolves to the project env instead of whatever the shell would have found.
 * A no-op when there is no venv (the environment is returned unchanged).
 */
export function applyProjectEnvironment(
  env: Record<string, string | undefined>,
  venv: ProjectVenv | null,
): Record<string, string | undefined> {
  if (!venv) return env;
  const current = env.PATH ?? '';
  // A venv already on PATH is left alone; otherwise it goes first so it wins.
  const parts = current.split(delimiter).filter(Boolean);
  if (!parts.includes(venv.binDir)) parts.unshift(venv.binDir);
  return {
    ...env,
    PATH: parts.join(delimiter),
    VIRTUAL_ENV: venv.dir,
    // A VIRTUAL_ENV without a matching interpreter can confuse sub-tools.
    PYTHONHOME: undefined,
  };
}

/**
 * Parse the distribution names a project declares in `requirements.txt`.
 *
 * Deliberately narrow and text-based (no TOML/pip dependency): it keeps only
 * the name before any version specifier or environment marker, skips flags
 * (`-r`, `-e`, `--index-url`), comments and blank lines, and follows a `-r`
 * include one level deep. A name it cannot read is skipped rather than
 * guessed — the guard must never invent a requirement the project did not ask
 * for.
 */
function requirementNamesFromRequirementsTxt(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    // `pkg[extra]==1.2 ; python_version>'3.8'` -> `pkg`
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * Distribution names declared as KEYS of one or more TOML tables, selected by
 * a section predicate. Handles the `[tool.poetry.dependencies]` shape
 * (`requests = "^2.31"` / `requests = { version = "…" }`) and poetry's newer
 * `[tool.poetry.group.<name>.dependencies]` tables. A key that names the
 * interpreter (`python`) or an environment selector is skipped — it is not a
 * distribution the guard should demand.
 *
 * Text-based on purpose: the guard must not pull a TOML parser into the hot
 * path, and an unreadable line is skipped rather than guessed.
 */
function requirementNamesFromTomlSections(
  text: string,
  isDependencySection: (section: string) => boolean,
): string[] {
  const names: string[] = [];
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = line.match(/^\[([^\]]+)\]/);
    if (section) {
      inSection = isDependencySection(section[1].trim());
      continue;
    }
    if (!inSection || !line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
    if (match && !NON_DISTRIBUTION_NAMES.has(match[1].toLowerCase())) names.push(match[1]);
  }
  return names;
}

/** Is this a poetry dependency table? (`tool.poetry.dependencies`, dev, groups) */
function isPoetryDependencySection(section: string): boolean {
  return (
    section === 'tool.poetry.dependencies' ||
    section === 'tool.poetry.dev-dependencies' ||
    /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section)
  );
}

/** Is this a pipenv table? (`packages`, `dev-packages`) */
function isPipfileDependencySection(section: string): boolean {
  return section === 'packages' || section === 'dev-packages';
}

/**
 * Distribution names from a `Pipfile` (`[packages]` + `[dev-packages]`).
 */
function requirementNamesFromPipfile(text: string): string[] {
  const names: string[] = [];
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = line.match(/^\[([^\]]+)\]/);
    if (section) {
      inSection = isPipfileDependencySection(section[1].trim());
      continue;
    }
    if (!inSection || !line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
    if (match && !NON_DISTRIBUTION_NAMES.has(match[1].toLowerCase())) names.push(match[1]);
  }
  return names;
}

/**
 * Distribution names from a `Pipfile.lock` (JSON): the `default` and
 * `develop` maps. Used only as a fallback when no `Pipfile` is present.
 */
function requirementNamesFromPipfileLock(text: string): string[] {
  const names: string[] = [];
  try {
    const parsed = JSON.parse(text) as { default?: Record<string, unknown>; develop?: Record<string, unknown> };
    for (const key of ['default', 'develop'] as const) {
      const group = parsed[key];
      if (group && typeof group === 'object') names.push(...Object.keys(group));
    }
  } catch {
    /* best-effort */
  }
  return names;
}

/**
 * The distribution names a project declares, from `requirements.txt`, a
 * best-effort scan of `pyproject.toml` (PEP 621 `dependencies = [ … ]` AND
 * poetry's `[tool.poetry.dependencies]` tables), and a `Pipfile`/`Pipfile.lock`
 * (pipenv). Returns [] when there is nothing to check — the guard then does
 * nothing.
 */
export function projectRequirementNames(projectDir: string): string[] {
  const names = new Set<string>();
  const reqPath = join(projectDir, 'requirements.txt');
  try {
    if (existsSync(reqPath)) {
      for (const n of requirementNamesFromRequirementsTxt(readFileSync(reqPath, 'utf-8'))) {
        names.add(n);
      }
    }
  } catch {
    /* best-effort */
  }
  const pyproject = join(projectDir, 'pyproject.toml');
  try {
    if (existsSync(pyproject)) {
      const text = readFileSync(pyproject, 'utf-8');
      // PEP 621 / poetry 2.x: `dependencies = [ "a", "b" ]`
      const block = text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (block) {
        for (const n of requirementNamesFromRequirementsTxt(block[1].replace(/["',]/g, '\n'))) {
          names.add(n);
        }
      }
      // poetry 1.x: `[tool.poetry.dependencies]` / groups / dev-dependencies
      for (const n of requirementNamesFromTomlSections(text, isPoetryDependencySection)) {
        names.add(n);
      }
    }
  } catch {
    /* best-effort */
  }
  const pipfile = join(projectDir, 'Pipfile');
  try {
    if (existsSync(pipfile)) {
      for (const n of requirementNamesFromPipfile(readFileSync(pipfile, 'utf-8'))) names.add(n);
    } else {
      const lock = join(projectDir, 'Pipfile.lock');
      if (existsSync(lock)) {
        for (const n of requirementNamesFromPipfileLock(readFileSync(lock, 'utf-8'))) names.add(n);
      }
    }
  } catch {
    /* best-effort */
  }
  return [...names];
}

/** Does this directory look like it declares Python dependencies? */
export function hasPythonManifest(dir: string): boolean {
  return PYTHON_MANIFESTS.some((m) => existsSync(join(dir, m)));
}

// ─── Command classification ────────────────────────────────────────────────

/**
 * Split a shell line into the separately-run pieces, with each piece's
 * decorations peeled off.
 *
 * `NUVIRA_ENV_GUARD=off python3 -m unittest tests.x` is the command
 * `python3 -m unittest tests.x`. Reading the raw text missed it entirely, so
 * the guard did not apply the project venv AND the confirmation classifier did
 * not recognize a test run: one measured bench turn lost three steps to that
 * single misparse. See src/utils/command-shape.ts.
 */
function commandSegments(command: string): string[] {
  return unwrappedSegments(command).map((s) => s.toLowerCase());
}

const PYTHON_TOOLCHAIN_RE =
  /^(?:(?:sudo|env|command|time)\s+)*(?:[\w./-]*\/)?(python3?(?:\.\d+)?|pip3?|uv|pyinstaller|pytest|py\.test|uvicorn|gunicorn|flask|django-admin|poetry|pipenv|tox)\b/;

/**
 * Does any segment of this command invoke the Python toolchain? (A bare
 * `python`/`pip`/`pyinstaller`/`pytest`, or `python -m …`.)
 */
export function isPythonToolchainCommand(command: string): boolean {
  return commandSegments(command).some((s) => PYTHON_TOOLCHAIN_RE.test(s));
}

const PIP_INSTALL_RE =
  /^(?:(?:sudo|env|command|time)\s+)*(?:[\w./-]*\/)?(?:pip3?\s+install|python3?(?:\.\d+)?\s+-m\s+pip\s+install|uv\s+(?:pip\s+)?install|uv\s+add|poetry\s+(?:add|install)|pipenv\s+install)\b/;

/** Does any segment of this command install Python packages? */
export function isPythonInstallCommand(command: string): boolean {
  return commandSegments(command).some((s) => PIP_INSTALL_RE.test(s));
}

/**
 * Does the command name an absolute interpreter OUTSIDE the pinned venv
 * (e.g. `/usr/local/bin/python3 -m pip install …`)? A bare `python3` does NOT
 * count: with the venv on PATH it resolves to the project env, which is the
 * outcome we want.
 */
export function targetsForeignInterpreter(command: string, venv: ProjectVenv | null): boolean {
  // `--user` installs into the user site, never the project env — foreign
  // whether or not an absolute interpreter is also named.
  if (/(?:^|\s)--user\b/.test(command)) return true;
  const abs = command.match(/(?:^|\s)(\/[\w./-]*\/?(?:python3?(?:\.\d+)?|pip3?))\b/g) ?? [];
  if (abs.length === 0) return false;
  if (!venv) return true; // an absolute interpreter with no pinned venv is foreign by definition
  return abs.some((token) => {
    const path = token.trim();
    return !path.startsWith(venv.binDir) && !path.startsWith(venv.dir);
  });
}

// ─── The environment guard ─────────────────────────────────────────────────

/** Probe signature — injectable so tests need no real interpreter. */
export type EnvironmentProbe = (python: string, names: string[]) => string[];

/** Install packages the project declares, inside the given interpreter. */
const PROBE_SCRIPT = [
  'import sys, json, importlib.metadata as md',
  'reqs = json.loads(sys.argv[1])',
  'missing = []',
  'for r in reqs:',
  '    ok = False',
  "    for c in (r, r.replace('_','-'), r.replace('.','-')):",
  '        try:',
  '            md.version(c); ok = True; break',
  '        except Exception:',
  '            pass',
  '    if not ok:',
  '        missing.append(r)',
  'print(json.dumps(missing))',
].join('\n');

/**
 * Which declared distributions are NOT installed in `python`?
 * A probe that fails to run returns [] — an unavailable interpreter is not
 * evidence that a dependency is missing, and the guard must never refuse on a
 * guess.
 */
export const defaultEnvironmentProbe: EnvironmentProbe = (python, names) => {
  if (names.length === 0) return [];
  try {
    const res = spawnSync(python, ['-c', PROBE_SCRIPT, JSON.stringify(names)], {
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true,
    });
    if (res.error || res.status !== 0) return [];
    const parsed = JSON.parse((res.stdout ?? '').trim() || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/** Memoize probes for the run, keyed by interpreter + the requirement set. */
const PROBE_CACHE = new Map<string, string[]>();

/** The interpreter a bare `python`/`python3` would resolve to on PATH. */
function interpreterOnPath(): string | null {
  try {
    const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['python3'], {
      encoding: 'utf-8',
      timeout: 4000,
      windowsHide: true,
    });
    if (res.status !== 0) return null;
    const first = (res.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first ?? null;
  } catch {
    return null;
  }
}

/** What the guard decided for a command. */
export type EnvironmentVerdict =
  | { action: 'not-applicable' }
  | { action: 'proceed'; venv: ProjectVenv | null; note?: string }
  | { action: 'refuse'; reason: string; hint: string };

/** Does this value switch a guard off? */
function switchesGuardOff(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'false' || value === 'no';
}

/** Is the guard disabled by the deployment? */
export function envGuardDisabled(): boolean {
  return switchesGuardOff(process.env.NUVIRA_ENV_GUARD ?? process.env.BUFF_ENV_GUARD);
}

/**
 * Decide whether a command may run against the project's environment.
 *
 * Two refusals, both drawn from the live failure:
 *   1. a Python PACKAGE INSTALL that would land outside the project venv (or
 *      with no venv at all while the project declares dependencies);
 *   2. a BUILD/RUN with an interpreter that is missing the project's declared
 *      dependencies — the `PyQt6` case, caught before the build instead of
 *      after a successful-looking bundle.
 * Everything else proceeds, with the pinned venv applied to the environment.
 */
export function guardCommandEnvironment(
  command: string,
  cwd: string,
  options: { probe?: EnvironmentProbe; provision?: VenvProvisioner } = {},
): EnvironmentVerdict {
  if (envGuardDisabled()) return { action: 'not-applicable' };
  // The bypass is documented as `NUVIRA_ENV_GUARD=off …` before the command —
  // so it must work in that form. It could not: the variable was set for the
  // CHILD process only, this process never saw it, and the refusal message told
  // the model to do the very thing that kept being refused. Honour the
  // assignment the command itself carries.
  const inline = leadingAssignments(command);
  if (switchesGuardOff(inline.NUVIRA_ENV_GUARD ?? inline.BUFF_ENV_GUARD)) {
    return { action: 'not-applicable' };
  }
  if (!isPythonToolchainCommand(command)) return { action: 'not-applicable' };

  let venv = getPinnedProjectVenv(cwd);
  const names = projectRequirementNames(cwd);

  if (isPythonInstallCommand(command)) {
    if (targetsForeignInterpreter(command, venv)) {
      return {
        action: 'refuse',
        reason: 'this install names an interpreter outside the project virtualenv',
        hint: venv
          ? `Install into the project env instead: \`${venv.python} -m pip install …\` (or rely on the pinned PATH, which already points at ${venv.binDir}).`
          : 'Create and use a project virtualenv first: `python3 -m venv .venv` then `.venv/bin/python -m pip install …` — never install project dependencies into the system interpreter.',
      };
    }
    // ── C3: install sandbox ───────────────────────────────────────────────
    // With no project venv, a `pip install` would mutate the interpreter on
    // PATH — the machine's GLOBAL Python. Rather than merely refuse (which
    // blocks the fix), provision a project-scoped `.venv`, PIN it, and run the
    // install there. Only a provision failure falls back to refusal, so the
    // global interpreter is never the target.
    if (!venv) {
      const provision = options.provision ?? ensureProjectVenv;
      venv = provision(cwd);
      if (!venv) {
        return {
          action: 'refuse',
          reason: names.length > 0
            ? 'this project declares Python dependencies but has no virtualenv, and one could not be created, so the install would mutate the system interpreter'
            : 'this install has no project virtualenv to land in, and one could not be created, so it would mutate the system interpreter',
          hint: 'Create and use one yourself: `python3 -m venv .venv && .venv/bin/python -m pip install …` (this pins `.venv` for the rest of the run).',
        };
      }
      return {
        action: 'proceed',
        venv,
        note: `created a project venv ${venv.dir} and sandboxed the install there (the system interpreter is untouched)`,
      };
    }
    return { action: 'proceed', venv, note: `installing into the project venv ${venv.dir}` };
  }

  // Build/run: the interpreter must actually have the project's dependencies.
  //
  // A missing dependency is a FACT about this machine, not a property of the
  // command, so the guard reports it and lets the command run. It used to
  // refuse, which was measured to be the single most expensive decision in the
  // harness: on a Windows-only wxPython app inspected on macOS (where those
  // wheels cannot be installed at all) EVERY interpreter call was refused, so a
  // review could not execute one module; and on a stdlib-only task the guard
  // refused the test suite six times, which is why that bench turn spent 28
  // model steps where Cline spent 17.
  //
  // Nothing is silently lost by proceeding, because the case the refusal existed
  // for is caught by OBSERVATION instead of by prediction: a build that bundles
  // around a missing import exits 0, and `effect-verification` then LAUNCHES the
  // artifact and reports the crash with its stderr (the live Aukat_check
  // failure). A test or a run that needs the missing wheel fails in the open.
  // The note names the gap and who is missing it, so the turn can still say
  // "this was not verified" honestly.
  const interpreter = venv?.python ?? interpreterOnPath();
  if (interpreter && names.length > 0) {
    const probe = options.probe ?? defaultEnvironmentProbe;
    const cacheKey = `${interpreter}\u0000${names.join(',')}`;
    let missing = PROBE_CACHE.get(cacheKey);
    if (missing === undefined) {
      missing = probe(interpreter, names);
      PROBE_CACHE.set(cacheKey, missing);
    }
    if (missing.length > 0) {
      const label = venv ? 'the project venv' : 'the interpreter on PATH';
      return {
        action: 'proceed',
        venv,
        note:
          `${label} (${interpreter}) is missing ${missing.length} declared dependency(ies): ` +
          `${missing.join(', ')} — commands that import them will fail loudly; everything ` +
          'that does not need them still runs. A bundling command is the exception: it can ' +
          'exit 0 around a missing import, so its artifact is launched before the build is ' +
          'called a success. Install with ' +
          `\`${interpreter} -m pip install -r requirements.txt\` where the wheel exists for this platform.`,
      };
    }
  }
  return { action: 'proceed', venv, note: venv ? `using the project venv ${venv.dir}` : undefined };
}

/** Forget memoized probes (tests; also after an install changes the env). */
export function clearEnvironmentProbeCache(): void {
  INTERPRETER_SHEET.clear();
  PROBE_CACHE.clear();
}

/** Memoize the interpreter sheet per directory: it costs subprocesses, and the
 * answer cannot change inside one run. */
const INTERPRETER_SHEET = new Map<string, string>();

/** The importable package a project's tests exercise, or null. */
function projectPackageName(dir: string): string | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !SKIP_PACKAGE_DIRS.has(name) && !name.startsWith('.'))
      .sort();
    for (const name of entries) {
      if (existsSync(join(dir, name, '__init__.py'))) return name;
    }
    return null;
  } catch {
    return null;
  }
}

/** Directories that are never the project's own package. */
const SKIP_PACKAGE_DIRS = new Set([
  'node_modules', 'tests', 'test', 'build', 'dist', 'docs', 'doc', 'scripts',
  'venv', 'env', '.venv', '.tox', 'site-packages', 'packaging', 'examples',
]);

/**
 * Measured facts about a project's Python runtime, for the ambient context.
 *
 * WHY THIS IS NOT A ONE-LINE GUESS ANY MORE. It used to answer from configuration
 * alone — "no project venv found (create `.venv`)" — which sent an agent on a
 * measured wild goose chase: it created a `.venv` inside the user's repository,
 * wrote a shell script to run the tests, computed a suite delta by hand across four
 * code-execution probes, and asked the user a question no one could answer. Eleven
 * of that turn's twenty-eight model steps were spent re-deriving its environment.
 *
 * So this RUNS the candidates instead of describing them, and reports what actually
 * happened: which interpreter can import the project's own package (and the first
 * line of the failure when none can), the exact command that runs the project's
 * tests, and what the environment guard will do with that command. Three cheap
 * subprocesses, memoized per directory, inside a hard timeout — and still a list of
 * FACTS, not an instruction: the model decides what to do with them.
 */
export function describeProjectInterpreter(dir: string): string {
  try {
    if (!hasPythonManifest(dir) && !projectPackageName(dir)) return '';
    const cached = INTERPRETER_SHEET.get(dir);
    if (cached !== undefined) return cached;

    const venv = getPinnedProjectVenv(dir);
    const pkg = projectPackageName(dir);
    const candidates: string[] = [];
    if (venv) candidates.push(venv.python);
    const onPath = interpreterOnPath();
    for (const candidate of [onPath, 'python3', 'python']) {
      if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
    }

    const lines: string[] = [];
    let usable: string | null = venv ? venv.python : null;
    if (pkg) {
      let firstFailure: { python: string; detail: string } | null = null;
      for (const python of candidates) {
        const result = probePackageImport(python, pkg, dir);
        if (result.ok) {
          usable = python;
          break;
        }
        if (!firstFailure) firstFailure = { python, detail: result.detail };
      }
      if (usable) {
        lines.push(`python: \`${usable}\` imports \`${pkg}\`${venv ? ' (the pinned project env)' : ''}`);
      } else if (firstFailure) {
        lines.push(
          `python: no interpreter tried can import \`${pkg}\` — \`${firstFailure.python}\`: ${firstFailure.detail}`,
        );
      }
    } else if (venv) {
      lines.push(`python: \`${venv.python}\` (the pinned project env)`);
    }

    // The exact test command, from what the tree actually contains — not a guess.
    const hasTests = existsSync(join(dir, 'tests'));
    const pytestProject = ['pytest.ini', 'conftest.py', 'tox.ini'].some((f) => existsSync(join(dir, f)));
    if (hasTests) {
      const python = usable ?? candidates[0] ?? 'python3';
      const command = pytestProject
        ? `${python} -m pytest -q`
        : `${python} -m unittest discover -s tests -p 'test_*.py'`;
      lines.push(`tests: \`${command}\``);
      // What the guard will do with it — the guard's OWN verdict, quoted, so the
      // model does not have to discover a refusal by trying and failing.
      try {
        const verdict = guardCommandEnvironment(command, dir);
        if (verdict.action === 'refuse') {
          lines.push(`env guard: refuses \`${command}\` — ${verdict.reason}. ${verdict.hint}`);
        }
      } catch {
        // A guard that cannot decide adds nothing; omit the line.
      }
    }

    const sheet = lines.join('\n');
    INTERPRETER_SHEET.set(dir, sheet);
    return sheet;
  } catch {
    return '';
  }
}

/** Does `python` import the project package? One subprocess, capped. */
function probePackageImport(
  python: string,
  pkg: string,
  dir: string,
): { ok: boolean; detail: string } {
  try {
    const res = spawnSync(python, ['-c', `import ${pkg}`], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5_000,
      windowsHide: true,
    });
    if (res.error) return { ok: false, detail: (res.error as Error).message.slice(0, 120) };
    if (res.status === 0) return { ok: true, detail: 'ok' };
    const text = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
    const line = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && /Error|error:|No module/.test(l))
      .pop();
    return { ok: false, detail: (line ?? `exit ${res.status}`).slice(0, 160) };
  } catch (err) {
    return { ok: false, detail: (err as Error).message.slice(0, 120) };
  }
}
