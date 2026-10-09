/**
 * Edit-verification guards (enterprise-grade hardening, G1 + G2).
 *
 * The calculator audit found the sharpest agent-side gap: across 99 LLM calls
 * the loop never once ran `run_terminal`/`test`/`browser` — it edited files
 * and *asserted* they worked ("successfully fixed", "now fully operational")
 * eight turns in a row while the user kept reporting the same breakage. The
 * loop's existing honesty guards only cover DELIVERY claims (`gateway_send`),
 * so a false claim about a CODE change passed unflagged.
 *
 * This module is the single source of truth for two questions:
 *
 *   1. Which tool calls MUTATE the workspace, and which ones can VERIFY a
 *      mutation? (G1 — the verification gate consumes this.)
 *   2. Does the final answer CLAIM an edit that no verification backed?
 *      (G2 — `detectUnverifiedEditClaim`.)
 *
 * Both are pure + deterministic (no LLM, no I/O), so they can be unit-tested
 * exhaustively and behave identically across the CLI, dashboard, and gateway.
 *
 * A third question is answered here too, and it is the one exception to that
 * rule: WHICH check this project can actually run (`verificationNudgeFor` /
 * `detectAvailableChecks`). It reads workspace markers (package.json scripts,
 * tsconfig/vitest/jest/cargo/go) — filesystem only, never the network and never
 * a model — because "the strongest check" is a property of THIS project, and a
 * nudge that names it is actionable where a generic preference order is not.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Tools that CHANGE the workspace. A turn that ran one of these has produced
 * a claim about reality that only a verification run can support.
 *
 * Deliberately an ALLOWLIST: a write-capable tool added to the registry later
 * is NOT assumed to be a mutation until it is reviewed here (the same
 * fail-safe direction as `PARALLEL_SAFE_TOOL_NAMES`).
 */
export const MUTATION_TOOLS: ReadonlySet<string> = new Set(['edit_file', 'write_file']);

/**
 * Tools that can PROVE a mutation works — they observe the artifact rather
 * than assert it. `run_terminal` (typecheck/tests/build), the `test` pipeline,
 * a real `browser` run, and `run_cli` (e.g. `nuvira test`) all qualify.
 *
 * `delegate` is intentionally excluded: a sub-agent's prose summary is not an
 * observed artifact, and treating it as verification would let the exact
 * failure mode we are closing through the back door.
 */
export const VERIFICATION_TOOLS: ReadonlySet<string> = new Set([
  'run_terminal',
  'test',
  'browser',
  'run_cli',
]);

/** Whether a tool call changes the workspace. */
export function isMutationTool(name: string): boolean {
  return MUTATION_TOOLS.has(name);
}

/** Whether a tool call can verify a mutation (observe the artifact). */
export function isVerificationTool(name: string): boolean {
  return VERIFICATION_TOOLS.has(name);
}

/**
 * Classify a turn's tools into mutations + verifications. Only tools that
 * actually RAN SUCCESSFULLY should be passed in (an `Error:` refusal is not a
 * mutation and not a verification — see `ToolLoopProgress.successfulToolCalls`).
 */
export function classifyEditActivity(toolsRun: readonly string[]): {
  mutations: string[];
  verifications: string[];
  needsVerification: boolean;
} {
  const mutations: string[] = [];
  const verifications: string[] = [];
  for (const name of toolsRun) {
    if (isMutationTool(name)) mutations.push(name);
    else if (isVerificationTool(name)) verifications.push(name);
  }
  return {
    mutations,
    verifications,
    // A mutated workspace with nothing observed is the unverified case.
    needsVerification: mutations.length > 0 && verifications.length === 0,
  };
}

/** One executed tool call, as observed by the loop (args + result text). */
export interface ToolCallEvidence {
  tool: string;
  args?: Record<string, unknown>;
  /** The tool-result text (the loop feeds this to the model verbatim). */
  result?: string;
}

/**
 * Commands that exercise the WHOLE project, so any change in it is covered.
 * `npm test`, a typecheck, a build, a linter — these observe the artifact even
 * when they never name the changed file.
 *
 * `node --check` USED to be in this list, which is what let the calculator
 * session report "verified" after running `node -c script.js`. See
 * `PARSE_ONLY_RE` below for why that cannot count.
 */
const GENERIC_VERIFY_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:--prefix[=\s]+\S+\s+)?(?:run\s+)?(?:test|build|lint|typecheck|check|ci)\b|\b(?:tsc|vitest|jest|pytest|mocha|cargo\s+test|go\s+test|gradle|mvn|make)\b/i;

