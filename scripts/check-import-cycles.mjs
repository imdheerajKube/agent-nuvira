#!/usr/bin/env node
/**
 * Import-graph analyzer for src/** — classifies each edge by KIND, because the
 * three kinds have completely different structural meaning:
 *
 *   static  — `import x from './y'`, `export * from './y'`, side-effect import.
 *             Creates a real runtime dependency that participates in module
 *             load order. THESE are the cycles that matter.
 *   type    — `import type …`, `export type …`, `import { type A } …`
 *             (all-type clause). ERASED by TypeScript — not a runtime edge at
 *             all. Counting these as cycles inflates the blob dramatically.
 *   lazy    — `await import('./y')` / `require('./y')`. A deliberate deferral:
 *             the code chose to break the static edge already. Harmless for load
 *             order (still an upward-layering smell worth reporting).
 *
 * So the headline is the STATIC runtime graph; lazy edges are reported
 * separately and only counted when `--include-lazy` is passed.
 *
 * Usage:
 *   node scripts/check-import-cycles.mjs                    # report
 *   node scripts/check-import-cycles.mjs --top=30           # list cycle members
 *   node scripts/check-import-cycles.mjs --json             # machine-readable
 *   node scripts/check-import-cycles.mjs --list-unreachable # dead module inventory
 *   node scripts/check-import-cycles.mjs --include-lazy     # add dynamic edges to the graph
 *   node scripts/check-import-cycles.mjs --max-static-scc=20    # CI gate
 *   node scripts/check-import-cycles.mjs --max-unreachable-pct=13
 *
 * Residual caveat: a *value* import whose bindings are used only in type
 * positions is also elided by TypeScript, and that cannot be detected without a
 * type checker. So the static graph is a slight OVER-estimate of runtime edges.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = resolve(ROOT, 'src');

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const has = (name) => args.includes(`--${name}`);
const TOP = Number(flag('top') ?? 12);
const INCLUDE_LAZY = has('include-lazy');
const MAX_SCC = flag('max-static-scc') === undefined ? null : Number(flag('max-static-scc'));
const MAX_UNREACHABLE_PCT = flag('max-unreachable-pct') === undefined ? null : Number(flag('max-unreachable-pct'));

/**
 * Entry paths. A module is only "unreachable" relative to a set of roots, so
 * missing roots manufacture dead code. Each root here is a real way the code
 * gets loaded:
 *   - the six agent/server entry paths
 *   - the dashboard browser bundle (`index.html` → `main.tsx`), which is why
 *     the walker must also collect `.tsx`
 *   - the published `agent-sdk` package entry
 *   - tooling config roots loaded by vite/vitest rather than by an import
 */
const ENTRIES = [
  'src/cli/chat.ts',
  'src/cli/execute.ts',
  'src/agents/orchestrator.ts',
  'src/web-dashboard/server.ts',
  'src/gateway/registry.ts',
  'src/index.ts',
  'src/web-dashboard/src/main.tsx',
  'src/agent-sdk/src/index.ts',
  'src/web-dashboard/vite.config.ts',
  'src/web-dashboard/vitest.config.ts',
].map((p) => resolve(ROOT, p));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(p, out);
    } else if (
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.endsWith('.d.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx')
    ) {
      // `.tsx` is included deliberately: the dashboard UI is real production
      // code reachable from `index.html` → `main.tsx`. Excluding it reported
      // ~2,900 lines of live, unit-tested React as dead.
      out.push(p);
    }
  }
  return out;
}

const files = walk(SRC);
const known = new Set(files);
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

