/**
 * A1 end-to-end — `run_terminal` must not report a build as successful when the
 * artifact it produced crashes on launch.
 *
 * This reproduces the Aukat_check shape without a real toolchain: a fake
 * `pyinstaller` on PATH exits 0 (the build "succeeded") while writing a bundle
 * that crashes with a PyQt6 import error. The tool result must be a FAILURE that
 * carries the launch stderr, not a green build. POSIX-only (uses a shell shim).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTerminalTool } from '../../src/tools/run-terminal.js';
import type { ToolContext } from '../../src/tools/registry.js';

const dirs: string[] = [];
const origPath = process.env.PATH;

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'run-terminal-effect-'));
  dirs.push(d);
  return d;
}

/**
 * Install a fake `pyinstaller` that exits 0 and writes `dist/App` whose launch
 * behaviour is given by `appBody`.
 */
function installFakePyinstaller(root: string, appBody: string): void {
  const shimDir = join(root, 'shim');
  mkdirSync(shimDir, { recursive: true });
  const shim = join(shimDir, 'pyinstaller');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      'mkdir -p dist',
      "cat > dist/App <<'APPEOF'",
      '#!/bin/sh',
      appBody,
      'APPEOF',
      'chmod +x dist/App',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(shim, 0o755);
  process.env.PATH = `${shimDir}:${origPath ?? ''}`;
}

afterEach(() => {
  process.env.PATH = origPath;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('run_terminal — build/run effect verification (A1)', () => {
  posixOnly('turns a build into a FAILURE when its artifact crashes on launch', async () => {
    const root = tmp();
    writeFileSync(join(root, 'App.spec'), "a = BUNDLE(coll, name='App')\n");
    installFakePyinstaller(root, 'echo "ModuleNotFoundError: No module named \'PyQt6\'" >&2\nexit 1');
    const ctx: ToolContext = { configManager: {}, cwd: root };

    const result = await runTerminalTool({ command: 'pyinstaller App.spec', confirm: true }, ctx);

    expect(result.startsWith('Error:')).toBe(true);
    expect(result).toContain('CRASHES');
    expect(result).toContain('PyQt6');
  });

  posixOnly('verifies a build whose artifact launches cleanly', async () => {
    const root = tmp();
    writeFileSync(join(root, 'App.spec'), "a = BUNDLE(coll, name='App')\n");
    installFakePyinstaller(root, 'exit 0');
    const ctx: ToolContext = { configManager: {}, cwd: root };

    const result = await runTerminalTool({ command: 'pyinstaller App.spec', confirm: true }, ctx);

    expect(result.startsWith('Error:')).toBe(false);
    expect(result).toContain('effect verified');
  });
});
