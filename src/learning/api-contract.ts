/**
 * API CONTRACT VERIFICATION — does the published spec describe the API that exists?
 *
 * WHY THIS EXISTS (measured 2026-10-27, the head-to-head). The winning artefact shipped
 * an OpenAPI document with 42 paths and its own `progress.md` claims it was VERIFIED:
 * "OpenAPI 3.0.3 contract: 40 paths, 28 schemas, zero unresolved `$ref`s". The other arm
 * shipped no machine-readable contract at all — and after that gap was fixed, the deeper
 * one remained: nuvira has no way to tell whether a spec it wrote is TRUE. A spec is the
 * one document a stranger's tooling trusts without reading the code: a client generator
 * will produce methods for paths that do not exist, and a missing `$ref` breaks the
 * whole document at the parser, before anyone reads a word. A stale spec is worse than
 * no spec, because nothing about it looks wrong.
 *
 * So this module makes the three checks an engineer would make by hand, deterministically:
 *
 * 1. REF INTEGRITY — every internal `$ref: '#/components/…'` resolves to a component the
 *    document actually defines. One dangling ref makes the document unloadable in
 *    Swagger UI, Insomnia, Postman and every codegen tool.
 * 2. DOCUMENTED BUT NOT IMPLEMENTED — a path in the spec that no route registers.
 * 3. IMPLEMENTED BUT NOT DOCUMENTED — a registered route the spec never mentions.
 *
 * WHAT IT DOES NOT DO: it does not judge schemas, security, or whether a documented field
 * is the right field. It compares SURFACES — the paths and methods — because that is the
 * part a caller's tooling acts on, and the part that can be checked without inventing
 * intent.
 *
 * HOW IT READS A SPEC WITHOUT A YAML DEPENDENCY. OpenAPI documents in the wild are YAML
 * or JSON; this repo has no YAML parser and a gate must not pull in a new dependency at
 * runtime. So JSON is parsed properly, and YAML is read STRUCTURALLY — indentation is the
 * grammar for the three things needed here (`paths:`, its method keys, and the
 * `components:`/`schemas:` names). Everything the scanner is unsure about is reported as
 * NOT CHECKED rather than guessed at, which is why `problems` distinguishes
 * "unresolved ref" from "could not parse".
 *
 * HOW IT RESOLVES ROUTES. Route files are mounted, so `/` inside `modules/tasks/routes.ts`
 * is really `/api/v1/tasks`. The mounts are read from the same `app.use('<prefix>', router)`
 * calls the server uses, with the router's identifier resolved through the file's imports.
 * When a mount cannot be resolved the raw path is kept, and the comparison falls back to a
 * suffix match (two or more segments) instead of inventing a prefix — a false "not
 * implemented" finding is worse than a missed one, because it teaches the model to ignore
 * this gate.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';

export interface RouteEntry {
  method: string;
  /** Normalised path (parameters collapsed to `{}`). */
  path: string;
  /**
   * The path as the code writes it, mount included (`/api/v1/tasks/:id`). Kept because
   * parameter NAMES are lost by normalisation and a generated spec should keep them.
   */
  raw: string;
  /** Workspace-relative file the route was found in. */
  source: string;
}

export interface SpecFacts {
  path: string;
  /** Documented operations, normalised. */
  operations: Array<{ method: string; path: string }>;
  /** Internal `$ref` targets, as written. */
  refs: string[];
  /** Component names the document defines, by section (`schemas` → names). */
  components: Record<string, Set<string>>;
  /** True when the document could be read as an OpenAPI/Swagger document at all. */
  parsed: boolean;
}

export type ContractProblemKind =
  | 'unresolved-ref'
  | 'documented-not-implemented'
  | 'implemented-not-documented';

export interface ContractProblem {
  kind: ContractProblemKind;
  /** The thing at fault, quoted (a path+method, or a `$ref`). */
  claim: string;
  /** What the other side actually has, as a fact. */
  problem: string;
}

export interface ContractVerdict {
  specPath?: string;
  parsed: boolean;
  documented: number;
  registered: number;
  problems: ContractProblem[];
  /** Problems found, before the cap (the message lists the first few). */
  total: number;
}

const SPEC_FILE = /(?:^|\/)(?:openapi|swagger)[\w.-]*\.(json|ya?ml)$/i;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  'vendor',
  'target',
  '__pycache__',
]);
const MAX_FILES = 2500;
const MAX_SOURCE_READS = 80;

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

/**
 * Identifiers that actually serve HTTP. `tasksRouter`, `app`, `server`, `r` — not
 * `teamByKey`, `headers`, `params`, `cache`.
 */
const ROUTER_RECEIVER = /^(?:app|router\d*|routes?|server|api|fastify|hono|r|express|koa)\w*$|\w+(?:Router|Routes|App|Server)$/;

