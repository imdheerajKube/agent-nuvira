/**
 * The SCRATCH WORKSPACE — where a turn writes when no project folder is known.
 *
 * WHY THIS EXISTS. A turn that must produce a file and has no workspace used to
 * be dead-ended: the dashboard refused with "attach a folder" (see
 * `workspace-guard.ts`), and a messaging turn simply wrote into whatever
 * directory the gateway process happened to run in — a tree that belongs to
 * nobody asking the question. Neither is intelligent handling of a request the
 * user genuinely made: asked for a script and no folder, the right answer is a
 * file the user is TOLD about, not a refusal and not an invisible write.
 *
 * THE LADDER, and this module is only its last rung. A turn's workspace is
 * resolved in `workspace-resolution.ts`: the folder the user attached, then the
 * one this chat attached earlier, then one they named in their message, then
 * the operator's configured default (`dashboard.cwd`) — and only then here.
 * The scratch folder is never presented as a project: every surface is required
 * to say where the file went and offer to keep it (set it as the project, move
 * it, or attach a real folder).
 *
 * WHY NOT `os.tmpdir()` FIRST. `os.tmpdir()` is the obvious choice and the wrong
 * primary: macOS clears `/var/folders` and systemd-tmpfiles clears `/tmp`, so
 * "your file is at /tmp/x" can be a path that stops existing between the reply
 * and the user going to look for it. The primary root is therefore a durable,
 * clearly-temporary directory under the app's own home (or `$NUVIRA_SCRATCH_DIR`),
 * with `os.tmpdir()` kept as the fallback for a home that is not writable. Both
 * paths are built with `node:path`/`node:os`, so every OS is covered without a
 * single `process.platform` branch.
 *
 * DEFECTS THIS CLOSES (measured):
 *   - WhatsApp, trace-1792061511046-jdhgyy: a poem request took 117s, the poem
 *     was produced and then deleted by a gate, and the sender got a dangling
 *     fragment. Nothing to do with scratch alone — but the same session had no
 *     workspace at all, which is what made the turn's file behaviour
 *     unpredictable in the first place.
 *   - Dashboard chat: "agent keep going mad and confused when project folder not
 *     attached" — a produce ask was refused for a folder it did not need.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envBuff, resolveNuviraDataPath } from './paths.js';
// The NEED the caller resolved for this ask (`'produce'` / `'read'` / `null`) —
// imported rather than re-spelled so a new need value is a compile error here
// instead of a silently wrong decision about where a turn may write.
import type { MissingWorkspaceNeed } from '../utils/workspace-need.js';

/** Default retention for a scratch folder nobody came back to (30 days). */
export const SCRATCH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The directory name used by the `os.tmpdir()` fallback. */
const TMP_FALLBACK_DIR = 'nuvira-scratch';

/** Longest run of readable characters kept from a key before a hash is added. */
const SLUG_MAX = 48;

/**
 * Turn an arbitrary key (a session id, a `platform:channelId` contact key) into
 * ONE filesystem-safe directory name.
 *
 * A key that is already safe is returned unchanged, so the dashboard's own
 * session ids produce readable paths. A key that needed character substitution
 * (a WhatsApp `jid` is `918800604222@s.whatsapp.net`, which contains `@` and a
 * dot) gets a short hash of the RAW key appended: substitution alone can collide
 * two different contacts onto one folder, and two people sharing a scratch
 * directory is a defect, not a curiosity.
 */
export function scratchKeyToDirName(key: string): string {
  const raw = (key || '').trim();
  if (!raw) return 'unnamed';
  const readable = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+/, '').replace(/[-.]+$/, '');
  const safe = raw === readable && readable !== '' && readable !== '.' && readable !== '..';
  if (safe) return readable.slice(0, SLUG_MAX);
  const slug = (readable || 'key').slice(0, SLUG_MAX);
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 6);
  return `${slug}-${hash}`;
}

/**
 * The scratch ROOT: `$NUVIRA_SCRATCH_DIR`, else `<nuvira home>/workspace`.
 *
 * `resolveNuviraDataPath` honours `$NUVIRA_CONFIG_DIR`, so an isolated
 * deployment (and the test suite) never writes scratch folders into the real
 * `~/.nuvira`.
 */
export function scratchWorkspaceRoot(): string {
  const override = envBuff('SCRATCH_DIR');
  if (override && override.trim()) return override.trim();
  return resolveNuviraDataPath('workspace');
}

/** The scratch directory a given key WOULD use (not created, not checked). */
export function scratchWorkspaceFor(key: string): string {
  return join(scratchWorkspaceRoot(), scratchKeyToDirName(key));
}

/**
 * Create (if needed) and return the scratch directory for `key`, or `undefined`
 * when no writable location exists — the caller must then behave exactly as it
 * did before this module existed (ask for a folder; never guess a path).
 *
 * Two candidates, in order: the app-home root, then `os.tmpdir()`. The first
 * that can actually be created and written wins. Never throws.
 */