/** Every named specifier in the clause is `type`-prefixed → the import is erased. */
function isAllTypeClause(clause) {
  const inner = clause.trim();
  if (!inner.startsWith('{')) return false;
  const names = inner.slice(1, inner.lastIndexOf('}')).split(',');
  const nonEmpty = names.map((n) => n.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return false;
  return nonEmpty.every((n) => /^type\s+[\w$]+/.test(n));
}

/**
 * Strip comments WITHOUT misreading string literals.
 *
 * The previous implementation used `raw.replace(/\/\*[\s\S]*?\*\//g, '')`. That is
 * catastrophic on this codebase: a tool description containing an escaped glob
 * — `description: '... (e.g. "src/**\/*.ts")'` — puts a literal `/*` inside a
 * string, which the regex happily treats as a comment opener and then eats
 * everything up to the next `*/` (here: 331 lines, 26 real tool registrations).
 * Every tool in that span looked "unreachable", which is how a bogus dead-code
 * report of ~18k lines was produced.
 *
 * This scanner tracks single/double/backtick strings and escapes, so a `/*`
 * inside a string can never open a comment. Comment characters are replaced by
 * spaces (newlines preserved) so line structure stays intact.
 */
function stripComments(raw) {
  let out = '';
  let state = 'code'; // code | line | block | ' | " | `
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const next = raw[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out += '  '; i++; continue; }
      if (c === '/' && next === '*') { state = 'block'; out += '  '; i++; continue; }
      if (c === "'" || c === '"' || c === '`') { state = c; out += c; continue; }
      out += c;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; continue; }
      out += ' ';
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out += '  '; i++; continue; }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    // inside a string literal
    if (c === '\\') { out += c + (next ?? ''); i++; continue; }
    if (c === state) state = 'code';
    // A template literal may contain `${ … }` code; treat it as string content.
    // Nothing in this repo puts an import() inside a template expression.
    out += c;
  }
  return out;
}

function parseImports(file) {
  const raw = readFileSync(file, 'utf8');
  const src = stripComments(raw);
  const staticValue = new Set();
  const typeOnly = new Set();
  const lazy = new Set();
  const relative_ = (s) => s && s.startsWith('.');

  // `import type … from '…'` and `export type … from '…'`
  for (const m of src.matchAll(/\b(?:import|export)\s+type\s+[^;]*?\bfrom\s+['"]([^'"]+)['"]/g)) {
    if (relative_(m[1])) typeOnly.add(m[1]);
  }
  // dynamic / require → lazy (checked first so they never land in static)
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) if (relative_(m[1])) lazy.add(m[1]);
  for (const m of src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g)) if (relative_(m[1])) lazy.add(m[1]);
  // static value imports / re-exports
  for (const m of src.matchAll(/\bimport\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (!relative_(m[2])) continue;
    if (/^\s*type\b/.test(m[1])) {
      typeOnly.add(m[2]);
      continue;
    }
    if (isAllTypeClause(m[1])) {
      typeOnly.add(m[2]);
      continue;
    }
    staticValue.add(m[2]);
  }
  for (const m of src.matchAll(/\bexport\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (!relative_(m[2])) continue;
    if (/^\s*type\b/.test(m[1])) {
      typeOnly.add(m[2]);
      continue;
    }
    staticValue.add(m[2]);
  }
  // side-effect import: `import './x'`
  for (const m of src.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) if (relative_(m[1])) staticValue.add(m[1]);

  return { staticValue: [...staticValue], typeOnly: [...typeOnly], lazy: [...lazy] };
}

function resolveSpec(fromFile, spec) {
  // `.js` → `.ts`/`.tsx` is mandatory under NodeNext: a TSX component is
  // referenced as `./Foo.js` even though the file on disk is `Foo.tsx`.
  // Without the `.tsx` candidates every React import silently failed to
  // resolve, which is what made the dashboard look unreachable.
  const base = resolve(dirname(fromFile), spec.replace(/\.jsx?$/, ''));
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const cand of candidates) if (known.has(cand)) return cand;
  return null;
}

const parsed = new Map();
for (const f of files) parsed.set(f, parseImports(f));

/** Edge sets resolved to files. */
function buildGraph({ includeLazy }) {
  const g = new Map();
  for (const f of files) {
    const deps = new Set();
    for (const spec of parsed.get(f).staticValue) {
      const r = resolveSpec(f, spec);
      if (r && r !== f) deps.add(r);
    }
    if (includeLazy) {
      for (const spec of parsed.get(f).lazy) {
        const r = resolveSpec(f, spec);
        if (r && r !== f) deps.add(r);
      }
    }
    g.set(f, [...deps]);
  }
  return g;
}

