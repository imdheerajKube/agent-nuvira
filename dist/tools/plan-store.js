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
const VALID_STATUSES = ['pending', 'running', 'done', 'blocked'];
export class PlanStore {
    plan = null;
    /** The current plan (null when none was created yet). */
    snapshot() {
        return this.plan ? { ...this.plan, steps: this.plan.steps.map((s) => ({ ...s })) } : null;
    }
    /** A GUI-friendly snapshot (same shape, no internals). */
    toGUI() {
        const p = this.snapshot();
        return p ? { goal: p.goal, steps: p.steps, revision: p.revision } : null;
    }
    /**
     * Create (or REPLACE) the plan. Idempotent: re-declaring steps is the
     * model's way to correct course — a fresh declaration supersedes the old.
     */
    create(goal, steps) {
        const cleanSteps = (steps ?? []).map((s, i) => ({
            id: String(s?.id ?? `step-${i + 1}`),
            description: String(s?.description ?? '').trim(),
            status: 'pending',
        })).filter((s) => s.description.length > 0);
        this.plan = {
            goal: String(goal ?? '').trim() || '(untitled plan)',
            steps: cleanSteps,
            revision: (this.plan?.revision ?? 0) + 1,
            updatedAt: Date.now(),
        };
        return this.snapshot();
    }
    /** Mark one step's status. Unknown id → no-op (returns the unchanged plan). */
    update(id, status) {
        if (!this.plan)
            return null;
        if (!VALID_STATUSES.includes(status))
            return this.snapshot();
        let changed = false;
        for (const step of this.plan.steps) {
            if (step.id === id) {
                if (step.status !== status)
                    changed = true;
                step.status = status;
            }
        }
        if (changed) {
            this.plan.revision += 1;
            this.plan.updatedAt = Date.now();
        }
        return this.snapshot();
    }
    /** Human-readable text the model sees as the tool result. */
    toText() {
        const p = this.plan;
        if (!p)
            return 'No plan yet — call plan_todo with action "create" and the steps to start one.';
        const done = p.steps.filter((s) => s.status === 'done').length;
        const icon = (s) => (s === 'done' ? '✅' : s === 'running' ? '🔄' : s === 'blocked' ? '⛔' : '⬜');
        const lines = p.steps.map((s) => `  ${icon(s.status)} [${s.id}] ${s.description} (${s.status})`);
        return `📋 Plan: ${p.goal} — ${done}/${p.steps.length} done\n${lines.join('\n')}`;
    }
}
/**
 * Shared fallback store — used when a tool runs without an injected store
 * (never throws). The dashboard console injects per-session stores, so this
 * is only the CLI/execute default path.
 */
const sharedStore = new PlanStore();
export function defaultPlanStore() {
    return sharedStore;
}
//# sourceMappingURL=plan-store.js.map