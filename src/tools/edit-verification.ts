/**
 * Edit-verification guards (enterprise-grade hardening, G1 + G2).
 *
 * The calculator audit found the sharpest agent-side gap: across 99 LLM calls
 * the loop never once ran `run_terminal`/`test`/`browser` — it edited files
 * and *asserted* they worked ("successfully fixed", "now fully operational")
 * eight turns in a row while the user kept reporting the same breakage. The
 * loop's existing honesty guards only cover DELIVERY claims (`gateway_send`),
 * so a false claim about a CODE change passed unflagged.
 *
 * This module is the single source of truth for two questions:
 *
 *   1. Which tool calls MUTATE the workspace, and which ones can VERIFY a
 *      mutation? (G1 — the verification gate consumes this.)
 *   2. Does the final answer CLAIM an edit that no verification backed?
 *      (G2 — `detectUnverifiedEditClaim`.)
 *
 * Both are pure + deterministic (no LLM, no I/O), so they can be unit-tested
 * exhaustively and behave identically across the CLI, dashboard, and gateway.
 */

/**
 * Tools that CHANGE the workspace. A turn that ran one of these has produced
 * a claim about reality that only a verification run can support.
 *
 * Deliberately an ALLOWLIST: a write-capable tool added to the registry later
 * is NOT assumed to be a mutation until it is reviewed here (the same
 * fail-safe direction as `PARALLEL_SAFE_TOOL_NAMES`).
 */
export const MUTATION_TOOLS: ReadonlySet<string> = new Set(['edit_file', 'write_file']);

/**
 * Tools that can PROVE a mutation works — they observe the artifact rather
 * than assert it. `run_terminal` (typecheck/tests/build), the `test` pipeline,
 * a real `browser` run, and `run_cli` (e.g. `nuvira test`) all qualify.
 *
 * `delegate` is intentionally excluded: a sub-agent's prose summary is not an
 * observed artifact, and treating it as verification would let the exact
 * failure mode we are closing through the back door.
 */
export const VERIFICATION_TOOLS: ReadonlySet<string> = new Set([
  'run_terminal',
  'test',
  'browser',
  'run_cli',
]);

/** Whether a tool call changes the workspace. */
export function isMutationTool(name: string): boolean {
  return MUTATION_TOOLS.has(name);
}

/** Whether a tool call can verify a mutation (observe the artifact). */
export function isVerificationTool(name: string): boolean {
  return VERIFICATION_TOOLS.has(name);
}

/**
 * Classify a turn's tools into mutations + verifications. Only tools that
 * actually RAN SUCCESSFULLY should be passed in (an `Error:` refusal is not a
 * mutation and not a verification — see `ToolLoopProgress.successfulToolCalls`).
 */
export function classifyEditActivity(toolsRun: readonly string[]): {
  mutations: string[];
  verifications: string[];
  needsVerification: boolean;
} {
  const mutations: string[] = [];
  const verifications: string[] = [];
  for (const name of toolsRun) {
    if (isMutationTool(name)) mutations.push(name);
    else if (isVerificationTool(name)) verifications.push(name);
  }
  return {
    mutations,
    verifications,
    // A mutated workspace with nothing observed is the unverified case.
    needsVerification: mutations.length > 0 && verifications.length === 0,
  };
}

/** One executed tool call, as observed by the loop (args + result text). */
export interface ToolCallEvidence {
  tool: string;
  args?: Record<string, unknown>;
  /** The tool-result text (the loop feeds this to the model verbatim). */
  result?: string;
}

/**
 * Commands that exercise the WHOLE project, so any change in it is covered.
 * `npm test`, a typecheck, a build, a linter — these observe the artifact even
 * when they never name the changed file.
 */
const GENERIC_VERIFY_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check|ci)\b|\b(?:tsc|vitest|jest|pytest|mocha|cargo\s+test|go\s+test|gradle|mvn|make|node\s+--check)\b/i;

/**
 * Did this turn's verification actually EXERCISE the artifact it changed?
 *
 * The first cut accepted ANY successful `run_terminal` — so `echo hi` or `ls`
 * marked a turn "verified" (the same class of false positive the gate exists to
 * prevent). A run counts only when it:
 *   - is the `test` pipeline or a real `browser` run (inherently project-wide), OR
 *   - runs a generic project check (`npm test`, typecheck, build, linter), OR
 *   - names one of the files the turn changed (e.g. `grep … style.css`,
 *     `node --check script.js`).
 *
 * When the turn's changed paths are UNKNOWN, it falls back to "any successful
 * verification counts" — the pre-strictening behaviour — so an unidentifiable
 * mutation is never falsely flagged.
 */
