/**
 * PLAN DEPTH — the breadth of a build is set by the granularity of its plan.
 *
 * WHY THIS EXISTS (measured 2026-10-27, two arms, one identical prompt). Both delivered
 * a green project; one had 69 endpoints, the other 51, and the eight-endpoint difference
 * was depth inside the same modules — refresh rotation, logout-all, organization
 * switching, unread counts, read-all, notification preferences, document publish and
 * version history, audit logs, admin user status. The ask never named those, so a
 * "does the word appear" check cannot find them; a gate cannot invent them either.
 *
 * What produced them was the PLAN. The winning run's task list had 15 phases and ~150
 * atomic tasks (T-080…T-229): `T-082 Refresh token generation, hashing, rotation, reuse
 * detection`, `T-086 Refresh, logout, logout-all`, `T-089 Organization switching token
 * issuance`, … `T-229 Git commit of runnable state`. The other arm's plan had seven
 * steps, one of which read:
 *
 *   "Implement backend: auth/JWT, RBAC, projects, tasks, documents, notifications,
 *    AI assistant, admin"
 *
 * EIGHT named requirements in ONE step. That step was marked done as soon as the
 * modules existed — and every unbuilt endpoint inside those modules read as "done",
 * because nothing in the plan could tell the difference. The plan was not a summary of
 * the work; it WAS the work, and it had eight features per checkbox.
 *
 * So this module checks one fact a loop can actually judge: does the plan decompose the
 * ask's own requirements, or does it bundle them? A step that names three or more
 * requirements, or requirements with no step at all, is a plan that cannot measure its
 * own progress — and it is asked, ONCE, to split before the build goes further.
 *
 * WHY ONE ASK AND NOT A RULE. A plan is the model's own statement of the work; the loop
 * may point out that it cannot be checked, but re-writing the plan for the model would
 * replace the thing being measured. So: one bounded, specific ask, naming the step and
 * the requirements it swallows.
 *
 * WHY NOTHING HAPPENS ON A SMALL ASK. Fewer than `MIN_FEATURES` named requirements is a
 * fix or a script, not a delivery — a two-step plan is proportionate there, and a gate
 * that insists otherwise is noise. Technology and quality words ("Next.js frontend",
 * "PostgreSQL", "unit tests") are not requirements with a checkbox of their own; they are
 * covered by the surface and documentation duties, and are excluded here so the ask
 * stays about the product's own features.
 */

/** Below this many named requirements a coarse plan is proportionate. */
export const MIN_FEATURES = 4;

/** A step naming this many requirements is a phase pretending to be a task. */
export const MAX_FEATURES_PER_STEP = 2;

/**
 * Words that name a technology or a quality attribute, not a deliverable.
 *
 * Held as CANONICAL forms (`next` for "Next.js", `postgres` for "PostgreSQL") because the
 * ask writes them as product names and the stoplist must still recognise them — the
 * measured ask lists eleven bullets of which five are technology and four are the quality
 * bar, and counting those as features would make every plan look too coarse.
 */
const TECH_ALIAS: Record<string, string> = {
  'next.js': 'next',
  'nextjs': 'next',
  'node.js': 'node',
  'nodejs': 'node',
  postgresql: 'postgres',
  'postgres15': 'postgres',
  'postgres16': 'postgres',
  'react19': 'react',
  'next.js16': 'next',
};

const NOT_A_FEATURE = new Set([
  'next',
  'nextjs',
  'react',
  'vue',
  'svelte',
  'angular',
  'node',
  'nodejs',
  'express',
  'nestjs',
  'postgres',
  'postgresql',
  'mysql',
  'sqlite',
  'mongo',
  'mongodb',
  'redis',
  'prisma',
  'database',
  'db',
  'backend',
  'frontend',
  'fullstack',
  'jwt',
  'auth',
  'authentication',
  'authorisation',
  'authorization',
  'rbac',
  'security',
  'secure',
  'tests',
  'test',
  'testing',
  'unit',
  'integration',
  'e2e',
  'playwright',
  'documentation',
  'docs',
  'readme',
  'performance',
  'optimisation',
  'optimization',
  'quality',
  'production',
  'ready',
  'architecture',
  'api',
  'rest',
  'graphql',
  'server',
  'service',
  'application',
  'app',
  'platform',
  'saas',
  'system',
  'code',
  'typescript',
  'javascript',
  'python',
  'docker',
  'kubernetes',
  'deployment',
  // The quality bar's own vocabulary: "Complete documentation" is not a feature of the
  // product, and it is already the documentation duty's job.
  'complete',
  'completed',
  'comprehensive',
  'best',
  'practices',
  'optimal',
  'maintainable',
  'scalable',
  'robust',
  'clean',
  'exhaustive',
]);

