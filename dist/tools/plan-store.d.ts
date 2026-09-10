/**
 * P0.7 — Plan store (creating AND tracking plans).
 *
 * The chat agent's plan/todo capability: the model declares ordered steps
 * (id + description), updates their status as work progresses
 * (pending → running → done/blocked), and can reference the plan on a LATER
 * turn ("step 3 is done" — the store outlives a single tool call).
 *
 * The store is deliberately tiny and dependency-free. The orchestrator's
 * internal planner stays untouched — this is the CHAT-loop surface (the
 * dashboard chat renders it as a live checklist card).
 *
 * Lifecycle: the ToolContext carries an OPTIONAL `planStore`; chat.ts owns
 * one per ChatCommand instance (default) and the dashboard console injects a
 * per-session store so plans never leak across conversations. A tool run
 * without a store falls back to a shared module-level store (best-effort —
 * the tool must never throw on a missing store).
 */
/** Step statuses the model can set (pending is the default on create). */
export type PlanStepStatus = 'pending' | 'running' | 'done' | 'blocked';
/** One ordered step in a plan. */
export interface PlanStep {
    id: string;
    description: string;
    status: PlanStepStatus;
}
/** The whole plan — goal + ordered steps. */
export interface Plan {
    goal: string;
    steps: PlanStep[];
    /** Monotonic revision so the GUI can order plan:changed events. */
    revision: number;
    updatedAt: number;
}
/** The structured payload the GUI renders (SSE `plan` event / chat-console). */
export interface PlanSnapshot {
    goal: string;
    steps: PlanStep[];
    revision: number;
}
/** A store must be able to hand back its current state (or undefined). */
export interface PlanStoreLike {
    snapshot(): Plan | null;
    create(goal: string, steps: Array<{
        id: string;
        description: string;
    }>): Plan;
    update(id: string, status: PlanStepStatus): Plan | null;
    /** Structured GUI snapshot (plan_todo emits it via plan:changed). */
    toGUI?(): PlanSnapshot | null;
    /** Human-readable checklist text (the model's tool result). */
    toText?(): string;
}
export declare class PlanStore implements PlanStoreLike {
    private plan;
    /** The current plan (null when none was created yet). */
    snapshot(): Plan | null;
    /** A GUI-friendly snapshot (same shape, no internals). */
    toGUI(): PlanSnapshot | null;
    /**
     * Create (or REPLACE) the plan. Idempotent: re-declaring steps is the
     * model's way to correct course — a fresh declaration supersedes the old.
     */
    create(goal: string, steps: Array<{
        id: string;
        description: string;
    }>): Plan;
    /** Mark one step's status. Unknown id → no-op (returns the unchanged plan). */
    update(id: string, status: PlanStepStatus): Plan | null;
    /** Human-readable text the model sees as the tool result. */
    toText(): string;
}
export declare function defaultPlanStore(): PlanStoreLike;
//# sourceMappingURL=plan-store.d.ts.map