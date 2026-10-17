/**
 * SELF-CHECK DISCOVERY — name the project's OWN checks on an assessment turn.
 *
 * WHY THIS EXISTS (the side-by-side audit, 2026-10-16). On an audit of a Python
 * desktop app (`/Users/dheeraj/Documents/anuj_voice`, 60 modules) this CLI read
 * the right modules, measured two real bugs, and still missed three findings
 * that the other agent found — because it never RAN the repository's own
 * tooling. The tree contained `tools/dead_code_audit.py` (an unreachable-code
 * auditor, clean) and `tools/winget_validate.py` (a packaging-compliance
 * checker, which is what reported the shipped manifest defect its test suite
 * had been failing on). This CLI's plan mentioned `tools/` in its notes and
 * never executed either one.
 *
 * That is a pure capability gap, and it is the cheapest kind to close: the
 * project has already declared its own checks in files the agent can read, and
 * running a check the repository itself ships produces evidence whose
 * PROVENANCE the agent cannot fabricate. A finding that says "the project's own
 * auditor reports X" costs one tool call and cannot be a hallucination.
 *
 * WHY THIS ONLY NAMES COMMANDS AND NEVER RUNS THEM. A repository's declared
 * scripts are arbitrary code. Executing them because a prompt block suggested
 * it would hand a cloned repository's `package.json` the ability to run
 * anything of its choosing at audit time, with no gate and no consent — the
 * exact class of surprise the write/shell gates exist to prevent. Naming the
 * command keeps the decision where it belongs: the model proposes the run
 * through the normal terminal tool, which keeps its own confirmation and
 * sandbox rules. This module is READ-ONLY over the filesystem, by design.
 *
 * WHY IT IS BOUNDED, AND WHY THE CAP IS RANKED RATHER THAN ALPHABETICAL. The
 * output is prompt text that competes with the actual file tree for the context
 * budget, so it is capped (MAX_CHECKS) and the walk is depth-1 over known
 * directories rather than a recursive scan. But a purely alphabetical cap is
 * WRONG, and the audited project proves it: its `tools/` directory holds ~30
 * scripts whose names start `a11y_`, so an alphabetical list of ten filled up
 * before it ever reached `tools/winget_validate.py` — the checker whose output
 * WAS the release defect the assessment missed. Ordering is therefore by
 * RELEVANCE first (a name that says check/audit/validate/verify/lint/test…, and
 * the project's own test suite) and alphabetical only as the tie-break inside
 * each tier. Deterministic still, and stable across turns; just not arbitrary.
 *
 * WHY THE SUITE OUTRANKS LOOSE SCRIPTS. `pytest` / `npm test` is the check the
 * project itself runs before shipping, and a directory of helper scripts is not.
 * A cap that lets thirty utility scripts displace the test suite would give the
 * agent the weakest evidence first.
 *
 * WHY IT IS DETERMINISTICALLY ORDERED. Same reason the tree walk is: a block
 * whose contents reorder between turns breaks the prompt cache, and the whole
 * point of an ambient block is that it is stable across the turns of one task.
 *
 * DETERMINISTIC AND LLM-FREE, like everything else in `learning/`: it decides
 * from the filesystem, not from a model's idea of what a project "usually"
 * has. A project with no discoverable checks yields an EMPTY string, so its
 * turn is byte-identical to one from a build without this module.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/** One command the project itself declares, and where it was declared. */
export interface SelfCheck {
  /** The command to run, exactly as the project declares or ships it. */
  command: string;
  /** Where it came from (`package.json scripts`, `tools/`, CI…). */
  source: string;
}

/**
 * Everything the discovery needs, so the matching rules can be unit-tested
 * with no filesystem at all. {@link readProjectSelfChecks} is the thin I/O
 * wrapper that fills this in from a real directory.
 */
