/**
 * Harness directives — how the loop SPEAKS to the model about a gate it hit.
 *
 * WHY THIS EXISTS. Every gate that nudges the turn — "declare a plan first",
 * "files changed and nothing observed the result", "you announced an action but
 * did nothing" — used to be pushed into the thread as a `user` message. A chat
 * model is trained to ANSWER a user turn, so the model replied to the harness:
 * it narrated the interruption back at the user ("the earlier grep was blocked
 * as state-changing…") instead of silently acting on it. On a surface that also
 * shows those gate events, that narration is what reads as an "agent vs model"
 * struggle — a second voice the user can hear, when there is only one.
 *
 * WHAT THIS IS. A single delivery channel for harness-authored instructions:
 *
 *   - they are `system`-role, not `user`-role, so they read as a directive the
 *     model acts on rather than a conversation partner it answers;
 *   - they are prefixed with a fixed `[harness]` marker, so a model — and a
 *     reader of the trace — can tell the loop's own voice from the user's;
 *   - they are DEDUPED by gate within a turn, so the same instruction cannot be
 *     re-injected and read as nagging.
 *
 * The gate text itself is unchanged; only who is seen to be speaking changes.
 */

import type { ToolMessage } from '../inference/interface.js';

/** The fixed marker that precedes every harness-authored directive. */
export const HARNESS_MARKER = '[harness]';

/** One harness directive, as it is placed on the wire. */
export function harnessDirective(content: string): ToolMessage {
  return { role: 'system', content: `${HARNESS_MARKER} ${content}` };
}

export interface HarnessDirectiveSink {
  /**
   * Push a directive ONCE per turn. Returns false when this gate has already
   * spoken this turn (nothing is pushed), so a repeated nudge cannot nag.
   */
  push(thread: ToolMessage[], gate: string, content: string): boolean;
  /** Has this gate already delivered a directive this turn? */
  has(gate: string): boolean;
  /** The gates that have spoken, in order — for the turn report / tests. */
  deliveredGates(): string[];
}

/** A fresh per-turn sink (one turn = one sink; dedupe is scoped to it). */
export function createHarnessDirectiveSink(): HarnessDirectiveSink {
  const delivered = new Set<string>();
  return {
    push(thread, gate, content) {
      if (delivered.has(gate)) return false;
      delivered.add(gate);
      thread.push(harnessDirective(content));
      return true;
    },
    has: (gate) => delivered.has(gate),
    deliveredGates: () => [...delivered],
  };
}
