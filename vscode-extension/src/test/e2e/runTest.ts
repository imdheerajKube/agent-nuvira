/**
 * E2E launcher — downloads (once) a VS Code build and runs the suite in it.
 *
 * `npm run test:e2e` compiles the harness, then runs this file. The editor is
 * launched with `--disable-extensions` so only the extension under development
 * is loaded, which keeps activation deterministic.
 *
 * Two things make this robust across VS Code releases:
 *   - `VSCODE_TEST_VERSION` pins the build (CI can set it); unset means the
 *     current stable, which is the coverage we actually want day to day.
 *   - `@vscode/test-electron` resolves the macOS launcher as
 *     `Contents/MacOS/Electron`, but current VS Code builds ship `Code` there.
 *     Without the fallback the download succeeds and the spawn fails with
 *     ENOENT, so we translate the name when the legacy one is missing.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

/**
 * Resolve a launchable VS Code binary. Falls back to `Code` on macOS when the
 * build no longer ships the legacy `Electron` launcher name.
 */
async function resolveVSCodeExecutable(): Promise<string> {
  const version = process.env.VSCODE_TEST_VERSION?.trim();
  const resolved = version ? await downloadAndUnzipVSCode(version) : await downloadAndUnzipVSCode();

  if (process.platform !== 'darwin') {
    return resolved;
  }
  if (fs.existsSync(resolved)) {
    return resolved;
  }
  const renamed = path.join(path.dirname(resolved), 'Code');
  if (fs.existsSync(renamed)) {
    return renamed;
  }
  // Return the original path so the failure message names what was expected.
  return resolved;
}

async function main(): Promise<void> {
  try {
    const vscodeExecutablePath = await resolveVSCodeExecutable();

    // Run from the compiled location (out/test/e2e) back to vscode-extension/.
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index.js');

    // VS Code binds a unix socket under the user-data dir, and the OS caps the
    // path at ~103 chars. The default dir lives under this repo's
    // node_modules-adjacent path, which overflows on a deep checkout, so use a
    // short, stable directory in the system temp root instead.
    const userDataDir = path.join(os.tmpdir(), 'nuvira-vscode-e2e');

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--disable-extensions', `--user-data-dir=${userDataDir}`],
    });

    console.log('E2E: passed');
  } catch (err) {
    console.error('E2E: failed', err);
    process.exit(1);
  }
}

void main();