export function verificationExercisedArtifact(
  evidence: readonly ToolCallEvidence[],
  changedFiles: readonly string[],
): boolean {
  if (evidence.length === 0) return false;
  // Unknown changed paths → cannot judge relevance; don't cry wolf.
  if (changedFiles.length === 0) return true;

  const names = new Set<string>();
  for (const f of changedFiles) {
    if (!f) continue;
    names.add(f);
    const base = f.split(/[\\/]/).pop();
    if (base) names.add(base);
  }

  for (const e of evidence) {
    if (e.tool === 'test' || e.tool === 'browser') return true;
    let text = e.result ?? '';
    if (e.args) {
      try {
        text += ` ${JSON.stringify(e.args)}`;
      } catch {
        // Unserializable args — the result text alone is still usable.
      }
    }
    if (GENERIC_VERIFY_RE.test(text)) return true;
    for (const n of names) {
      if (n && text.includes(n)) return true;
    }
  }
  return false;
}

/**
 * Full edit assessment for a turn: what mutated, what verified, and whether a
 * verification still OWED. This is the single call the loop uses so the gate,
 * the nudge and the honesty flag can never disagree.
 */
export function assessEditActivity(
  toolsRun: readonly string[],
  evidence: readonly ToolCallEvidence[] = [],
  changedFiles: readonly string[] = [],
): {
  mutations: string[];
  verifications: string[];
  needsVerification: boolean;
} {
  const base = classifyEditActivity(toolsRun);
  if (base.mutations.length === 0) return { ...base, needsVerification: false };
  return { ...base, needsVerification: !verificationExercisedArtifact(evidence, changedFiles) };
}

/** A sentence that is future/interrogative/negated is NOT a completed claim. */
const NON_CLAIM_CONTEXT_RE =
  /\b(?:not|n't|never|unable|cannot|can't|couldn't|didn't|won't|will|would|should|could|can|may|might|going to|about to|try(?:ing)? to|attempt|if you|let me|shall i|should i|do you want|i'?ll|next|then)\b/i;

/**
 * Past-tense sentences that ASSERT a completed code change. Grouped, because
 * the audit surfaced several distinct phrasings the model used:
 *   - "I have successfully secured the calculator…"
 *   - "The inline event handlers have been successfully removed…"
 *   - "I have applied the requested changes…"
 *   - "The converter is now fully operational…"
 */
