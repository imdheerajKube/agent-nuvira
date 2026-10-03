/**
 * Plan-quality assessment (G5) — deterministic, LLM-free.
 *
 * WHY THIS EXISTS
 * ---------------
 * The plan is the highest-leverage artifact in a pipeline run: every downstream
 * step inherits its dependency graph. A weak planner produces two failure
 * shapes observed in practice —
 *   1. structurally broken graphs (a step that depends on itself, a dependency
 *      on a step that does not exist, or a cycle), which the orchestrator can
 *      only resolve by failing steps it could otherwise have run; and
 *   2. steps that NAME a deliverable in prose but declare no `expectedFiles`,
 *      so the artifact check (Part 1/Part 2's whole subject) has nothing to
 *      verify and a step can "succeed" without producing its file — exactly the
 *      live NVDA-addon failure.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It never invents or deletes work. The only CORRECTION it applies is dropping
 * a SELF-dependency (a step depending on itself is unambiguously a bug and would
 * deadlock its own step). Everything else is reported as an ADVISORY, because a
 * dangling or cyclic dependency can also mean a genuinely missing step — hiding
 * that behind a silent "fix" would trade one falsehood for another.
 *
 * Deterministic and dependency-free by design (like the other ledgers), so it is
 * cheap to call per plan and trivial to test.
 */

/** The step shape this assessor needs — a structural subset of `TaskStep`. */
export interface PlanQualityStep {
  id: string;
  description: string;
  agentType: string;
  dependsOn: string[];
  expectedFiles?: string[];
}

export type PlanQualityIssueKind =
  | 'self-dependency'
  | 'dangling-dependency'
  | 'cycle'
  | 'duplicate-step'
  | 'undeclared-artifact';

export interface PlanQualityIssue {
  kind: PlanQualityIssueKind;
  /** The step the issue is about (absent for a whole-plan issue like a cycle). */
  stepId?: string;
  /** One line naming the problem, for the planner log / trace. */
  message: string;
}

export interface PlanQualityReport {
  issues: PlanQualityIssue[];
  /** Model/user-facing advisories (bounded, deduped). Empty for a clean plan. */
  advisories: string[];
  /**
   * The plan with SAFE corrections applied — currently, self-dependencies
   * removed. Order and all other fields are preserved.
   */
  steps: PlanQualityStep[];
}

/** Agent types whose step is expected to PRODUCE files. */
const PRODUCING_AGENTS = new Set(['writer', 'runner', 'delegate']);

/**
 * A file-looking token in a step description. Deliberately specific (a known
 * extension, or a path with a slash and an extension) so ordinary prose
 * ("create the page") is not mistaken for a declared artifact.
 */
const ARTIFACT_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|json|ya?ml|toml|ini|cfg|md|txt|sh|sql|html|css|scss|zip|whl|tgz|tar\.gz|nvda-addon|vsix|jar|pdf)\b/i;

/** Bound on advisories surfaced per plan, so a pathological plan adds no wall. */
const MAX_ADVISORIES = 6;

/**
 * Assess a plan. Pure: same input → same output; never throws.
 */
export function assessPlanQuality(steps: readonly PlanQualityStep[]): PlanQualityReport {
  const issues: PlanQualityIssue[] = [];
  const advisories: string[] = [];
  const push = (issue: PlanQualityIssue): void => {
    issues.push(issue);
  };

  try {
    const byId = new Map<string, PlanQualityStep>();
    for (const s of steps) if (s && typeof s.id === 'string') byId.set(s.id, s);

    // ── Per-step structural checks ─────────────────────────────────────────
    const corrected: PlanQualityStep[] = [];
    for (const s of steps) {
      if (!s || typeof s.id !== 'string') {
        corrected.push(s);
        continue;
      }
      const deps = Array.isArray(s.dependsOn) ? s.dependsOn : [];
      const selfDeps = deps.filter((d) => d === s.id);
      if (selfDeps.length > 0) {
        push({ kind: 'self-dependency', stepId: s.id, message: `'${s.id}' depends on itself — removed` });
      }
      const dangling = deps.filter((d) => d !== s.id && !byId.has(d));
      for (const d of dangling) {
        push({ kind: 'dangling-dependency', stepId: s.id, message: `'${s.id}' depends on unknown step '${d}'` });
      }
      // Safe correction: drop self-deps only.
      corrected.push({ ...s, dependsOn: deps.filter((d) => d !== s.id) });
    }

    // ── Duplicate descriptions (LLM repetition) ────────────────────────────
    const seenDesc = new Map<string, string>();
    for (const s of steps) {
      if (!s || typeof s.id !== 'string') continue;
      const key = (s.description || '').trim().toLowerCase();
      if (!key) continue;
      const prev = seenDesc.get(key);
      if (prev) {
        push({ kind: 'duplicate-step', stepId: s.id, message: `'${s.id}' repeats the description of '${prev}'` });
      } else {
        seenDesc.set(key, s.id);
      }
    }

    // ── Cycles (Kahn): ids that never reach in-degree 0 are in a cycle ─────
    // Operates on the CORRECTED deps (self-loops already removed).
    const ids = corrected.filter((s) => s && typeof s.id === 'string').map((s) => s.id);
    const indeg = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const id of ids) {
      indeg.set(id, 0);
      adj.set(id, []);
    }
    for (const s of corrected) {
      for (const d of s.dependsOn ?? []) {
        if (!adj.has(s.id) || !indeg.has(d)) continue; // dangling → not part of the graph
        adj.get(d)!.push(s.id);
        indeg.set(s.id, (indeg.get(s.id) ?? 0) + 1);
      }
    }
    const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
    let resolved = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      resolved += 1;
      for (const next of adj.get(id) ?? []) {
        const remaining = (indeg.get(next) ?? 0) - 1;
        indeg.set(next, remaining);
        if (remaining === 0) queue.push(next);
      }
    }
    if (resolved < ids.length) {
      const cyclic = ids.filter((id) => (indeg.get(id) ?? 0) > 0);
      push({ kind: 'cycle', message: `dependency cycle among: ${cyclic.join(', ')}` });
    }

    // ── Undeclared artifacts (the Part 1/Part 2 blind spot) ────────────────
    for (const s of steps) {
      if (!s || typeof s.id !== 'string') continue;
      if (!PRODUCING_AGENTS.has(s.agentType)) continue;
      const declared = Array.isArray(s.expectedFiles) ? s.expectedFiles.filter(Boolean) : [];
      if (declared.length > 0) continue;
      if (ARTIFACT_RE.test(s.description || '')) {
        push({
          kind: 'undeclared-artifact',
          stepId: s.id,
          message: `'${s.id}' names a deliverable but declares no expectedFiles — it cannot be verified`,
        });
      }
    }

    // ── Bounded, deduped advisories ────────────────────────────────────────
    for (const issue of issues) {
      if (advisories.length >= MAX_ADVISORIES) break;
      const line = `⚠️ plan: ${issue.message}`;
      if (!advisories.includes(line)) advisories.push(line);
    }

    return { issues, advisories, steps: corrected };
  } catch {
    // Never let an assessment break planning.
    return { issues: [], advisories: [], steps: [...steps] };
  }
}