/**
 * Commands that only PARSE the files they are handed. They prove the source is
 * syntactically valid and nothing else.
 *
 * WHY THIS EXISTS. The 2026-09-23 calculator re-test reproduced the audit's
 * finding through a new door: asked to review a project, the agent ran
 * `node -c script.js` and the gate accepted it as verification. It then
 * reported the code "in good shape" while a live correctness bug sat on line
 * 102 — a bug a parser cannot see, because a parser has no notion of what
 * `display.value` holds at runtime. A modification to BEHAVIOUR cannot be
 * observed by a syntax check, so these never satisfy the gate.
 *
 * The same reasoning as the `echo hi` hole this module already closed: a run
 * counts only when it can observe the thing that changed.
 */
const PARSE_ONLY_RE =
  /\bnode\s+(?:--check|-c)\b|\bpython[23]?\s+-m\s+(?:py_compile|compileall)\b|\bpy_compile\b|\b(?:ruby|perl)\s+-c\b|\bphp\s+-l\b|\bbash\s+-n\b|\bgcc\s+-fsyntax-only\b/i;

/** The text an evidence entry exposes to the relevance + parse-only checks. */
function evidenceText(e: ToolCallEvidence): string {
  let text = e.result ?? '';
  if (e.args) {
    try {
      text += ` ${JSON.stringify(e.args)}`;
    } catch {
      // Unserializable args — the result text alone is still usable.
    }
  }
  return text;
}

/**
 * Is this evidence a parse/syntax check rather than an observation of
 * behaviour?
 *
 * A run that ALSO performs a real check (`node -c a.js && npm test`) is judged
 * on the real check — it is not demoted for the parse step it contains.
 */
export function isParseOnlyCheck(evidence: ToolCallEvidence): boolean {
  const text = evidenceText(evidence);
  return PARSE_ONLY_RE.test(text) && !GENERIC_VERIFY_RE.test(text);
}

// ─── WHICH CHECK COVERS WHICH FILE (the nested-package rule) ────────────────

/**
 * Runner configs that mean "this directory has its OWN suite", script or not.
 * Mirrors the markers `detectAvailableChecks` already accepts one level down.
 */
const OWN_TEST_CONFIG_FILES = [
  'vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs',
  'jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.mjs',
  'pytest.ini', 'Cargo.toml', 'go.mod',
] as const;

/** Does this path exist as a file? (Never throws.) */
function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Does this directory declare its OWN test command — i.e. a suite that an
 * ANCESTOR's generic check will not run? Deliberately test-shaped only: a bare
 * `package.json` (a deps-only stub) has no suite, so a change under it is still
 * judged the old, permissive way.
 */
function packageHasOwnTests(dir: string): boolean {
  if (!fileExists(join(dir, 'package.json'))) {
    // No manifest, but a runner config is still a suite of its own.
    return OWN_TEST_CONFIG_FILES.some((f) => fileExists(join(dir, f)));
  }
  const pkg = readJsonSafe(join(dir, 'package.json'));
  const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
  for (const k of ['test', 'tests']) {
    if (typeof scripts[k] === 'string' && String(scripts[k]).trim().length > 0) return true;
  }
  return OWN_TEST_CONFIG_FILES.some((f) => fileExists(join(dir, f)));
}

/** Memoized package-script bodies, so the gate does not re-read per changed file. */
const packageScriptCache = new Map<string, Record<string, unknown>>();

/** The `scripts` object of a package, or {} (memoized, never throws). */
function packageScripts(dir: string): Record<string, unknown> {
  const cached = packageScriptCache.get(dir);
  if (cached) return cached;
  const pkg = fileExists(join(dir, 'package.json')) ? readJsonSafe(join(dir, 'package.json')) : null;
  const scripts = ((pkg?.scripts ?? {}) as Record<string, unknown>) || {};
  packageScriptCache.set(dir, scripts);
  return scripts;
}

/** npm/pnpm/yarn subcommands that are NOT package scripts. */
const RESERVED_SUBCOMMANDS = new Set([
  'install', 'i', 'ci', 'ls', 'list', 'view', 'info', 'show', 'publish', 'pack', 'exec', 'x',
  'audit', 'outdated', 'why', 'init', 'create', 'config', 'link', 'unlink', 'update', 'up',
  'dedupe', 'prune', 'fund', 'doctor', 'cache', 'login', 'logout', 'owner', 'root', 'prefix',
  'add', 'remove', 'rm', 'dlx', 'import', 'rebuild', 'help',
]);

/** The script a `npm run <name>` / `npm test` style command invokes, or null. */
function scriptNameOf(text: string): string | null {
  const m = /^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:_-]+)\b/.exec(text.trim());
  if (!m) return null;
  const name = m[1];
  return RESERVED_SUBCOMMANDS.has(name) ? null : name;
}

/**
 * Where do this command's checks actually RUN?
 *
 * `cd src/web-dashboard && npm test` → that package. `npm --prefix x run test`
 * → x. `npm run test:dashboard` → wherever the root script it names goes, which
 * is how a project declares the canonical check for a nested package. Anything
 * else runs at `cwd`.
 *
 * One level of script indirection only (depth < 2), so a self-referential or
 * pathological chain cannot loop.
 */
