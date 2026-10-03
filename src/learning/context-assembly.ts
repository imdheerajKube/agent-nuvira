/**
 * Context assembly (P5, scoped) — the SINGLE place the CROSS-SESSION memory block
 * is composed for every surface.
 *
 * WHY THIS EXISTS. The loop engine (`tools/loop-project-context.ts`) and the
 * orchestrator engine (`agents/prompt-assembly.ts`) each built their own ambient
 * context. They already shared the WORKING-STATE and HAND-OFF leaf helpers, but
 * the cross-session memory (the recent-asks digest, and the opt-in semantic
 * recall) reached only the loop — so an orchestrator turn in the same project saw
 * less history than a loop turn, for no reason other than where the code lived.
 * This module is the one composer both call, so the two engines cannot drift
 * again, and a golden test (`tests/agents/context-assembly-parity.test.ts`) pins
 * that the same project yields the same block on either surface.
 *
 * ADVISORY ONLY, ALWAYS. Both blocks are history, self-labelled as such: nothing
 * here is read to decide completion — that still derives from artifacts on disk.
 *
 * Best-effort throughout: a digest read or a recall failure yields '' or a
 * partial block, never a broken turn.
 */

import { formatSessionDigest } from './session-digest.js';
import { formatSessionRecall, recallPastSessions } from './session-recall.js';

/**
 * The SYNCHRONOUS cross-session block: the deterministic recent-asks digest.
 * This is what a synchronous assembler (the orchestrator's assessment) can adopt
 * without introducing an embedding round-trip into a prompt build.
 */
export function formatCrossSessionMemorySync(projectPath: string): string {
  try {
    return formatSessionDigest(projectPath);
  } catch {
    return '';
  }
}

/**
 * The FULL cross-session block: the digest, plus (only when the deployment asks
 * for it) the semantically similar past asks for THIS goal. The recall half is
 * async and opt-in, so a caller that omits `goal` — or a deployment that never
 * sets `NUVIRA_SESSION_RECALL` — gets exactly the synchronous block.
 */
export async function formatCrossSessionMemory(
  projectPath: string,
  opts: { goal?: string; sessionRecall?: boolean } = {},
): Promise<string> {
  const parts: string[] = [];
  const digest = formatCrossSessionMemorySync(projectPath);
  if (digest) parts.push(digest);

  if (opts.goal) {
    try {
      const hits = await recallPastSessions(opts.goal, {
        projectPath,
        ...(opts.sessionRecall === undefined ? {} : { enabled: opts.sessionRecall }),
      });
      const recall = formatSessionRecall(hits, { projectPath });
      if (recall) parts.push(recall);
    } catch {
      // Best-effort — the digest still stands on its own.
    }
  }
  return parts.join('\n');
}