export interface SelfCheckInput {
  /** `package.json` `scripts`, as declared. */
  packageScripts?: Record<string, string>;
  /** The package manager the repo uses — decides `npm run` vs `pnpm run` … */
  packageManager?: string;
  /** Repo-relative paths of the project's own tooling files (`tools/audit.py`). */
  toolFiles?: string[];
  /** Repo-relative paths of CI workflow files. */
  ciWorkflows?: string[];
  /** Repo-relative paths of top-level runner files (`Makefile`, `justfile`). */
  markerFiles?: string[];
  /** Makefile target names, already parsed (see {@link parseMakeTargets}). */
  makeTargets?: string[];
  /** Does a `tests/` tree with `test_*.py` files exist? */
  hasPythonTests?: boolean;
}

/**
 * Script names worth running on an assessment. Deliberately anchored on the
 * whole name (or a `prefix:name` / `name:suffix` part) rather than a substring,
 * so `contest` and `latest` do not match `test` — a false positive here sends
 * the agent to run the wrong thing and report its output as a check.
 */
const CHECK_SCRIPT_RE =
  /^(?:test|tests|lint|lint:|check|checks|typecheck|type-check|types|verify|validate|audit|smoke|ci|build|compile|test:|lint:|check:|verify:)/i;

/**
 * Does this tool file's NAME say it is a checker? Anchored on a separator
 * (`_`/`-`/`.`) at the START of a word so `audit` matches `dead_code_audit` and
 * `a11y_audit`, and applies to the basename without its extension.
 *
 * This is the ranking signal for `tools/`, and the reason is concrete rather
 * than aesthetic: the audited project's `tools/` had 30+ scripts, its checkers
 * were `dead_code_audit.py` and `winget_validate.py`, and the ones it did NOT
 * need on an assessment (`a11y_sample.py`, `build_book_pdf.py`) sorted ahead of
 * both. A name that declares itself a check is the only relevance signal
 * available without reading the files, which this module deliberately does not
 * do (see the header: it names commands, it never executes or parses them).
 */
const TOOL_CHECK_NAME_RE = /(?:^|[_\-.])(?:check|checks|audit|validate|verify|lint|test|tests|scan|doctor|health|smoke)(?:$|[_\-.])/i;

/** Tooling directories worth scanning (depth 1 only — see the header). */
const TOOL_DIRS = ['tools', 'scripts', 'bin', 'dev', 'hack'];

/** Script extensions that map to a runnable interpreter, and how to run them. */
const RUNNER_FOR_EXT: Record<string, string> = {
  '.py': 'python',
  '.sh': 'bash',
  '.bash': 'bash',
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
  '.ts': 'npx tsx',
};

/** Hard cap on the rendered list — the block shares the context budget. */
export const MAX_CHECKS = 10;

/** How many candidates are considered per source before capping. */
const MAX_PER_SOURCE = 12;

/** Top-level runner files, and the command each implies when present. */
const MARKER_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['justfile', 'just --list'],
  ['Justfile', 'just --list'],
  ['tox.ini', 'tox'],
  ['noxfile.py', 'nox -l'],
  ['Taskfile.yml', 'task --list'],
];

/** Package manager → the script-runner command, defaulting to npm. */
function scriptRunner(packageManager: string | undefined): string {
  const pm = (packageManager || '').trim().toLowerCase();
  if (pm.includes('pnpm')) return 'pnpm run';
  if (pm.includes('yarn')) return 'yarn';
  if (pm.includes('bun')) return 'bun run';
  return 'npm run';
}

/**
 * Makefile target names — the `name:` lines at the start of a line, excluding
 * the special targets (`%`, `.PHONY`) and any name carrying a `=`/`$` (a
 * variable assignment, not a target).
 */
export function parseMakeTargets(text: string): string[] {
  const found: string[] = [];
  for (const line of (text || '').split(/\r?\n/)) {
    const m = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line);
    if (!m || !m[1]) continue;
    found.push(m[1]);
  }
  return [...new Set(found)];
}

