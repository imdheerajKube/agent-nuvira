/**
 * Requirement ledger — the ask's OWN numbered items, as rows a loop can check.
 *
 * WHY THIS EXISTS (measured 2026-10-25, three agents, one 30-minute build task).
 * agent-nuvira finished in 14 minutes with a green build, 22 passing tests and no
 * TODO/progress/changelog/README/e2e — although the prompt named all of them. The
 * cause was not capability: the loop had no representation of "what the request
 * asked for", so its only definition of done was "the model stopped calling
 * tools". `task-artifacts.ts` fixed the first specialisation of that (named files
 * and test classes); this module is the general one, so the same check works for
 * "run the tests and fix what fails", "add a webhook and prove it", or a spec with
 * a numbered list.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 * - It does not invent requirements. Only an EXPLICIT enumeration, an explicitly
 *   named artifact, or an explicitly named acceptance check becomes a row.
 * - It does not enforce what it cannot resolve. A behavioural row ("must support
 *   SSO") is `unknown` forever: reported to the caller, never turned into a nudge.
 *   The loop may only insist on facts it can point at.
 * - It does not re-implement artifact detection: named files and test classes are
 *   `task-artifacts.ts`, whose checks are already measured.
 */

import {
  requiredArtifactsFor,
  verifyArtifacts,
  type ArtifactRequirement,
} from './task-artifacts.js';

export type RequirementKind = 'artifact' | 'test-class' | 'check' | 'behaviour';

/**
 * `satisfied` — evidence exists in the workspace/turn.
 * `unmet`     — the row is checkable and the check says no (ENFORCEABLE).
 * `unknown`   — the row is understood but not machine-checkable (REPORTED ONLY).
 */
export type RequirementStatus = 'satisfied' | 'unmet' | 'unknown';

export interface RequirementRow {
  id: string;
  kind: RequirementKind;
  /** Short noun for the row — a file name, a check name, or the ask's own words. */
  label: string;
  /** Imperative line used when telling the model what is outstanding. */
  describe: string;
  /** For `kind: 'check'`: which check kind satisfies it (`tests`, `build`, …). */
  checkKind?: string;
}

export interface ResolvedRequirement extends RequirementRow {
  status: RequirementStatus;
  /** The command that satisfied it, or why it did not. */
  evidence?: string;
}

/** A row plus the status the turn's evidence gives it. */
export interface RequirementLedger {
  rows: ResolvedRequirement[];
  /** Rows that are checkable and currently negative — the enforceable set. */
  unmet: ResolvedRequirement[];
  /** Rows understood but not machine-checkable — reported, never enforced. */
  unknown: ResolvedRequirement[];
  satisfied: ResolvedRequirement[];
}

/** Named acceptance checks, in the order an ask tends to name them. */
const CHECK_DEMANDS: Array<{ kind: string; label: string; pattern: RegExp; describe: string }> = [
  {
    kind: 'tests',
    label: 'tests pass',
    // "run the tests", "make them pass", "tests must pass", "test suite green"
    pattern:
      /\b(?:run|runs|running|execute|pass|passes|passing|green)\b[^.\n]{0,40}\b(?:tests?|test suite|suite)\b|\btests?\b[^.\n]{0,20}\b(?:must\s+)?(?:pass|passes|passing|green)\b/i,
    describe: 'the test suite must actually RUN and pass (a configured script is not a run)',
  },
  {
    kind: 'typecheck',
    label: 'typecheck',
    pattern: /\b(?:run\s+)?(?:type[- ]?check(?:er)?|tsc)\b|\btype[- ]?check\b[^.\n]{0,20}\b(?:pass|clean|green)\b/i,
    describe: 'the typecheck must RUN and pass',
  },
  {
    kind: 'lint',
    label: 'lint',
    pattern: /\b(?:run|fix|pass|clean|green)\b[^.\n]{0,30}\blint(?:ing)?\b|\blint(?:ing)?\b[^.\n]{0,20}\b(?:pass|clean|green)\b/i,
    describe: 'lint must RUN and pass',
  },
  {
    kind: 'build',
    label: 'build',
    pattern:
      /\b(?:run|make|get|keep|ensure|verify)\b[^.\n]{0,30}\b(?:build|compile)\b|\b(?:build|compile)\b[^.\n]{0,20}\b(?:pass|passes|green|succeeds)\b/i,
    describe: 'the build must RUN and succeed',
  },
];