export function checkRootFor(command: string, cwd: string, depth = 0): string {
  const text = String(command ?? '');
  const cd = /\bcd\s+(?:--\s+)?(?:"([^"]+)"|'([^']+)'|([^\s&;|)]+))/.exec(text);
  const cdTarget = cd?.[1] ?? cd?.[2] ?? cd?.[3];
  if (cdTarget) return resolve(cwd, cdTarget);

  const prefix = /--prefix[=\s]+(?:"([^"]+)"|'([^']+)'|([^\s&;|)]+))/.exec(text);
  const prefixTarget = prefix?.[1] ?? prefix?.[2] ?? prefix?.[3];
  if (prefixTarget) return resolve(cwd, prefixTarget);

  if (depth < 2) {
    const name = scriptNameOf(text);
    if (name) {
      const body = packageScripts(cwd)[name];
      if (typeof body === 'string' && body.trim()) return checkRootFor(body, cwd, depth + 1);
    }
  }
  return resolve(cwd);
}

/**
 * Is `fileAbs` covered by a generic check rooted at `rootAbs`?
 *
 * The walk is the whole rule: start at the file's own directory and climb to
 * the check root; if any package on the way declares its OWN test command, the
 * ancestor's check does not run it, so the answer is NO.
 */
function pathCoveredByRoot(fileAbs: string, rootAbs: string): boolean {
  const under = relative(rootAbs, fileAbs);
  if (under === '' || under.startsWith('..')) return false;
  let cur = dirname(fileAbs);
  for (;;) {
    const rel = relative(rootAbs, cur);
    if (rel === '' || rel.startsWith('..')) return true; // reached (or passed) the check root
    if (packageHasOwnTests(cur)) return false;
    const parent = dirname(cur);
    if (parent === cur) return true;
    cur = parent;
  }
}

/**
 * Does this command's check cover this changed file?
 *
 * `foreign` = the file is outside the project root entirely. We do not judge
 * those (there is nothing to compare against), so the previous permissive
 * answer stands rather than inventing a stricter rule with no evidence behind
 * it — the same stance the empty-`changedFiles` fallback takes.
 */
function commandCoversFile(command: string, fileAbs: string, cwdAbs: string, foreign: boolean): boolean {
  if (foreign) return true;
  const root = checkRootFor(command, cwdAbs);
  return pathCoveredByRoot(fileAbs, root);
}

/** The `command` argument of an executed run (falls back to the result text). */
function commandOf(e: ToolCallEvidence): string {
  const a = e.args as { command?: unknown; cmd?: unknown } | undefined;
  const c = a?.command ?? a?.cmd;
  return typeof c === 'string' ? c : (e.result ?? '');
}

/**
 * WHICH of the changed files did this turn's verification actually EXERCISE?
 *
 * This is the per-file truth the gate's boolean and the working-state ledger's
 * debt both derive from, so the two can never disagree about what was covered.
 *
 * A file counts when some successful observation either:
 *   - NAMES it (`grep … style.css`, `node --check script.js` — the parse filter
 *     below removes the syntax-only shapes), OR
 *   - is the `test` pipeline, judged by the same coverage rule as a generic
 *     command at the project root (see {@link checkRootFor}), OR
 *   - is a real `browser` run — a live observation of the running app, which is
 *     precisely the check a component change needs, so it is never narrowed, OR
 *   - is a generic project check whose ROOT covers the file (`npm test` at the
 *     root covers root files; the nested package's own script covers its own).
 */
/**
 * NOTE ON `needsVerification` vs the per-file split. The gate asks ONE question —
 * "did anything observe this turn's result?" — and spends one bounded nudge; the
 * split says WHICH files are still owed a check. They are deliberately not the
 * same predicate: a turn that covered three of four files is not a turn with no
 * verification at all, and firing the nudge on it would ask again for work the
 * model already did. The outstanding file is carried by `unverifiedPaths`
 * instead (the ledger's debt and the next turn's block), which is where it can
 * be acted on; `needsVerification` stays what it always was.
 */
export function verifiedPathsFor(
  evidence: readonly ToolCallEvidence[],
  changedFiles: readonly string[],
  cwd: string = process.cwd(),
): string[] {
  const observed = evidence.filter((e) => !isParseOnlyCheck(e));
  if (observed.length === 0) return [];
  const cwdAbs = resolve(cwd);
  const covered: string[] = [];

  for (const f of changedFiles) {
    if (!f) continue;
    const fileAbs = resolve(cwdAbs, f);
    const foreign = relative(cwdAbs, fileAbs).startsWith('..');
    const base = f.split(/[\\/]/).pop() ?? '';
    let hit = false;
    for (const e of observed) {
      if (e.tool === 'browser') {
        hit = true;
        break;
      }
      if (e.tool === 'test') {
        if (commandCoversFile('npm test', fileAbs, cwdAbs, foreign)) {
          hit = true;
          break;
        }
        continue;
      }
      const text = evidenceText(e);
      if (base && text.includes(base)) {
        hit = true;
        break;
      }
      if (f && text.includes(f)) {
        hit = true;
        break;
      }
      if (GENERIC_VERIFY_RE.test(text) && commandCoversFile(commandOf(e), fileAbs, cwdAbs, foreign)) {
        hit = true;
        break;
      }
    }
    if (hit) covered.push(f);
  }
  return covered;
}

