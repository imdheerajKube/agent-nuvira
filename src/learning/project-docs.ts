/**
 * PROJECT DOCUMENTATION (software deliverables).
 *
 * The gap this closes: a software build produced CODE and stopped. The
 * documents a real project ships — a README, a changelog that grows with each
 * change, a short architecture note with a diagram, and (for a library/service)
 * usage + API docs — were only produced when the user named them, which is
 * exactly backwards: a user should not have to ask a "world-class developer" to
 * write down what it built.
 *
 * Two rules keep this from becoming noise:
 *
 *   1. **Software only.** This module is consulted ONLY for a `code` deliverable
 *      that is not authored (`deliverable-class.ts` already separates a poem
 *      from a program). Nobody wants a README and an ARCHITECTURE.md for
 *      "write me a poem about rain" — the classifier decides, and this guidance
 *      is never appended to an authored ask.
 *   2. **Proportionate.** A README and a CHANGELOG are expected of every
 *      software deliverable; the heavier documents (architecture, API reference,
 *      contributing guide) are asked for only when the shape warrants them —
 *      a multi-component or library/service build, or an explicit request for
 *      docs. A one-file script still gets a README; it is not asked to invent an
 *      architecture diagram.
 *
 * It also encodes the maintenance rule the user cares about: an EXISTING
 * document is UPDATED in place (CHANGELOG gets a new entry at the top), never
 * shadowed by a second file — a project with two changelogs is worse than one
 * with none.
 *
 * Pure and side-effect free: every input is data, so it is unit-testable and can
 * be appended to any prompt without touching the filesystem.
 */

/** The canonical documents a software project ships, in priority order. */
export interface ProjectDocArtifact {
  /** Project-relative path the document lives at. */
  path: string;
  /** What it is FOR — handed to the model so the document has a job. */
  purpose: string;
  /** Required of every software deliverable (README, CHANGELOG). */
  always: boolean;
}

export const PROJECT_DOC_ARTIFACTS: readonly ProjectDocArtifact[] = [
  {
    path: 'README.md',
    purpose:
      'what the project is, how to install it, and a copy-pasteable quick start — the FIRST thing a ' +
      'newcomer reads',
    always: true,
  },
  {
    path: 'CHANGELOG.md',
    purpose:
      'Keep a Changelog format, newest section first (Added / Changed / Fixed / Removed) — every ' +
      'meaningful change appends an entry here',
    always: true,
  },
  {
    path: 'ARCHITECTURE.md',
    purpose:
      'the components, how data flows between them, and a diagram (a Mermaid `flowchart` or ' +
      '`sequenceDiagram` block renders on GitHub with no tooling)',
    always: false,
  },
  {
    path: 'docs/usage.md',
    purpose: 'task-oriented guides: "how do I do X", with working examples',
    always: false,
  },
  {
    path: 'docs/api.md',
    purpose: 'the public API reference — every exported symbol, its signature and an example',
    always: false,
  },
  {
    path: 'CONTRIBUTING.md',
    purpose: 'how to build, test and submit a change (the commands a contributor needs)',
    always: false,
  },
];

/** What we know about the deliverable, from the goal + project assessment. */
export interface ProjectDocShape {
  /**
   * True when the workspace has no project yet (a scaffold). A greenfield build
   * gets the full proportionate set rather than only the always-on pair.
   */
  greenfield?: boolean;
  /**
   * A library, package, SDK or service — a thing other code CONSUMES — rather
   * than an end-user app. Its public surface must be documented.
   */
  isLibraryOrService?: boolean;
  /** The project already exposes tests (or the agent is expected to write them). */
  hasTests?: boolean;
  /** Names the user explicitly asked for docs ("with documentation", "API docs"). */
  docsRequested?: boolean;
  /**
   * Documents that ALREADY exist in the workspace (project-relative paths).
   * These are UPDATED in place, never duplicated.
   */
  existingDocs?: readonly string[];
}