const EDIT_CLAIM_RES: readonly RegExp[] = [
  // First-person completed change: "I have fixed / updated / refactored …"
  /\bi(?:'ve| have)\s+(?:just\s+|now\s+|also\s+|already\s+|successfully\s+)*(?:fixed|updated|refactored|implemented|applied|added|created|removed|corrected|replaced|rewritten|rewrote|changed|modified|enhanced|completed|adjusted|introduced|resolved|rebuilt|migrated|secured|cleaned\s+up|wired\s+up|hooked\s+up)\b/i,
  // Bare verb form: "I fixed / updated …"
  /\bi\s+(?:just\s+|already\s+|successfully\s+|now\s+)*(?:fixed|updated|refactored|implemented|applied|corrected|replaced|removed|resolved|rewrote|rebuilt)\b/i,
  // Adverb-led success: "successfully updated / properly fixed / fully implemented"
  /\b(?:successfully|properly|fully|correctly)\s+(?:fixed|updated|refactored|implemented|applied|added|created|removed|corrected|replaced|changed|modified|moderni[sz]ed|improved|polished|styled|reworked|optimi[sz]ed|simplified|hardened|enhanced|completed|resolved|rewired|restored|cleaned|secured|wired|hooked)\b/i,
  // Passive change: "the fix / changes / edits have been applied"
  /\b(?:the\s+)?(?:fix|change|changes|update|updates|edit|edits|issue|bug|problem|error|refactor|patch)\s+(?:has|have|is|are)\s+(?:now\s+)?(?:been\s+)?(?:applied|made|implemented|fixed|completed|resolved|added|removed|corrected|patched)\b/i,
  // State assertion: "it is now fully operational / working / fixed"
  /\b(?:is|are|it'?s|this\s+is|that\s+is)\s+(?:now\s+)?(?:fully\s+|properly\s+|already\s+)?(?:operational|functional|working(?:\s+(?:correctly|now|fine|as\s+expected))?|fixed|complete|completed|done|ready|in\s+place|up\s+to\s+date)\b/i,
  // "I have applied the requested changes"
  /\bi(?:'ve| have)\s+(?:now\s+|just\s+)*(?:applied|made)\s+the\s+(?:changes|requested\s+changes|fix|edits|updates|modifications)\b/i,
  // "the changes are applied / complete"
  /\b(?:changes|edits|updates|modifications)\s+(?:are|have\s+been)\s+(?:applied|made|complete|completed|done)\b/i,
];

/**
 * True when the answer asserts a completed CODE change that no verification
 * backed.
 *
 * The claim is judged ONLY when the turn actually mutated the workspace and
 * ran nothing that could observe the result. If a verification tool ran
 * successfully, the assertion is (at least) grounded in an observed artifact
 * and the flag stays quiet — crying wolf on a verified edit would erode the
 * flag the way an over-eager linter gets ignored.
 *
 * Sentence-scoped so a negation or a conditional elsewhere in the answer
 * never turns a truthful statement into a flag (and vice-versa).
 */
export function detectUnverifiedEditClaim(
  content: string,
  mutationsRun: readonly string[],
  verificationsRun: readonly string[],
): boolean {
  const text = (content || '').trim();
  if (!text) return false;
  // Nothing was changed → no code-change claim can be "unverified".
  if (!mutationsRun.some(isMutationTool)) return false;
  // Something observed the artifact → the claim is grounded.
  if (verificationsRun.some(isVerificationTool)) return false;

  const sentences = text.split(/(?<=[.!?\u3002\uff01\uff1f])\s+|\n+/);
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s || NON_CLAIM_CONTEXT_RE.test(s)) continue;
    if (EDIT_CLAIM_RES.some((re) => re.test(s))) return true;
  }
  return false;
}

/**
 * The nudge sent when a turn mutated the workspace and verified nothing.
 * Deliberately concrete (names the tools) so a weak model can act on it
 * without inventing a syntax — the same principle as `TOOL_FALLBACK_HINTS`.
 */
export const VERIFICATION_NUDGE =
  'You changed files this turn but nothing VERIFIED the change — an edit is not ' +
  'evidence that it works. Before finishing, run the check that actually observes ' +
  'the artifact (e.g. run_terminal for a typecheck/test/build, the test pipeline, ' +
  'or a browser run), then report what that check showed. If no such check is ' +
  'possible here, say so explicitly and do NOT claim the change works.';

/**
 * The nudge sent when a turn ended asking PERMISSION for work the user's own
 * request already authorized (G13 — the manual-cadence complaint).
 *
 * Deliberately states the authorization and the expected behaviour, and names
 * the one case where asking is still right, so the model does not read this as
 * "never consult" — a blanket no-asking rule would produce silent wrong turns
 * instead of stalls, which is worse. The vocabulary is the autonomy policy's:
 * proceed unless the decision is blocking, high-impact, irreversible and has
 * no sensible default.
 */
export const AUTHORIZED_WORK_NUDGE =
  'The user\u2019s own request already asked for this work, so asking whether to ' +
  'proceed is a round trip that delivers nothing. Do NOT end the turn on a request ' +
  'for permission: carry the work out with the tools available, decide anything that ' +
  'is yours to decide, and state the decision in your answer so the user can redirect. ' +
  'Reserve `ask_user` for a decision that is genuinely theirs — one that cannot ' +
  'proceed without an answer, is high-impact and irreversible, and has no sensible ' +
  'default — and never ask for permission in plain text.';

/**
 * The nudge sent when the request asked for an AUTHORED deliverable to be
 * produced and the turn ended having written nothing to disk (G13b).
 *
 * WHY THIS IS NOT THE EXISTING DANGLING-PROMISE NUDGE. That one fires when the
 * model announces an action and does nothing — it keys on the model's closing
 * line. The failure here is quieter and was the one that shipped a 12-page story
 * into a chat window: the model DID the work, in prose, and simply never wrote
 * it anywhere. There is no promise to detect and no missing tool call to point
 * at, so the gate has to key on the REQUEST and the ABSENCE of a file.
 *
 * It names the destination when the request gave one ("write it to the path the
 * request named") because "write it somewhere" leaves the model free to answer
 * with a filename it invented; it also says plainly that composing the text was
 * not enough, since that is exactly what the model believes it already did.
 */
export function deliverableNudge(requestedPath?: string): string {
  const destination = requestedPath
    ? `the request named the destination \u2014 write the complete work to ${requestedPath}`
    : 'write the complete work to a file (naming it after the deliverable) in the workspace';
  return (
    'The request asked for a written deliverable to be PRODUCED, and you composed the text in your ' +
    'reply but wrote no file \u2014 so nothing has been delivered. Composing it in the answer does not ' +
    'satisfy the request: ' + destination + ', using write_file. The request itself already authorised ' +
    'this, so do not stop to ask. When the file is written, say which path it landed at.'
  );
}

/**
 * The correction appended to a delivered answer whose code-change claim was
 * never verified. Kept short and honest — it states what is known, not a
 * verdict about whether the edit is correct.
 */
export const UNVERIFIED_EDIT_NOTE =
  '\u26a0\ufe0f Note: files were changed this turn but no verification (test / ' +
  'typecheck / build / browser run) confirmed the result — treat the claim above ' +
  'as unverified.';
