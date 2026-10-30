/**
 * Required artifacts — the files and test classes a request NAMED, and whether the
 * turn actually produced them.
 *
 * WHY THIS EXISTS (measured 2026-10-25, three agents, one 30-minute build task).
 * agent-nuvira finished in 14 minutes of a 30-minute budget with a green build and
 * 22 passing tests — and no `todo.md`, no `progress.md`, no `changelog.md`, no
 * README and no e2e tests, although the prompt named all of them. Cline, on the
 * same prompt, produced every tracking file and 20 test files. The difference was
 * not capability: it was that nuvira's turn ENDS when the model stops calling
 * tools, so "I have done what I planned" is indistinguishable from "the request
 * is satisfied". Cline's prompt makes completion a tool call and continues the run
 * when it is missing.
 *
 * So this module turns the explicit artifacts in an ask into a CHECKABLE list:
 * named files (`todo.md`, `progress.md`, `issues.md`, `changelog.md`, `README`,
 * `PRD`, …) and named test classes (unit / integration / e2e). The loop spends a
 * bounded nudge naming what is missing, and the turn is not allowed to end quietly
 * with them absent.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not infer requirements. An ask that
 * never names these files is untouched — "explain the README" must not create one,
 * which is why detection requires a BUILD-shaped ask as well as the name. It also
 * does not judge content: a 3-line `progress.md` satisfies it. Quality stays the
 * reviewer's job; existence and non-emptiness are what a loop can decide on its own.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Directories that are never part of "did this turn produce the artifact". */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__']);

/** Below this, a file is a placeholder, not the artifact the ask described. */
export const MIN_ARTIFACT_BYTES = 40;

/**
 * An ask that implies PRODUCING something, not answering a question about it.
 *
 * Two tests, and both are load-bearing:
 *
 * 1. It must read as work — a production verb (`build`, `implementation`, `write`,
 *    `deliver`, …) or a product noun. Nouns alone are too loose to be a verdict:
 *    `the project is broken` is not a build request.
 * 2. It must not be INTERROGATIVE. Measured 2026-10-26: the asks "read the README
 *    and tell me what the project does" and "what does src/app.ts do?" both
 *    matched the old noun list (`project`, `app`), so the requirements machinery
 *    offered to write a README in answer to a question about one. A question is
 *    never a delivery, whatever nouns it contains.
 */
const BUILD_VERB =
  /\b(?:build|create|implement|develop|scaffold|construct|writ|ship|deliver|cod(?:e|ing)|generat|set(?:ting)?\s+up|add)\w*/i;
const PRODUCT_NOUN =
  /\b(?:app|application|platform|service|api|saas|project|system|website|cli|package|monorepo)\b/i;
const QUESTION_ASK =
  /^\s*(?:what|how|why|which|who|when|where|is|are|was|were|does|do|did|can|could|should|would|explain|describe|tell|show|read|review|audit|list|find|compare|check|summar)/i;

/** The old, looser test — kept as the name `requiredArtifactsFor` always used. */
const BUILD_ASK_LOOSE = BUILD_VERB;

export type ArtifactKind = 'file' | 'readme' | 'unit-tests' | 'integration-tests' | 'e2e-tests';

export interface ArtifactRequirement {
  id: string;
  kind: ArtifactKind;
  /** Canonical lowercase basename for `kind: 'file'`. */
  name?: string;
  /** The phrase used when telling the model what is missing. */
  describe: string;
}

/** The named files this module knows how to check, in the order an ask names them. */
const NAMED_FILES: Array<{ id: string; name: string; pattern: RegExp; describe: string }> = [
  { id: 'todo', name: 'todo.md', pattern: /\btodo\.md\b/i, describe: 'todo.md — the task list the ask told you to maintain' },
  {
    id: 'progress',
    name: 'progress.md',
    pattern: /\bprogress\.md\b/i,
    describe: 'progress.md — what is done, what is in progress, and what is not',
  },
  { id: 'issues', name: 'issues.md', pattern: /\bissues\.md\b/i, describe: 'issues.md — the problems found and their status' },
  {
    id: 'changelog',
    name: 'changelog.md',
    pattern: /\bchangelog(\.md)?\b/i,
    describe: 'changelog.md — what changed, in order',
  },
  { id: 'readme', name: 'readme.md', pattern: /\breadme\b/i, describe: 'README.md — what this is and how to run it' },
  { id: 'prd', name: 'prd.md', pattern: /\bprd\b|product requirements/i, describe: 'a PRD document' },
  { id: 'architecture', name: 'architecture.md', pattern: /\barchitecture\b/i, describe: 'an architecture document' },
  { id: 'roadmap', name: 'roadmap.md', pattern: /\broadmap\b/i, describe: 'an implementation roadmap' },
  {
    id: 'risk',
    name: 'risk.md',
    pattern: /\brisk (?:register|assessment)\b/i,
    describe: 'a risk register',
  },
];

