/**
 * Documentation duty + claim audit.
 *
 * WHY THIS EXISTS (measured 2026-10-25, three agents, one build task). Offered the
 * same prompt — which named a README — nuvira wrote five planning documents and no
 * README, Cline wrote nine docs and no README, Freebuff wrote 721 lines of docs and
 * no README. Three independent harnesses failing the same literal instruction is
 * the strongest possible evidence that "complete documentation" is not attached to
 * anything that can fail. It is an adjective; a fresh clone cannot run an adjective.
 *
 * So this module supplies the two checks a loop can actually make:
 *
 * 1. QUICKSTART DUTY — a turn that produced a RUNNABLE entry point (a `package.json`
 *    with scripts, a Makefile, a compose file) and left no README has not documented
 *    the project, however many architecture notes it wrote.
 * 2. CLAIM AUDIT — every markdown file this turn wrote is scanned for claims that
 *    name an artifact (`npm run test:e2e`, `tests/e2e/checkout.spec.ts`). Each is
 *    resolved against the filesystem and `package.json`; a contradiction is
 *    reported. Measured antecedent: nuvira's own ROADMAP and RISK_REGISTER cited
 *    tests it never wrote, and no agent — nuvira, Cline or Freebuff — checks a
 *    document against the tree it describes.
 *
 * WHAT IT DOES NOT DO: it does not judge prose, and it does not demand a README on
 * a turn that merely edited one. It resolves REFERENCES ("does this path exist",
 * "is this script defined"), never truth — a doc may plan a future test, so the
 * finding says "not present" and the model may keep it with a note.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
// CONTRACT VERIFICATION — a spec is a claim about the whole API surface, and it is the
// one document a stranger's tooling trusts without reading the code (see
// `learning/api-contract.ts`). Measured 2026-10-27: the winning arm shipped a 42-path
// OpenAPI document and verified its refs; this arm had no way to tell whether a spec it
// wrote described the routes it registered.
import { contractFindings, verifyApiContract } from './api-contract.js';

/** A README below this is a placeholder, not a quickstart. */
export const MIN_README_BYTES = 1200;

/** Above this the doc is not going to be audited cheaply (and is usually data). */
const MAX_DOC_CHARS = 120_000;

const RUNNABLE_ENTRY = /^(?:package\.json|makefile|docker-compose\.ya?ml|compose\.ya?ml|pyproject\.toml|cargo\.toml|go\.mod|gemfile|pom\.xml|build\.gradle(?:\.kts)?)$/i;

export interface QuickstartDuty {
  needed: boolean;
  /** The entry point that made the project runnable, relative to the workspace. */
  entry?: string;
  /** A README was found but is too thin to follow. */
  thinReadme?: { path: string; bytes: number };
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf-8').slice(0, MAX_DOC_CHARS);
  } catch {
    return '';
  }
}

function findReadme(cwd: string): { path: string; bytes: number } | null {
  let names: string[] = [];
  try {
    names = readdirSync(cwd);
  } catch {
    return null;
  }
  const name = names.find((n) => /^readme(\.md|\.markdown|\.txt)?$/i.test(n));
  if (!name) return null;
  try {
    const st = statSync(join(cwd, name));
    if (!st.isFile()) return null;
    return { path: name, bytes: st.size };
  } catch {
    return null;
  }
}

/**
 * Does this turn owe a quickstart?
 *
 * Only when it WROTE a runnable entry point this turn: a build task that adds or
 * rewrites `package.json` has made the project launchable, and the one document a
 * human needs first is the one that says how. An edit turn that touches a service
 * file owes nothing, which is what keeps this from firing on every turn.
 */
export function quickstartDuty(input: { cwd: string; writtenPaths: readonly string[] }): QuickstartDuty {
  const entries = input.writtenPaths.filter((p) => RUNNABLE_ENTRY.test(basename(p)));
  if (entries.length === 0) return { needed: false };
  const readme = findReadme(input.cwd);
  if (readme && readme.bytes >= MIN_README_BYTES) return { needed: false };
  return {
    needed: true,
    entry: posix(entries[0]),
    ...(readme ? { thinReadme: readme } : {}),
  };
}