/** `Next.js` → `next`, `PostgreSQL` → `postgres`, `Node.js` → `node`. */
function canonicalWord(word: string): string {
  const lower = word.toLowerCase();
  const alias = TECH_ALIAS[lower];
  if (alias) return alias;
  const bare = lower.replace(/[^a-z0-9]/g, '');
  return TECH_ALIAS[bare] ?? bare;
}

const BULLET = /^\s*[-*+]\s+(.+?)\s*$/;
const REQUIREMENTS_HEADING = /\b(?:requirements?|features?|scope|deliverables?)\b/i;

/** Strip markdown emphasis, parentheticals and trailing punctuation. */
function cleanLabel(raw: string): string {
  return raw
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+[—–-]\s+.*$/, '')
    .replace(/[.:;]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Singular/plural-insensitive identity for matching a label against plan text. */
export function featureKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/(?:ies)$/, 'y').replace(/(?:sses|shes|ches|xes)$/, (m) => m.slice(0, -2)).replace(/(?<!s)s$/, ''))
    .join(' ');
}

/**
 * The ask's own requirement labels.
 *
 * Bullets under a requirements-ish heading, plus a `Requirements: a, b, c` line. The
 * heading check matters: an ask's *instructions* are also bullets sometimes
 * ("- maintain todo.md"), and those are duties the loop already enforces elsewhere.
 */
export function namedRequirements(ask: string): string[] {
  const text = (ask || '').replace(/\r/g, '');
  const lines = text.split('\n');
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const label = cleanLabel(raw);
    if (!label) return;
    // Hyphens and slashes separate words too: "Production-ready architecture" is three
    // quality words, not one unrecognisable compound.
    const words = label.split(/[\s/\u2013\u2014-]+/).filter((w) => /[a-z0-9]/i.test(w));
    // A label made only of technology/quality words is not a feature of its own.
    if (words.length === 0) return;
    if (words.every((w) => NOT_A_FEATURE.has(canonicalWord(w)))) return;
    const key = featureKey(label);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(label);
  };

  let inRequirements = false;
  for (const line of lines) {
    // The inline form first, region or not: `Requirements: Leads, Deals, Reports, Billing.`
    const inline = /\b(?:requirements?|features?|scope|deliverables?)\b[^:\n]{0,20}:\s*(.+)$/i.exec(line);
    if (inline) {
      // A list (commas) anywhere, or the keyword at the start of the line: "This meets the
      // requirements: no" is prose, "Requirements: Leads, Deals" is a list.
      const parts = inline[1].split(/[,;]/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2 || /^\s*(?:[-*+]\s+)?(?:\*\*)?(?:requirements?|features?)\b/i.test(line)) {
        inRequirements = true;
        for (const part of parts) push(part);
        continue;
      }
    }
    // A heading or bold line that opens a requirements region with nothing after the colon.
    if (/^\s*(?:#{1,6}\s*)?(?:\*\*)?[A-Za-z][^:\n]{0,40}(?:\*\*)?\s*:?\s*$/.test(line) && REQUIREMENTS_HEADING.test(line)) {
      inRequirements = true;
      continue;
    }
    if (!inRequirements) continue;
    const bullet = BULLET.exec(line);
    if (bullet) push(bullet[1]);
  }
  return out.slice(0, 16);
}

export interface PlanStepLike {
  id: string;
  text?: string;
  title?: string;
  description?: string;
  status?: string;
}

export interface PlanDepthIssue {
  /** Requirements the plan has no step for. */
  missing: string[];
  /** Steps that swallow several requirements at once. */
  bundled: Array<{ step: string; stepText: string; features: string[] }>;
  /** Every requirement the plan was checked against (for a message that can be audited). */
  features: string[];
}