/**
 * Did this turn's verification actually EXERCISE the artifact it changed?
 *
 * The first cut accepted ANY successful `run_terminal` — so `echo hi` or `ls`
 * marked a turn "verified" (the same class of false positive the gate exists to
 * prevent). A run counts only when it:
 *   - is the `test` pipeline or a real `browser` run (inherently project-wide), OR
 *   - runs a generic project check (`npm test`, typecheck, build, linter) that
 *     COVERS the changed file (see {@link checkRootFor} for the nested-package
 *     rule this gained), OR
 *   - names one of the files the turn changed (e.g. `grep … style.css`).
 *
 * When the turn's changed paths are UNKNOWN, it falls back to "any successful
 * verification counts" — the pre-strictening behaviour — so an unidentifiable
 * mutation is never falsely flagged.
 *
 * Delegates to {@link verifiedPathsFor} rather than re-implementing the rule, so
 * the gate and the per-file debt cannot drift apart.
 */
export function verificationExercisedArtifact(
  evidence: readonly ToolCallEvidence[],
  changedFiles: readonly string[],
  cwd: string = process.cwd(),
): boolean {
  // A parse check observes syntax, never behaviour — drop it before judging,
  // so it can satisfy neither the relevance match nor the file-name match.
  if (evidence.filter((e) => !isParseOnlyCheck(e)).length === 0) return false;
  // Unknown changed paths → cannot judge relevance; don't cry wolf.
  if (changedFiles.length === 0) return true;
  return verifiedPathsFor(evidence, changedFiles, cwd).length > 0;
}

/**
 * Full edit assessment for a turn: what mutated, what verified, and whether a
 * verification still OWED. This is the single call the loop uses so the gate,
 * the nudge and the honesty flag can never disagree.
 *
 * `verifiedPaths` / `unverifiedPaths` are the PER-FILE split of the same
 * judgement; the caller records them in the working-state ledger so the debt it
 * owes is a set of paths rather than a bare count.
 */
export function assessEditActivity(
  toolsRun: readonly string[],
  evidence: readonly ToolCallEvidence[] = [],
  changedFiles: readonly string[] = [],
  cwd: string = process.cwd(),
): {
  mutations: string[];
  verifications: string[];
  needsVerification: boolean;
  verifiedPaths: string[];
  unverifiedPaths: string[];
} {
  const base = classifyEditActivity(toolsRun);
  if (base.mutations.length === 0) {
    return { ...base, needsVerification: false, verifiedPaths: [], unverifiedPaths: [] };
  }
  const verifiedPaths = verifiedPathsFor(evidence, changedFiles, cwd);
  const covered = new Set(verifiedPaths);
  return {
    ...base,
    needsVerification: !verificationExercisedArtifact(evidence, changedFiles, cwd),
    verifiedPaths,
    unverifiedPaths: changedFiles.filter((f) => f && !covered.has(f)),
  };
}

/** A sentence that is future/interrogative/negated is NOT a completed claim. */
const NON_CLAIM_CONTEXT_RE =
  /\b(?:not|n't|never|unable|cannot|can't|couldn't|didn't|won't|will|would|should|could|can|may|might|going to|about to|try(?:ing)? to|attempt|if you|let me|shall i|should i|do you want|i'?ll|next|then)\b/i;

/**
 * Past-tense sentences that ASSERT a completed code change. Grouped, because
 * the audit surfaced several distinct phrasings the model used:
 *   - "I have successfully secured the calculator…"
 *   - "The inline event handlers have been successfully removed…"
 *   - "I have applied the requested changes…"
 *   - "The converter is now fully operational…"
 */
