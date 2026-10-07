/**
 * Path rules shared by the SURFACES that resolve a workspace (the dashboard's
 * chat server) and the TOOLS that must respect one (the tool registry's
 * `ask_user`, which adopts a folder the user names in a reply).
 *
 * It lives in `utils/` rather than next to either user because it has two, and
 * a tool importing the dashboard would invert the dependency: `src/tools` is
 * driven by the CLI, the SDK and the child agent too, none of which are the
 * dashboard. The rules are pure string/filesystem questions, so a shared,
 * dependency-free home is the honest one.
 *
 * See the Cluster G write-up in `docs/PLAN_MODEL_ROUTING_PARITY.md` for the
 * measured failures these answer.
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * True when `p` exists and is a directory something can actually run in.
 *
 * The exists+isDirectory pair is deliberate: a configured path that has since
 * been deleted, or one that points at a FILE, is not a workspace, and treating
 * it as one is how a turn ends up scoped to nothing and reporting success.
 */
export function isUsableDirectory(p: string | undefined): p is string {
  if (typeof p !== 'string' || !p.trim()) return false;
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Expand `~` and make the path absolute. Returns undefined for anything that is
 * not a path we can act on: empty, a URL, or a RELATIVE path.
 *
 * A relative path is rejected on purpose and is the important case. Resolving
 * it would require a base directory, and the only basis for choosing one is the
 * process's own cwd — which is exactly the guess that produced the reported
 * "it went to kuttaaddon": the dashboard was started from the home folder and
 * read a checkout sitting there as the user's project.
 */
export function normalizeWorkspacePath(raw: string): string | undefined {
  const t = raw.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return undefined;
  if (t === '~') return resolve(homedir());
  if (t.startsWith('~/') || t.startsWith('~\\')) return resolve(join(homedir(), t.slice(2)));
  return isAbsolute(t) ? resolve(t) : undefined;
}

/**
 * The DIRECTORY the user named in their own message, if any.
 *
 * Deliberately narrow, and each restriction has a failure behind it:
 * - ONLY an absolute path (or `~/…`) counts — see {@link normalizeWorkspacePath}.
 * - The candidate must be an existing DIRECTORY. A path in a message is usually
 *   a FILE the user is talking about ("fix /Users/x/proj/src/app.ts"); adopting
 *   that file's folder would silently move the turn into a project the user
 *   merely mentioned.
 * - Trailing sentence punctuation and wrapping quotes are trimmed, so
 *   "work in /Users/you/app." and '"/Users/you/app"' both resolve.
 *
 * With nothing else available, the user's own words do not get to relocate the
 * turn by accident.
 */
export function directoryFromMessage(message: string | undefined): string | undefined {
  if (typeof message !== 'string' || !message) return undefined;
  // Path-ish tokens: start at `~`, `/`, or a drive letter; stop at whitespace
  // and at the delimiters that end a sentence, a clause or an inline-code span.
  const candidates = message.match(/(?:~[\\/]|\/|[A-Za-z]:[\\/])[^\s"'`<>|]*/g) ?? [];
  for (const raw of candidates) {
    const cleaned = raw.replace(/[.,;:!?)\]}]+$/, '');
    if (!cleaned) continue;
    const abs = normalizeWorkspacePath(cleaned);
    if (abs && isUsableDirectory(abs)) return abs;
  }
  return undefined;
}
