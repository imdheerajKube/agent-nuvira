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
 * THE OBSERVATION CONTRACT (2026-10-27). A gate's fact is derived mechanically —
 * a regex over the ask, a static import scan, a filename convention. That kind of
 * derivation is right most of the time and WRONG for the task in front of it the
 * rest of the time, which is why a fixed checklist ("no README → write one") used
 * to fire on work where a README was never part of the deliverable. So every
 * directive carries the same standing invitation: the model is given the
 * observation and the right to judge it, and its answer is recorded instead of
 * being overruled. Nothing here is an order; a command's real output outranks all
 * of it. This is the difference between a cage and a colleague: the loop says what
 * it noticed, and the model decides what is true of THIS request.
 *
 * The gate text itself is unchanged; what changes is that it arrives as an
 * observation with an answer channel — plus who is seen to be speaking.
 */

import type { ToolMessage } from '../inference/interface.js';

/** The fixed marker that precedes every harness-authored directive. */
export const HARNESS_MARKER = '[harness]';

/**
 * The standing invitation appended to every directive.
 *
 * It says three things the model needs in order to reason rather than comply: the
 * text is an observation (not an instruction), disagreement with a reason is a
 * valid answer, and executed evidence outranks it. Kept short on purpose — it is
 * paid for on every gate.
 */
export const OBSERVATION_CONTRACT = [
  'This is an observation about this turn, not an order.',
  'Judge it against the actual request: if it applies, act on it now; if it does not apply to THIS request, say why in one line and continue — that is a valid answer, and this gate will not speak again this turn.',
  "Nothing here outranks the real output of a command you ran.",
].join(' ');

/** One directive the loop delivered, and what the model did with it. */
export interface HarnessObservation {
  gate: string;
  /** The gate's own text, without the marker or the contract. */
  directive: string;
  /** The model's first response after the directive, when it produced one. */
  answer?: string;
  /** Step index at which the directive was delivered (1-based), for ordering. */
  step?: number;
}

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
  /**
   * Record the model's response to the newest directive that has no answer yet.
   *
   * Deliberately parse-free: whatever the model said next IS its answer, whether
   * that is an action taken, a reason the observation does not apply, or both. A
   * parser would turn a valid judgment into a formatting failure, which is the
   * cage this whole channel exists to avoid.
   */
  answerLast(content: string, step?: number): void;
  /** Every directive this turn delivered, in order, with the answer if any. */
  observations(): HarnessObservation[];
}

/** A fresh per-turn sink (one turn = one sink; dedupe is scoped to it). */
export function createHarnessDirectiveSink(): HarnessDirectiveSink {
  const delivered = new Set<string>();
  const log: HarnessObservation[] = [];
  const trimAnswer = (text: string) => {
    const flat = text.trim().replace(/\s+/g, ' ');
    return flat.length > 600 ? `${flat.slice(0, 600)}…` : flat;
  };
  return {
    push(thread, gate, content) {
      if (delivered.has(gate)) return false;
      delivered.add(gate);
      thread.push(harnessDirective(`${content}\n\n${OBSERVATION_CONTRACT}`));
      log.push({ gate, directive: content });
      return true;
    },
    has: (gate) => delivered.has(gate),
    deliveredGates: () => [...delivered],
    answerLast(content, at) {
      const text = String(content ?? '').trim();
      if (!text) return;
      // The newest entry is the one the model just read: gates are pushed between
      // model calls, so "the directive without an answer" is always the tail.
      for (let i = log.length - 1; i >= 0; i -= 1) {
        if (log[i].answer === undefined) {
          log[i].answer = trimAnswer(text);
          if (at !== undefined) log[i].step = at;
          return;
        }
      }
    },
    observations: () => log.map((entry) => ({ ...entry })),
  };
}