/**
 * Turn a project's declared facts into an ordered, capped list of checks.
 *
 * Order is by SOURCE (scripts, then Make targets, then the shipped tools, then
 * CI) and then alphabetically inside each source — stable across turns, and
 * "the things the project officially declares" ahead of "the loose scripts in
 * a folder", because the declared ones are the ones its own CI actually runs.
 */
export function discoverSelfChecks(input: SelfCheckInput): SelfCheck[] {
  const out: SelfCheck[] = [];
  const seen = new Set<string>();
  const add = (command: string, source: string): void => {
    const cmd = command.trim();
    if (!cmd || seen.has(cmd)) return;
    seen.add(cmd);
    out.push({ command: cmd, source });
  };

  // 1. Declared package scripts — the project's own public check surface.
  const scripts = input.packageScripts ?? {};
  const runner = scriptRunner(input.packageManager);
  const names = Object.keys(scripts)
    .filter((name) => CHECK_SCRIPT_RE.test(name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_PER_SOURCE);
  for (const name of names) add(`${runner} ${name}`, 'package.json scripts');

  // 2. Make / task-runner targets that look like checks.
  const makeTargets = (input.makeTargets ?? [])
    .filter((t) => CHECK_SCRIPT_RE.test(t))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_PER_SOURCE);
  for (const target of makeTargets) add(`make ${target}`, 'Makefile targets');

  // 3. The suite the project itself runs. Ahead of the loose scripts on purpose:
  //    a test suite is the strongest evidence here, and a directory of helpers
  //    must never be able to push it past the cap.
  if (input.hasPythonTests) add('python -m pytest', 'tests/');

  // 4. The repository's OWN tooling — the case this module was written for.
  //    Check-shaped names first (see TOOL_CHECK_NAME_RE), then the rest, so the
  //    cap falls on the least relevant scripts rather than on the auditors.
  const toolFiles = (input.toolFiles ?? [])
    .slice()
    .sort((a, b) => {
      // Checks first: a non-check `b` against a check `a` must sort a BEFORE b.
      const rank = Number(TOOL_CHECK_NAME_RE.test(basename(b))) - Number(TOOL_CHECK_NAME_RE.test(basename(a)));
      return rank !== 0 ? rank : a.localeCompare(b);
    });
  for (const file of toolFiles.slice(0, MAX_PER_SOURCE)) {
    const ext = file.slice(file.lastIndexOf('.'));
    const interpreter = RUNNER_FOR_EXT[ext];
    if (!interpreter) continue;
    add(`${interpreter} ${file}`, 'the project\'s own tooling');
  }

  // 5. Marker-file runners (each is a listing command: how to ASK the project
  //    what it can do), then CI, named rather than run — a workflow file is not
  //    a command, so `cat` is the honest verb.
  for (const [file, command] of MARKER_COMMANDS) {
    if ((input.markerFiles ?? []).includes(file)) add(command, file);
  }
  const workflows = (input.ciWorkflows ?? []).slice().sort((a, b) => a.localeCompare(b));
  for (const wf of workflows.slice(0, 2)) add(`cat ${wf}`, 'CI workflow (read what CI runs)');

  return out.slice(0, MAX_CHECKS);
}

/**
 * Read a directory and discover its checks. Best-effort by contract: any
 * failure (unreadable directory, malformed `package.json`, a race with a
 * concurrent write) yields an empty list, never a throw — an ambient context
 * must not be able to break a turn.
 */