/** The always-on pair, plus the heavier docs a bigger build warrants. */
export function requiredProjectDocs(shape: ProjectDocShape = {}): string[] {
  const paths = PROJECT_DOC_ARTIFACTS.filter((a) => a.always).map((a) => a.path);
  if (shape.isLibraryOrService || shape.docsRequested) paths.push('docs/api.md', 'docs/usage.md');
  if (shape.greenfield || shape.isLibraryOrService || shape.docsRequested) paths.push('ARCHITECTURE.md');
  if (shape.hasTests) paths.push('CONTRIBUTING.md');
  // De-dupe while preserving priority order.
  return [...new Set(paths)];
}

/**
 * Does the goal name something other code CONSUMES (a library, package, SDK,
 * CLI, service, plugin) rather than an end-user app? A consumed surface has a
 * public API worth documenting; an app does not need an API reference.
 */
export function looksLikeLibraryOrService(goal: string): boolean {
  const consumed =
    /\b(library|lib|package|npm\s+package|sdk|module|cli|command[- ]?line|api|service|server|daemon|plugin|extension|framework|toolkit)\b/i.test(
      goal,
    );
  const endUserApp =
    /\b(website|web\s?app|webapp|landing\s+page|game|mobile\s+app|desktop\s+app|swiftui|android\s+app|ios\s+app)\b/i.test(
      goal,
    );
  return consumed && !endUserApp;
}

/** The required docs that do NOT yet exist on disk (the ones to CREATE). */
export function missingProjectDocs(shape: ProjectDocShape = {}): string[] {
  const existing = new Set((shape.existingDocs ?? []).map((p) => p.replace(/^\.\//, '')));
  return requiredProjectDocs(shape).filter((p) => !existing.has(p));
}

/** The required docs that already exist (the ones to UPDATE, not recreate). */
export function existingProjectDocs(shape: ProjectDocShape = {}): string[] {
  const existing = new Set((shape.existingDocs ?? []).map((p) => p.replace(/^\.\//, '')));
  return requiredProjectDocs(shape).filter((p) => existing.has(p));
}

/**
 * The instruction appended to the reasoner/planner prompt for a SOFTWARE
 * deliverable. Returns `''` for a non-software (authored) ask, so callers can
 * append it unconditionally without a poem ever being asked for a CHANGELOG.
 */
export function softwareProjectGuidance(
  verdictClass: string,
  authored: boolean,
  shape: ProjectDocShape = {},
): string {
  if (authored || verdictClass !== 'code') return '';
  const create = missingProjectDocs(shape);
  const update = existingProjectDocs(shape);
  if (create.length === 0 && update.length === 0) return '';

  const purposeOf = (path: string) =>
    PROJECT_DOC_ARTIFACTS.find((a) => a.path === path)?.purpose ?? 'project documentation';

  const lines = [
    '',
    '## ⚠️ PROJECT DOCUMENTATION (this is a SOFTWARE deliverable)',
    'Code is not the whole deliverable. A project is not finished until the',
    'documents below exist and are current — include them as REAL plan steps with',
    '`expectedFiles`, not as an afterthought.',
    '',
    'Create:',
  ];
  for (const path of create) lines.push(`- \`${path}\` — ${purposeOf(path)}`);
  if (update.length > 0) {
    lines.push('', 'Update IN PLACE (do NOT create a second copy or a parallel file):');
    for (const path of update) lines.push(`- \`${path}\` — add the new state of the project (for a CHANGELOG, a new top section)`);
  }
  lines.push(
    '',
    'Rules:',
    '- Every document must reflect what was ACTUALLY built — never invent features,',
    '  flags or files that do not exist.',
    '- A document you cannot fill honestly gets a shorter honest version, not filler.',
    '- If the project already has these documents, UPDATING them is the task; a',
    '  duplicate CHANGELOG or a shadow architecture file is a defect.',
    '- Keep the CHANGELOG append-only going forward: each change adds an entry, and',
    '  old entries are never rewritten.',
  );
  return lines.join('\n');
}