export function ensureScratchWorkspace(key: string): string | undefined {
  const dirName = scratchKeyToDirName(key);
  const candidates = [join(scratchWorkspaceRoot(), dirName), join(tmpdir(), TMP_FALLBACK_DIR, dirName)];
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      // `mkdirSync` is happy on an existing read-only directory, so prove
      // writability rather than trusting it: a scratch folder nothing can be
      // written into would fail later, at the tool call, with a confusing error.
      const probe = join(dir, '.nuvira-scratch-probe');
      mkdirSync(probe, { recursive: true });
      rmSync(probe, { recursive: true, force: true });
      return dir;
    } catch {
      // Fall through to the next candidate.
    }
  }
  return undefined;
}

/**
 * The scratch folder for THIS turn, or `undefined` when a scratch folder must
 * not be used — one place, so two surfaces cannot answer the same question
 * differently.
 *
 * The caller applies the ladder FIRST (attached → session → named in the message
 * → the deployment's configured default) and asks here only when the turn has no
 * folder of the user's. Three conditions then decide it, and each is a case where
 * a temporary folder would be worse than none:
 *
 *   1. `need === 'produce'` — a place to PUT new work. A scratch folder is EMPTY,
 *      so it can neither answer an ask about work that already exists (`'read'`)
 *      nor serve plain chat (`null`).
 *   2. NOT plain chat, for a second reason the first cannot cover: `projectPath`
 *      also drives per-project recall, the resume fingerprint and worktree
 *      isolation, so handing one to a turn that asked for nothing changes what
 *      the turn IS rather than where it writes.
 *   3. NOT an ISOLATED turn. Isolation's contract is a throwaway copy of a REAL
 *      project plus the diff against its base commit (`tools/worktree.ts`), and a
 *      scratch folder is neither a project nor a repository — it has no commit to
 *      start from, so it cannot be isolated at all. Substituting one turns a
 *      request the deployment made (`NUVIRA_ISOLATE=1`) into a REFUSAL, when the
 *      surface's own directory was there to be isolated all along. Measured: the
 *      gateway dropped to `generation_failed` with no model call on the
 *      cross-surface worktree scenario, while the CLI and dashboard — whose
 *      ladder had a real directory above this rung — stayed green.
 */
export function scratchWorkspaceForTurn(input: {
  /** The key this folder belongs to (a session id, a `platform:channelId`). */
  key: string;
  /** What the ask needs a folder for (`workspaceNeedForMissingFolder`). */
  need: MissingWorkspaceNeed;
  /** Is this turn asked to run in an isolated copy of a repository? */
  isolationAsked: boolean;
}): string | undefined {
  if (input.need !== 'produce') return undefined;
  if (input.isolationAsked) return undefined;
  return ensureScratchWorkspace(input.key);
}

/**
 * What the model (and the user) must be told about a scratch workspace.
 *
 * Deliberately explicit about three things, because all three were defects when
 * left implicit: that NOTHING was attached (so nobody wonders why the file is
 * where it is), that the folder is TEMPORARY rather than a project, and the two
 * ways to keep the work. It is written to read correctly on EVERY surface —
 * a messaging reply and a dashboard caption — so it names no UI control and no
 * particular app: "the app" and "the folder path" travel everywhere.
 *
 * It is BOTH the turn's project context (so the model knows where it may write
 * and what to say about it) and the user-visible caption of the response, the
 * same double duty `defaultWorkspaceNotice` performs.
 */
export function scratchWorkspaceNotice(path: string): string {
  return (
    `No project folder is attached, so this turn used a TEMPORARY workspace (${path}) — ` +
    'it is not one of the user\u2019s projects and it will be cleaned up. Name the full path of ' +
    'anything you create there, say plainly that it is temporary, and offer the two ways to keep ' +
    'the work: the user can send the folder path they want it moved to (you move the files there), ' +
    'or attach a project folder so the next turn runs inside it.'
  );
}

/**
 * Remove scratch folders that have not been touched within `maxAgeMs`.
 *
 * A scratch folder is temporary BY DEFINITION, so leaving every one of them on
 * disk forever would turn a convenience into unbounded growth of the user's home
 * directory. Best-effort on both counts: an unreadable entry or an unremovable
 * directory is skipped, never an error — this runs at server/gateway startup and
 * must never be able to stop one.
 *
 * Returns the number of folders removed, for the caller's log line.
 */
export function pruneScratchWorkspaces(maxAgeMs: number = SCRATCH_RETENTION_MS): number {
  const root = scratchWorkspaceRoot();
  if (!existsSync(root)) return 0;
  const cutoff = Date.now() - Math.max(0, maxAgeMs);
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      const info = statSync(dir);
      if (!info.isDirectory()) continue;
      if (info.mtimeMs >= cutoff) continue;
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Skip anything unreadable or unremovable.
    }
  }
  return removed;
}
