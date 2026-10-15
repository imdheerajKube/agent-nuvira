/**
 * Workspace guard (dashboard wording) — refuse to guess a working directory.
 *
 * The dashboard's chat turns run against a DIRECTORY. When the user attaches a
 * project the turn is scoped to it. When they do NOT, the turn used to inherit
 * the dashboard server process's own working directory — so on a service started
 * from the home folder, "assess this project" listed `~`, found some unrelated
 * checkout sitting there, and assessed THAT. The user saw it as "it went to
 * kuttaaddon": a real, conversational-sounding answer about a project they never
 * mentioned, which is worse than an error.
 *
 * WHAT REMAINS HERE: the message the USER reads (`projectAttachmentPrompt`), which
 * is dashboard-specific — it names the composer's Select Project Folder box and
 * the Browse button — plus re-exports of the rules. The RULES themselves moved to
 * `utils/workspace-need.ts` because every surface needs them now (the CLI's tool
 * context, the messaging gateway, `ask_user` adopting a folder named in a reply)
 * and those must not depend on the dashboard. This module's callers and tests are
 * unchanged: same names, same behaviour, one source of truth.
 *
 * The rules, in summary (see `utils/workspace-need.ts` for the reasoning):
 *   - `needsProjectAttachment` — does this ask need a workspace at all? Narrow on
 *     purpose: chat, prose deliverables and META asks ("give me a test scenario")
 *     all answer inline and must never be gated behind a folder prompt.
 *   - `workspaceNeedForMissingFolder` — what the workspace is FOR: `'produce'`
 *     (a temporary folder serves it) vs `'read'` (only the real tree does, so the
 *     prompt below is still the right answer).
 */

export {
  needsProjectAttachment,
  workspaceNeedForMissingFolder,
  type MissingWorkspaceNeed,
} from '../utils/workspace-need.js';

/**
 * What the user sees instead of a wrong answer.
 *
 * It names the specific failure ("I picked a folder you didn't ask about") and
 * the ways forward, and it offers suggestions that are actual next actions —
 * an ask with no way out just looks like the agent broke.
 *
 * THREE ways forward are named, because all three are now honoured:
 * the composer's picker, the composer's path box, and — the one this message
 * used to omit — simply TYPING the folder's absolute path in the next message.
 * The server adopts a directory the user names in their own message
 * (`directoryFromMessage`, workspace-resolution.ts), so a user who answers this
 * ask with "/Users/me/Documents/my-app" gets a scoped turn rather than the same
 * ask again. THAT repeat was the reported "brutal failure … agent keep refusing
 * even after i attach the folder".
 *
 * It is reached in exactly two cases now: the ask must READ or CHANGE work that
 * already exists (a temporary folder holds none of it), or a temporary folder
 * could not be created. A produce ask no longer dead-ends here.
 */
export function projectAttachmentPrompt(): string {
  return [
    '📁 **Which folder should I work in?**',
    '',
    'No project folder is attached to this chat, so I have no workspace to work in — and I will not',
    'guess one. Guessing is how "assess this project" ends up describing whatever unrelated folder',
    'sits in my own working directory.',
    '',
    '**Give me the folder any of these ways, then send the message again:**',
    '1. Just type its absolute path in your next message — e.g.',
    '   `/Users/you/Documents/my-app create the app here`. I will use it.',
    '2. Or paste that path into the **Select Project Folder** box above the message box and click',
    '   **Attach**.',
    '3. Or click **🗂️ Browse**, navigate to the folder, and click **Attach**.',
    '',
    'On some systems your browser then shows a permission prompt for that folder — click **Allow**,',
    'and the folder is attached to this chat. (You can **✕ detach** it any time.)',
    '',
    'Once attached, every turn in this chat is scoped to it — and a brand-new EMPTY folder is a',
    'perfectly good answer: I will create your files inside it.',
    '',
    '_Tip for operators: set a default working directory in **Admin → Provider Configuration →',
    'Workspace** and unattached turns run there (with a visible warning) instead of stopping here._',
  ].join('\n');
}

/** The followups offered with the refusal — real next actions, not filler. */
export function projectAttachmentFollowups(): Array<{ label: string; prompt: string }> {
  return [
    { label: 'How do I attach a folder?', prompt: 'How do I attach a project folder?' },
    { label: 'Browse the picker for me', prompt: 'Open the project folder picker.' },
  ];
}
