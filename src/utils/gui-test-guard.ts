import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { insertProgramArgs } from './command-shape.js';

/**
 * Contain a project's GUI test suite so an audit can run it without macOS
 * showing "Python quit unexpectedly" for every run.
 *
 * WHY THIS EXISTS (measured): auditing a wxPython desktop app means running its
 * own suite, and that suite segfaults at interpreter exit — `wxApp::CleanUp()` →
 * `sipwxFrame::~sipwxFrame()` destroys a frame whose children were already
 * released (`EXC_BAD_ACCESS` at 0x10, two `wx.App` objects in one process). The
 * crash is a fact about the APP and belongs in the report; what does not belong
 * in the audit is the OS crash dialog that lands on the user's screen for every
 * attempt, including the retries the model makes while diagnosing it.
 *
 * Three levers, in order of honesty:
 *  1. Real offscreen where the toolkit has one: Qt honours `QT_QPA_PLATFORM=offscreen`.
 *     wx has NO offscreen backend on macOS — nothing in the environment can stop
 *     a crashing destructor from crashing, so we do not pretend otherwise.
 *  2. `PYTHONFAULTHANDLER=1`, so the segfault leaves a Python stack and the crash
 *     becomes evidence instead of a mystery.
 *  3. The dialog itself: `com.apple.CrashReporter DialogType=none` for the
 *     lifetime of the child, restored afterwards (the preference is only read
 *     while the crash is handled, i.e. before the child exits). Opt out with
 *     `NUVIRA_SILENCE_CRASH_DIALOGS=off`; this touches a user preference for the
 *     duration of one command and puts it back, including on error.
 */
export interface GuiTestGuard {
  /** The command is a Python test run against a project that imports a GUI toolkit on macOS. */
  applies: boolean;
  /** Toolkit found, for the note and for choosing an offscreen backend. */
  toolkit: 'wx' | 'qt' | 'tk' | null;
  /** Env additions to merge over the run environment. */
  env: Record<string, string>;
  /**
   * The command to RUN. Identical to the caller's unless the runner has a way to
   * express an exclusion — see `exclusionFlagFor`.
   */
  effectiveCommand: string;
  /** The widget-building modules the run leaves out, for the disclosure. */
  excluded: string[];
  /** True when `excluded` is actually written into `effectiveCommand`. */
  exclusionApplied: boolean;
  /** One-line disclosure for the tool result ('' when `applies` is false). */
  note: string;
  /** Put the machine back exactly as it was. Safe to call more than once. */
  restore(): void;
}

const NOOP: GuiTestGuard = {
  applies: false,
  toolkit: null,
  env: {},
  effectiveCommand: '',
  excluded: [],
  exclusionApplied: false,
  note: '',
  restore() {},
};

/**
 * Any Python execution, not just a test command.
 *
 * WHY NOT TESTS ONLY (measured): the first guarded audit still showed a crash
 * dialog, because its Python ran through a heredoc and a one-liner probe — none
 * of them contain the word `pytest`. In this project wx is imported by the GUI
 * modules, so ANY interpreter run can reach the crashing teardown; the check
 * that matters is "does this project use a GUI toolkit", which is done
 * separately, and then every interpreter invocation is contained.
 */
