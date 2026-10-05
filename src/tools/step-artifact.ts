/**
 * Step artifacts — a step that names a FILE is not done until that file exists.
 *
 * WHY (A6). A plan is a claim about the future, and marking a step `done` is a
 * claim about the past. On the `cal` Android run the plan included producing an
 * APK; the build failed, but nothing tied the step's DONE state to the artifact
 * it named, so the checklist could — and did — advance past work that was never
 * delivered. A step whose description names an artifact is verifiable, so it is
 * verified: `plan_todo` refuses to mark it done while the file is absent.
 *
 * The extraction is deliberately CONSERVATIVE. It fires only on tokens that are
 * unambiguously file-like (a quoted path, a slash-containing path, or a token
 * with a known file extension) and skips anything it cannot be sure about —
 * URLs, globs, flags, version numbers, prose. A false "artifact missing" that
 * blocks a legitimate step is worse than missing a check, so when in doubt the
 * token is ignored.
 */

import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** Extensions that make a bare token file-like. Keep this list pragmatic. */
const ARTIFACT_EXT =
  /\.(apk|aab|aar|jar|zip|tar|tgz|gz|md|mdx|txt|json|ya?ml|toml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|kts|gradle|properties|lock|pdf|png|jpe?g|gif|svg|webp|sh|bash|csv|tsv|xlsx?|docx?|pptx?|bin|exe|dll|so|dylib|whl|ipynb)$/i;

/**
 * Tokens that must never be treated as artifacts even when they look file-like:
 * URLs, globs, flags, and prose fragments.
 */
function isExcluded(token: string): boolean {
  if (!token) return true;
  if (/^https?:\/\//i.test(token) || token.includes('://')) return true;
  if (/[<>*?{}()=]/.test(token)) return true; // globs, prose, assignments
  if (token.startsWith('-')) return true; // flags
  if (token.startsWith('~')) return true; // home-relative — machine-local, not the project's
  if (token.includes(' ')) return true;
  return false;
}

/** Strip wrapping punctuation a description commonly puts around a path. */
function cleanToken(raw: string): string {
  return raw.replace(/^[`"'([{<]+/, '').replace(/[`"'\])}>,.;:!?]+$/, '');
}

/**
 * Extract candidate artifact paths from a step description. Returns a deduped
 * list, in first-seen order. Never throws.
 */
export function extractArtifactPaths(description: string): string[] {
  const text = String(description ?? '');
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const token = cleanToken(raw);
    if (isExcluded(token)) return;
    const looksLikePath = token.includes('/') && !token.endsWith('/');
    const hasExtension = ARTIFACT_EXT.test(token);
    if (!looksLikePath && !hasExtension) return;
    // A slash-containing token must still look like a filename at the end
    // (`src/foo`) unless it carries a known extension.
    if (looksLikePath && !hasExtension && !/[^/]\.[a-z0-9]+$/i.test(token)) return;
    if (seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };

  // Quoted / backticked spans first — the strongest signal.
  for (const m of text.matchAll(/[`"']([^`"']+)[`"']/g)) push(m[1]);
  // Then any whitespace-separated token.
  for (const m of text.matchAll(/\S+/g)) push(m[0]);
  return out;
}

export interface ArtifactCheck {
  /** Paths that were checked, as written in the description. */
  checked: string[];
  /** The subset that does not exist in the workspace. */
  missing: string[];
}

/**
 * Check the artifacts a step names against the workspace. When `cwd` is absent
 * nothing is checked (there is no workspace to check against) — the caller must
 * treat an empty `missing` as "no verdict", not as "present".
 */
export function checkStepArtifacts(description: string, cwd: string | undefined): ArtifactCheck {
  const paths = extractArtifactPaths(description);
  if (!cwd || paths.length === 0) return { checked: paths, missing: [] };
  const missing: string[] = [];
  for (const p of paths) {
    try {
      // A token that names a LOCATION is checked there directly. A BARE file
      // name (`local.properties`, `app-debug.apk`) has no location, and a step
      // routinely names an artifact that a tool wrote into a subdirectory
      // (`android/local.properties`, `android/app/build/outputs/apk/debug/`).
      // Resolving a bare name against the workspace ROOT produced false
      // "missing" verdicts on the live run — it refused to mark a `local.properties`
      // step done after the file had been written one level down. A bare name is
      // therefore searched for in the workspace before it is called missing.
      if (isAbsolute(p) || p.includes('/')) {
        const abs = isAbsolute(p) ? p : resolve(cwd, p);
        if (!existsSync(abs)) missing.push(p);
      } else if (!basenameExists(cwd, p)) {
        missing.push(p);
      }
    } catch {
      // An unreadable path is not proof of absence — stay silent.
    }
  }
  return { checked: paths, missing };
}

/** Directories never worth descending into when locating a named artifact. */
const SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', '.gradle', '.idea', '.vscode']);
/** Bounds so a workspace walk can never become the expensive part of a plan update. */
const SEARCH_MAX_DEPTH = 6;
const SEARCH_MAX_DIRS = 4000;

/**
 * Does a file with this basename exist anywhere in the (bounded) workspace? Used
 * only for a token that names no directory, so a step that calls `app-debug.apk`
 * an artifact is satisfied by the APK under `android/.../apk/debug/` — while a
 * name that exists nowhere is still genuinely missing.
 */
function basenameExists(cwd: string, name: string): boolean {
  const target = name.toLowerCase();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
  let visited = 0;
  while (queue.length > 0) {
    if (++visited > SEARCH_MAX_DIRS) break;
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < SEARCH_MAX_DEPTH && !SEARCH_SKIP_DIRS.has(e.name)) {
          queue.push({ dir: join(dir, e.name), depth: depth + 1 });
        }
      } else if (e.isFile() && e.name.toLowerCase() === target) {
        return true;
      }
    }
  }
  return false;
}