/** The quickstart nudge — names the entry point and the bar the README must clear. */
export function quickstartNudge(duty: QuickstartDuty): string {
  const entry = duty.entry ?? 'a runnable entry point';
  const state = duty.thinReadme
    ? `README exists but is ${duty.thinReadme.bytes} bytes — too thin to follow.`
    : 'There is no README.';
  return [
    `This turn produced a runnable project (\`${entry}\`) and did not document how to run it. ${state}`,
    'Write README.md now with:',
    '  1. one line on what it is;',
    '  2. the exact setup commands (install, env vars, database);',
    '  3. the exact run command, copied from the scripts that exist;',
    '  4. how to run the tests, and the URL/port the app comes up on.',
    'Every command you write must be one the project DEFINES — do not invent `npm run` scripts.',
  ].join('\n');
}

/**
 * PRODUCTION-READINESS DUTY — a "production-ready" ask owes a way to run it in production.
 *
 * WHY THIS EXISTS (measured 2026-10-26, the final bench). The documentation row is worth 100:
 * README 30, API docs 25, deployment 25, architecture 20. The patched arm scored 75 — a 9,520-byte
 * README, API docs and an architecture document, and nothing that says how the thing ships, because
 * it deleted its `docker-compose.yml` when the mid-run SQLite change request landed and never
 * replaced the deployment story. Cline scored 100, and the whole gap was that one row.
 *
 * THE SAME ROW, A DIFFERENT FAILURE, in the round before it: four nuvira/freebuff arms scored 70,
 * 70, 70 and 45 with NO README at all, and the README nudge in the 210-step arm fired at step 209.
 * That one is a TIMING defect and is fixed in the loop (the duty is now asked mid-build, where
 * there is budget); this module owns only the FACT it asks about.
 *
 * WHAT WAS CHECKED FIRST, because "add a gate" is the wrong reflex: Cline and Freebuff do NOT
 * have a documentation gate. Cline ships three tools (`editor`, `read_files`, `run_commands`),
 * no plan or finish tool, and its shipped binary contains no README/deployment check at all —
 * `README` appears there only in new-project template lists and `docker-compose` never; its docs
 * come from model discipline (it scored 100 because it happened to write them), and Freebuff —
 * which lost the same README row in the other round — is the control that shows this is not
 * automatic.
 *
 * RE-VERIFIED ON THE SHIPPED BINARIES, 2026-10-27, because "Cline does it better" was the
 * question and a guess is not an answer. What the two competitors actually ship:
 * `@cline/cli-darwin-arm64` (90 MB, `strings`): no README/deployment/completion rule anywhere —
 * `README` survives only in file-type lists and third-party messages, `docker-compose` never;
 * what it DOES have is a rules/workflows directory (`.clinerules`) plus a self-maintained
 * `task_progress` list, i.e. the user declares the standard and the model fills in. It also
 * prices cache reads per model (`cacheRead`/`cacheWrite` in its catalog) and sends Anthropic
 * `cache_control` breakpoints — accounting discipline, not documentation discipline. `freebuff`
 * (88 MB, `strings`): `README` appears only as a file to READ or EXCLUDE, plus a todo checklist
 * in its UI. So neither hardcodes the requirement and neither checks a document against its
 * tree: the efficient handling is delegation, and a delegation that failed the README row in
 * measured runs. nuvira's duties are therefore compensation, and the compensation is only
 * defensible while it stays a FACT about the tree that any engineer would agree with.
 *
 * VALIDATED ON THE REAL WORKSPACES, not fixtures — re-run on 2026-10-27 over all ten benchmark
 * trees: it asks for the artefact in the patched arm and the installed release (both scored 75
 * with no deployment at all), asks for a POINTER in the one earlier arm whose only artefact was
 * `ops/`, and stays silent for every tree that shipped a self-describing artefact (the compose
 * files in Cline, patched2 and the 26th's nuvira/Freebuff; Cline also ships two Dockerfiles).
 * The same pass measured the ten accepted forms against the tree: six are recognisable by path,
 * four (`infra/`, `ops/`, `helm/`, `terraform/`) are not — which is why an unnamed one now gets
 * the pointer ask instead of silence.
 *
 * A README SENTENCE IS NOT THE ARTEFACT. The patched arm's 9,520-byte README discusses deployment
 * and still scored 0 on this row, because there was nothing to point at. The duty reads the tree,
 * never the prose.
 *
 * THE FACT: an ask that says "production-ready" and a turn that produced a runnable service owe
 * ONE operational artefact — and "one" is deliberately plural in form, because a compose file, a
 * Dockerfile, a deploy/k8s directory, a deployment document and a CI deploy workflow are all
 * honest answers; an `infra/`-style bucket is honest too, but only once something says what is in
 * it. This is the same shape as the README duty (entry point written, no way for a reader to run
 * it), one level up: the thing exists, but nobody said how it reaches a server.
 */