function isPythonRun(command: string): boolean {
  return (
    /\bpython[0-9.]*\b/.test(command) ||
    /\.venv\/bin\/python/.test(command) ||
    /\b(?:pytest|py\.test)\b/.test(command) ||
    /pytest\.main\s*\(/.test(command) ||
    /\bunittest\s+discover\b/.test(command)
  );
}

/** Narrower: a TEST run, for the wording of the crash note. */
function isTestRun(command: string): boolean {
  return /\b(?:pytest|py\.test)\b|pytest\.main\s*\(|unittest\s+discover\b|\s-m\s+pytest\b/.test(command);
}

/** Cached per project root: scanning a tree on every command is pure waste. */
const toolkitCache = new Map<string, 'wx' | 'qt' | 'tk' | null>();

/**
 * Which GUI toolkit the project imports, from a bounded sample of its sources.
 * 200 files is enough to catch a `import wx` in a package and cheap enough to
 * run on the first test command of a turn; .venv/node_modules are skipped so a
 * dependency's own imports cannot answer for the project.
 */
export function detectGuiToolkit(root: string): 'wx' | 'qt' | 'tk' | null {
  const cached = toolkitCache.get(root);
  if (cached !== undefined) return cached;
  const found = scan(root);
  toolkitCache.set(root, found);
  return found;

  function scan(dir: string): 'wx' | 'qt' | 'tk' | null {
    let budget = 400;
    const walk = (current: string): 'wx' | 'qt' | 'tk' | null => {
      let entries: string[];
      try {
        entries = readdirSync(current);
      } catch {
        return null;
      }
      for (const name of entries) {
        if (budget <= 0) return null;
        if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build') continue;
        const abs = join(current, name);
        let stat;
        try {
          stat = statSync(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          // A virtualenv's site-packages is not the project's own code.
          if (name === '.venv' || name === 'venv' || name === 'site-packages' || name === '__pycache__') continue;
          const nested = walk(abs);
          if (nested) return nested;
          continue;
        }
        if (!name.endsWith('.py')) continue;
        budget -= 1;
        if (stat.size > 400_000) continue;
        let text: string;
        try {
          text = readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        if (/^\s*(?:import\s+wx\b|from\s+wx\b)/m.test(text)) return 'wx';
        if (/^\s*(?:from\s+PyQt[56]|import\s+PyQt[56]|from\s+PySide[26]|import\s+PySide[26])/m.test(text)) return 'qt';
        if (/^\s*(?:import\s+tkinter|from\s+tkinter\b)/m.test(text)) return 'tk';
      }
      return null;
    };
    return existsSync(dir) ? walk(dir) : null;
  }
}

/**
 * Test modules that construct GUI objects, which is what makes the suite crash at
 * exit on macOS. Deselecting them is the only mechanism that actually prevents
 * the crash: the toolkit has no offscreen backend, and the CrashReporter
 * `DialogType` preference is ignored on this macOS (measured — the preference
 * read back as `none` while three dialogs were shown).
 *
 * Bounded and conservative: only files that import the toolkit directly, at most
 * eight, only under directories that look like tests, and never a path with a
 * quote in it.
 */
function guiTestModules(root: string, toolkit: 'wx' | 'qt' | 'tk'): string[] {
  // CONSTRUCTION, not import: many test modules import wx for one constant and
  // never build a window, and excluding those would shrink the suite for no
  // reason. A widget that is created is what starts the teardown that crashes.
  const pattern =
    toolkit === 'wx'
      ? /\bwx\.(?:App|Frame|Dialog|Panel|StaticText|Button|Notebook|BoxSizer|ListBox|TextCtrl|Choice)\s*\(/
      : toolkit === 'qt'
        ? /\b(?:QApplication|QWidget|QMainWindow|QDialog|QPushButton)\s*\(/
        : /\b(?:Tk|Toplevel|tk\.Tk|tkinter\.Tk)\s*\(/;
  const out: string[] = [];
  const seen = new Set<string>();
  let budget = 400;
  const walk = (dir: string, rel: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= 8 || budget <= 0) return;
      if (name === '__pycache__' || name === '.venv' || name === 'node_modules') continue;
      const abs = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs, relPath);
        continue;
      }
      if (!name.endsWith('.py') || !/test/i.test(relPath)) continue;
      budget -= 1;
      if (stat.size > 400_000 || /['"\\]/.test(relPath)) continue;
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (pattern.test(text) && !seen.has(relPath)) {
        seen.add(relPath);
        out.push(relPath);
      }
    }
  };
  walk(root, '');
  return out;
}

/** Quote a path for the shell only when it needs it. */
function shellQuote(path: string): string {
  return /^[\w./@%+=:-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * The flag this RUNNER uses to leave a path out, or null when it has none.
 *
 * Not every runner can express it, and pretending otherwise is the bug this
 * replaces: the guard used to append `--ignore='tests/test_x.py'` to whatever the
 * model wrote. On a `unittest discover` command that is an unrecognized argument
 * (exit 2), and on a pipeline it landed on `tail`, so a measured bench turn
 * watched the same verification fail several times for a reason that had nothing
 * to do with its code. The flag is the runner's, so the runner decides.
 */
function exclusionFlagFor(shapeText: string): string | null {
  return /\b(?:pytest|py\.test)\b/.test(shapeText.toLowerCase()) ? '--ignore=' : null;
}

/** The user's current CrashReporter dialog preference, or null when unset. */
function readDialogType(): string | null {
  try {
    const out = execFileSync('/usr/bin/defaults', ['read', 'com.apple.CrashReporter', 'DialogType'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function writeDialogType(value: string | null): void {
  try {
    if (value === null) {
      execFileSync('/usr/bin/defaults', ['delete', 'com.apple.CrashReporter', 'DialogType'], {
        timeout: 2_000,
        stdio: 'ignore',
      });
    } else {
      execFileSync('/usr/bin/defaults', ['write', 'com.apple.CrashReporter', 'DialogType', value], {
        timeout: 2_000,
        stdio: 'ignore',
      });
    }
  } catch {
    // Best effort: a preference that cannot be written is not a reason to fail the command.
  }
}

/**
 * Advisory appended after a GUI suite crashed. It is stated as evidence rules,
 * not as an instruction to hide the crash: the crash IS one of the findings
 * (two application objects in one launch), and a silent re-run would erase it.
 */
export function guiCrashNote(command: string, output: string, root: string): string {
  if (!isPythonRun(command)) return '';
  const segfault =
    /\bSIGSEGV\b|\bexit(?:ed)?\s+(?:code\s+)?139\b|Segmentation fault|Fatal Python error/.test(output);
  if (!segfault) return '';
  const toolkit = detectGuiToolkit(root);
  if (!toolkit) return '';
  return (
    `\n🖥️ This run crashed the interpreter (SIGSEGV, exit 139) — the stack above is the ` +
    `evidence. A crash at exit while destroying a ${toolkit} window is a defect in the project ` +
    `under test (typically more than one application object per process), not in the harness: ` +
    `report it, with the exit code, as a finding. Do NOT re-run ` +
    `${isTestRun(command) ? 'this module' : 'the same command'} to "confirm" it — each run crashes ` +
    `again; run the non-GUI modules separately if you need a green count.`
  );
}

/**
 * Reference-counted suppression, and the reason the pref is not simply written
 * and restored per command: two guarded children can overlap (a long suite is
 * handed off to monitoring while the next command starts). With independent
 * save/restore, the second guard saves "none" as the user's setting and writes
 * it back at the end, leaving the preference changed for good — measured, during
 * the first run of this guard. Only the first acquirer saves the real value, and
 * only the last release puts it back.
 */
const suppression = { depth: 0, previous: null as string | null, active: false };

function acquireSuppression(): { silenced: boolean; release: () => void } {
  if (suppression.depth === 0) {
    suppression.previous = readDialogType();
    if (suppression.previous !== 'none') {
      writeDialogType('none');
      suppression.active = readDialogType() === 'none';
    }
  }
  suppression.depth += 1;
  const silenced = suppression.active;
  let released = false;
  return {
    silenced,
    release: () => {
      if (released) return;
      released = true;
      suppression.depth = Math.max(0, suppression.depth - 1);
      if (suppression.depth === 0 && suppression.active) {
        writeDialogType(suppression.previous);
        suppression.active = false;
      }
    },
  };
}

/**
 * Build the guard for one command. Never throws: an audit must run with a
 * degraded guard rather than not run at all.
 */
export function guardGuiTests(
  command: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
  opts: { silenceDialogs?: boolean } = {},
): GuiTestGuard {
  if (platform !== 'darwin') return NOOP;
  if (!isPythonRun(command)) return NOOP;
  const toolkit = detectGuiToolkit(root);
  if (!toolkit) return NOOP;

  const env: Record<string, string> = {
    // A segfault without a stack is a mystery; with faulthandler it is evidence.
    PYTHONFAULTHANDLER: '1',
    PYTHONUNBUFFERED: '1',
  };
  if (toolkit === 'qt') env.QT_QPA_PLATFORM = 'offscreen';

  // wx/tk have no offscreen backend on macOS, so the only way to run the suite
  // without the teardown crash is to leave out the modules that build widgets.
  // This is disclosed in the note, never silent: a green run that quietly
  // skipped half the suite is exactly the kind of claim the protocol forbids.
  const candidates = toolkit === 'qt' ? [] : isTestRun(command) ? guiTestModules(root, toolkit) : [];
  // A module is only "excluded" if the command can actually express it. Otherwise
  // the suite runs whole, the crash happens, and the note says what it means.
  let spliced = command;
  let excluded: string[] = [];
  if (candidates.length > 0) {
    const withArgs = insertProgramArgs(
      command,
      candidates.map((p) => `${exclusionFlagFor(command) ?? ''}${shellQuote(p)}`),
      (shape) => exclusionFlagFor(shape.text) !== null,
    );
    if (withArgs) {
      spliced = withArgs;
      excluded = candidates;
    }
  }
  const exclusionApplied = spliced !== command;

  // Opt IN, not out: the preference was measured not to suppress the dialog on
  // this macOS (it read back as `none` while dialogs appeared), so changing a
  // user's crash-reporting setting by default would be a side effect with no
  // benefit. `NUVIRA_SILENCE_CRASH_DIALOGS=1` keeps it available where it does
  // work.
  const silence =
    opts.silenceDialogs ??
    ['1', 'on', 'true'].includes((process.env.NUVIRA_SILENCE_CRASH_DIALOGS ?? '').toLowerCase());
  let restore = () => {};
  let silenced = false;
  if (silence) {
    const held = acquireSuppression();
    silenced = held.silenced;
    restore = held.release;
  }

  const offscreen =
    toolkit === 'qt'
      ? 'Qt is running with the offscreen platform plugin'
      : toolkit === 'wx'
        ? 'wx has no offscreen backend on macOS, so the suite runs as-is with faulthandler on'
        : 'tkinter has no offscreen backend, so the suite runs as-is with faulthandler on';

  return {
    applies: true,
    toolkit,
    env,
    effectiveCommand: spliced,
    excluded,
    exclusionApplied,
    note:
      `\n🖥️ GUI test run contained: ${offscreen}` +
      (excluded.length
        ? `; ${excluded.length} widget-building module(s) are excluded from the run — ` +
          `${excluded.join(', ')}. Report that as a gap alongside the crash it avoids: the suite ` +
          `was NOT fully run, and a green total here does not cover ${excluded.length === 1 ? 'that module' : 'those modules'}.`
        : candidates.length > 0
          ? `; ${candidates.length} widget-building module(s) (${candidates.join(', ')}) ` +
            `cannot be deselected from this runner, so they run and may crash the interpreter at exit. ` +
            `That crash is a finding about the project — report it with its exit code, and read the ` +
            `module's own pass/fail lines above it as its real result.`
          : '') +
      (silenced ? ' Crash dialogs are also suppressed for this command (best effort — macOS may ignore the preference).' : '.'),
    restore: () => {
      restore();
      restore = () => {};
    },
  };
}