/**
 * What counts as a UNIT TEST FILE — in any language the project might be in.
 *
 * WHY IT IS NOT JS-ONLY (measured 2026-10-30, DEV-FEATURE, three runs): the
 * matcher used to be `\.(test|spec)\.[cm]?[jt]sx?$`, so on a PYTHON project the
 * `unit-tests` requirement could never be satisfied — `tests/test_format_duration.py`
 * did not match, the artifact gate therefore fired twice on every run AFTER the
 * file had been written, and the model spent 3–5 further steps proving to the gate
 * that its file existed (`ls`, `git add`, a `finding` about it). A check that can
 * only fail is worse than no check: it costs steps and teaches the model to ignore
 * the gate. The conventions below are the standard filenames of the ecosystems
 * this agent is pointed at, not a guess at test quality — presence is still all
 * this module claims to decide.
 */
const UNIT_TEST_FILE =
  /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.(?:py|go|rb|exs)$|(?:^|\/)[^/]+(?:_spec|_test)\.rb$|(?:^|\/)[^/]*(?:Test|Tests|Spec|IT)\.(?:java|kt|kts|cs|scala|php|swift)$/i;

const TEST_CLASSES: Array<{
  id: string;
  kind: ArtifactKind;
  pattern: RegExp;
  /** How a file proves it belongs to this class. */
  match: RegExp;
  describe: string;
}> = [
  {
    id: 'unit-tests',
    kind: 'unit-tests',
    pattern: /\bunit tests?\b/i,
    match: UNIT_TEST_FILE,
    describe: 'unit tests (no unit test file exists)',
  },
  {
    id: 'integration-tests',
    kind: 'integration-tests',
    pattern: /\bintegration tests?\b/i,
    match: /integration/i,
    describe: 'integration tests (no integration test file exists)',
  },
  {
    id: 'e2e-tests',
    kind: 'e2e-tests',
    pattern: /\be2e\b|\bend[- ]to[- ]end\b|\bplaywright\b|\bcypress\b/i,
    match: /e2e|end-to-end|playwright|cypress/i,
    describe: 'end-to-end tests (no e2e spec or runner config exists)',
  },
];

/**
 * Does this ask describe PRODUCING something (rather than asking about it)?
 *
 * Exported because the completion contract needs the same distinction: a build
 * turn owes a quickstart and tests for the modules it wrote; a question turn owes
 * neither. One definition, two readers.
 */
export function isBuildShapedAsk(request: string): boolean {
  const text = (request || '').trim();
  if (!text) return false;
  if (QUESTION_ASK.test(text)) return false;
  return BUILD_VERB.test(text) || PRODUCT_NOUN.test(text);
}

/**
 * The artifacts an ask explicitly named. Empty for a question, a review, or any
 * ask that does not both name an artifact and ask for something to be built.
 */
export function requiredArtifactsFor(request: string): ArtifactRequirement[] {
  const text = (request || '').trim();
  if (!text) return [];
  const building = isBuildShapedAsk(text) && (BUILD_ASK_LOOSE.test(text) || PRODUCT_NOUN.test(text));
  const out: ArtifactRequirement[] = [];
  for (const file of NAMED_FILES) {
    if (!file.pattern.test(text)) continue;
    // README/PRD/architecture are also things an ask can *read* — only the build
    // shape makes them deliverables.
    if (!building && file.id !== 'todo' && file.id !== 'progress') continue;
    out.push({ id: file.id, kind: file.id === 'readme' ? 'readme' : 'file', name: file.name, describe: file.describe });
  }
  for (const testClass of TEST_CLASSES) {
    if (!testClass.pattern.test(text)) continue;
    out.push({ id: testClass.id, kind: testClass.kind, describe: testClass.describe });
  }
  return out;
}

interface WalkedFile {
  path: string;
  name: string;
  size: number;
}

/** File listing bounded by depth and count — an artifact check must be cheap. */
function walkProject(root: string, maxDepth = 4, maxFiles = 4000): WalkedFile[] {
  const files: WalkedFile[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && files.length < maxFiles) {
    const { dir, depth } = stack.pop()!;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (IGNORED_DIRS.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth + 1 <= maxDepth) stack.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (st.isFile()) files.push({ path: abs, name: name.toLowerCase(), size: st.size });
    }
  }
  return files;
}

