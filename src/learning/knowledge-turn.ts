/**
 * Knowledge TURN wiring (`src/learning/knowledge-turn.ts`) — the deterministic,
 * tag-scoped pre-step for a chat turn.
 *
 * WHY THIS EXISTS. `knowledge-base.ts` is the STORE, and the `knowledge` tool
 * lets the model drive it mid-task. Neither answers "answer from THIS document",
 * because that shape makes the model the trigger: it has to know the tag exists
 * and decide to use it, and a wrong guess is a silent answer from the wrong
 * corpus. Here a message that OPENS with a resolvable tag has that tag's
 * relevant passages retrieved and placed in front of the model BEFORE it sees
 * the question. The trigger is syntax, not judgement — which is what makes it
 * deterministic, explainable, and testable.
 *
 * THE CAPABILITY GUARANTEE (the whole point of this module). It is INERT unless
 * the message opens with a marker that resolves to a tag the user actually has:
 *
 *   - no marker, or no tags at all → `block: ''`, NO embedder call, and the turn
 *     is byte-identical to one from a build without this feature;
 *   - marker names an unknown tag → a short "no such tag" note, and the question
 *     is answered normally — the wrong corpus is never substituted;
 *   - tag exists but nothing clears the relevance floor → a note saying the
 *     tagged documents did not cover it, which is the honest answer;
 *   - any failure at all → `block: ''` (best-effort, mirroring the ambient
 *     project-context contract in `src/tools/loop-project-context.ts`).
 *
 * So it cannot add cost, latency, noise, or a wrong corpus to a turn that did
 * not ask for it. And because the block is a USER-TURN message (never the system
 * prompt), the prompt stays byte-stable and therefore cacheable — the same rule
 * the channel-policy block follows in `src/cli/chat.ts`.
 *
 * WHERE IT RUNS. One seam — `runChatAnswer` in `src/cli/chat.ts` — is shared by
 * the CLI, the dashboard console (`debugSurface: 'dashboard-chat'`) and the
 * gateway (`gateway-chat`), so all three surfaces get the same behaviour and
 * cannot drift.
 *
 * THE MARKER. `#tag` as the FIRST token, followed by whitespace or end of input.
 * A leading `/` is already the interactive chat's command prefix, so it is not
 * used here. The whole-word requirement plus requiring the tag to start with a
 * LETTER is what keeps `#1 priority`, a Markdown heading (`# Title`), a shebang
 * (`#!/bin/bash`), and mid-sentence `C#` from resolving. A pasted `#include`
 * DOES parse as the tag name `include` — which is exactly why an unknown marker
 * only ever produces a note, and why the whole feature is inert until the user
 * has at least one tag of their own.
 */

import {
  formatKnowledgeContext,
  listKnowledgeTags,
  normalizeKnowledgeTag,
  queryKnowledge,
  type KnowledgeOptions,
  type KnowledgeTagEntry,
} from './knowledge-base.js';
import { logger } from '../utils/logger.js';

/**
 * The marker: `#tag` as the first token. The tag must begin with a LETTER (so
 * `#1`, `#!`, and `#/` cannot match) and must end at whitespace or end-of-input
 * (so `#fff,` does not run on into the sentence).
 */
export const KNOWLEDGE_MARKER_RE = /^\s*#([A-Za-z][A-Za-z0-9_-]*)(?=\s|$)/;

/**
 * Hard cap on the injected block. `topK` already bounds the chunk COUNT, but a
 * pathological document set could still produce a large block, and a context
 * block must never crowd out the ask it was meant to help answer. Truncation is
 * explicit, never silent.
 */
export const MAX_KNOWLEDGE_BLOCK_CHARS = 12_000;

/** How many candidates a "did you mean" note may name. */
export const MAX_TAG_SUGGESTIONS = 3;

/** How the marker was handled. `none` means the turn is untouched. */
export type KnowledgeTurnOutcome = 'none' | 'matched' | 'empty' | 'unknown-tag';

export interface KnowledgeTurnContext {
  /** The block to inject as a user-turn message — `''` when nothing applies. */
  block: string;
  /** The tag that resolved, when one did. */
  tag?: string;
  outcome: KnowledgeTurnOutcome;
}

/** The tag a message opens with, normalized, or null when it opens with none. */
export function parseKnowledgeMarker(message: string): string | null {
  const match = KNOWLEDGE_MARKER_RE.exec(message);
  if (!match) return null;
  const tag = normalizeKnowledgeTag(match[1]);
  return tag.length > 0 ? tag : null;
}