const EDIT_CLAIM_RES: readonly RegExp[] = [
  // First-person completed change: "I have fixed / updated / refactored …"
  /\bi(?:'ve| have)\s+(?:just\s+|now\s+|also\s+|already\s+|successfully\s+)*(?:fixed|updated|refactored|implemented|applied|added|created|removed|corrected|replaced|rewritten|rewrote|changed|modified|enhanced|completed|adjusted|introduced|resolved|rebuilt|migrated|secured|cleaned\s+up|wired\s+up|hooked\s+up)\b/i,
  // Bare verb form: "I fixed / updated …"
  /\bi\s+(?:just\s+|already\s+|successfully\s+|now\s+)*(?:fixed|updated|refactored|implemented|applied|corrected|replaced|removed|resolved|rewrote|rebuilt)\b/i,
  // Adverb-led success: "successfully updated / properly fixed / fully implemented"
  /\b(?:successfully|properly|fully|correctly)\s+(?:fixed|updated|refactored|implemented|applied|added|created|removed|corrected|replaced|changed|modified|moderni[sz]ed|improved|polished|styled|reworked|optimi[sz]ed|simplified|hardened|enhanced|completed|resolved|rewired|restored|cleaned|secured|wired|hooked)\b/i,
  // Passive change: "the fix / changes / edits have been applied"
  /\b(?:the\s+)?(?:fix|change|changes|update|updates|edit|edits|issue|bug|problem|error|refactor|patch)\s+(?:has|have|is|are)\s+(?:now\s+)?(?:been\s+)?(?:applied|made|implemented|fixed|completed|resolved|added|removed|corrected|patched)\b/i,
  // State assertion: "it is now fully operational / working / fixed"
  /\b(?:is|are|it'?s|this\s+is|that\s+is)\s+(?:now\s+)?(?:fully\s+|properly\s+|already\s+)?(?:operational|functional|working(?:\s+(?:correctly|now|fine|as\s+expected))?|fixed|complete|completed|done|ready|in\s+place|up\s+to\s+date)\b/i,
  // "I have applied the requested changes"
  /\bi(?:'ve| have)\s+(?:now\s+|just\s+)*(?:applied|made)\s+the\s+(?:changes|requested\s+changes|fix|edits|updates|modifications)\b/i,
  // "the changes are applied / complete"
  /\b(?:changes|edits|updates|modifications)\s+(?:are|have\s+been)\s+(?:applied|made|complete|completed|done)\b/i,
];

/**
 * True when the answer asserts a completed CODE change that no verification
 * backed.
 *
 * The claim is judged ONLY when the turn actually mutated the workspace and
 * ran nothing that could observe the result. If a verification tool ran
 * successfully, the assertion is (at least) grounded in an observed artifact
 * and the flag stays quiet — crying wolf on a verified edit would erode the
 * flag the way an over-eager linter gets ignored.
 *
 * Sentence-scoped so a negation or a conditional elsewhere in the answer
 * never turns a truthful statement into a flag (and vice-versa).
 */
export function detectUnverifiedEditClaim(
  content: string,
  mutationsRun: readonly string[],
  verificationsRun: readonly string[],
): boolean {
  const text = (content || '').trim();
  if (!text) return false;
  // Nothing was changed → no code-change claim can be "unverified".
  if (!mutationsRun.some(isMutationTool)) return false;
  // Something observed the artifact → the claim is grounded.
  if (verificationsRun.some(isVerificationTool)) return false;

  const sentences = text.split(/(?<=[.!?\u3002\uff01\uff1f])\s+|\n+/);
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s || NON_CLAIM_CONTEXT_RE.test(s)) continue;
    if (EDIT_CLAIM_RES.some((re) => re.test(s))) return true;
  }
  return false;
}

/**
 * The nudge sent when a turn mutated the workspace and verified nothing.
 * Deliberately concrete (names the tools) so a weak model can act on it
 * without inventing a syntax — the same principle as `TOOL_FALLBACK_HINTS`.
 */
/** One check the project actually HAS, strongest first. */
export interface AvailableCheck {
  /** The exact command to run. */
  command: string;
  /** Where it comes from, phrased for the model ("the \"test\" script in package.json"). */
  label: string;
  /** Higher = observes more. Used only for ordering. */
  strength: number;
  /**
   * Absolute directory this check COVERS — the package it runs in. Absent means
   * the project root. Used to prefer the check that actually covers the files a
   * turn changed (`npm run test:dashboard` over `npm test` for a dashboard file).
   */
  root?: string;
}

/** Read a JSON file, returning null on any failure (never throws at the gate). */
function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Directories never walked looking for nested packages. */
const NESTED_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', '.git', '.next',
]);
/** How deep a nested package may sit (`src/web-dashboard`, `examples/sdk` = 2). */
const NESTED_MAX_DEPTH = 2;

/**
 * Relative paths of packages nested under `cwd` (bounded depth, no vendor dirs).
 * Dot-directories are skipped, so a checked-in toolchain cache (`.vscode-test`)
 * is never mistaken for a package in the project.
 */
function findNestedPackages(cwd: string): string[] {
  const found: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > NESTED_MAX_DEPTH) return;
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || NESTED_SKIP_DIRS.has(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (fileExists(join(cwd, child, 'package.json'))) found.push(child);
      walk(child, depth + 1);
    }
  };
  walk('', 1);
  return found;
}