export function readProjectSelfChecks(dir: string): SelfCheck[] {
  if (!dir) return [];
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];

    const input: SelfCheckInput = {};

    // ── package.json ──────────────────────────────────────────────────────
    try {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          scripts?: Record<string, string>;
          packageManager?: string;
        };
        if (pkg.scripts && typeof pkg.scripts === 'object') input.packageScripts = pkg.scripts;
        if (typeof pkg.packageManager === 'string') input.packageManager = pkg.packageManager;
      }
    } catch {
      // Malformed package.json is not our problem to report — carry on.
    }
    // A lockfile names the manager when `packageManager` is absent.
    if (!input.packageManager) {
      for (const [lock, pm] of [
        ['pnpm-lock.yaml', 'pnpm'],
        ['yarn.lock', 'yarn'],
        ['bun.lockb', 'bun'],
        ['package-lock.json', 'npm'],
      ] as const) {
        if (existsSync(join(dir, lock))) {
          input.packageManager = pm;
          break;
        }
      }
    }

    // ── Makefile targets ──────────────────────────────────────────────────
    for (const makeFile of ['Makefile', 'makefile', 'GNUmakefile']) {
      const p = join(dir, makeFile);
      if (existsSync(p)) {
        try {
          input.makeTargets = parseMakeTargets(readFileSync(p, 'utf8'));
        } catch {
          // Unreadable Makefile — skip its targets.
        }
        break;
      }
    }

    // ── The project's own tooling (depth 1) ───────────────────────────────
    const toolFiles: string[] = [];
    for (const toolDir of TOOL_DIRS) {
      const abs = join(dir, toolDir);
      try {
        if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
        const entries = readdirSync(abs, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => `${toolDir}/${e.name}`)
          .sort((a, b) => a.localeCompare(b));
        toolFiles.push(...entries);
      } catch {
        // Unreadable tooling dir — skip it.
      }
    }
    if (toolFiles.length > 0) input.toolFiles = toolFiles;

    // ── CI workflows ──────────────────────────────────────────────────────
    const ciWorkflows: string[] = [];
    try {
      const wfDir = join(dir, '.github', 'workflows');
      if (existsSync(wfDir) && statSync(wfDir).isDirectory()) {
        for (const name of readdirSync(wfDir).sort((a, b) => a.localeCompare(b))) {
          if (/\.ya?ml$/i.test(name)) ciWorkflows.push(`.github/workflows/${name}`);
        }
      }
    } catch {
      // Unreadable workflows dir — skip.
    }
    if (ciWorkflows.length > 0) input.ciWorkflows = ciWorkflows;

    // ── Marker files ──────────────────────────────────────────────────────
    const markerFiles: string[] = [];
    for (const [file] of MARKER_COMMANDS) {
      if (existsSync(join(dir, file))) markerFiles.push(file);
    }
    if (markerFiles.length > 0) input.markerFiles = markerFiles;

    // ── A Python suite (depth 1 of tests/) ────────────────────────────────
    try {
      const testsDir = join(dir, 'tests');
      if (existsSync(testsDir) && statSync(testsDir).isDirectory()) {
        input.hasPythonTests = readdirSync(testsDir).some((n) => /^test_.*\.py$/.test(n));
      }
    } catch {
      // Unreadable tests dir — no pytest suggestion.
    }

    return discoverSelfChecks(input);
  } catch {
    return [];
  }
}

/**
 * Render the checks as the prompt section the assessment protocol appends.
 * Returns '' for an empty list, which is what keeps a project with no
 * discoverable checks byte-identical to a build without this module.
 *
 * The wording carries the two rules the audit proved were missing: run these
 * BEFORE concluding, and treat their output as the strongest evidence in the
 * report — with the provenance named, so a reader can re-run it.
 */
export function buildSelfCheckBlock(checks: SelfCheck[]): string {
  if (checks.length === 0) return '';
  const lines = [
    '## This project\'s own checks — run these, do not just read them',
    'The repository declares the checks below. Running them is the cheapest',
    'high-provenance evidence available: a finding that cites the project\'s own',
    'tooling cannot be a hallucination, and a checker that ships with the code',
    'often reports exactly the defect you are looking for.',
    '',
  ];
  for (const check of checks) lines.push(`- \`${check.command}\`  — ${check.source}`);
  lines.push(
    '',
    'Run the ones that match what you are auditing (a run is one tool call; a',
    'wrong conclusion is a whole report). If you choose NOT to run one, say so',
    'and why in the report — an unrun check is a known gap, not a silent one.',
  );
  return lines.join('\n');
}
