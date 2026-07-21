/**
 * Shell utilities — Platform-aware host shell detection for cross-platform
 * child_process execution.
 *
 * Before this module existed, the `platform() === 'win32' ? cmd.exe : /bin/sh`
 * pattern was duplicated inline in three places (SandboxManager.execHostCommand,
 * SandboxManager.runCommandWithOutput, RunnerAgent.executeOnHost). Now those
 * call sites delegate to this single function.
 *
 * Usage:
 * ```ts
 * import { getHostShell } from '../../utils/shell.js';
 *
 * const output = execSync(command, {
 *   shell: getHostShell(),
 *   // ...
 * });
 * ```
 */

import { platform } from 'node:os';

/**
 * Return the path to the host shell executable, determined at runtime based
 * on the current operating system.
 *
 * | Platform  | Return value                        |
 * |-----------|-------------------------------------|
 * | Linux     | `/bin/sh`                           |
 * | macOS     | `/bin/sh`                           |
 * | Windows   | `process.env.COMSPEC \|\| 'cmd.exe'` |
 *
 * The `COMSPEC` environment variable points to the command interpreter on
 * Windows (usually `C:\Windows\system32\cmd.exe`). We fall back to the
 * bare executable name `cmd.exe` which Node.js resolves via `PATH`.
 */
export function getHostShell(): string {
  return platform() === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';
}
