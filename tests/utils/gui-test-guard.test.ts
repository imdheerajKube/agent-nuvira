import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectGuiToolkit, guardGuiTests, guiCrashNote } from '../../src/utils/gui-test-guard.js';

/**
 * The guard exists because auditing a wxPython app means running its suite, and
 * that suite segfaults at exit (`wxApp::CleanUp` → `sipwxFrame::~sipwxFrame`),
 * which puts a macOS crash dialog on the user's screen for every attempt. These
 * tests pin the three decisions that keep that contained without pretending wx
 * has an offscreen mode: WHEN the guard applies, WHAT it sets, and that a crash
 * is reported as a finding instead of being hidden or re-run.
 *
 * Every case builds its own temp project, because toolkit detection is cached
 * per root — reusing one directory would let an earlier case answer for a later
 * one and test the cache instead of the detection.
 */
describe('gui-test-guard', () => {
  const roots: string[] = [];
  const project = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'gui-guard-'));
    roots.push(root);
    for (const [name, source] of Object.entries(files)) {
      const abs = join(root, name);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, source);
    }
    return root;
  };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('detects the toolkit from the project, not from a virtualenv dependency', () => {
    const withoutWx = project({
      'app/main.py': 'def main():\n    pass\n',
      '.venv/site-packages/dep.py': 'import wx\n',
    });
    expect(detectGuiToolkit(withoutWx)).toBeNull();

    const withWx = project({ 'app/main.py': 'import wx\n\napp = wx.App(False)\n' });
    expect(detectGuiToolkit(withWx)).toBe('wx');
  });

  it('applies to a python test run against a wx project on macOS', () => {
    const root = project({ 'app/main.py': 'import wx\n' });
    const guard = guardGuiTests('python -m pytest tests -q', root, 'darwin', { silenceDialogs: false });
    expect(guard.applies).toBe(true);
    expect(guard.toolkit).toBe('wx');
    // A segfault without a stack is a mystery; faulthandler makes it evidence.
    expect(guard.env.PYTHONFAULTHANDLER).toBe('1');
    // wx has no offscreen backend on macOS — the guard must say so rather than
    // claim an isolation it does not have.
    expect(guard.note).toMatch(/no offscreen backend on macOS/);
  });

  it('uses the real offscreen backend where the toolkit has one', () => {
    const root = project({ 'app/window.py': 'from PyQt6.QtWidgets import QApplication\n' });
    const guard = guardGuiTests('pytest -q', root, 'darwin', { silenceDialogs: false });
    expect(guard.applies).toBe(true);
    expect(guard.toolkit).toBe('qt');
    expect(guard.env.QT_QPA_PLATFORM).toBe('offscreen');
  });

  it('covers every python run in a GUI project, not only a literal pytest command', () => {
    const wx = project({ 'app/main.py': 'import wx\n' });
    // MEASURED: the first guarded audit still raised a dialog because its python
    // ran through a heredoc and a one-liner — neither contains the word pytest.
    // Importing the GUI module is what reaches the crashing teardown.
    expect(guardGuiTests('python scripts/build.py', wx, 'darwin', { silenceDialogs: false }).applies).toBe(true);
    expect(guardGuiTests('.venv/bin/python - <<"PY"\nimport wx\nPY', wx, 'darwin', { silenceDialogs: false }).applies).toBe(true);
  });

  it('stays out of the way for non-python commands, non-GUI projects and other platforms', () => {
    const wx = project({ 'app/main.py': 'import wx\n' });
    expect(guardGuiTests('ls -la && wc -l README.md', wx, 'darwin').applies).toBe(false);
    const plain = project({ 'lib/x.py': 'import json\n' });
    expect(guardGuiTests('pytest -q', plain, 'darwin').applies).toBe(false);
    expect(guardGuiTests('pytest -q', wx, 'linux').applies).toBe(false);
  });

  it('leaves widget-building test modules out of the run, and says which ones', () => {
    // MEASURED: macOS ignored the CrashReporter preference (it read back as
    // `none` while dialogs appeared), and wx has no offscreen backend — so the
    // suite can only run without crashing if the modules that build widgets are
    // deselected. Silence here would be a claim that the whole suite passed.
    const root = project({
      'app/main.py': 'import wx\n',
      'tests/test_core.py': 'import json\n\ndef test_ok():\n    assert True\n',
      'tests/test_dialogs.py': 'import wx\n\ndef test_dialog():\n    app = wx.App(False)\n    assert app\n',
      // Imports wx but builds nothing: excluding this would shrink the suite for
      // no reason, because only a created widget starts the crashing teardown.
      'tests/test_constants.py': 'import wx\n\ndef test_id():\n    assert wx.ID_OK == 5100\n',
    });
    const guard = guardGuiTests('.venv/bin/python -m pytest tests -q', root, 'darwin', { silenceDialogs: false });
    expect(guard.excluded).toEqual(['tests/test_dialogs.py']);
    expect(guard.exclusionApplied).toBe(true);
    expect(guard.effectiveCommand).toBe(
      '.venv/bin/python -m pytest tests -q --ignore=tests/test_dialogs.py',
    );
    expect(guard.note).toMatch(/excluded from the run/);
    expect(guard.note).toMatch(/was NOT fully run/);

    // A non-test command is never rewritten.
    expect(guardGuiTests('python scripts/probe.py', root, 'darwin').exclusionApplied).toBe(false);
  });

  it('puts the exclusion where the RUNNER is, not at the end of the line', () => {
    // MEASURED: the suffix used to be concatenated onto the whole line, so on a
    // piped verification the flags landed on `tail` and the turn watched the run
    // fail for a reason unrelated to its code — several times in one bench turn.
    const root = project({
      'app/main.py': 'import wx\n',
      'tests/test_dialogs.py': 'import wx\n\napp = wx.App(False)\n',
    });
    const piped = guardGuiTests(
      '.venv/bin/python -m pytest tests -q 2>&1 | tail -20',
      root,
      'darwin',
      { silenceDialogs: false },
    );
    expect(piped.effectiveCommand).toBe(
      '.venv/bin/python -m pytest tests -q --ignore=tests/test_dialogs.py 2>&1 | tail -20',
    );

    // A decorated run keeps its decorations; the flag joins the runner's args.
    const decorated = guardGuiTests('cd repo && python3 -m pytest tests', root, 'darwin', {
      silenceDialogs: false,
    });
    expect(decorated.effectiveCommand).toBe(
      'cd repo && python3 -m pytest tests --ignore=tests/test_dialogs.py',
    );
  });

  it('leaves a runner that HAS no exclusion flag completely alone', () => {
    // MEASURED: `--ignore=` is a pytest flag. Appending it to `unittest discover`
    // is an unrecognized argument (exit 2), which is the harness failing the
    // turn's verification for it. When the exclusion cannot be expressed, the
    // suite runs whole and the note says what the crash means.
    const root = project({
      'app/main.py': 'import wx\n',
      'tests/test_dialogs.py': 'import wx\n\napp = wx.App(False)\n',
    });
    const unit = guardGuiTests('python3 -m unittest discover -s tests', root, 'darwin', {
      silenceDialogs: false,
    });
    expect(unit.effectiveCommand).toBe('python3 -m unittest discover -s tests');
    expect(unit.excluded).toEqual([]);
    expect(unit.exclusionApplied).toBe(false);
    expect(unit.note).toMatch(/cannot be deselected/);
    expect(unit.note).toMatch(/tests\/test_dialogs\.py/);
  });

  it('reports a GUI segfault as the project defect it is, and forbids the blind re-run', () => {
    const root = project({ 'app/main.py': 'import wx\n' });
    const crash =
      'Fatal Python error: Segmentation fault\n' +
      '  File ".../wx/_core.py", line 1 in DestroyChildren\n' +
      'Error: run_terminal: `pytest -q` failed (exit 139).';
    const note = guiCrashNote('pytest -q', crash, root);
    expect(note).toMatch(/defect in the project\s+under test/);
    expect(note).toMatch(/Do NOT re-run this module/);

    // A clean failure says nothing, and so does a non-GUI project's crash.
    expect(guiCrashNote('pytest -q', 'Error: run_terminal: `pytest -q` failed (exit 1).', root)).toBe('');
    const plain = project({ 'lib/x.py': 'import json\n' });
    expect(guiCrashNote('pytest -q', crash, plain)).toBe('');
  });
});