function posix(path: string): string {
  return path.split(sep).join('/');
}

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
      if (st.isDirectory()) stack.push(rel);
      else if (st.isFile()) out.push(rel);
    }
  }
  return out;
}

function readText(root: string, rel: string, maxBytes = 3_000_000): string {
  try {
    const abs = join(root, rel);
    const st = statSync(abs);
    if (!st.isFile() || st.size === 0 || st.size > maxBytes) return '';
    return readFileSync(abs, 'utf-8');
  } catch {
    return '';
  }
}

/** Collapse `:id`, `{id}`, `<id>` and `*` so two spellings of one route compare equal. */
export function normalizePath(path: string): string {
  let out = (path || '').trim();
  if (!out) return '/';
  out = out.split('?')[0];
  out = out.replace(/\/{2,}/g, '/');
  out = out.replace(/\/:[A-Za-z0-9_]+/g, '/{}');
  out = out.replace(/\{[^}]*\}/g, '{}');
  out = out.replace(/<[^>]*>/g, '{}');
  out = out.replace(/\/\*+$/g, '/{}');
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out.startsWith('/') ? out : `/${out}`;
}

/** The real, mounted path a route file serves, e.g. `/api/v1` + `/tasks`. */
export function joinMount(prefix: string, path: string): string {
  const left = (prefix || '').replace(/\/+$/, '');
  const right = (path || '').trim();
  if (!right || right === '/') return normalizePath(left || '/');
  if (!left) return normalizePath(right);
  return normalizePath(`${left}/${right.replace(/^\/+/, '')}`);
}

/**
 * The document's own facts, from JSON or from YAML's indentation.
 *
 * The YAML reader is deliberately narrow: `paths:` at column 0, one 2-space key per path,
 * one 4-space key per method, plus `components.<section>.<Name>`. It recognises nothing
 * else, and a document it cannot see paths in is reported as unparsed rather than as an
 * empty spec — "0 documented paths" and "we could not read it" are different facts.
 */
export function readSpec(root: string, rel: string): SpecFacts | null {
  const text = readText(root, rel);
  if (!text) return null;
  const facts: SpecFacts = { path: rel, operations: [], refs: [], components: {}, parsed: false };

  if (/\.json$/i.test(rel)) {
    try {
      const doc = JSON.parse(text) as Record<string, unknown>;
      facts.parsed = traverseJson(doc, facts);
      return facts;
    } catch {
      return facts;
    }
  }

  const lines = text.replace(/\r/g, '').split('\n');
  let section: 'paths' | 'components' | null = null;
  let componentSection: string | null = null;
  let currentPath: string | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (/^paths:\s*$/.test(line)) {
      section = 'paths';
      componentSection = null;
      currentPath = null;
      facts.parsed = true;
      continue;
    }
    if (/^components:\s*$/.test(line)) {
      section = 'components';
      currentPath = null;
      facts.parsed = true;
      continue;
    }
    if (/^[A-Za-z][\w-]*:\s*$/.test(line)) {
      // Any other top-level key ends the region we care about.
      section = null;
      componentSection = null;
      currentPath = null;
    }
    const ref = /\$ref:\s*['"]?(#[^'"\s]+)['"]?/.exec(line);
    if (ref) facts.refs.push(ref[1]);

    if (section === 'paths') {
      const pathKey = /^ {2}['"]?(\/[^'":]*)['"]?:\s*$/.exec(line);
      if (pathKey) {
        currentPath = pathKey[1];
        continue;
      }
      const method = /^ {4}(get|post|put|patch|delete|head|options|trace):/i.exec(line);
      if (method && currentPath) {
        facts.operations.push({ method: method[1].toUpperCase(), path: normalizePath(currentPath) });
        continue;
      }
      // A new 2-space non-path key (e.g. `servers`) ends the paths region.
      if (/^ {2}[A-Za-z]/.test(line)) currentPath = null;
      continue;
    }
    if (section === 'components') {
      const sub = /^ {2}['"]?([A-Za-z]\w*)['"]?:\s*$/.exec(line);
      if (sub) {
        componentSection = sub[1];
        facts.components[componentSection] = facts.components[componentSection] ?? new Set();
        continue;
      }
      const name = /^ {4}['"]?([A-Za-z0-9_.-]+)['"]?:\s*$/.exec(line);
      if (name && componentSection) facts.components[componentSection].add(name[1]);
    }
  }
  return facts;
}

/** JSON documents: paths + refs + component names, from the parsed object. */
function traverseJson(doc: unknown, facts: SpecFacts): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const root = doc as Record<string, unknown>;
  if (!root.openapi && !root.swagger) return false;
  const paths = root.paths;
  if (paths && typeof paths === 'object') {
    for (const [path, item] of Object.entries(paths as Record<string, unknown>)) {
      if (!item || typeof item !== 'object') continue;
      for (const method of Object.keys(item as Record<string, unknown>)) {
        if (!(METHODS as readonly string[]).includes(method.toLowerCase())) continue;
        facts.operations.push({ method: method.toUpperCase(), path: normalizePath(path) });
      }
    }
  }
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string') {
        if (value.startsWith('#') && !seen.has(value)) {
          seen.add(value);
          facts.refs.push(value);
        }
        continue;
      }
      visit(value);
    }
  };
  visit(root);
  const components = root.components;
  if (components && typeof components === 'object') {
    for (const [section, entries] of Object.entries(components as Record<string, unknown>)) {
      // Swagger 2 keeps `definitions` at the root; handled below.
      if (!entries || typeof entries !== 'object') continue;
      facts.components[section] = new Set(Object.keys(entries as Record<string, unknown>));
    }
  }
  const definitions = root.definitions;
  if (definitions && typeof definitions === 'object') {
    facts.components.definitions = new Set(Object.keys(definitions as Record<string, unknown>));
  }
  return true;
}

