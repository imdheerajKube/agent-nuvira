/**
 * The consent picture — ONE place that says, for every state-changing action,
 * whether it is denied, grantable, or decided by evidence.
 *
 * WHY THIS EXISTS. The rules are already enforced (`autonomy-policy.ts`,
 * `run-terminal.ts`, `intent-envelope.ts`, `session-grant.ts`), but they lived
 * in six files and several refusal messages, so neither the user nor the model
 * had a single view of them. When the user asks "why is this asking / why won't
 * this run", the answer should be one table, not an archaeology of gates.
 *
 * The categories are stable and code-owned — this module DERIVES nothing and
 * changes nothing; it renders the policy that is already in force. A rule that
 * moves in the policy should move here in the same change (the dashboard shows
 * this, so drift is visible).
 */

export interface ConsentExample {
  action: string;
  /** The evidence the gate actually consults, in one line. */
  evidence: string;
}

export interface ConsentPicture {
  /** Never runs, grant or no grant. The hard floor. */
  denied: { title: string; note: string; examples: ConsentExample[] };
  /** Runs after ONE explicit, session-scoped grant the user picks. */
  grantable: { title: string; note: string; examples: ConsentExample[] };
  /** Runs on its own when the user's OWN request names it (or it is recoverable). */
  decided: { title: string; note: string; examples: ConsentExample[] };
}

export function consentPicture(): ConsentPicture {
  return {
    denied: {
      title: 'Denied — never runs',
      note: 'The hard floor. No session grant and no request phrasing unlocks these; the DENY patterns are checked before any grant is consulted.',
      examples: [
        { action: 'sudo / privilege escalation', evidence: 'absolute deny pattern' },
        { action: 'rm -rf / (roots, home, system dirs, globs)', evidence: 'absolute deny pattern' },
        { action: 'mkfs, fdisk, dd, shutdown, kill -9, fork bombs', evidence: 'absolute deny pattern' },
        { action: 'git reset --hard / git clean / checkout -- (working-tree destruction)', evidence: 'absolute deny pattern' },
        { action: 'raw `git push` as a shell string', evidence: 'use the structured git tool (gated by evidence)' },
      ],
    },
    grantable: {
      title: 'Grantable — one explicit "allow for this session"',
      note: 'Offered as one extra choice at the confirmation a tool demanded. Never inferred from prose; recorded as a revisable decision; ends with the conversation.',
      examples: [
        { action: 'file writes + whole-file overwrites', evidence: 'the `write` session grant' },
        { action: 'recoverable workspace commands (install, mkdir, cp/mv, git add)', evidence: 'the `terminal` session grant' },
        { action: 'off-machine actions: network fetches, global/system installs, publish, push', evidence: 'the `external` session grant' },
      ],
    },
    decided: {
      title: 'Decided on its own — evidence, not a round trip',
      note: 'The user’s own request is the authorization. These proceed and REPORT what happened instead of asking again.',
      examples: [
        { action: 'creating a file the request asked for', evidence: 'the request names the work' },
        { action: 'a surgical edit (small relative to the file) or a file the request names', evidence: 'requestNamesPath / isSurgicalEdit' },
        { action: 'a command the request itself names', evidence: 'namedByRequest' },
        { action: 'git commit / git push the request names', evidence: 'requestRequestsCommit / requestRequestsPush' },
        { action: 'publish the request resolves to', evidence: 'the request resolves to the publish CLI intent' },
        { action: 'recoverable CLI intents the user asked for (stop dashboard, clear cache…)', evidence: 'the intent is declared reversible in cli-intent-effects.ts + namedByRequest' },
        { action: 'a workspace command the request authorized', evidence: 'authorizedByRequest + recoverable' },
      ],
    },
  };
}
