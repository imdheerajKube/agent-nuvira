/**
 * Explicit skill requests (`src/learning/skill-request.ts`).
 *
 * The model-driven catalog is the right default: the model reads the task and
 * decides whether a skill genuinely applies. But a user can also SAY which skill
 * they want — "use the rag-pipeline skill" — and on that path the harness used
 * to leave the whole request to the same optional model choice. A weak model
 * could then ignore a direct instruction with nothing on screen to show it.
 *
 * This module detects only that narrow case: an EXACT catalog name inside a
 * request clause ("use/apply/follow/load ... skill"). It is not a relevance
 * scorer and it is not a keyword match for the task. If the user does not ask
 * for a named skill, it returns nothing. If the user asks for one that does not
 * fit, the loaded block still requires a relevance check and an explicit reason
 * for skipping it; the model is never forced to apply an irrelevant skill.
 */

/** Words that turn a mention into a request to use the named skill. */
const REQUEST_CUE =
  /\b(?:use|using|apply|applying|follow|following|load|loading|invoke|invoking|run|running|try|trying|leverage|leveraging|adopt|adopting)\b/;

/** Words that mean the user is rejecting/skipping the skill, not requesting it. */
const NEGATIVE_CUE = /\b(?:not|never|don't|do not|without|avoid|skip|skipping|ignore|ignoring)\b/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a boundary-safe pattern for a catalog name.
 *
 * Hyphen/space/underscore are interchangeable so "rag-pipeline" and "RAG
 * pipeline" both resolve to the same installed skill. The surrounding guard
 * prevents a short name from matching inside a longer word.
 */
function namePattern(name: string): string {
  const parts = name
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter(Boolean);
  return parts.map(escapeRegExp).join('[\\s_-]+');
}

/** Start of the clause containing `before` (used to find the request cue). */
function clauseStart(text: string): number {
  const boundary = Math.max(
    text.lastIndexOf('.'),
    text.lastIndexOf('!'),
    text.lastIndexOf('?'),
    text.lastIndexOf('\n'),
    text.lastIndexOf(';'),
  );
  return boundary + 1;
}

/**
 * The names the user explicitly asked to use, in catalog order.
 *
 * Deliberately conservative:
 *   - the exact skill name (or its spaced spelling) must appear;
 *   - the same clause must carry a request cue, or the name must directly
 *     follow one;
 *   - a negation near the name ("don't use X", "X, not Y") excludes it;
 *   - a plain mention ("what is the rag-pipeline skill?") is not a request.
 */
export function detectRequestedSkillNames(
  message: string,
  availableNames: readonly string[],
): string[] {
  const text = String(message ?? '');
  if (!text.trim()) return [];
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  const requested: string[] = [];

  for (const rawName of availableNames) {
    const name = String(rawName ?? '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    const pattern = namePattern(name);
    if (!pattern) continue;

    const re = new RegExp(`(^|[^a-z0-9_-])${pattern}(?=$|[^a-z0-9_-])`, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(lower)) !== null) {
      const tokenStart = match.index + match[1].length;
      const tokenEnd = tokenStart + match[0].length - match[1].length;
      const before = lower.slice(Math.max(0, tokenStart - 180), tokenStart);
      const after = lower.slice(tokenEnd, tokenEnd + 80);

      // Check negation only in the local predicate. This keeps
      // "don't use X, use Y" from poisoning Y while still rejecting
      // "use X, not Y".
      const localBefore = before.slice(-48);
      const lastComma = localBefore.lastIndexOf(',');
      const predicate = lastComma >= 0 ? localBefore.slice(lastComma + 1) : localBefore;
      if (NEGATIVE_CUE.test(predicate)) continue;

      const clause = before.slice(clauseStart(before));
      const cue = REQUEST_CUE.test(clause) || REQUEST_CUE.test(after.slice(0, 48));
      if (!cue) continue;

      const namesSkill =
        /\bskills?\b/.test(clause) || /\bskills?\b/.test(after.slice(0, 48));
      // Without the word "skill", require the name to directly follow a
      // request verb ("use rag-pipeline"), not merely share a clause with one.
      const directCue =
        /\b(?:use|using|apply|applying|follow|following|load|loading|invoke|invoking|run|running|try|trying|leverage|leveraging|adopt|adopting)\b[^.!?\n;]{0,45}$/.test(
          before,
        );
      if (!namesSkill && !directCue) continue;

      seen.add(name.toLowerCase());
      requested.push(name);
      break;
    }
  }

  return requested;
}
