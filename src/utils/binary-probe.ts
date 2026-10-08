/**
 * Is an executable on PATH? ONE implementation, shared.
 *
 * WHY THIS FILE EXISTS. Two copies of this function already existed —
 * `tools/modality/shared.ts` and `enterprise/vault.ts` — with identical bodies;
 * the modality one even documents itself as "mirrors vault.ts binaryOnPath". The
 * capability layer needs a third caller (a requirement pre-flight), so the
 * duplication is resolved here rather than tripled.
 *
 * WHY `which`/`where` RATHER THAN A PATH SCAN. The OS resolver already handles
 * PATHEXT, shell shims and `.cmd` wrappers. A hand-rolled `existsSync` scan
 * silently disagrees with what the shell will ACTUALLY run, which is the wrong
 * answer for a check whose whole job is to predict whether a command will work.
 *
 * MEMOIZED. OS tool presence cannot change mid-process, and this is consulted on
 * every `Vault.open` (which every ConfigManager construction triggers) and on
 * every capability readiness check, so one spawn per tool per process is enough.
 */

import { execFileSync } from 'node:child_process';

const cache = new Map<string, boolean>();

/** True when `name` resolves on PATH. Never throws. */
export function binaryOnPath(name: string): boolean {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  let found: boolean;
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    found = true;
  } catch {
    found = false;
  }
  cache.set(name, found);
  return found;
}

/** Which of `names` resolve on PATH. */
export function binariesOnPath(names: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const n of names) out[n] = binaryOnPath(n);
  return out;
}

/** Clear the memo — for test isolation, which is why it is exported. */
export function resetBinaryProbeCache(): void {
  cache.clear();
}
