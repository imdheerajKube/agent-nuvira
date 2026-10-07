/**
 * Cluster G — WHERE this turn's workspace came from, in one tested place.
 *
 * The dashboard chat used to answer "which folder is this turn about?" with a
 * two-line rule: the path the browser posted, else the operator-configured
 * `dashboard.cwd`, else nothing. Three measured failures came out of that:
 *
 * 1. THE BROWSER IS NOT THE ONLY PLACE A FOLDER CAN COME FROM. The dashboard
 *    keeps a per-session `projectPath`, and the composer only re-sends it from
 *    React state: a page reload mid-conversation, or an attach whose response
 *    the UI never received, drops it — and the server then had no folder even
 *    though the chat had one. The user's report was exactly this: "agent keep
 *    refusing even after i attach the folder". A folder this chat already
 *    attached is a folder the server can still read back.
 *
 * 2. THE USER CAN NAME A FOLDER IN THE MESSAGE. The workspace guard already
 *    treats a typed absolute path as "the user is being specific, do not ask
 *    them to attach anything" — and then threw the path away instead of
 *    running there. "as user gives folder either path via chat … we can use
 *    it" is the missing half of that rule.
 *
 * 3. A CONFIGURED DEFAULT IS NOT THE USER'S PROJECT. `dashboard.cwd` is an
 *    operator's choice about where unattached work lands, and the turn was
 *    told nothing about it — so a turn scoped to the default answered as if it
 *    were inside a project the user had pointed at. See {@link WorkspaceSource}.
 *
 * The order is deliberate and safe-by-default: the folder the USER attached
 * wins, then the one this conversation already attached, then one the user
 * named in their own message, and only then the operator's default — and the
 * default is the one case that carries a warning, because it is the one case
 * the user did not choose.
 */

import { directoryFromMessage, isUsableDirectory } from '../utils/workspace-path.js';

/**
 * Re-exported so a caller of this module needs one import, not two. The rules
 * themselves live in `utils/workspace-path.ts` because a TOOL also uses them
 * (`ask_user`, adopting a folder the user names in a reply) and `src/tools`
 * must not depend on the dashboard.
 */
export { directoryFromMessage, isUsableDirectory, normalizeWorkspacePath } from '../utils/workspace-path.js';

/**
 * Where this turn's folder came from. `none` means the turn has NO workspace —
 * the case every write must refuse to guess about.
 */
export type WorkspaceSource = 'attached' | 'session' | 'message' | 'default' | 'none';

export interface ResolvedWorkspace {
  /** The absolute directory, when there is one. */
  path?: string;
  source: WorkspaceSource;
  /**
   * A one-line, user-facing account of where the turn is running — present for
   * EVERY source except `attached` (the user's own folder needs no
   * explanation). Rides into the turn's project context AND onto the response,
   * so the reason a write landed somewhere is visible rather than inferred.
   */
  notice?: string;
  /** True when the turn has no workspace at all: writes must ask, never guess. */
  unscoped: boolean;
}

/**
 * The caption the SURFACE shows for a resolved workspace, or undefined when
 * there is nothing to say.
 *
 * Nothing to say means exactly one case: the user's own attached folder. Every
 * other source is a folder the user did not pick THIS turn, and a file that
 * lands somewhere unexpected is the difference between a tool and a mystery —
 * so each of those gets one plain sentence naming the directory and why.
 */
export function formatWorkspaceNoticeText(workspace: ResolvedWorkspace): string | undefined {
  if (workspace.source === 'attached') return undefined;
  if (!workspace.path) {
    return (
      'No project folder is attached — this turn is running UNSCOPED, so nothing will be ' +
      'written to disk until you say where it should go.'
    );
  }
  return workspace.notice ?? `Workspace: ${workspace.path} (${workspace.source}).`;
}

/** The warning a turn scoped to the operator's DEFAULT workspace must carry. */
export function defaultWorkspaceNotice(path: string): string {
  return (
    `No project folder is attached to this chat, so this turn is running in the configured ` +
    `default workspace (${path}). Anything created lands THERE — say so plainly if you create ` +
    `a file, and name the path. If the work belongs in a different project, ask the user to ` +
    `attach that folder (the Select Project Folder box above the composer) or to paste its ` +
    `absolute path.`
  );
}

export interface TurnWorkspaceInput {
  /** The path the browser posted with this turn, if any. */
  attachedPath?: string;
  /** The path this conversation attached earlier, read back from its session. */
  sessionPath?: string;
  /** The operator-configured `dashboard.cwd`, if any. */
  configuredCwd?: string;
  /** This turn's user message — the last place a folder can come from. */
  message?: string;
}

/**
 * Decide the turn's workspace, in priority order, with the notice it must be
 * told about. Pure and synchronous so the rule can be tested on its own; the
 * only I/O is an existence check per candidate.
 */
export function resolveTurnWorkspace(input: TurnWorkspaceInput): ResolvedWorkspace {
  if (isUsableDirectory(input.attachedPath)) {
    return { path: input.attachedPath, source: 'attached', unscoped: false };
  }
  if (isUsableDirectory(input.sessionPath)) {
    return {
      path: input.sessionPath,
      source: 'session',
      unscoped: false,
      notice:
        `Workspace: ${input.sessionPath} — restored from this conversation's earlier attachment ` +
        '(the request did not carry it). The user attached this folder to this chat.',
    };
  }
  const named = directoryFromMessage(input.message);
  if (named) {
    return {
      path: named,
      source: 'message',
      unscoped: false,
      notice:
        `Workspace: ${named} — taken from the folder the user named in their message. ` +
        'They pointed at this directory; treat it as their project.',
    };
  }
  if (isUsableDirectory(input.configuredCwd)) {
    return {
      path: input.configuredCwd,
      source: 'default',
      unscoped: false,
      notice: defaultWorkspaceNotice(input.configuredCwd),
    };
  }
  return { source: 'none', unscoped: true };
}
