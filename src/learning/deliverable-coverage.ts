/**
 * DELIVERABLE COVERAGE — the surfaces the ask named, checked against the tree.
 *
 * WHY THIS EXISTS (measured 2026-10-26, Ultimate Agent Benchmark, SaaS platform).
 * Two nuvira runs on the identical prompt both ended at their step ceiling, and the
 * harsher of the two shipped **no frontend at all**: `apps/` held `api` only, the
 * tree had zero `.tsx` files, and its own `docs/ARCHITECTURE.md` described
 * `apps/web`. Every gate the loop owned was satisfied — 210 steps of progress, 13
 * test files, 391 assertions, `todo.md` + `issues.md` + `changelog.md`, a green
 * suite — because each gate asked about something that EXISTED. Nothing asked
 * whether the thing the ask was FOR had been started.
 *
 * The measured cost of that blind spot: `next` false in the stack, 84 code files
 * instead of 101, and a rubric that reports 85/100 while the product has no UI.
 *
 * WHAT THIS IS. A small deterministic table of SURFACES — frontend, backend,
 * database, e2e, unit/integration tests — each with (a) the words in the ask that
 * demand it and (b) the evidence in the tree that proves it exists. A surface the
 * ask named and the tree does not contain is a GAP, and the gap is named back to
 * the model with the evidence that was looked for.
 *
 * WHY IT IS SAFE TO FIRE. It only runs on a BUILD-shaped ask (a change request
 * that mentions "the Next.js frontend" is not asked to create one), and it only
 * reports a surface whose demand words are in the ask AND whose evidence is absent
 * from the whole tree. A project that has the surface is never nagged, and a
 * question is never a delivery.
 *
 * "BEST IN CLASS" IS NOT THIS. This checks that the parts exist, not that they are
 * good — a three-line `page.tsx` satisfies the frontend row. The point is that a
 * missing part can no longer be described as a finished product.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isBuildShapedAsk } from './task-artifacts.js';

export type SurfaceId = 'frontend' | 'backend' | 'database' | 'e2e' | 'tests';

export interface SurfaceGap {
  id: SurfaceId;
  /** One-line label, used in the message. */
  label: string;
  /** The words in the ask that demanded it, quoted. */
  asked: string;
  /** What was looked for in the tree and not found. */
  missing: string;
}

/** Directories never scanned: dependency installs and build output. */
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

/** Bounded so the check can never become the turn's main work. */
const MAX_FILES = 6000;

interface SurfaceDef {
  id: SurfaceId;
  label: string;
  /** Words in the ask that demand this surface. */
  demand: RegExp;
  /** What a tree that HAS the surface contains. */
  missing: string;
  /** Files that prove it, plus (optionally) whether a source file exists at all. */
  evidence: (files: readonly FileFact[]) => boolean;
  /**
   * A SECOND way to prove it, for a project whose filenames say nothing.
   *
   * WHY THIS EXISTS (measured 2026-10-30, GREENFIELD-API, the head-to-head). A
   * stdlib Python service — `server.py` using `http.server`, notes in `sqlite3` —
   * was reported as missing **backend / API** and **database / schema** because
   * every evidence pattern was a JS/TS filename (`server.ts`, `schema.prisma`,
   * `migrations/`). The gate then fired TWICE after `finish` had been accepted,
   * and the model spent steps running `ls server.py client.py` to prove, to a
   * checker, that the server it had just built existed. A gate that cannot see
   * the artifact is not a safety net, it is a tax — and a false one is worse than
   * a missing one, because it teaches the model that the loop's claims are noise.
   *
   * So a surface may be proven by its RUNTIME SHAPE too: the code that registers a
   * route or opens a database is exactly as much evidence as the filename a
   * convention would have given it.
   */
  content?: RegExp;
}

interface FileFact {
  /** Posix path relative to the workspace. */
  path: string;
  size: number;
  /** Lowercased basename, for cheap matching. */
  name: string;
}

const has = (files: readonly FileFact[], re: RegExp): boolean => files.some((f) => re.test(f.path));

/**
 * Extensions that hold PROGRAM SOURCE, in any language this agent is pointed at.
 * Used only to decide which files are worth reading for runtime evidence.
 */
const SOURCE_FILE = /\.(?:py|pyw|js|mjs|cjs|jsx|ts|mts|cts|tsx|go|rb|java|kt|kts|cs|php|rs|swift|scala|ex|exs|clj|lua|pl|sh)$/i;

