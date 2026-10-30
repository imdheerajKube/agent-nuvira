#!/usr/bin/env node
/**
 * Endpoint + documentation delta between two agent-delivered trees.
 *
 * WHY THIS EXISTS. The head-to-head scores an aspect per arm, but the verdict a user
 * feels ("who built the better product") came down to two countable things in the
 * 2026-10-27 round: how many endpoints each tree actually serves and how many of them
 * a client can call without reading the source, and which documents a stranger needs
 * are present. Both are facts about the tree, and both were being counted by hand.
 *
 * It reads them the SAME way the in-loop verifier does — `dist/learning/api-contract.js`,
 * i.e. the same route scanner and spec reader the gate uses — so a number here is the
 * number the model was shown, not a second opinion. Requires a built tree (`npm run
 * build`); it never reads the arm's node_modules.
 *
 * Usage:
 *   node scripts/bench/platform/compare-delivery.mjs cline=/tmp/bench/cline ours=/tmp/bench/nuvira [--json]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { verifyApiContract, registeredRoutes } = await import(`${REPO}/dist/learning/api-contract.js`);

const IGNORED = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'playwright-report',
  'test-results',
]);
const DOC_EXT = /\.(?:md|mdx|txt)$/i;

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (IGNORED.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(abs);
      else if (st.isFile()) out.push({ abs, path: relative(root, abs).split(sep).join('/'), size: st.size });
    }
  }
  return out;
}

const read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/** The documents the benchmark prompt names, plus the ones that make it adoptable. */
const DOC_SLOTS = {
  readme: /^readme\.md$/i,
  prd: /(?:^|\/)(?:prd|product[-_ ]?requirements)[^/]*\.md$/i,
  architecture: /(?:^|\/)(?:architecture|design|adr|system[-_ ]?design)[^/]*\.md$/i,
  roadmap: /(?:^|\/)(?:roadmap|implementation[-_ ]?plan)[^/]*\.md$/i,
  risk: /(?:^|\/)(?:risk)[^/]*\.md$/i,
  todo: /(?:^|\/)todo\.md$/i,
  progress: /(?:^|\/)progress\.md$/i,
  issues: /(?:^|\/)issues\.md$/i,
  changelog: /(?:^|\/)changelog\.md$/i,
  deployment: /(?:^|\/)(?:deploy(?:ment)?|devops|operations|runbook|infra)[^/]*\.md$/i,
  api: /(?:^|\/)(?:api|endpoints|routes|openapi)[^/]*\.md$/i,
  security: /(?:^|\/)(?:security)[^/]*\.md$/i,
  testing: /(?:^|\/)(?:test(?:ing)?)[^/]*\.md$/i,
};

function describe(label, dir) {
  const files = walk(dir);
  const docs = files.filter((f) => DOC_EXT.test(f.path));
  const code = files.filter((f) => /\.(?:[cm]?[jt]sx?|py|go|rs|sql)$/i.test(f.path));

  const verdict = verifyApiContract({ cwd: dir });
  const routes = registeredRoutes({ cwd: dir });
  const methods = {};
  for (const r of routes) methods[r.method] = (methods[r.method] ?? 0) + 1;

  const slots = {};
  for (const [slot, re] of Object.entries(DOC_SLOTS)) {
    const hit = docs.filter((d) => re.test(d.path));
    slots[slot] = hit.length ? hit.map((d) => ({ path: d.path, bytes: d.size })) : null;
  }

  const specFiles = files.filter((f) => /(?:^|\/)(?:openapi|swagger)[\w.-]*\.(?:json|ya?ml)$/i.test(f.path));
  const specText = specFiles.map((f) => read(f.abs)).join('\n');

  const byKind = { 'implemented-not-documented': [], 'documented-not-implemented': [], 'unresolved-ref': [] };
  for (const p of verdict.problems) byKind[p.kind]?.push(`${p.claim} — ${p.problem}`);

  return {
    label,
    dir,
    files: files.length,
    codeFiles: code.length,
    docFiles: docs.length,
    docBytes: docs.reduce((n, d) => n + d.size, 0),
    slots,
    spec: specFiles.map((f) => ({ path: f.path, bytes: f.size })),
    specBytes: specFiles.reduce((n, f) => n + f.size, 0),
    specParsed: verdict.parsed,
    operationsDocumented: verdict.documented,
    routesRegistered: routes.length,
    routesByMethod: methods,
    contractProblems: verdict.total,
    problemsByKind: byKind,
    todoSummaries: (specText.match(/summary:\s*TODO/gi) ?? []).length,
  };
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const arms = args
  .filter((a) => a.includes('='))
  .map((a) => {
    const at = a.indexOf('=');
    return { label: a.slice(0, at), dir: a.slice(at + 1) };
  });
if (arms.length === 0) {
  console.error('usage: compare-delivery.mjs <label>=<dir> [<label>=<dir> ...] [--json]');
  process.exit(2);
}

const results = arms.map(({ label, dir }) => {
  if (!existsSync(dir)) throw new Error(`missing: ${dir}`);
  return describe(label, dir);
});

if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const labels = results.map((r) => r.label);
  const row = (name, fn) => `| ${name} | ${results.map((r) => fn(r) ?? '—').join(' | ')} |`;
  console.log(`| metric | ${labels.join(' | ')} |`);
  console.log(`|---|${labels.map(() => '---:').join('|')}|`);
  console.log(row('Files (excl. deps/build)', (r) => r.files));
  console.log(row('Routes registered (scanner)', (r) => r.routesRegistered));
  console.log(row('OpenAPI operations documented', (r) => (r.specParsed ? r.operationsDocumented : 'no spec')));
  console.log(row('Contract problems', (r) => (r.specParsed ? r.contractProblems : 'no spec')));
  console.log(row('Spec bytes', (r) => (r.spec.length ? r.specBytes : 'none')));
  console.log(row('TODO summaries in spec', (r) => r.todoSummaries));
  console.log(row('Doc files / KB', (r) => `${r.docFiles} / ${Math.round(r.docBytes / 1024)}`));
  for (const slot of Object.keys(DOC_SLOTS)) {
    console.log(row(slot, (r) => (r.slots[slot] ? r.slots[slot].map((d) => d.path).join(', ') : 'MISSING')));
  }
  console.log('\nPer-arm method mix:');
  for (const r of results) console.log(`  ${r.label}: ${JSON.stringify(r.routesByMethod)}`);
  console.log('\nContract problems by kind:');
  for (const r of results) {
    const k = r.problemsByKind;
    console.log(
      `  ${r.label}: documented-not-implemented=${k['documented-not-implemented'].length} ` +
        `implemented-not-documented=${k['implemented-not-documented'].length} ` +
        `unresolved-ref=${k['unresolved-ref'].length}`,
    );
  }
}