function sccs(graph) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  let counter = 0;
  const comps = [];
  const visit = (v) => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      comps.push(comp);
    }
  };
  for (const f of graph.keys()) if (!index.has(f)) visit(f);
  return comps;
}

const staticGraph = buildGraph({ includeLazy: false });
const fullGraph = buildGraph({ includeLazy: true });
const staticCycles = sccs(staticGraph).filter((c) => c.length > 1).sort((a, b) => b.length - a.length);
const fullCycles = sccs(fullGraph).filter((c) => c.length > 1).sort((a, b) => b.length - a.length);

const typeOnlyEdges = [...parsed.values()].reduce((a, p) => a + p.typeOnly.length, 0);
const lazyEdges = [...parsed.values()].reduce((a, p) => a + p.lazy.length, 0);
const staticEdges = [...staticGraph.values()].reduce((a, d) => a + d.length, 0);

// Reachability uses the FULL graph (static + lazy): a `await import()` is a
// real dependency, just a deferred one. Only CYCLE detection differentiates
// (a static cycle is a load-order defect; a lazy cycle is a deliberate break).
const graph = fullGraph;
const seen = new Set();
const work = ENTRIES.filter((p) => known.has(p));
while (work.length) {
  const f = work.pop();
  if (seen.has(f)) continue;
  seen.add(f);
  for (const d of graph.get(f) ?? []) if (!seen.has(d)) work.push(d);
}
const lines = (p) => readFileSync(p, 'utf8').split('\n').length;
const totalLines = files.reduce((a, f) => a + lines(f), 0);
/**
 * Deliberate non-import entry points. These modules are LIVE, but reachable only
 * by a mechanism the static graph cannot see — a compiled `.js` spawn target, a
 * published package surface, a documented fallback exercised by tests, a
 * benchmark fixture. Counting them as dead code inflates the number and buries
 * the real signal (a bogus dead-code list once nearly deleted the browser, vision
 * and voice tools). Each entry names the mechanism that keeps it alive: verify
 * that mechanism before trusting the exemption, and delete the entry when the
 * mechanism goes away.
 */
const EXEMPT = new Map([
  ['src/tools/child-agent-worker.ts', 'spawned as dist/tools/child-agent-worker.js by child-agent-entry.js'],
  ['src/agent-sdk/src/testing.ts', 'published `agent-sdk` package surface'],
  ['src/agent-sdk/src/types.ts', 'published package surface (imported via `import type` only)'],
  ['src/web-dashboard/src/components/MarkdownZeroDep.tsx', 'documented zero-dep fallback, exercised by Markdown.test.tsx'],
  ['src/web-dashboard/src/types.ts', '`import type` only — erased at runtime, so the graph cannot see it'],
  ['src/agents/nvda-addon.ts', 'fixture for the `py-nvda-addon` benchmark task'],
]);

const unreachableAll = files.filter((f) => !seen.has(f));
const exempt = unreachableAll.filter((f) => EXEMPT.has(rel(f)));
const unreachable = unreachableAll.filter((f) => !EXEMPT.has(rel(f)));
const unreachableLines = unreachable.reduce((a, f) => a + lines(f), 0);
const unreachablePct = (unreachableLines / totalLines) * 100;

const byDir = (members) => {
  const acc = {};
  for (const f of members) {
    const m = /^src\/([^/]+)\//.exec(rel(f));
    const k = m ? m[1] : 'src';
    acc[k] = (acc[k] ?? 0) + 1;
  }
  return Object.entries(acc)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
};

const biggestStatic = staticCycles[0] ?? [];

/**
 * `--list-unreachable` — every production module not reachable from an entry
 * path, with its line count, grouped by directory. This is the working list
 * for "is this dead code superseded or a missing wiring job?".
 */