/**
 * Does `text` name `feature`? Word-boundary, singular/plural tolerant.
 *
 * ANY distinctive word of the feature counts, not just its head: a plan step called
 * "P11 — Admin" does cover the ask's "Admin Dashboard", and treating it as missing would
 * ask a well-planned build to re-plan. For MISSING detection over-covering is the safe
 * direction (it produces silence, not a nag); for BUNDLING the multi-word match is what
 * makes "projects, tasks, documents, notifications, AI assistant, admin" one step.
 */
function mentions(text: string, feature: string): boolean {
  const haystack = featureKey(text).split(' ').filter(Boolean);
  if (haystack.length === 0) return false;
  const needle = featureKey(feature);
  if (` ${haystack.join(' ')} `.includes(` ${needle} `)) return true;
  const words = needle.split(' ').filter((w) => w.length >= 3 && !NOT_A_FEATURE.has(w));
  return words.some((w) => haystack.includes(w));
}

/**
 * Is this plan too coarse for the ask?
 *
 * `null` when there is nothing to say: too few named requirements, or a plan that
 * already gives each requirement its own place.
 */
export function planDepthIssue(input: {
  ask: string;
  steps: readonly PlanStepLike[];
  /** Skip the check once the plan is mostly executed — splitting a finished plan is theatre. */
  doneRatioLimit?: number;
  /**
   * The mid-turn `CHANGE_REQUEST.md`, when one exists. A requirement the user has since
   * REPLACED is not missing from the plan: measured 2026-10-27, the request said "teams
   * replace projects", and a plan that stopped building projects was correct. The
   * winning arm's own phase list would otherwise be flagged for the same reason.
   */
  changeRequest?: string;
}): PlanDepthIssue | null {
  const superseded = (feature: string): boolean =>
    Boolean(input.changeRequest && mentions(input.changeRequest, feature));
  const features = namedRequirements(input.ask).filter((f) => !superseded(f));
  if (features.length < MIN_FEATURES) return null;
  const steps = input.steps.filter((s) => (s.text ?? s.title ?? s.description ?? '').trim().length > 0);
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.status === 'done').length;
  if (done / steps.length > (input.doneRatioLimit ?? 0.6)) return null;

  const covered = new Map<string, string[]>();
  for (const feature of features) {
    const hits = steps
      .filter((s) => mentions(`${s.text ?? ''} ${s.title ?? ''} ${s.description ?? ''}`, feature))
      .map((s) => s.id);
    covered.set(feature, hits);
  }
  const missing = features.filter((f) => (covered.get(f) ?? []).length === 0);
  const bundled: PlanDepthIssue['bundled'] = [];
  for (const step of steps) {
    const stepText = `${step.text ?? ''} ${step.title ?? ''} ${step.description ?? ''}`.trim();
    const swallowed = features.filter((f) => mentions(stepText, f));
    if (swallowed.length > MAX_FEATURES_PER_STEP) {
      bundled.push({ step: step.id, stepText: stepText.slice(0, 160), features: swallowed });
    }
  }
  if (missing.length === 0 && bundled.length === 0) return null;
  return { missing, bundled, features };
}

/**
 * The ask: split the plan so each named requirement is its own checkbox.
 *
 * It quotes the step it is talking about, because "your plan is too coarse" is not
 * actionable and "step 4 names auth, tasks, documents, notifications, admin and AI"
 * is.
 */
export function planDepthNudge(issue: PlanDepthIssue): string {
  const lines: string[] = [];
  const worst = issue.bundled.sort((a, b) => b.features.length - a.features.length)[0];
  if (worst) {
    lines.push(
      `Your plan bundles ${worst.features.length} of the request's ${issue.features.length} named requirement(s) into ONE step:`,
      `  step "${worst.step}": ${worst.stepText}`,
      'That step will be marked done as soon as the first of them exists, and every unbuilt feature inside it reads as complete.',
    );
  }
  if (issue.missing.length > 0) {
    lines.push(
      `${issue.missing.length} named requirement(s) have no step of their own: ${issue.missing.join(', ')}.`,
    );
  }
  lines.push(
    'Split the plan so each requirement is its own step, and give each one the depth the requirement implies —',
    'for a platform that means the operations a user performs, not just the module: create, read, update, delete,',
    'plus the states that make it usable (refresh/rotate credentials, mark-read, publish/version, audit trail, admin controls).',
    'Then work the steps in order. A plan whose checkboxes are features is the only reason a build has breadth.',
  );
  return lines.join('\n');
}
