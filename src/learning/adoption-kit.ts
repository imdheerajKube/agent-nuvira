/**
 * THE ADOPTION KIT — the documents that let a stranger USE what the turn built.
 *
 * WHY THIS EXISTS (measured 2026-10-27, the head-to-head that asked "who builds the
 * better product"). Both arms passed their own suites; the difference was what a
 * person who was not in the room could do with the artefact. Cline shipped 69
 * endpoints, an **OpenAPI contract with 40 paths**, an operations runbook, a threat
 * model, 7 ADRs and a README that gets you running. nuvira shipped 51 endpoints,
 * every suite green, a 9.5 KB README, API prose and an architecture document — and
 * no machine-readable contract, no runbook, no security document and no decision
 * record. "The reference build is more complete" was the whole verdict, and every
 * point of it was documentation.
 *
 * The existing duties cover the two documents that were already being asked for:
 * `quickstartDuty` (a README, because a fresh clone must be runnable) and
 * `productionReadinessDuty` (an operational artefact, because a "production-ready"
 * claim needs a way to ship). What remained uncovered is the layer that makes the
 * product INTEGRABLE and MAINTAINABLE by someone who is not its author:
 *
 *   - an API CONTRACT — a client can be written without reading the server source;
 *   - an OPERATIONS story — env vars, migrations, health, backup: how it is kept alive;
 *   - a SECURITY story — what the trust boundary is, when the ask builds auth or tenancy;
 *   - DECISION RECORDS — why the architecture is what it is, when the ask says so.
 *
 * WHAT THIS IS NOT. It is not a "write more docs" gate. Each item is a FACT about the
 * tree, gated on a fact about the ask, and each is silent when the thing exists:
 *
 *   - no HTTP server in the tree → no API contract is owed (a CLI or a library owes none);
 *   - fewer than `MIN_ROUTES` registered routes → no contract (a three-route toy does
 *     not need a spec, and asking for one is how a gate teaches a model to pad);
 *   - an ask that never mentions security/tenancy → no threat model;
 *   - an ask that never mentions decisions/ADRs → no decision records.
 *
 * The gate this feeds is BOUNDED (see `documentationGate` in `tools/tool-loop.ts`):
 * one item per message, at most three messages a turn, and never the same item twice
 * in a row. A checklist recited in full is a message a model skims; one gap named
 * with the evidence that was looked for is a step it can take.
 *
 * WHY A PROSE API DOC IS CITED BUT NOT ACCEPTED, as of 2026-10-27. An endpoint
 * reference with `GET /api/tasks` lines IS adoptable — a client author can work from
 * it — and it is therefore cited as evidence rather than ignored. But it cannot be
 * the resting state any more, because the document can now be DERIVED from the routes
 * (`api_spec` → `learning/api-spec.ts`). Measured in the 2026-10-27 head-to-head: the
 * patched arm served **55 routes**, wrote `docs/API.md` by hand, and shipped **no
 * machine-readable contract at all**; Cline documented 59 of its 60 routes in a 48 KB
 * spec. A hand-written list of 55 routes is a document that has already begun to
 * drift — every route added after it was written is missing from it, silently — and
 * prose that was correct on the day it was typed looks exactly like prose that is
 * correct now. So prose counts as evidence that the routes exist, and the ask is
 * "derive the document", which is one tool call.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isBuildShapedAsk } from './task-artifacts.js';

export type AdoptionItemId = 'api-contract' | 'operations' | 'security' | 'decisions';

export interface AdoptionGap {
  id: AdoptionItemId;
  /** One-line label, used in the message. */
  label: string;
  /** What was looked for in the tree, as a fact about what is absent. */
  missing: string;
  /** What the tree DOES contain that made the item applicable (quoted in the nudge). */
  evidence: string;
}

/** Directories that are never part of the delivered surface. */
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'venv',
  '.venv',
  'env',
  '__pycache__',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'playwright-report',
  'test-results',
  '.pytest_cache',
  '.mypy_cache',
]);

/** A service needs a contract only once it is worth integrating with. */
export const MIN_ROUTES = 3;

/** Bounds: the check runs mid-build, so it must stay cheap on a large monorepo. */
const MAX_FILES = 2500;
const MAX_READS = 60;
const MAX_READ_BYTES = 96_000;
/** A document below this is a heading, not a story. */
const MIN_DOC_BYTES = 600;

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|php|java|kt|cs)$/i;
const DOC_EXT = /\.(?:md|markdown|mdx|txt)$/i;