if (has('list-unreachable')) {
  const grouped = new Map();
  for (const f of unreachable) {
    const m = /^src\/([^/]+)\//.exec(rel(f));
    const key = m ? m[1] : 'src';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ path: rel(f), lines: lines(f) });
  }
  for (const [dir, members] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const dirLines = members.reduce((a, m) => a + m.lines, 0);
    console.log(`\n${dir}  (${members.length} files, ${dirLines} lines)`);
    for (const m of members.sort((a, b) => b.lines - a.lines)) console.log(`  ${String(m.lines).padStart(6)}  ${m.path}`);
  }
  console.log(`\nTOTAL: ${unreachable.length} files, ${unreachableLines} lines (${unreachablePct.toFixed(1)}% of production)`);
  if (exempt.length > 0) {
    // Reported separately, never folded into the percentage — these are alive.
    console.log(`\nEXEMPT (live, not statically reachable — ${exempt.length} files, ${exempt.reduce((a, f) => a + lines(f), 0)} lines):`);
    for (const f of exempt) console.log(`  ${String(lines(f)).padStart(6)}  ${rel(f)}  — ${EXEMPT.get(rel(f))}`);
  }
} else if (has('json')) {
  console.log(
    JSON.stringify(
      {
        modules: files.length,
        lines: totalLines,
        edges: { static: staticEdges, lazy: lazyEdges, typeOnly: typeOnlyEdges },
        staticCycles: staticCycles.map((c) => ({ size: c.length, members: c.map(rel), dirs: byDir(c) })),
        allCyclesIncludingLazy: fullCycles.map((c) => ({ size: c.length, dirs: byDir(c) })),
        unreachable: {
          files: unreachable.length,
          lines: unreachableLines,
          pct: Number(unreachablePct.toFixed(1)),
          members: unreachable.map((f) => ({ path: rel(f), lines: lines(f) })),
        },
      },
      null,
      2,
    ),
  );
} else {
  console.log(`modules (production .ts, excl. tests): ${files.length}  (${totalLines} lines)`);
  console.log(`edges: ${staticEdges} static · ${lazyEdges} lazy (dynamic import/require) · ${typeOnlyEdges} type-only (erased)`);
  console.log('');
  console.log(`STATIC RUNTIME cycles:                ${staticCycles.length}`);
  console.log(`  largest static cycle:               ${biggestStatic.length} modules  [${byDir(biggestStatic)}]`);
  console.log(`  all cycles incl. lazy edges:        ${fullCycles.length}  (largest ${fullCycles[0]?.length ?? 0} modules)`);
  console.log(`unreachable from entry paths:         ${unreachable.length} files (${unreachableLines} lines, ${unreachablePct.toFixed(1)}%)`);
  if (exempt.length > 0) {
    console.log(`  exempt (live, not statically visible): ${exempt.length} files (reported separately, never in the % above)`);
  }
  console.log('');
  for (const c of staticCycles.slice(0, 3)) {
    console.log(`static cycle of ${c.length} — ${byDir(c)}`);
    for (const f of c.slice().sort((a, b) => rel(a).localeCompare(rel(b))).slice(0, TOP)) console.log(`   ${rel(f)}`);
    if (c.length > TOP) console.log(`   … and ${c.length - TOP} more`);
    console.log('');
  }
  if (staticCycles.length > 3) console.log(`${staticCycles.length - 3} smaller static cycle(s) not shown (use --json).\n`);
}

let failed = false;
if (MAX_SCC !== null && biggestStatic.length > MAX_SCC) {
  console.error(`✗ largest STATIC cycle is ${biggestStatic.length} modules — limit is ${MAX_SCC}`);
  failed = true;
}
if (MAX_UNREACHABLE_PCT !== null && unreachablePct > MAX_UNREACHABLE_PCT) {
  console.error(`✗ unreachable code is ${unreachablePct.toFixed(1)}% — limit is ${MAX_UNREACHABLE_PCT}%`);
  failed = true;
}
if (failed) process.exit(1);