export interface ArtifactCheck {
  satisfied: ArtifactRequirement[];
  missing: ArtifactRequirement[];
}

/**
 * Which of `requirements` the workspace satisfies.
 *
 * A named file is satisfied when it exists with real content. A test class is
 * satisfied by a FILE whose path (or, for small files, its text) says it belongs to
 * that class — a runner configured with no specs is not e2e coverage.
 */
export function verifyArtifacts(requirements: ArtifactRequirement[], cwd: string): ArtifactCheck {
  const satisfied: ArtifactRequirement[] = [];
  const missing: ArtifactRequirement[] = [];
  if (requirements.length === 0) return { satisfied, missing };
  const files = existsSync(cwd) ? walkProject(cwd) : [];
  // A candidate is a test file when its NAME says so (any language) or it lives in a
  // test directory — a root-level `test_util.py` is a real pytest file that no
  // directory rule would have found.
  const testFiles = files.filter(
    (f) => UNIT_TEST_FILE.test(f.path) || /(^|\/)(__tests__|tests?|spec)\//i.test(f.path),
  );

  for (const requirement of requirements) {
    if (requirement.kind === 'file' || requirement.kind === 'readme') {
      const named = requirement.name ?? '';
      const found = files.some((f) => f.name === named && f.size >= MIN_ARTIFACT_BYTES);
      (found ? satisfied : missing).push(requirement);
      continue;
    }
    const testClass = TEST_CLASSES.find((t) => t.kind === requirement.kind);
    const found =
      !!testClass &&
      testFiles.some((f) => {
        if (testClass.match.test(f.path) || testClass.match.test(basename(f.path))) return true;
        // Content check, size-bounded: "integration" often lives in the test body.
        if (f.size > 200_000) return false;
        try {
          return testClass.match.test(readFileSync(f.path, 'utf-8').slice(0, 20_000));
        } catch {
          return false;
        }
      });
    (found ? satisfied : missing).push(requirement);
  }
  return { satisfied, missing };
}

/**
 * The nudge: one message, every missing artifact, and the rule that makes it
 * stick — the turn is not done while they are absent. Naming the file is not
 * enough on its own; the measured failure was an agent that had simply decided it
 * was finished.
 */
export function artifactsNudge(missing: ArtifactRequirement[]): string {
  const list = missing.map((m) => `  - ${m.describe}`).join('\n');
  return [
    'Before this turn ends: the request names artifacts that do not exist yet in the workspace.',
    list,
    'Create each one now, with real content (not a placeholder), and keep it consistent with what you built.',
    'A turn that stops with these absent has not satisfied the request, however green the build is.',
  ].join('\n');
}

/**
 * The OPENING observation for a request that names a deliverable path.
 *
 * Measured 2026-10-29 (BUG-SEEDED): the ask names `docs/BUGS_FOUND.md`, the turn found
 * and fixed all four seeded defects — and handed in no report, ending on "next steps:
 * write up the audit report". Cline, on the same ask, wrote 164 lines of it. The
 * difference is not ability, it is ORDER: a deliverable left until after the work is a
 * deliverable that competes with the work for the last step, and loses.
 *
 * So the loop says the order out loud at the start, when it is free to act on it:
 * create the file with its section skeleton on the first evidence pass, then fill each
 * section as the evidence for it arrives. A skeleton is cheap, it makes the remaining
 * work visible in the tree, and it cannot be forgotten at the end.
 */
export function deliverableFirstNudge(paths: readonly string[]): string {
  const list = paths.map((p) => `  - \`${p}\``).join('\n');
  return [
    'The request names a file it wants on disk:',
    list,
    'Write it in the FIRST evidence pass, as a skeleton with one section per thing you were asked to report — then fill a section as soon as you have the evidence for it, instead of saving the document for the end.',
    'A turn cannot claim completion with a named deliverable still absent; `finish` checks the file on disk, not the plan to write it.',
  ].join('\n');
}

/**
 * Should the gate fire? Returns the missing artifacts when it should, else null.
 *
 * Three conditions, all load-bearing: the ask must have NAMED artifacts, the turn
 * must have actually produced something (a question-answering turn is not made to
 * write a todo list), and something must still be missing.
 */
export function artifactsGateApplies(input: {
  request: string;
  cwd: string;
  didWork: boolean;
}): ArtifactRequirement[] | null {
  if (!input.didWork) return null;
  const requirements = requiredArtifactsFor(input.request);
  if (requirements.length === 0) return null;
  const { missing } = verifyArtifacts(requirements, input.cwd);
  return missing.length > 0 ? missing : null;
}