const PRODUCTION_ASK = /\b(production[- ]ready|production[- ]grade|for\s+production|deploy(?:ment|ed|ing)?|ship(?:ping)?|go[- ]live|launch(?:ing)?\s+(?:to|in)\s+production)\b/i;

/**
 * A deployment artefact, by any of the forms a real project uses.
 *
 * `unnamed` is the one distinction that matters after the first measurement of this duty
 * (2026-10-27): a directory called `infra/`, `ops/`, `helm/` or `terraform/` is a BUCKET, not a
 * deployment story — `ops/init-test-db.sql` says nothing about how the service ships, and a
 * reader browsing the root has no way to know which file to open. `deploy/`, `k8s/`, a
 * Dockerfile, a compose file, a deployment document and a deploying workflow all name
 * themselves. So an unnamed artefact does not satisfy the duty on its own: it is cited, and the
 * ask becomes “say where it lives” (which is the same one paragraph a person would want).
 *
 * Measured, because the difference is not academic: of the ten forms accepted here, six are
 * recognised by a path scan of the tree and four are not, and the scoring arm that lost this
 * row lost it with a 9,520-byte README that TALKS about deployment and no artefact to point at.
 * A README sentence is therefore not accepted as the artefact — the thing must exist.
 */
const DEPLOYMENT_ARTEFACT: ReadonlyArray<{ label: string; match: RegExp; needsDeployStep?: boolean; unnamed?: boolean }> = [
  { label: 'a compose file', match: /(?:^|\/)(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i },
  { label: 'a Dockerfile', match: /(?:^|\/)dockerfile(?:\.[\w.-]+)?$/i },
  { label: 'a deploy/k8s directory', match: /(?:^|\/)(?:deploy(?:ment)?|k8s|kubernetes)(?:\/|$)/i },
  { label: 'an infra/ops/helm/terraform directory', match: /(?:^|\/)(?:infra(?:structure)?|ops|helm|terraform)(?:\/|$)/i, unnamed: true },
  { label: 'a deployment document', match: /(?:^|\/)(?:deploy(?:ment)?|ops|runbook|operations)[\w.-]*\.(?:md|mdx|ya?ml|txt)$/i },
  { label: 'a CI/deploy workflow', match: /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i, needsDeployStep: true },
];

/** Steps that make a workflow a DEPLOYMENT, not just a test runner. */
const DEPLOY_STEP = /\b(kubectl|helm|docker\s+push|docker\s+buildx|flyctl|vercel|netlify|aws-actions|cloudflare|gcloud|az\s+webapp|deploy|release)\b/i;

export interface ProductionDuty {
  needed: boolean;
  /** The ask's own word that demanded it (quoted in the nudge). */
  asked?: string;
  /** The entry point that made the project runnable. */
  entry?: string;
  /**
   * An artefact EXISTS but its path does not say what it is (`infra/`, `ops/`, `helm/`,
   * `terraform/`). The ask is then a pointer, not another artefact — see `DEPLOYMENT_ARTEFACT`.
   */
  pointerTo?: string;
}

/**
 * Does this turn owe a deployment story?
 *
 * Only when the ASK says production/deploy, the turn wrote a runnable entry point, and no
 * artefact of any accepted form exists. A project that is not claimed production-ready is
 * never asked for one — a script, a library or a prototype owes none, which is what keeps
 * this from firing on every build.
 */
export function productionReadinessDuty(input: {
  ask: string;
  cwd: string;
  writtenPaths: readonly string[];
}): ProductionDuty {
  const asked = PRODUCTION_ASK.exec(input.ask || '');
  if (!asked) return { needed: false };
  const entries = input.writtenPaths.filter((p) => RUNNABLE_ENTRY.test(basename(p)));
  if (entries.length === 0) return { needed: false };
  const tree = listFiles(input.cwd, 4);
  let unnamed: string | null = null;
  for (const artefact of DEPLOYMENT_ARTEFACT) {
    const candidates = tree.filter((p) => artefact.match.test(p));
    for (const rel of candidates) {
      if (artefact.needsDeployStep) {
        const body = readText(join(input.cwd, rel));
        if (!DEPLOY_STEP.test(body)) continue;
      }
      // A self-describing artefact settles the question; an unnamed one is remembered
      // only until we know nothing better exists.
      if (artefact.unnamed) {
        unnamed = unnamed ?? rel;
        continue;
      }
      return { needed: false };
    }
  }
  return {
    needed: true,
    asked: asked[0],
    entry: posix(entries[0]),
    ...(unnamed ? { pointerTo: unnamed } : {}),
  };
}

/** Bounded directory walk for the duty's existence check (never the whole tree). */
function listFiles(root: string, depth: number, prefix = ''): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(join(root, prefix));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (name === 'node_modules' || name === '.git' || name === '.next' || name === 'dist' || name === 'build') continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try {
      st = statSync(join(root, rel));
    } catch {
      continue;
    }
    out.push(rel);
    if (st.isDirectory() && depth > 1) out.push(...listFiles(root, depth - 1, rel));
  }
  return out;
}