/**
 * The message with its leading marker removed — the marker is retrieval syntax,
 * not part of the question, and leaving `#tag` in the text it is embedded from
 * would nudge the query vector toward the tag token instead of the ask.
 */
export function stripKnowledgeMarker(message: string): string {
  const match = KNOWLEDGE_MARKER_RE.exec(message);
  if (!match) return message;
  return message.slice(match[0].length).trimStart();
}

/** Bounded Levenshtein distance — tags are short, so this is cheap and exact. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length];
}

/**
 * "Did you mean" candidates for an unknown tag, best first.
 *
 * A prefix relationship is the common typo ("spec" for "spec-v2") and is worth
 * naming even when the edit distance is larger than the cap. Suggestion only —
 * nothing here ever substitutes one tag for another.
 */
export function suggestKnowledgeTags(unknown: string, tags: KnowledgeTagEntry[]): string[] {
  const target = normalizeKnowledgeTag(unknown);
  if (!target) return [];
  const maxDistance = target.length <= 4 ? 1 : 2;
  return tags
    .map((entry) => {
      const candidate = entry.tag;
      return {
        tag: candidate,
        distance: editDistance(target, candidate),
        prefix: candidate.startsWith(target) || target.startsWith(candidate),
      };
    })
    .filter((c) => c.prefix || c.distance <= maxDistance)
    .sort((a, b) => (a.prefix === b.prefix ? a.distance - b.distance : a.prefix ? -1 : 1))
    .slice(0, MAX_TAG_SUGGESTIONS)
    .map((c) => c.tag);
}

/** Honest, explicit truncation of an over-long block. */
function capBlock(block: string): string {
  if (block.length <= MAX_KNOWLEDGE_BLOCK_CHARS) return block;
  return `${block.slice(0, MAX_KNOWLEDGE_BLOCK_CHARS)}\n[... knowledge context truncated at ${MAX_KNOWLEDGE_BLOCK_CHARS} characters ...]`;
}

/**
 * Build the knowledge block for a turn. Never throws, never blocks a turn on a
 * failure, and returns an empty block unless the message genuinely asked for a
 * tag the user has.
 */
export async function buildKnowledgeTurnContext(
  message: string,
  opts: KnowledgeOptions = {},
): Promise<KnowledgeTurnContext> {
  try {
    const marker = parseKnowledgeMarker(message);
    if (!marker) return { block: '', outcome: 'none' };

    const tags = listKnowledgeTags();
    // No tags at all: the feature is inert. Without this, a stray leading
    // `#word` (a pasted `#include`, a `#fff` colour) would produce a note about
    // a corpus that does not exist.
    if (tags.length === 0) return { block: '', outcome: 'none' };

    const match = tags.find((entry) => entry.tag === marker);
    if (!match) {
      const suggestions = suggestKnowledgeTags(marker, tags);
      const hint =
        suggestions.length > 0
          ? ` Did you mean ${suggestions.map((s) => `#${s}`).join(' or ')}?`
          : ` Known tags: ${tags
              .slice(0, MAX_TAG_SUGGESTIONS * 2)
              .map((t) => `#${t.tag}`)
              .join(', ')}.`;
      return {
        block:
          `[Knowledge] No knowledge tag '#${marker}'.${hint} ` +
          'Answer the question from your own knowledge — do not guess at documents the user has not tagged.',
        outcome: 'unknown-tag',
      };
    }

    const question = stripKnowledgeMarker(message) || message;
    const hits = await queryKnowledge(match.tag, question, opts);
    if (hits.length === 0) {
      // The relevance floor dropped everything. This is the honest case the
      // store could not previously express, and it must NOT be softened into a
      // general answer read off the tagged documents.
      return {
        block:
          `[Knowledge] Tag '#${match.tag}' has ${match.chunkCount} indexed chunk(s), but none matched this ` +
          'question closely enough to be used. Answer from your own knowledge and say the tagged documents did not cover it.',
        outcome: 'empty',
        tag: match.tag,
      };
    }

    return {
      block: capBlock(`[Knowledge] ${formatKnowledgeContext(match.tag, hits)}`),
      outcome: 'matched',
      tag: match.tag,
    };
  } catch (err) {
    // Best-effort, exactly like the ambient project context: a retrieval failure
    // must never break or delay the turn's actual answer.
    logger.debug(`Knowledge turn context failed: ${err instanceof Error ? err.message : err}`);
    return { block: '', outcome: 'none' };
  }
}