/**
 * Which verification checks does THIS project actually have?
 *
 * The nudge used to name a generic preference order ("the project's own test
 * command, a typecheck or build, a real run"). That is the right ORDER but it is
 * not actionable on its own: a model holding it still has to guess what the
 * project has, and the guess it reached for in a live turn was `node -c` — the
 * cheapest thing available, and the one that is not allowed to count. Asking for
 * the strongest check only works if the loop NAMES it, so this detects the real
 * command instead of describing one.
 *
 * Deterministic, filesystem-only, never throws — a project with no checks at all
 * is a normal answer (and produces the honest "say so explicitly" nudge).
 */
export function detectAvailableChecks(cwd: string): AvailableCheck[] {
  const checks: AvailableCheck[] = [];
  const add = (command: string, label: string, strength: number, root?: string): void => {
    if (!checks.some((c) => c.command === command)) checks.push({ command, label, strength, ...(root ? { root } : {}) });
  };
  const cwdAbs = resolve(cwd);

  const pkg = fileExists(join(cwd, 'package.json')) ? readJsonSafe(join(cwd, 'package.json')) : null;
  const scripts = ((pkg?.scripts ?? {}) as Record<string, unknown>) || {};
  const hasScript = (k: string): boolean => typeof scripts[k] === 'string' && String(scripts[k]).trim().length > 0;

  // The project's OWN test command is the strongest observation there is.
  if (hasScript('test')) add('npm test', 'the "test" script in package.json', 100);
  if (hasScript('tests')) add('npm test', 'the "tests" script in package.json', 100);
  if (hasScript('typecheck')) add('npm run typecheck', 'the "typecheck" script in package.json', 80);
  if (hasScript('type-check')) add('npm run type-check', 'the "type-check" script in package.json', 80);
  if (hasScript('build')) add('npm run build', 'the "build" script in package.json', 60);
  if (hasScript('lint')) add('npm run lint', 'the "lint" script in package.json', 40);
  if (hasScript('check')) add('npm run check', 'the "check" script in package.json', 40);

  // A runner configured without a package script is still a real test command.
  if (!checks.some((c) => c.strength >= 90)) {
    for (const name of ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js']) {
      if (fileExists(join(cwd, name))) {
        add('npx vitest run', `a ${name}`, 95);
        break;
      }
    }
    for (const name of ['jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.mjs']) {
      if (fileExists(join(cwd, name))) {
        add('npx jest', `a ${name}`, 95);
        break;
      }
    }
    if (fileExists(join(cwd, 'pytest.ini')) || fileExists(join(cwd, 'pyproject.toml'))) {
      add('pytest', 'a Python test setup', 95);
    }
    if (fileExists(join(cwd, 'Cargo.toml'))) add('cargo test', 'a Cargo project', 95);
    if (fileExists(join(cwd, 'go.mod'))) add('go test ./...', 'a Go module', 95);
  }

  // A typechecker with no script is still the strongest static observation.
  if (fileExists(join(cwd, 'tsconfig.json'))) add('npx tsc --noEmit', 'a tsconfig.json', 70);

  // ── NESTED PACKAGES (a monorepo's own suites) ───────────────────────────
  // A root `npm test` does NOT run a nested package's suite, so a project that
  // has one has already declared the command that does — a root script that
  // `cd`s into it (`"test:dashboard": "cd src/web-dashboard && npm test"`).
  // Name THAT: it is the canonical way this project checks that package, so the
  // model has nothing to invent.
  const coveredRoots = new Set<string>();
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string' || !body.trim()) continue;
    if (!GENERIC_VERIFY_RE.test(body)) continue;
    const root = checkRootFor(body, cwdAbs);
    if (root === cwdAbs || !fileExists(join(root, 'package.json'))) continue;
    coveredRoots.add(root);
    const where = relative(cwdAbs, root) || '.';
    add(`npm run ${name}`, `the "${name}" script in package.json (covers ${where})`, 100, root);
  }
  // A nested package with its own suite and NO root script for it: the suite
  // exists, so name the direct command instead of leaving it invisible.
  for (const rel of findNestedPackages(cwdAbs)) {
    const abs = join(cwdAbs, rel);
    if (coveredRoots.has(abs) || !packageHasOwnTests(abs)) continue;
    add(`cd ${rel} && npm test`, `the project in ${rel} (its own test command)`, 100, abs);
  }

  return checks.sort((a, b) => b.strength - a.strength);
}

/**
 * The nudge sent when a turn mutated the workspace and verified nothing.
 *
 * Deliberately concrete (names the tools) so a weak model can act on it
 * without inventing a syntax — the same principle as `TOOL_FALLBACK_HINTS`.
 * Static text, exported for callers that have no workspace (and for back-compat);
 * the loop uses {@link verificationNudgeFor}, which names THIS project's checks.
 */