/** A list item that states an obligation — the enumeration half of an ask. */
const ENUMERATED_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.{12,220})$/;
const OBLIGATION = /\b(?:must|should|shall|include|includes|support|add|keep|ensure|require[sd]?)\b/i;
/**
 * A line that turns the list BELOW it into the ask's own list ("Deliverables:",
 * "Requirements", "Acceptance criteria:", "Scope:"). Measured shape: the
 * 2026-10-25 task listed its tracking files this way, with no "must" on each line.
 */
const LIST_HEADING = /^(?:\s*#{1,6}\s*)?[\w /&()-]{2,40}:?\s*$|\b(?:deliverables?|requirements?|acceptance criteria|must include|definition of done|scope)\b/i;

/** Compare list text against extracted labels without caring about `-` vs space. */
function norm(text: string): string {
  return text.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Above this the ask is a document, not a task list; the ledger stays bounded. */
export const MAX_LEDGER_ROWS = 14;

function artifactRow(requirement: ArtifactRequirement): RequirementRow {
  const kind: RequirementKind =
    requirement.kind === 'unit-tests' || requirement.kind === 'integration-tests' || requirement.kind === 'e2e-tests'
      ? 'test-class'
      : 'artifact';
  return {
    id: requirement.id,
    kind,
    label: requirement.name ?? requirement.id,
    describe: requirement.describe,
  };
}

/**
 * The rows an ask explicitly names. Empty for a conversation, a question about
 * the code, or any ask with no enumeration, artifact or acceptance check — which
 * is what keeps this from becoming a nag on every turn.
 */
export function buildRequirementLedger(request: string): RequirementRow[] {
  const text = (request || '').trim();
  if (!text) return [];
  const rows: RequirementRow[] = [];
  const seen = new Set<string>();
  const push = (row: RequirementRow): void => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    rows.push(row);
  };

  for (const artifact of requiredArtifactsFor(text)) push(artifactRow(artifact));
  for (const demand of CHECK_DEMANDS) {
    if (!demand.pattern.test(text)) continue;
    push({
      id: `check-${demand.kind}`,
      kind: 'check',
      label: demand.label,
      describe: demand.describe,
      checkKind: demand.kind,
    });
  }

  // Enumerated obligations: `- must support X`, `3. keep the changelog current`,
  // and every item under an explicit heading ("Deliverables:"). Reported, never
  // enforced — the loop cannot verify "supports SSO" from a tree.
  const known = rows.flatMap((r) => [norm(r.label), norm(r.id)]).filter((k) => k.length > 2);
  let enumerated = 0;
  let listContext = false;
  for (const line of text.split(/\r?\n/)) {
    if (enumerated >= 6 || rows.length >= MAX_LEDGER_ROWS) break;
    if (!line.trim()) {
      listContext = false;
      continue;
    }
    const match = line.match(ENUMERATED_ITEM);
    if (!match) {
      // A heading introduces a list; any other prose ends one.
      listContext = LIST_HEADING.test(line.trim()) && line.trim().endsWith(':');
      continue;
    }
    const item = match[1].trim();
    if (!OBLIGATION.test(item) && !listContext) continue;
    // An item that names an artifact/check already has a checkable row.
    const lower = norm(item);
    if (known.some((k) => lower.includes(k))) continue;
    enumerated += 1;
    push({
      id: `behaviour-${enumerated}`,
      kind: 'behaviour',
      label: item.slice(0, 80),
      describe: item,
    });
  }

  return rows.slice(0, MAX_LEDGER_ROWS);
}

/** One successful (or failed) check the turn ran, as the loop observed it. */
export interface ObservedCheck {
  /** `classifyCheck(...).kinds` — what the command actually exercised. */
  kinds: readonly string[];
  ok: boolean;
  command?: string;
  tool?: string;
}

export interface ResolveFacts {
  cwd: string;
  /** Every check the turn ran, in order. */
  checks?: readonly ObservedCheck[];
  /** Paths the turn wrote (used only to describe evidence). */
  mutatedPaths?: readonly string[];
}

/**
 * Resolve extracted rows against what the turn actually did.
 *
 * Pure enough to test without a model: artifacts are read from the filesystem and
 * checks from the turn's own ledger. A behavioural row is always `unknown`.
 */
export function resolveRequirementLedger(
  rows: readonly RequirementRow[],
  facts: ResolveFacts,
): RequirementLedger {
  const checks = facts.checks ?? [];
  const artifactRequirements = rows
    .filter((r) => r.kind === 'artifact' || r.kind === 'test-class')
    .map((r) => artifactRequirementOf(r));
  const check = artifactRequirements.length > 0 ? verifyArtifacts(artifactRequirements, facts.cwd) : null;
  const satisfiedArtifactIds = new Set(check?.satisfied.map((s) => s.id) ?? []);

  const resolved: ResolvedRequirement[] = rows.map((row) => {
    if (row.kind === 'artifact' || row.kind === 'test-class') {
      const ok = satisfiedArtifactIds.has(row.id);
      return {
        ...row,
        status: ok ? 'satisfied' : 'unmet',
        ...(ok ? { evidence: `${row.label} exists in the workspace` } : {}),
      };
    }
    if (row.kind === 'check') {
      const kind = row.checkKind ?? '';
      const ofKind = checks.filter((c) => c.kinds.includes(kind));
      const passed = ofKind.filter((c) => c.ok);
      if (passed.length > 0) {
        const last = passed[passed.length - 1];
        return {
          ...row,
          status: 'satisfied',
          evidence: last.command ? `${last.command} passed` : `${last.tool ?? 'check'} passed`,
        };
      }
      const failed = ofKind.filter((c) => !c.ok);
      if (failed.length > 0) {
        const last = failed[failed.length - 1];
        return {
          ...row,
          status: 'unmet',
          evidence: last.command ? `${last.command} ran and FAILED` : 'the check ran and failed',
        };
      }
      return { ...row, status: 'unmet', evidence: 'no such check ran this turn' };
    }
    return { ...row, status: 'unknown' };
  });

  return {
    rows: resolved,
    unmet: resolved.filter((r) => r.status === 'unmet'),
    unknown: resolved.filter((r) => r.status === 'unknown'),
    satisfied: resolved.filter((r) => r.status === 'satisfied'),
  };
}

/** Rebuild the ArtifactRequirement shape a row came from, for `verifyArtifacts`. */
function artifactRequirementOf(row: RequirementRow): ArtifactRequirement {
  const kind: ArtifactRequirement['kind'] =
    row.kind === 'test-class'
      ? row.id === 'unit-tests'
        ? 'unit-tests'
        : row.id === 'integration-tests'
          ? 'integration-tests'
          : 'e2e-tests'
      : row.id === 'readme'
        ? 'readme'
        : 'file';
  return { id: row.id, kind, name: row.label, describe: row.describe };
}

/**
 * The outstanding rows as one line each — the message the model receives, and the
 * same text the final report carries. Only `unmet` rows are ever listed as work:
 * an `unknown` row is a fact about the ask, not a task.
 */
export function describeUnmet(unmet: readonly ResolvedRequirement[], limit = 6): string[] {
  return unmet.slice(0, limit).map((row) => {
    const why = row.evidence ? ` (${row.evidence})` : '';
    return `${row.describe}${why}`;
  });
}

/** A one-line count for the trace / turn report. */
export function ledgerSummary(ledger: RequirementLedger): string {
  return `${ledger.satisfied.length}/${ledger.rows.length} requirement(s) satisfied` +
    (ledger.unmet.length > 0 ? `, ${ledger.unmet.length} unmet` : '') +
    (ledger.unknown.length > 0 ? `, ${ledger.unknown.length} unverifiable` : '');
}