/** The `$ref`s that name a component the document does not define. */
export function unresolvedRefs(spec: SpecFacts): string[] {
  const out: string[] = [];
  for (const ref of spec.refs) {
    const target = ref.replace(/^#\/?/, '');
    const parts = target.split('/').filter(Boolean);
    if (parts.length < 2) continue; // `#/paths/...` and other non-component targets
    const [section, name] = parts;
    if (section === 'definitions') {
      if (!spec.components.definitions?.has(name)) out.push(ref);
      continue;
    }
    if (section !== 'components') continue;
    const kind = parts[1];
    const componentName = parts[2];
    if (!kind || !componentName) continue;
    if (!spec.components[kind]?.has(componentName)) out.push(ref);
  }
  return out;
}

/** Identifiers mounted by `app.use('<prefix>', <router>)`, resolved to their source file. */
function readMounts(root: string, files: readonly string[]): Map<string, string> {
  const mounts = new Map<string, string>();
  const candidates = files.filter((f) => /\.(?:[cm]?[jt]s)$/i.test(f)).slice(0, MAX_SOURCE_READS);
  for (const rel of candidates) {
    const text = readText(root, rel, 400_000);
    if (!text || !text.includes('.use(')) continue;
    const imports = new Map<string, string>();
    for (const m of text.matchAll(/import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g)) {
      const names = m[1] ? m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop() as string) : [m[2]];
      for (const name of names) {
        if (!name) continue;
        imports.set(name, m[3]);
      }
    }
    for (const m of text.matchAll(/\buse\s*\(\s*['"]([^'"]*)['"]\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
      const [, prefix, ident] = m;
      const specifier = imports.get(ident);
      if (!specifier) continue;
      const base = specifier.startsWith('.')
        ? posix(normalize(join(dirname(rel), specifier)))
        : specifier;
      // The import may name a `.js` that is a `.ts` on disk (the repo's ESM style).
      const asTs = base.replace(/\.js$/, '.ts');
      const target = files.find((f) => f === base || f === asTs || f.replace(/\.(ts|tsx|js)$/, '') === base.replace(/\.js$/, ''));
      if (target) mounts.set(target, prefix);
    }
  }
  return mounts;
}

/**
 * The routes the code actually registers, with mount prefixes applied where they can be
 * resolved. Bounded: the check runs on a turn, not in a build step.
 */
export function registeredRoutes(input: { cwd: string; files?: readonly string[] }): RouteEntry[] {
  const files = [...(input.files ?? walk(input.cwd))];
  const routes: RouteEntry[] = [];
  const seen = new Set<string>();
  const mounts = readMounts(input.cwd, files);

  const sources = files
    .filter((f) => /\.(?:[cm]?[jt]s)$/i.test(f) && !/(?:^|\/)(?:tests?|__tests__|spec)\//i.test(f))
    .sort((a, b) => Number(/routes?|controllers?|api/i.test(b)) - Number(/routes?|controllers?|api/i.test(a)));
  for (const rel of sources.slice(0, MAX_SOURCE_READS)) {
    const text = readText(input.cwd, rel, 500_000);
    if (!text) continue;
    const prefix = mounts.get(rel) ?? '';
    const push = (method: string, path: string): void => {
      const full = joinMount(prefix, path);
      const key = `${method.toUpperCase()} ${full}`;
      if (seen.has(key)) return;
      seen.add(key);
      const left = prefix.replace(/\/+$/, '');
      const right = path.trim();
      const raw = !right || right === '/' ? left || '/' : `${left}/${right.replace(/^\/+/, '')}` || right;
      routes.push({
        method: method.toUpperCase(),
        path: full,
        raw: raw.startsWith('/') ? raw : `/${raw}`,
        source: rel,
      });
    };

    // express / fastify / koa: `router.get('/x', …)` — the path may sit on the next line.
    //
    // The RECEIVER has to look like a router. Without that filter `.get('ADMIN')` on a
    // Map reads as a route: measured on a real tree (2026-10-27), `teamByKey.get('APOLLO')`
    // in a seed file produced `GET /APOLLO`, and a false "undocumented route" teaches the
    // model to ignore this gate.
    for (const m of text.matchAll(
      /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|all|head|options)\s*\(\s*['"`]([^'"`\n]+)['"`]/g,
    )) {
      if (!ROUTER_RECEIVER.test(m[1])) continue;
      if (!m[3].startsWith('/')) continue;
      push(m[2] === 'all' ? 'ALL' : m[2], m[3]);
    }
    // NestJS: `@Controller('tasks')` + `@Get(':id')` in the same file.
    const controller = /@Controller\(\s*['"`]([^'"`]*)['"`]?\s*\)/.exec(text);
    if (controller) {
      for (const m of text.matchAll(/@(Get|Post|Put|Patch|Delete|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g)) {
        const base = controller[1];
        const sub = m[2] ?? '';
        push(m[1] === 'All' ? 'ALL' : m[1], joinMount(`/${base.replace(/^\/+/, '')}`, sub || '/'));
      }
    }
  }
  return routes;
}

/** A documented path matches a registered one when they are equal, or when the mount prefix was unknowable. */
function sameOperation(a: { method: string; path: string }, b: RouteEntry): boolean {
  if (a.method !== b.method && a.method !== 'ALL' && b.method !== 'ALL') return false;
  if (a.path === b.path) return true;
  const as = a.path.split('/').filter(Boolean);
  const bs = b.path.split('/').filter(Boolean);
  if (as.length < 2 || bs.length < 2) return false;
  const lastTwo = (parts: string[]): string => parts.slice(-2).join('/');
  return lastTwo(as) === lastTwo(bs);
}

/**
 * The verdict: what the document promises, what the server serves, and the difference.
 *
 * Capped at `maxProblems` so the message can list a handful; `total` keeps the count
 * honest if there are more.
 */
export function verifyApiContract(input: {
  cwd: string;
  files?: readonly string[];
  maxProblems?: number;
}): ContractVerdict {
  const files = [...(input.files ?? walk(input.cwd))];
  const specRel = files
    .filter((f) => SPEC_FILE.test(f))
    .sort((a, b) => (readText(input.cwd, b, 0) ? 0 : 0) || b.length - a.length)[0];
  if (!specRel) {
    return { parsed: false, documented: 0, registered: 0, problems: [], total: 0 };
  }
  const spec = readSpec(input.cwd, specRel);
  if (!spec || !spec.parsed) {
    return { specPath: specRel, parsed: false, documented: 0, registered: 0, problems: [], total: 0 };
  }
  const routes = registeredRoutes({ cwd: input.cwd, files });
  const max = input.maxProblems ?? 8;
  const problems: ContractProblem[] = [];

  for (const ref of unresolvedRefs(spec)) {
    problems.push({
      kind: 'unresolved-ref',
      claim: ref,
      problem: 'the document defines no such component, so the whole spec fails to load in Swagger/codegen tools',
    });
  }

  const phantom = spec.operations.filter((op) => !routes.some((r) => sameOperation(op, r)));
  for (const op of phantom) {
    problems.push({
      kind: 'documented-not-implemented',
      claim: `${op.method} ${op.path}`,
      problem: `no route in the code serves it (${routes.length} route(s) registered)`,
    });
  }

  const undocumented = routes.filter(
    (r) => r.method !== 'ALL' && !spec.operations.some((op) => sameOperation(op, r)),
  );
  for (const route of undocumented) {
    problems.push({
      kind: 'implemented-not-documented',
      claim: `${route.method} ${route.path}`,
      problem: `registered in \`${route.source}\` and absent from \`${specRel}\``,
    });
  }

  return {
    specPath: specRel,
    parsed: true,
    documented: spec.operations.length,
    registered: routes.filter((r) => r.method !== 'ALL').length,
    problems: problems.slice(0, max),
    total: problems.length,
  };
}

/** The finding lines a document audit can carry, one per contradiction. */
export function contractFindings(verdict: ContractVerdict): Array<{ claim: string; problem: string }> {
  if (!verdict.specPath || !verdict.parsed) return [];
  return verdict.problems.map((p) => ({ claim: p.claim, problem: p.problem }));
}