export const VERIFICATION_NUDGE =
  'You changed files this turn but nothing VERIFIED the change — an edit is not ' +
  'evidence that it works, and neither is a syntax/parse check (`node --check` / ' +
  '`node -c`, `python -m py_compile`): those prove the file PARSES, not that it ' +
  'behaves correctly, so they do not count. Run the strongest check this project ' +
  'actually has, in this order of preference: (1) the project\u2019s own test command ' +
  '(package.json "test", or `nuvira test`), (2) a typecheck or build, (3) the ' +
  'browser tool or a real run that exercises the changed code with actual input. ' +
  'Then report what that check showed. If genuinely no such check exists here, ' +
  'say so explicitly and do NOT claim the change works.';

/**
 * The verification nudge for a specific workspace — the strongest check it
 * actually HAS, named.
 *
 * The difference from {@link VERIFICATION_NUDGE} is the difference between
 * "run the strongest check you have" and "run `npm test`". A model handed the
 * first re-derives the answer and reaches for the cheapest thing that looks like
 * a check; a model handed the second has nothing to guess. When the project has
 * no runnable check at all the instruction is a REAL RUN, and failing that an
 * explicit admission — never a claim.
 */
/**
 * File extensions that are WRITING deliverables rather than executable code.
 *
 * A `.md`/`.txt` file is the deliverable itself — there is nothing to "run".
 * Treating it like code is what made an essay turn run the whole
 * test/typecheck/run gauntlet (and, before that, spin twice producing nothing)
 * for ten lines about cows.
 */
const PROSE_ARTIFACT_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx', '.txt', '.text', '.rst', '.adoc', '.asc', '.org',
]);

/** Is this changed path a prose/text deliverable (not code)? */
export function isProseArtifactPath(path: string): boolean {
  const clean = String(path ?? '').trim().toLowerCase();
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return false;
  return PROSE_ARTIFACT_EXTENSIONS.has(clean.slice(dot));
}

export function verificationNudgeFor(cwd: string, changedFiles: readonly string[] = []): string {
  const cwdAbs = resolve(cwd);
  const allChanged = changedFiles.filter(Boolean);
  const changed = allChanged.slice(0, 5);

  // ORDER BY RELEVANCE, not strength alone. In a monorepo the strongest check
  // for the project (`npm test`) is not the check that covers the file that
  // changed — the nested package's own suite is. Preferring a check the files are
  // not under would send the model to run a suite that cannot see its change.
  const coversChanged = (c: AvailableCheck): boolean => {
    if (allChanged.length === 0) return false;
    const root = c.root ?? cwdAbs;
    return allChanged.some((f) => {
      const abs = resolve(cwdAbs, f);
      if (relative(cwdAbs, abs).startsWith('..')) return false;
      return pathCoveredByRoot(abs, root) && relative(root, abs) !== '';
    });
  };
  const checks = [...detectAvailableChecks(cwd)].sort(
    (a, b) => Number(coversChanged(b)) - Number(coversChanged(a)) || b.strength - a.strength,
  );

  // A WRITING deliverable is verified by its CONTENT, not by a test/build/run —
  // none of those apply to prose, and asking for them sent a weak model into
  // empty retries. Say what the check actually is, so it converges in one step.
  if (allChanged.length > 0 && allChanged.every((f) => isProseArtifactPath(f))) {
    return (
      'You produced a written deliverable this turn' +
      (changed.length > 0 ? ` (${changed.join(', ')})` : '') +
      ' but nothing VERIFIED the change. A written file IS the deliverable, so the check ' +
      'is a CONTENT check — not a test, typecheck, build or run (those do not apply to prose). ' +
      'Re-read the file (`read_files`, or `run_terminal` with `cat <file>`) and confirm it contains ' +
      'what the request asked for — the right subject, the requested length and structure, and no ' +
      'placeholder text. Fix anything wrong, then say plainly what you checked.'
    );
  }

  const head =
    'You changed files this turn' +
    (changed.length > 0 ? ` (${changed.join(', ')})` : '') +
    ' but nothing VERIFIED the change — an edit is not evidence that it works, and neither ' +
    'is a syntax/parse check (`node --check` / `node -c`, `python -m py_compile`): those prove ' +
    'the file PARSES, not that it behaves correctly, so they do not count.';

  if (checks.length === 0) {
    return (
      `${head}\n` +
      'No test, typecheck or build command was found in this project, so the strongest check ' +
      'AVAILABLE to you is a REAL RUN that exercises the changed code — the `browser` tool, or ' +
      '`run_terminal` with a command that executes the changed behaviour with real input. Then ' +
      'report what it showed. If even that is impossible, say so explicitly and do NOT claim ' +
      'the change works.'
    );
  }

  const best = checks.slice(0, 3);
  const list = best
    .map((c, i) => `  ${i + 1}. \`${c.command}\` — ${c.label}`)
    .join('\n');
  // Say WHEN the first check is the one that covers this change, so a monorepo
  // turn does not answer a nested package's change with the root suite (a suite
  // that cannot see it). Only asserted when it is true of the files shown.
  const top = best[0];
  const coversLine =
    top && coversChanged(top)
      ? `\n\`${top.command}\` is the check that COVERS the file(s) you changed; the others ` +
        'run a different part of the repository and cannot observe this change.\n'
      : '';
  return (
    `${head}\n` +
    `This project's strongest available checks, best first:${coversLine}\n${list}\n` +
    'Run the strongest one and report what it showed. If it does not apply to this change, say ' +
    'which you tried and why. If none of them runs, say so explicitly and do NOT claim the ' +
    'change works.'
  );
}