/** Files worth reading first when looking for a server: they name themselves. */
const SERVER_HINT = /(?:^|\/)(?:server|app|main|index|router|routes?|controllers?|handlers?|endpoints?|api)(?:[./-]|$)/i;

/** Route registration, in the frameworks a build actually reaches for. */
const ROUTE_DEFS: readonly RegExp[] = [
  // express/fastify/koa: `app.get(`, `router.route(`, `server.delete(`
  /\b(?:app|router|server|api|fastify)\s*\.\s*(?:get|post|put|patch|delete|all|route|use)\s*\(/g,
  // NestJS / decorator routers
  /@(?:Get|Post|Put|Patch|Delete|All)\s*\(/g,
  // python frameworks: `@app.get("/x")`, `@router.post`
  /@(?:app|router|blueprint)\s*\.\s*(?:get|post|put|patch|delete|route)\s*\(/g,
  // go/chi/gin: `r.Get(`, `r.POST(`
  /\b(?:r|router|mux|e)\s*\.\s*(?:Get|Post|Put|Patch|Delete|GET|POST|PUT|PATCH|DELETE)\s*\(/g,
];

/** Evidence that the tree is an HTTP service at all. */
const HTTP_SERVER = /(?:\bexpress\s*\(|\bfastify\s*\(|\bcreateServer\s*\(|NestFactory\.create\s*\(|\bnew\s+Hono\s*\(|\bapp\.listen\s*\(|\bFlask\s*\(|\bFastAPI\s*\(|\buvicorn\.run\s*\(|\bhttp\.ListenAndServe\s*\()/;

/** Deployment artefacts, reused only as evidence that this is a service. */
const DEPLOY_ARTEFACT = /(?:^|\/)(?:dockerfile(?:[\w.-]+)?|(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml|(?:deploy(?:ment)?|k8s|kubernetes|infra(?:structure)?|ops|helm|terraform)\/)/i;

/** An OpenAPI/Swagger document, by the names real projects use. */
const SPEC_FILE = /(?:^|\/)(?:openapi|swagger)[\w.-]*\.(?:json|ya?ml)$/i;

/** A prose endpoint reference: `docs/API.md`, `docs/reference/rest.md`. */
const API_DOC_FILE = /(?:^|\/)(?:api|rest|endpoints?|reference)[\w.-]*\.(?:md|markdown|mdx)$/i;

/** An endpoint line in prose: `GET /api/tasks`, `- POST /auth/login`. */
const ENDPOINT_LINE = /^\s*(?:#{1,6}\s*)?[-*+]?\s*`?\**(?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+\/[\w@:./{}<>-]*/gim;

/**
 * An endpoint ROW in a markdown table: `| GET | /api/tasks | list tasks |`.
 *
 * Measured 2026-10-27: a real 159-line API reference that documented every route in a
 * table was read as "no contract at all", because the reference check only knew the
 * inline `METHOD /path` form. A false "nothing documented" is the mistake that teaches
 * a model to ignore the ask, so the table form is read too.
 */
const ENDPOINT_ROW = /^\s*\|\s*`?\**(?:GET|POST|PUT|PATCH|DELETE|HEAD)\b[^|]*\|\s*`?\**(\/[\w@:./{}<>-]*)/gim;

/** A section heading that makes a markdown file an operations story. */
const OPS_HEADING =
  /^#{1,4}\s*[^\n]*\b(?:environment|env\s+vars?|configuration|config|deployment|deploy|operations|runbook|production|backups?|health\s*check|monitoring)\b[^\n]*$/im;

/** An ask that builds an auth boundary owes a security story. */
/**
 * An ask that wants a SECURITY DOCUMENT — not an ask that implements security.
 *
 * Measured 2026-10-30 (GREENFIELD-API, the head-to-head): the vocabulary used to
 * include `auth`, `jwt`, `oauth`, `rbac`, `token` and `tenant`, so a task saying
 * "JSON notes API with token auth" was told — mid-build, on a correctness-perfect
 * run — that "security is missing: nothing in the tree lets a stranger operate
 * it", and the model wrote 61 lines of `SECURITY.md` nobody asked for. Implementing
 * authentication is not commissioning a threat model; the same false demand is the
 * one that inflates scope on every auth-bearing task.
 *
 * So the words left are the ones that ask for the ARTEFACT (`security`, `threat
 * model`, `owasp`, `compliance`, `soc 2`, `gdpr`, `pii`, `pen test`), and every
 * implementation word moved to `SECURITY_IMPLEMENTED` where it proves nothing about
 * documents.
 */
const SECURITY_ASK = /\b(?:security|threat(?:\s+model)?|owasp|compliance|soc\s*2|gdpr|pii|pen(?:etration)?\s*test(?:ing)?)\b/i;

/**
 * A PRODUCTION / ENTERPRISE posture, which owes the document even without the word.
 *
 * This is the half that keeps the duty alive. The measured case for a threat model
 * is a production-ready multi-tenant platform (2026-10-27, the head-to-head that
 * built 69 endpoints and shipped no security story); the measured case AGAINST it
 * is a small local service whose ask merely implements tokens for auth — it was
 * told "nothing in the tree lets a stranger operate it" and wrote 61 lines nobody
 * asked for. Posture is the honest separator: who is going to run this, and for
 * whom. `token auth` in a 200-line notes API says nothing about that; `SaaS`,
 * `enterprise`, `multi-tenant` and `production-ready` do.
 */
const PRODUCTION_POSTURE =
  /\b(?:production[- ]ready|enterprise|saas|multi-?tenan(?:t|cy)|regulated|auditable|audited)\b/i;

/** An ask that asks for decisions owes decision records. */
const DECISIONS_ASK = /\b(?:adrs?|architecture\s+decisions?|decision\s+records?|design\s+decisions?)\b/i;

interface TreeFacts {
  /** Every file below the workspace, posix-relative, bounded. */
  files: string[];
  /** Route registrations found across the files that were read. */
  routes: number;
  /** The tree runs an HTTP server. */
  servesHttp: boolean;
  /** One relative path per read file, so the nudge can cite what it looked at. */
  read: string[];
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

function readText(root: string, rel: string, maxBytes = MAX_READ_BYTES): string {
  try {
    const abs = join(root, rel);
    const st = statSync(abs);
    if (!st.isFile() || st.size === 0 || st.size > maxBytes) return '';
    return readFileSync(abs, 'utf-8');
  } catch {
    return '';
  }
}

/** Bounded walk: paths only, no reads. */
function walk(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop() as string;
    let names: string[] = [];
    try {
      names = readdirSync(dir ? join(root, dir) : root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (out.length >= MAX_FILES) break;
      if (SKIP_DIRS.has(name)) continue;
      const rel = dir ? `${dir}/${name}` : name;
      let st;
      try {
        st = statSync(join(root, rel));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(rel);
        continue;
      }
      if (st.isFile()) out.push(rel);
    }
  }
  return out;
}

/**
 * Read the tree once: which files exist, whether it serves HTTP, and how many
 * routes are registered. Server-named files are read first and reading stops at a
 * fixed budget, so the cost does not grow with an unrelated monorepo.
 */
function scanTree(root: string): TreeFacts {
  const files = walk(root);
  const candidates = files
    .filter((f) => SOURCE_EXT.test(f))
    .sort((a, b) => Number(SERVER_HINT.test(b)) - Number(SERVER_HINT.test(a)));
  let routes = 0;
  let servesHttp = false;
  const read: string[] = [];
  for (const rel of candidates.slice(0, MAX_READS)) {
    const text = readText(root, rel);
    if (!text) continue;
    read.push(rel);
    if (!servesHttp && HTTP_SERVER.test(text)) servesHttp = true;
    for (const pattern of ROUTE_DEFS) {
      pattern.lastIndex = 0;
      routes += text.match(pattern)?.length ?? 0;
    }
  }
  return { files, routes, servesHttp, read };
}

/** Where the tree's API contract stands: derived, hand-written, or absent. */
type ContractForm = { kind: 'spec'; path: string } | { kind: 'prose'; path: string } | { kind: 'none' };

/**
 * A contract someone outside this repo can build a client from.
 *
 * A spec with `paths` SETTLES it. An endpoint reference that enumerates method + path
 * still counts as the routes being documented, but it is reported as `prose` so the ask
 * can be for the derived document — see the module comment. A README sentence linking
 * "the API" is neither, which is exactly the artefact that lost the row.
 */
function contractForm(root: string, files: readonly string[]): ContractForm {
  for (const rel of files.filter((f) => SPEC_FILE.test(f))) {
    const text = readText(root, rel, 2_000_000);
    if (text && /\bpaths\b/i.test(text)) return { kind: 'spec', path: rel };
  }
  for (const rel of files.filter((f) => API_DOC_FILE.test(f) && DOC_EXT.test(f))) {
    const text = readText(root, rel, 400_000);
    if (!text) continue;
    ENDPOINT_LINE.lastIndex = 0;
    ENDPOINT_ROW.lastIndex = 0;
    const listed = (text.match(ENDPOINT_LINE)?.length ?? 0) + (text.match(ENDPOINT_ROW)?.length ?? 0);
    if (listed >= MIN_ROUTES) return { kind: 'prose', path: rel };
  }
  return { kind: 'none' };
}

/** Markdown that says how the service is kept alive, by any file name it uses. */
function hasOperationsDoc(root: string, files: readonly string[]): boolean {
  const docs = files.filter((f) => DOC_EXT.test(f));
  for (const rel of docs) {
    const text = readText(root, rel, 400_000);
    if (text.length < MIN_DOC_BYTES) continue;
    if (OPS_HEADING.test(text)) return true;
  }
  return false;
}

/** A security document or threat model, by the names projects use. */
function hasSecurityDoc(files: readonly string[]): boolean {
  return files.some((f) => /(?:^|\/)(?:security|threat[-_ ]?model)[\w.-]*\.(?:md|markdown|mdx|txt)$/i.test(f));
}

/** Decision records: the directory conventions, or the `.adr.md` suffix. */
function hasDecisionRecords(files: readonly string[]): boolean {
  return files.some(
    (f) =>
      /(?:^|\/)(?:adr|adrs|decisions|architecture-decisions)\//i.test(f) ||
      /\.adr\.(?:md|markdown)$/i.test(f),
  );
}

/**
 * Which adoption items this turn still owes.
 *
 * Ordered by what blocks adoption first: an integrator cannot start without a
 * contract, an operator cannot keep the service alive without a runbook, and the
 * security/decision documents come last because they explain rather than enable.
 *
 * `ask` may be the original request or a change request. The build-shape guard is
 * the same one the other duties use: a question, a review or a narrow fix owes no
 * new documentation, and must never be handed one.
 */
export function missingAdoptionItems(input: {
  ask: string;
  cwd: string;
  /** Skip the filesystem walk when the caller already has it (tests, callers that cache). */
  tree?: { files: readonly string[]; routes?: number; servesHttp?: boolean; read?: readonly string[] };
}): AdoptionGap[] {
  const ask = (input.ask || '').trim();
  if (!ask) return [];
  if (!isBuildShapedAsk(ask)) return [];
  const scanned = input.tree ? null : scanTree(input.cwd);
  const files = [...(input.tree?.files ?? scanned?.files ?? [])];
  const routes = input.tree?.routes ?? scanned?.routes ?? 0;
  const servesHttp = input.tree?.servesHttp ?? scanned?.servesHttp ?? false;
  const readPaths = [...(input.tree?.read ?? scanned?.read ?? [])];
  const isService = servesHttp || DEPLOY_ARTEFACT.test(files.join('\n'));

  const gaps: AdoptionGap[] = [];

  const contract = routes >= MIN_ROUTES ? contractForm(input.cwd, files) : { kind: 'none' as const };
  if (routes >= MIN_ROUTES && contract.kind !== 'spec') {
    const cited = readPaths.filter((p) => SERVER_HINT.test(p)).slice(0, 2);
    gaps.push({
      id: 'api-contract',
      label: 'API contract',
      missing:
        contract.kind === 'prose'
          ? `no OpenAPI/Swagger document with \`paths\` — the only reference is \`${contract.path}\`, written by hand, ` +
            'which stops matching the routes the next time one is added'
          : 'no OpenAPI/Swagger document with `paths`, and no endpoint reference that lists the routes ' +
            '(e.g. `docs/API.md` with `GET /api/…` lines)',
      // "found in the files read", not "the tree serves": this scan is bounded (60 files),
      // so on a large monorepo it finds fewer than `api_spec` will — measured 40 here against
      // 55 operations generated from the same tree. A count that reads as a census and is not
      // one is the kind of precision a model stops trusting.
      evidence: `${routes} route registration(s) found in the files read${contract.kind === 'prose' ? `, and \`${contract.path}\` lists some of them` : ''}${cited.length ? `, e.g. \`${cited.join('`, `')}\`` : ''}`,
    });
  }

  if (isService && !hasOperationsDoc(input.cwd, files)) {
    gaps.push({
      id: 'operations',
      label: 'operations',
      missing:
        'no markdown section covering environment variables, deployment, health or backups',
      evidence: servesHttp ? 'the tree runs an HTTP server' : 'the tree carries a deployment artefact',
    });
  }

  // The document is owed when the ask NAMES one of the audit words, or when the
  // ask's posture is production/enterprise. Implementing `token auth` is neither.
  const securityAsk = SECURITY_ASK.exec(ask);
  const posture = securityAsk ? null : PRODUCTION_POSTURE.exec(ask);
  if ((securityAsk || posture) && !hasSecurityDoc(files)) {
    gaps.push({
      id: 'security',
      label: 'security',
      missing: 'no `SECURITY.md` and no threat-model document',
      evidence: securityAsk
        ? `the ask names \`${securityAsk[0]}\``
        : `the ask is production-shaped (\`${posture?.[0] ?? ''}\`), so how this is trusted is part of the delivery`,
    });
  }

  if (DECISIONS_ASK.test(ask) && !hasDecisionRecords(files)) {
    gaps.push({
      id: 'decisions',
      label: 'decision records',
      missing: 'no `docs/adr/` (or `docs/decisions/`) directory and no `*.adr.md` file',
      evidence: `the ask names \`${DECISIONS_ASK.exec(ask)?.[0] ?? 'decisions'}\``,
    });
  }

  return gaps;
}

/**
 * The nudge. One item mid-build; the whole remaining list at the close.
 *
 * The closing form is the only place the model sees the full set, and it is
 * deliberately one message: a document set is a handover, and a handover that
 * arrives one page per step is a handover nobody finishes.
 */
export function adoptionKitNudge(
  gaps: readonly AdoptionGap[],
  opts: { closing?: boolean; entry?: string } = {},
): string {
  if (gaps.length === 0) return '';
  const head = opts.closing
    ? `Before this turn ends: the project is buildable${opts.entry ? ` (\`${opts.entry}\`)` : ''} and ${gaps.length === 1 ? 'one document is' : `${gaps.length} documents are`} missing that a stranger needs to adopt it.`
    : 'The tree is a working service, and the part that lets someone else USE it is still missing.';
  const items = gaps.map(
    (g) => `  - ${g.label}: ${g.missing} — evidence: ${g.evidence}.`,
  );
  // Only the forms for the gaps being asked about: a mid-build message that also
  // describes three documents the turn does not owe yet is the checklist the model
  // skims. Each form is shown once, with the bar it has to clear.
  const HOW: Record<AdoptionItemId, readonly string[]> = {
    'api-contract': [
      '  - call `api_spec` — it writes `docs/openapi.yaml` with `paths` derived from the routes the',
      '    code registers (paths, methods, parameter names are the code, so it cannot drift), with each',
      '    summary a `TODO` for you to fill. Then regenerate after adding a route.',
      '  - a `docs/API.md` that lists every route as `METHOD /path` with its auth requirement is a',
      '    reference, not a contract: it is correct only until the next route is added.',
    ],
    operations: [
      '  - `docs/OPERATIONS.md` — how it is configured and kept alive: env vars, migrations,',
      '    health check, logs and backup. A `## Deployment` / `## Environment` section in the',
      '    README counts, as long as it is specific.',
    ],
    security: [
      '  - `SECURITY.md` — the trust boundary: who can call what, how tokens are checked,',
      '    what is stored and what is deliberately not.',
    ],
    decisions: [
      '  - `docs/adr/0001-<decision>.md` — context, decision, consequence, one page each.',
    ],
  };
  const how = gaps.flatMap((g) => HOW[g.id]);
  return [
    head,
    ...items,
    '',
    'What each one looks like when it is real:',
    ...how,
    '',
    'Write them from what the code ALREADY does — do not describe features that are not there.',
    'If part of the product is not delivered, say so in the document and in the answer:',
    'a missing document and an overclaiming one are not the same failure, and the second is worse.',
  ].join('\n');
}