/** Bounded content scan: enough to find a route table, never the turn's main work. */
const CONTENT_MAX_FILES = 400;
const CONTENT_MAX_BYTES = 256 * 1024;

/**
 * Does any source file in the tree MATCH `re`?
 *
 * Reads at most {@link CONTENT_MAX_FILES} source files of at most
 * {@link CONTENT_MAX_BYTES}, first match wins, and every read is guarded — a
 * permission error or a vanishing file means "no evidence", never a throw.
 */
function someSourceMatches(root: string, files: readonly FileFact[], re: RegExp): boolean {
  let read = 0;
  for (const file of files) {
    if (read >= CONTENT_MAX_FILES) break;
    if (file.size === 0 || file.size > CONTENT_MAX_BYTES) continue;
    if (!SOURCE_FILE.test(file.path)) continue;
    read += 1;
    try {
      if (re.test(readFileSync(join(root, file.path), 'utf-8'))) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * A CREATION verb, required on top of the build shape.
 *
 * The build-shape classifier accepts a product noun alone ("the app"), which is
 * right for asking "is this a delivery?" and wrong here: "fix the login bug in the
 * React app" is a delivery AND a change request, and it must not be handed a
 * request to create a frontend that already exists. Only an ask that says something
 * is to be MADE can be missing a surface.
 */
const CREATION_VERB = /\b(build|create|implement|scaffold|develop|deliver|bootstrap|generate|set\s+up|spin\s+up|write|produce)\b/i;

/** A component/route file, not a config or a type declaration. */
const UI_FILE = /\.(?:tsx|jsx|vue|svelte)$/;

const SURFACES: readonly SurfaceDef[] = [
  {
    id: 'frontend',
    label: 'frontend / UI',
    demand: /\b(next\.js|react|vue|svelte|angular|frontend|front-end|web\s+ui|single[- ]page|spa|web\s+app)\b/i,
    missing:
      'no component file (`.tsx` / `.jsx` / `.vue` / `.svelte`), no `next.config.*`, no page/route file',
    // A UI is component files. A `"next"` line in a package.json is a dependency
    // declaration, which is exactly the artifact that fooled the benchmark's own
    // scorer into crediting a frontend that did not exist.
    evidence: (files) =>
      has(files, UI_FILE) || has(files, /(?:^|\/)next\.config\.[cm]?[jt]s$/) || has(files, /(?:^|\/)vite\.config\.[cm]?[jt]s$/),
  },
  {
    id: 'backend',
    label: 'backend / API',
    demand: /\b(backend|back-end|api\s+server|rest\s+api|graphql|express|fastify|nestjs|node\.?js\s+backend|http\s+api|json\s+http\s+api|http\s+api)\b/i,
    missing:
      'no server entry (`server|app|main|index` in any language), no `routes|controllers|handlers|endpoints|api` module, and no code that registers a route or starts a listener',
    evidence: (files) =>
      // Any language: `server.py`, `app.rb`, `main.go`, `index.ts`, `wsgi.py`…
      has(files, /(?:^|\/)(?:server|app|main|index|wsgi|asgi|api|service)(?:[._-][^/]*)?\.[a-z]{2,4}$/i) ||
      has(files, /(?:^|\/)(?:routes?|controllers?|handlers?|endpoints?|api)\//i),
    // …or the route/listener that a convention would have named.
    content:
      /(?:https?d?\.server|HTTPServer|ThreadingHTTPServer|BaseHTTPRequestHandler|@app\.(?:route|get|post|put|delete)|Flask\(|FastAPI\(|APIRouter\(|express\(|fastify\(|Koa\(|createServer\(|\.listen\(|serve_forever\(|net[\/]http|gin\.(?:Default|New)\(|http\.HandleFunc|SpringBootApplication|@RestController|Router\(\)|routes\.(?:get|post|put|delete)\()/,
  },
  {
    id: 'database',
    label: 'database / schema',
    demand: /\b(postgres(?:ql)?|mysql|sqlite|mongo(?:db)?|database|schema\.prisma|prisma|drizzle|knex|migrations?)\b/i,
    missing:
      'no `*.sql`, no `schema.prisma`, no `migrations/` directory, no schema module, no database file and no code that opens one',
    evidence: (files) =>
      has(files, /\.sql$/) ||
      has(files, /(?:^|\/)schema\.prisma$/) ||
      has(files, /(?:^|\/)migrations?\//) ||
      has(files, /(?:^|\/)(?:schema|db|database)(?:[._-][^/]*)?\.[a-z]{2,4}$/i) ||
      // A database FILE is the surface itself, not a declaration of it.
      has(files, /\.(?:db|sqlite|sqlite3)$/i),
    content:
      /(?:CREATE\s+TABLE|import\s+sqlite3|\bsqlite3\.connect|psycopg|asyncpg|SQLAlchemy|create_engine\(|pymongo|MongoClient|new\s+Pool\(|better-sqlite3|knex\(|drizzle|prisma\.|mongoose|Sequelize|DataSource\(|@Entity|CREATE\s+INDEX)/i,
  },
  {
    id: 'e2e',
    label: 'end-to-end tests',
    demand: /\b(e2e|end[- ]to[- ]end|playwright|cypress)\b/i,
    missing: 'no `*.spec.*` / `*.e2e.*` file, no playwright/cypress config, no `tests/e2e/` directory',
    evidence: (files) =>
      has(files, /\.(?:e2e|spec)\.[cm]?[jt]sx?$/) ||
      has(files, /(?:^|\/)(?:playwright|cypress)\.config\.[cm]?[jt]s$/) ||
      has(files, /(?:^|\/)(?:tests?|e2e)\/e2e\//),
  },
  {
    id: 'tests',
    label: 'unit / integration tests',
    demand: /\b(unit\s+tests?|integration\s+tests?|tests?\s+suite|test\s+coverage|well[- ]tested)\b/i,
    missing: 'no `*.test.*` / `*.spec.*` file and no `tests/` or `__tests__/` directory',
    evidence: (files) =>
      has(files, /\.(?:test|spec)\.[cm]?[jt]sx?$/) ||
      has(files, /(?:^|\/)(?:tests?|__tests__)\//),
  },
];

/**
 * Walk the workspace once. Bounded, dependency-free, and read-only: the gate must
 * be cheap enough to run at every ceiling, including on a large monorepo.
 */
export function collectFileFacts(root: string, maxFiles = MAX_FILES): FileFact[] {
  const out: FileFact[] = [];
  const stack: string[] = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop() as string;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (out.length >= maxFiles) break;
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!st.isFile()) continue;
      out.push({
        path: abs.slice(root.length + 1).split(sep).join('/'),
        size: st.size,
        name: name.toLowerCase(),
      });
    }
  }
  return out;
}

/**
 * The gaps: surfaces the ask demanded and the tree does not contain.
 *
 * `ask` may be the original request or a change request; the BUILD shape guard
 * keeps a review or a question from being asked to produce an app.
 */
export function missingSurfaceGaps(input: {
  ask: string;
  cwd: string;
  /** Files already known to the caller; collected from `cwd` when omitted. */
  files?: readonly FileFact[];
}): SurfaceGap[] {
  const ask = (input.ask || '').trim();
  if (!ask) return [];
  if (!isBuildShapedAsk(ask) || !CREATION_VERB.test(ask)) return [];
  const files = input.files ?? collectFileFacts(input.cwd);
  const gaps: SurfaceGap[] = [];
  for (const surface of SURFACES) {
    const match = surface.demand.exec(ask);
    if (!match) continue;
    if (surface.evidence(files)) continue;
    // A filename convention is one kind of evidence, not the only one. Before
    // reporting a surface absent, look for the code that IS that surface — the
    // measured false positive here was a working `server.py` on `http.server`
    // reported as "no backend" because it was not a `server.ts`.
    if (surface.content && someSourceMatches(input.cwd, files, surface.content)) continue;
    gaps.push({
      id: surface.id,
      label: surface.label,
      asked: match[0],
      missing: surface.missing,
    });
  }
  return gaps;
}

/** The gap message: what the ask demanded, what the tree holds instead. */
export function surfaceGapsNudge(gaps: readonly SurfaceGap[]): string {
  const lines = gaps.map((g) => `  - ${g.label}: the ask says "${g.asked}" — ${g.missing}.`);
  return [
    // Deliberately NOT opening with the artifacts gate's "Before this turn ends"
    // line: a reader (and a test) counting that gate's asks must not count this one.
    'The request asked for parts of the product that do not exist yet.',
    ...lines,
    'Build the missing part now, or state plainly in the answer that it is not delivered —',
    'do not describe the project as complete while one of its named surfaces is absent.',
    'A dependency line in a package.json is not the thing itself: a `"next"` entry is not a UI,',
    'and a `"pg"` entry is not a schema.',
  ].join('\n');
}