/**
 * The nudge sent when a turn ended asking PERMISSION for work the user's own
 * request already authorized (G13 — the manual-cadence complaint).
 *
 * Deliberately states the authorization and the expected behaviour, and names
 * the one case where asking is still right, so the model does not read this as
 * "never consult" — a blanket no-asking rule would produce silent wrong turns
 * instead of stalls, which is worse. The vocabulary is the autonomy policy's:
 * proceed unless the decision is blocking, high-impact, irreversible and has
 * no sensible default.
 */
/**
 * The escalation sent when the model produces REASONING ONLY, repeatedly, with
 * no tool call and no answer.
 *
 * WHY THIS EXISTS (a live eval run, 2026-09-23). A think-only response makes the
 * loop `continue` so a model that emits a reasoning block then its answer in the
 * next step is not cut off — sensible, but UNBOUNDED: nothing counted the
 * continuations and nothing ever changed the instruction. Both groq and gemini
 * therefore produced 31 consecutive reasoning-only steps, one `list_dir` call,
 * and a 0% score on a task they were perfectly capable of doing — with the exact
 * "model reasoning… (continuing)" spam a user had already reported in a real
 * dashboard turn. A spin is not a stall the user can act on; it burns the whole
 * budget and looks like the agent thinking hard while nothing happens.
 *
 * Deliberately an ESCALATION rather than a hard stop on the first repeat: a
 * legitimate `<think>`-then-answer model needs a step or two, so the loop allows
 * a small budget, then says this, then ends the turn honestly if it still spins.
 */
export const THINK_ONLY_ESCALATION =
  'You have produced only reasoning for several steps — no tool call and no answer to the ' +
  'user. Stop reasoning and ACT: call the tool you need now, or write your final answer. ' +
  'If you are unsure, make the decision you can defend and proceed — the user is waiting on ' +
  'a result, not on deliberation.';

export const AUTHORIZED_WORK_NUDGE =
  'The user\u2019s own request already asked for this work, so asking whether to ' +
  'proceed is a round trip that delivers nothing. Do NOT end the turn on a request ' +
  'for permission: carry the work out with the tools available, decide anything that ' +
  'is yours to decide, and state the decision in your answer so the user can redirect. ' +
  'Reserve `ask_user` for a decision that is genuinely theirs — one that cannot ' +
  'proceed without an answer, is high-impact and irreversible, and has no sensible ' +
  'default — and never ask for permission in plain text.';

/**
 * The nudge sent when the request asked for an AUTHORED deliverable to be
 * produced and the turn ended having written nothing to disk (G13b).
 *
 * WHY THIS IS NOT THE EXISTING DANGLING-PROMISE NUDGE. That one fires when the
 * model announces an action and does nothing — it keys on the model's closing
 * line. The failure here is quieter and was the one that shipped a 12-page story
 * into a chat window: the model DID the work, in prose, and simply never wrote
 * it anywhere. There is no promise to detect and no missing tool call to point
 * at, so the gate has to key on the REQUEST and the ABSENCE of a file.
 *
 * It names the destination when the request gave one ("write it to the path the
 * request named") because "write it somewhere" leaves the model free to answer
 * with a filename it invented; it also says plainly that composing the text was
 * not enough, since that is exactly what the model believes it already did.
 */
export function deliverableNudge(requestedPath?: string): string {
  const destination = requestedPath
    ? `the request named the destination \u2014 write the complete work to ${requestedPath}`
    : 'write the complete work to a file (naming it after the deliverable) in the workspace';
  return (
    'The request asked for a written deliverable to be PRODUCED, and you composed the text in your ' +
    'reply but wrote no file \u2014 so nothing has been delivered. Composing it in the answer does not ' +
    'satisfy the request: ' + destination + ', using write_file. The request itself already authorised ' +
    'this, so do not stop to ask. When the file is written, say which path it landed at.'
  );
}

/**
 * The correction appended to a delivered answer whose code-change claim was
 * never verified. Kept short and honest — it states what is known, not a
 * verdict about whether the edit is correct.
 */
export const UNVERIFIED_EDIT_NOTE =
  '\u26a0\ufe0f Note: files were changed this turn but no verification (test / ' +
  'typecheck / build / browser run) confirmed the result — treat the claim above ' +
  'as unverified.';