/** The deployment nudge: the ask's own word, and the forms that would satisfy it. */
export function productionDutyNudge(duty: ProductionDuty): string {
  if (duty.pointerTo) {
    return [
      `The request asks for something \`${duty.asked ?? 'production-ready'}\` and the deployment story exists — but only as \`${duty.pointerTo}\`,`,
      'a directory name that does not say what is inside it. A reader (and the next agent) browsing the root cannot tell how this ships.',
      'Make it findable: add a `docs/DEPLOYMENT.md` that says, in a few lines,',
      '  1. how the artefact is built (image, bundle, binary),',
      '  2. how it is released (the command or workflow),',
      '  3. the environment variables and services it needs in production.',
      'A `deploy/` directory, a `Dockerfile` or a `docker-compose.yml` also settles it.',
    ].join('\n');
  }
  return [
    `The request asks for something ${duty.asked ? `\`${duty.asked}\`` : 'production-ready'} and the project is runnable (\`${duty.entry}\`),`,
    'but nothing in the tree says how it reaches a server.',
    'Add ONE operational artefact a person could follow:',
    '  - a `Dockerfile` / `docker-compose.yml`, or',
    '  - a `deploy/`, `infra/`, `k8s/` (or similar) directory, or',
    '  - a deployment document (`docs/DEPLOYMENT.md`, a runbook), or',
    '  - a CI workflow that actually deploys (not one that only runs tests).',
    'If the project is NOT production-ready, say that plainly in the answer instead —',
    'an inflated claim is worse than a missing file.',
  ].join('\n');
}

export interface DocClaimFinding {
  /** The document that made the claim, relative to the workspace. */
  doc: string;
  /** The claim itself, quoted. */
  claim: string;
  /** What is wrong with it, as a fact. */
  problem: string;
}

/** A `npm run X` / `pnpm X` / `yarn X` invocation in a doc. */
const SCRIPT_CALL = /\b(?:npm\s+run|pnpm\s+run|yarn\s+run|bun\s+run|npm\s+test|pnpm\s+test|yarn\s+test)\s+([\w:.-]+)/g;

/**
 * A backticked path-like token: `src/server/http.ts`, `tests/e2e/checkout.spec.ts`,
 * `./scripts/bench.mjs`. Deliberately conservative — a bare word, a glob or a
 * placeholder (`<name>`, `*.ts`, `…`) is not a claim about a file.
 */
const PATH_TOKEN = /`([\w@./-]*(?:\/[\w@.-]+)+\.(?:[cm]?[jt]sx?|json|ya?ml|md|py|go|rs|sh|toml|sql|css|scss|html))`/g;

