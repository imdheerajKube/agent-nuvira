/**
 * Task-level model CONTINUITY (fix_model_routing P3, RC7).
 *
 * WHY THIS EXISTS. Routing is decided PER TURN, and for a continuation the turn
 * text is signal-free: "resume", "continue", "go on". `continuationSoftwareText`
 * already rescues the ROUTING by scoring the ask the continuation continues — but
 * the DECISION is then re-made from scratch, so a task that was being served by
 * a model that demonstrably worked can be handed, on its very next turn, to a
 * model that has never touched it (and, in the live case, to one that returns
 * nothing at all). The user sees a working run "resume" and die.
 *
 * The rule this module implements is the one a competent operator follows: when
 * you pick up a task someone was already making progress on, you go back to the
 * same worker if they are still available. Continuity is therefore a PREFERENCE,
 * never a constraint — the remembered pair is offered FIRST and the ordinary
 * routing pool stands behind it, so a model that has since died, been parked or
 * lost its key costs one check and is skipped (the caller re-validates before
 * using it; this module only remembers).
 *
 * What it is NOT: a pin. It never overrides the user's explicit provider/model,
 * and it never bypasses the governance or capability gates the router applies —
 * the caller checks those and falls back to the normal walk.
 *
 * Scope: deliberately IN-MEMORY, per process/session. A memory is a fact about
 * the run in front of us, and writing it to disk would make yesterday's model a
 * silent preference in a fresh session with different credentials.
 */

/** A model that produced usable work for a task signature. */
export interface RememberedServingModel {
  provider: string;
  model: string;
  /** The task signature this pair served (see {@link taskSignature}). */
  signature: string;
  /** When it last served that task (ms epoch). */
  servedAt: number;
}

/**
 * How long a memory is good for. Long enough to cover a real working session
 * (including a pause while the user reads the result), short enough that a stale
 * preference cannot outlive the task it belonged to.
 */
export const TASK_CONTINUITY_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * The identity of a TASK, as far as model continuity is concerned: what kind of
 * work it is and how hard it is. Deliberately NOT the raw prompt text — a
 * continuation re-states the task in different words ("resume" vs the original
 * sentence), so a text key would never match, while intent+complexity does,
 * because both are derived from the SAME ask (the continuation's routing text is
 * the prior software ask).
 *
 * Unknown parts stay unknown and are named `general`/`unknown` rather than
 * dropped, so two turns that both failed to classify still match each other
 * instead of silently forming an empty key.
 */
export function taskSignature(
  intent: string | undefined | null,
  complexity: string | undefined | null,
): string {
  const i = (intent ?? '').trim().toLowerCase() || 'general';
  const c = (complexity ?? '').trim().toLowerCase() || 'unknown';
  return `${i}|${c}`;
}

/**
 * The per-session memory. Bounded by construction: one entry per task signature
 * (a re-serve REPLACES rather than stacks), and a signature is a coarse class,
 * not a prompt.
 */
export class TaskModelContinuity {
  private bySignature = new Map<string, RememberedServingModel>();

  /** Record the pair that just produced usable work for this task. */
  remember(
    signature: string,
    provider: string,
    model: string,
    now: number = Date.now(),
  ): void {
    if (!signature || !provider || !model || model === 'default') return;
    this.bySignature.set(signature, { provider, model, signature, servedAt: now });
  }

  /** The remembered pair for this task, or null when there is none / it is stale. */
  recall(signature: string, now: number = Date.now()): RememberedServingModel | null {
    const entry = this.bySignature.get(signature);
    if (!entry) return null;
    if (now - entry.servedAt > TASK_CONTINUITY_TTL_MS) {
      this.bySignature.delete(signature);
      return null;
    }
    return entry;
  }

  /** Forget one task (used when the remembered pair turns out to be unusable). */
  forget(signature: string): void {
    this.bySignature.delete(signature);
  }

  /** How many tasks are remembered — telemetry/tests. */
  size(): number {
    return this.bySignature.size;
  }

  clear(): void {
    this.bySignature.clear();
  }
}