/** Read the `scripts` block of the nearest package.json above a doc. */
function scriptsFor(cwd: string, docAbs: string): Set<string> | null {
  let dir = dirname(docAbs);
  for (let i = 0; i < 4; i += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readText(candidate)) as { scripts?: Record<string, string> };
        return new Set(Object.keys(parsed.scripts ?? {}));
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the artifact claims in the markdown this turn wrote.
 *
 * Bounded to the files the TURN wrote (never the whole docs tree) and capped, so
 * the audit costs a handful of reads and can never become the turn's main work.
 */
export function auditDocClaims(input: {
  cwd: string;
  writtenPaths: readonly string[];
  /** Findings returned at most (the nudge lists 3–4). */
  max?: number;
}): DocClaimFinding[] {
  const max = input.max ?? 6;
  const docs = [...new Set(input.writtenPaths)]
    .filter((p) => /\.(?:md|markdown|mdx)$/i.test(p))
    .map((p) => resolve(input.cwd, p))
    .filter((abs) => existsSync(abs))
    .slice(0, 8);

  const findings: DocClaimFinding[] = [];
  const seen = new Set<string>();
  const push = (finding: DocClaimFinding): void => {
    if (findings.length >= max) return;
    const key = `${finding.doc}|${finding.claim}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  for (const abs of docs) {
    const relDoc = posix(relative(input.cwd, abs));
    const text = readText(abs);
    if (!text) continue;
    const scripts = scriptsFor(input.cwd, abs);

    if (scripts) {
      for (const match of text.matchAll(SCRIPT_CALL)) {
        const script = match[1];
        // `npm run` with no script name, or the universal `npm test` → `test`.
        if (!script || script.startsWith('-')) continue;
        if (scripts.has(script)) continue;
        push({
          doc: relDoc,
          claim: match[0].trim(),
          problem: `"${script}" is not a script in package.json (defined: ${[...scripts].sort().join(', ') || 'none'})`,
        });
      }
    }

    for (const match of text.matchAll(PATH_TOKEN)) {
      const token = match[1].replace(/^\.\//, '');
      if (!token || token.includes('<') || token.includes('*') || token.includes('…')) continue;
      // Resolve against the doc's own directory first, then the workspace root —
      // docs are written from both.
      const candidates = [resolve(dirname(abs), token), resolve(input.cwd, token)];
      if (candidates.some((c) => existsSync(c))) continue;
      push({
        doc: relDoc,
        claim: token,
        problem: `\`${token}\` does not exist in the workspace`,
      });
    }
  }
  // ── THE API CONTRACT ─────────────────────────────────────────────────────
  // Run only when the turn wrote the spec, for the same reason the other checks are
  // bounded to written documents: an untouched spec from an earlier turn is not this
  // turn's claim. The three findings (dangling `$ref`, documented-but-unserved path,
  // served-but-undocumented route) are the ones that make a contract unloadable or
  // misleading, and every one of them is a fact about the code, not an opinion about
  // the prose.
  const wroteSpec = [...new Set(input.writtenPaths)].some((p) =>
    /(?:^|\/)(?:openapi|swagger)[\w.-]*\.(?:json|ya?ml)$/i.test(p),
  );
  if (wroteSpec) {
    const verdict = verifyApiContract({ cwd: input.cwd });
    if (verdict.specPath && verdict.parsed) {
      for (const finding of contractFindings(verdict)) {
        push({ doc: verdict.specPath, claim: finding.claim, problem: finding.problem });
      }
    }
  }

  return findings;
}

/** The nudge: the contradictions, quoted, with the rule that a doc must match the tree. */
export function docClaimsNudge(findings: readonly DocClaimFinding[], extra: readonly string[] = []): string {
  const lines = findings.slice(0, 4).map((f) => `  - \`${f.doc}\`: ${f.claim} — ${f.problem}`);
  const more = findings.length > 4 ? `\n  …and ${findings.length - 4} more.` : '';
  const extraLines = extra.map((e) => `  - ${e}`);
  return [
    'Before this turn ends: documents it wrote describe things that do not exist.',
    ...lines,
    ...extraLines,
    more,
    'Either create what the document names, or correct the document. A reader — and the next agent — will try to run those commands.',
  ]
    .filter(Boolean)
    .join('\n');
}
