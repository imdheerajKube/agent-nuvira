#!/usr/bin/env node
/**
 * Validate the assembled book against the source tree.
 *
 *   node scripts/check-book-code.mjs            # report defects
 *   node scripts/check-book-code.mjs --json     # machine-readable
 *
 * WHY THIS EXISTS. The book makes three kinds of checkable claim, and each has
 * drifted at least once:
 *
 *   1. a `src/...` path — the book said `src/learning/decision-engine.ts`,
 *      `src/security/rbac.ts` and `src/tools/tool-registry.ts`; none exist.
 *   2. a relative import inside a code block (`from './complexity-scorer.js'`)
 *      — same failure mode, one layer in.
 *   3. a named symbol in backticks (`AutoModelRouter`, `analyzeTaskProfile`)
 *      — the fastest way for prose to describe software that is not there.
 *   4. a NUMBER ("487 files", "288 commands", "512 test files"). Counts drift
 *      faster than prose: chapter 17's project tree claimed `agents/ (487
 *      files)` when the directory holds 56, and the cover repeated two stale
 *      totals for months. Every count is now measured here from the same tree
 *      the book describes.
 *
 * A defect here is a CLAIM THE BOOK CANNOT SUPPORT. Some listed paths are
 * deliberately hypothetical (the "build your own X" exercises and the SDK's
 * example agents name files that live in YOUR project, not in this repo), so
 * those are carried in `ILLUSTRATIVE` with the reason, rather than being
 * silently ignored.
 *
 * Exit code is non-zero when an unlisted defect is found, so this can gate a
 * release the same way `verify-book.mjs` does.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const BOOK_ARG = (() => {
  const i = process.argv.indexOf('--book');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith('--book='));
  return inline ? inline.slice('--book='.length) : null;
})();
const BOOK = BOOK_ARG
  ? resolve(repoRoot, BOOK_ARG)
  : join(repoRoot, 'book', 'agent-nuvira-complete-guide.html');
const JSON_OUT = process.argv.includes('--json');

/**
 * Paths the book names on purpose as things the READER creates or that belong to
 * a host application — never as a description of this repository.
 */
const ILLUSTRATIVE = new Map([
  ['src/codeFormatter.ts', 'SDK scaffold output — the reader generates this'],
  ['src/conventionalCommit.js', 'SDK example agent in the reader’s project'],
  ['src/release-notes-plugin.ts', 'SDK plugin example in the reader’s project'],
  ['src/db.ts', 'generic example in the TypeScript fundamentals part'],
  ['src/file.ts', 'generic example in the TypeScript fundamentals part'],
  ['src/server.ts', 'CLI example: the reader’s own server file, e.g. `nuvira edit src/server.ts`'],
  ['src/api.ts', 'CLI example: a file in the reader’s project'],
  ['src/app.ts', 'CLI example: a file in the reader’s project'],
  ['src/web-dashboard/src/components/StatusBadge.tsx', 'labelled in the text as an example component'],
]);

/**
 * Bare filenames the book names that are not files in THIS repo, with the reason.
 * Two legitimate families: package names that merely look like files, and the
 * TypeScript-fundamentals examples the reader is asked to create.
 */
const ILLUSTRATIVE_MODULES = new Set(['conventionalCommit', 'helpers']);

const ILLUSTRATIVE_FILENAMES = new Set([
  // package names — spelled with a .js suffix by convention, not files
  'Node.js', 'Next.js', 'Commander.js', 'Discord.js', 'Prism.js', 'discord.js', 'whatsapp-web.js',
  // Part I/II teaching examples the reader writes, plus the playgrounds
  'error-handling.ts', 'generics.ts', 'greeting.ts', 'hello.js', 'hello.ts', 'mapped-types.ts',
  'observer-pattern.ts', 'playground.ts', 'strategy-pattern.ts', 'utils.ts',
  // labelled as an example in the surrounding text
  'StatusBadge.tsx',
]);

/** Symbols that are language/package vocabulary, not Agent-Nuvira identifiers. */
const SYMBOL_ALLOWLIST = new Set([
  'Array', 'Promise', 'Record', 'Partial', 'Readonly', 'Omit', 'Pick', 'Exclude', 'Extract',
  'ReturnType', 'Parameters', 'Awaited', 'Error', 'Object', 'Function', 'Symbol', 'Map', 'Set',
  'WeakMap', 'RegExp', 'Date', 'JSON', 'Math', 'Number', 'String', 'Boolean', 'Null', 'Undefined',
  'TypeScript', 'JavaScript', 'NodeJS', 'Node', 'Vitest', 'Jest', 'React', 'Commander', 'Zod',
  'Express', 'Mermaid', 'Dockerfile', 'Docker', 'WhatsApp', 'Telegram', 'Discord', 'Slack',
  'OAuth', 'JWT', 'LLM', 'LLMs', 'REST', 'API', 'APIs', 'CLI', 'SDK', 'MCP', 'HTTP', 'HTTPS',
  'JSONL', 'YAML', 'TOML', 'Markdown', 'GitHub', 'GitLab', 'VS', 'OK', 'PDF', 'AI', 'IDE', 'IDEs',
  'SQL', 'RBAC', 'CORS', 'URI', 'URL', 'URLs', 'UUID', 'ASCII', 'UTF', 'CPU', 'GPU', 'RAM',
  'TTL', 'SDKs', 'DLQ', 'EOF', 'MIT', 'ISC', 'ESM', 'CJS', 'AMD', 'AST', 'TPS', 'RPS', 'QPS',
  'OTEL', 'OTLP', 'SMTP', 'IMAP', 'TLS', 'SSL', 'DNS', 'CDN', 'VPN', 'ACL', 'MFA', 'SSO', 'SAML',
  'PII', 'GDPR', 'SOC', 'ISO', 'HIPAA', 'KV', 'DB', 'CI', 'CD', 'PR', 'PRs', 'UI', 'UX', 'DAG',
  'DDD', 'TDD', 'OOP', 'SOLID', 'DRY', 'YAGNI', 'ESLint', 'Prettier', 'ZodError', 'Buffer',
  'HooksPage', 'MCPPage', 'Layout', 'App', 'NavItem',
]);

const html = readFileSync(BOOK, 'utf-8');

// ── source index ─────────────────────────────────────────────────────────────
/** Every path under src/ (and a few roots) that actually exists. */
const sourceFiles = [];
/** Every identifier-ish word appearing anywhere in src/. */
const sourceWords = new Set();
/** Every module basename (without extension) under src/. */
const moduleBasenames = new Set();
/** Every real filename anywhere we ship (excluding build output and archives). */
const realBasenames = new Set();

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full);
    } else if (/\.(ts|tsx|json|md|mjs|js)$/.test(entry)) {
      const rel = full.slice(repoRoot.length + 1);
      sourceFiles.push(rel);
      moduleBasenames.add(entry.replace(/\.(ts|tsx|js|mjs)$/, ''));
      realBasenames.add(entry);
      if (entry.endsWith('.md')) continue;
      let text = '';
      try {
        text = readFileSync(full, 'utf-8');
      } catch {
        continue;
      }
      for (const w of text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) sourceWords.add(w);
    }
  }
}
walk(join(repoRoot, 'src'));
{
  // Root-level files (package.json, vite.config.ts, Dockerfile, …) so a bare
  // filename check keys off everything that actually ships, not just src/.
  for (const entry of readdirSync(repoRoot)) {
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist' || entry === 'book') continue;
    const full = join(repoRoot, entry);
    const st = statSync(full);
    if (st.isFile()) {
      realBasenames.add(entry);
      continue;
    }
    if (entry === 'vscode-extension' || entry === 'scripts' || entry === 'tests' || entry === 'examples') {
      // already walked (or deliberately not walked) above
    }
  }
  for (const dir of ['vscode-extension', 'examples']) {
    const p2 = join(repoRoot, dir);
    if (!existsSync(p2)) continue;
    const stack = [p2];
    while (stack.length) {
      const d = stack.pop();
      for (const entry of readdirSync(d)) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'out') continue;
        const full = join(d, entry);
        if (statSync(full).isDirectory()) stack.push(full);
        else realBasenames.add(entry);
      }
    }
  }
}
for (const extra of ['scripts', 'vscode-extension/src', 'tests']) {
  const p = join(repoRoot, extra);
  if (existsSync(p) && statSync(p).isDirectory()) walk(p);
}

// ── chapter slicing ──────────────────────────────────────────────────────────
const chapterRe = /<div class="chapter" id="([^"]+)">/g;
const marks = [...html.matchAll(chapterRe)].map((m) => ({ id: m[1], at: m.index }));
const chapters = marks.map((m, i) => ({
  id: m.id,
  // +600 so the chapter's own <h2> title is inside the slice
  body: html.slice(m.at, i + 1 < marks.length ? marks[i + 1].at : html.length),
}));
const titleOf = (body) => {
  const m = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(body.slice(0, 1200));
  return m ? m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '?';
};

const strip = (s) =>
  s
    .replace(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g, (_, c) => `\n@@CODE@@\n${c}\n@@ENDCODE@@\n`)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ge;/g, '>=')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&');

// ── the three checks ─────────────────────────────────────────────────────────
const defects = [];
const add = (chapterId, kind, detail) => {
  const found = chapters.find((c) => c.id === chapterId);
  defects.push({ chapter: chapterId, title: found ? titleOf(found.body) : chapterId, kind, detail });
};

/** The chapter an offset falls inside, or `(front matter)` before the first one. */
const chapterAt = (at) => {
  let cur = '(front matter)';
  for (const m of marks) {
    if (m.at <= at) cur = m.id;
    else break;
  }
  return cur;
};

for (const ch of chapters) {
  const text = strip(ch.body);

  // 1. src/... paths
  for (const p of new Set(text.match(/\bsrc\/[A-Za-z0-9_\-/]+\.[A-Za-z]+/g) ?? [])) {
    if (existsSync(join(repoRoot, p))) continue;
    // NodeNext TypeScript imports its own sources with a `.js` specifier, so
    // `src/tools/registry.js` is a CORRECT reference to `src/tools/registry.ts`.
    if (/\.js$/.test(p) && (existsSync(join(repoRoot, p.replace(/\.js$/, '.ts'))) ||
        existsSync(join(repoRoot, p.replace(/\.js$/, '.tsx'))))) continue;
    if (ILLUSTRATIVE.has(p)) continue;
    add(ch.id, 'missing-path', p);
  }

  // 1b. bare filenames (a "project structure" tree or a code header can name a
  // file this repo does not have, with no src/ prefix to catch it).
  for (const m of text.matchAll(/(?<![\w/.-])([A-Za-z][A-Za-z0-9_-]*\.(?:tsx|ts|js|mjs))(?![\w-])/g)) {
    const name = m[1];
    if (realBasenames.has(name)) continue;
    if (ILLUSTRATIVE_FILENAMES.has(name)) continue;
    add(ch.id, 'unknown-filename', name);
  }

  // 2. relative imports inside code blocks
  for (const block of text.match(/@@CODE@@([\s\S]*?)@@ENDCODE@@/g) ?? []) {
    for (const spec of new Set(block.match(/from\s+'(\.[^']+)'/g) ?? [])) {
      const target = spec.slice(6, -1);
      const base = basename(target).replace(/\.(js|ts|tsx)$/, '');
      if (moduleBasenames.has(base)) continue;
      if (ILLUSTRATIVE.has(base)) continue;
      if (ILLUSTRATIVE_MODULES.has(base)) continue;
      add(ch.id, 'unresolved-import', target);
    }
  }

  // 3. named symbols in backticks
  const prose = text.replace(/@@CODE@@[\s\S]*?@@ENDCODE@@/g, '');
  const symbols = new Set();
  for (const m of prose.matchAll(/`([A-Za-z_][A-Za-z0-9_.]{3,40})`/g)) {
    const raw = m[1];
    if (raw.includes('.')) continue; // member access — covered by the base word
    if (!/[A-Z]|_/.test(raw.slice(1))) continue; // needs PascalCase or snake_case shape
    symbols.add(raw);
  }
  for (const s of symbols) {
    if (SYMBOL_ALLOWLIST.has(s)) continue;
    if (sourceWords.has(s)) continue;
    // paths / flags / env vars are not symbols
    if (s.includes('/') || s.startsWith('NUVIRA') || s.startsWith('BUFF')) continue;
    add(ch.id, 'unknown-symbol', s);
  }
}

// ── 4. numeric claims ────────────────────────────────────────────────────────
// Each count the book states is compared with a value measured from THIS tree.
// A mismatch is reported with both numbers so the fix is a one-line edit.

function walkRepo() {
  const out = [];
  const skip = new Set(['node_modules', 'dist', 'out', '.git', 'book']);
  const go = (dir) => {
    for (const e of readdirSync(dir)) {
      if (skip.has(e) || e === '.DS_Store') continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) go(full);
      else out.push(full.slice(repoRoot.length + 1));
    }
  };
  go(repoRoot);
  return out;
}

const read = (p) => {
  try {
    return readFileSync(join(repoRoot, p), 'utf-8');
  } catch {
    return '';
  }
};
const lineCount = (p) => {
  const t = read(p);
  return t ? t.split('\n').length : 0;
};
const uniq = (arr) => [...new Set(arr)];

const repoFiles = walkRepo();
const srcTs = repoFiles.filter((p) => p.startsWith('src/') && /\.tsx?$/.test(p));
const dirFiles = (d) => srcTs.filter((p) => p.startsWith(`${d}/`)).length;

const providerCatalog = read('src/inference/provider-catalog.ts');
const moduleRegistry = read('src/agents/module-registry.ts');
const channelDirectory = read('src/gateway/channel-directory.ts');
const navModel = read('src/web-dashboard/src/nav.ts');
const dashboardServer = read('src/web-dashboard/server.ts');
const mcpCatalog = read('src/mcp/catalog.ts');

// The dashboard's route surface, counted exactly as `generate-book-chapters.mjs`
// counts it — exact paths plus parameterised prefix routes, minus the JSON-404
// fallback and the admin auth guard.
const apiExact = uniq(
  [...dashboardServer.matchAll(/(?:pathname|path)\s*===\s*'(\/api\/[^']+)'/g)].map((m) => m[1]),
);
const apiPrefix = uniq(
  [...dashboardServer.matchAll(/pathname\.startsWith\('(\/api\/[^']+)'\)/g)]
    .map((m) => m[1])
    .filter((p) => p !== '/api/' && p !== '/api/admin/'),
);
const apiSuffixed = uniq(
  [...dashboardServer.matchAll(/pathname\.startsWith\('(\/api\/[^']+)'\)[^\n]*endsWith\('([^']+)'\)/g)].map(
    (m) => `${m[1]}:id${m[2]}`,
  ),
);
const apiEndpointCount = uniq([...apiExact, ...apiPrefix.map((p) => `${p}:id`), ...apiSuffixed]).length;

const platformUnion = /export type Platform =([\s\S]*?);/.exec(channelDirectory)?.[1] ?? '';
const platforms = uniq([...platformUnion.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

// A skill is a DIRECTORY holding a `SKILL.md` (singular). The manifest
// `index.json` sits beside them, so counting directory entries over-reported the
// catalogue by one.
let skillCount = 0;
try {
  skillCount = readdirSync(join(repoRoot, '.agents', 'skills')).filter(
    (e) =>
      !e.startsWith('.') &&
      statSync(join(repoRoot, '.agents', 'skills', e)).isDirectory() &&
      existsSync(join(repoRoot, '.agents', 'skills', e, 'SKILL.md')),
  ).length;
} catch {
  /* no skills directory */
}

// Two values can only be measured by ASKING the built CLI, so they are read from
// `dist/` and reported as unmeasured when the build is missing — never guessed.
let cliCommandCount = 0;
let toolCount = 0;
/**
 * `id` → the command's own flags, whether it takes positional arguments, and
 * its children — the shape needed to resolve a typed command line.
 * `''` is the root.
 */
const commandTree = new Map();
try {
  const { createCLI } = await import(join(repoRoot, 'dist', 'cli', 'cli-program.js'));
  const argv = process.argv;
  process.argv = [argv[0], 'nuvira', '--help'];
  const program = createCLI();
  process.argv = argv;

  const flagsOf = (c) =>
    new Set(
      (c.options ?? [])
        .flatMap((o) => [o.short, o.long])
        .filter((f) => typeof f === 'string' && f.startsWith('-')),
    );
  /**
   * Flags that CONSUME the next token (`--transport <kind>`, `--arg <value>`).
   * Without this, a documented example like
   * `nuvira mcp add mine --command node --arg --stdio` reads as if `--stdio`
   * were a flag of `mcp add` — it is the CHILD process's argument.
   */
  const valueFlagsOf = (c) =>
    new Set(
      (c.options ?? [])
        .filter((o) => o.required || o.optional || o.variadic)
        .flatMap((o) => [o.short, o.long])
        .filter((f) => typeof f === 'string' && f.startsWith('-')),
    );
  const visit = (c, id, parentId) => {
    const own = id || `(root)`;
    commandTree.set(own, {
      id,
      parent: parentId,
      flags: flagsOf(c),
      valueFlags: valueFlagsOf(c),
      aliases: new Set(c.aliases?.() ?? []),
      children: new Set((c.commands ?? []).map((s) => s.name())),
      takesArgs: (c.registeredArguments ?? c._args ?? []).length > 0,
    });
    for (const sub of c.commands ?? []) visit(sub, id ? `${id} ${sub.name()}` : sub.name(), own);
  };
  visit(program, '', '');
  for (const [, node] of commandTree) {
    if (node.id && node.parent === '') node.parent = '(root)';
  }
  // Program-level options are valid on EVERY command (`nuvira plugins list --debug`),
  // so the allow-list has to start from the root's own flags, not a hardcoded pair.
  for (const f of commandTree.get('(root)')?.flags ?? []) GLOBAL_FLAGS.add(f);
  for (const f of commandTree.get('(root)')?.valueFlags ?? []) GLOBAL_VALUE_FLAGS.add(f);

  const count = (c, pre) => {
    let n = pre ? 1 : 0;
    for (const s of c.commands ?? []) n += count(s, `${pre} ${c.name()}`);
    return n;
  };
  cliCommandCount = count(program, '');
  const tools = await import(join(repoRoot, 'dist', 'tools', 'registry.js'));
  toolCount = tools.listTools().length;
} catch {
  /* dist/ not built — the CLI/tool/command rules are skipped below */
}

const MEASURED = {
  sourceFiles: srcTs.length,
  repoFiles: repoFiles.length,
  // Every `.ts`/`.tsx` the repository ships, tests included — the number the
  // cover and the closing chapter quote as the size of the codebase.
  tsFiles: repoFiles.filter((p) => /\.tsx?$/.test(p)).length,
  testFiles: repoFiles.filter((p) => /\.test\.(ts|tsx)$/.test(p)).length,
  providers: uniq([...providerCatalog.matchAll(/^\s{4}id: '([a-z0-9_-]+)'/gm)].map((m) => m[1])).length,
  agentTypes: uniq([...moduleRegistry.matchAll(/registry\.register\('([a-z-]+)'/g)].map((m) => m[1])).length,
  platforms: platforms.filter((p) => p !== 'mock').length,
  dashboardDestinations: uniq([...navModel.matchAll(/path: '([^']+)'/g)].map((m) => m[1])).length,
  apiEndpoints: apiEndpointCount,
  skills: skillCount,
  mcpCapabilities: uniq([...mcpCatalog.matchAll(/^\s{2}\{\s*$/gm)].map(() => 'x')).length ||
    uniq([...mcpCatalog.matchAll(/\bid: '([a-z0-9_.-]+)'/g)].map((m) => m[1])).length,
  toolCount,
  cliCommands: cliCommandCount,
  orchestratorLines: lineCount('src/agents/orchestrator.ts'),
  serverLines: lineCount('src/web-dashboard/server.ts'),
  dirAgents: dirFiles('src/agents'),
  dirLearning: dirFiles('src/learning'),
};

/** `true` when the claim's number disagrees with what the tree says. */
const num = (s) => Number(String(s).replace(/,/g, ''));

const CLAIM_RULES = [
  // NOTE: every number-first rule requires a LEADING DIGIT (`\d[\d,]*`, not
  // `[\d,]+`). With the older form a bare comma in prose satisfied the pattern —
  // "keys, providers, models" matched \b(,) providers and reported a stale
  // count for a sentence that states no count at all.
  { truth: MEASURED.testFiles, re: /\b(\d[\d,]*) test files\b/g },
  { truth: MEASURED.tsFiles, re: /\b(\d[\d,]*)-file TypeScript codebase\b/g },
  { truth: MEASURED.providers, re: /\b(\d[\d,]*) providers\b/g },
  { truth: MEASURED.agentTypes, re: /\b(\d[\d,]*) (?:specialist )?agents\b/g },
  { truth: MEASURED.agentTypes, re: /\b(\d[\d,]*) agent (?:types|roles)\b/g },
  { truth: MEASURED.platforms, re: /\b(\d[\d,]*) (?:messaging )?platforms\b/g },
  { truth: MEASURED.dashboardDestinations, re: /\b(\d[\d,]*) (?:dashboard )?(?:destinations|pages)\b/g },
  { truth: MEASURED.apiEndpoints, re: /\b(\d[\d,]*) API endpoints\b/g },
  { truth: MEASURED.skills, re: /\b(\d[\d,]*) SKILLS?\b/g },
  // Only a count that STARTS with a digit is a claim (`0 tools` describes a
  // server that exposes nothing, not a registry size).
  { truth: MEASURED.toolCount, re: /\b(\d[\d,]*)\+? (?:registered )?tools\b/g, skipZero: true },
  { truth: MEASURED.orchestratorLines, re: /orchestrator\.ts[^)\n]*?\(([\d,]+)\+? lines\)/g },
  { truth: MEASURED.orchestratorLines, re: /ORCHESTRATOR \(([\d,]+)\+? lines\)/g },
  { truth: MEASURED.orchestratorLines, re: /Orchestrator in Agent-Nuvira is ([\d,]+)\+? lines/g },
  { truth: MEASURED.serverLines, re: /server\.ts[^)\n]*?\(([\d,]+)\+? lines\)/g },
  { truth: MEASURED.dirAgents, re: /agents\/[^)\n]{0,40}?\(([\d,]+)\+? files\)/g },
  { truth: MEASURED.dirLearning, re: /learning\/[^)\n]{0,60}?\(([\d,]+)\+? files\)/g },
];

/**
 * Counts that are deliberately NOT about this repository. Each entry is a
 * sentence pattern; a match inside it is skipped. Add here only when the text
 * plainly describes a hypothetical, never to silence a real drift.
 */
const CLAIM_CONTEXT_EXCEPTIONS = [
  // Chapter 45 contrasts tools with skills: "A system with 50 tools would
  // overwhelm the LLM. A system with 50 skills only loads 2-3 per request." — a
  // hypothetical system, not the tool count of this one.
  /A system with [\d,]+\+? (?:tools|skills)/,
];

// Claims are scanned on STRIPPED text, so a count the book emphasises
// (`<strong>512</strong> test files`) is still seen, and it is scanned per region
// so a defect names the chapter that carries it.
const regions = [
  ...(marks.length ? [{ id: '(front matter)', text: strip(html.slice(0, marks[0].at)) }] : []),
  ...chapters.map((c) => ({ id: c.id, text: strip(c.body) })),
];

for (const { id, text } of regions) {
  for (const rule of CLAIM_RULES) {
    if (!rule.truth) continue; // unmeasured (no dist build, or no such surface)
    for (const m of text.matchAll(rule.re)) {
      if (num(m[1]) === rule.truth) continue;
      if (rule.skipZero && num(m[1]) === 0) continue;
      const window = text.slice(Math.max(0, m.index - 200), m.index + m[0].length + 60);
      if (CLAIM_CONTEXT_EXCEPTIONS.some((re) => re.test(window))) continue;
      add(
        id,
        'stale-number',
        `"${m[0].replace(/\s+/g, ' ')}" — measured ${rule.truth.toLocaleString('en-US')}`,
      );
    }
  }
  // The CLI count is only claimed in two places: the cover's `<N> CLI commands`
  // and the generated chapter's `<N> commands across <M> top-level groups`. A
  // bare "13 commands" (the VS Code addon) or "22 commands" (anything else) is
  // not a claim about the CLI surface.
  for (const m of text.matchAll(/\b(\d[\d,]*) CLI commands\b/g)) {
    if (!cliCommandCount || num(m[1]) === cliCommandCount) continue;
    add(id, 'stale-number', `"${m[0]}" — measured ${cliCommandCount}`);
  }
  for (const m of text.matchAll(/\b(\d[\d,]*) commands across /g)) {
    if (!cliCommandCount || num(m[1]) === cliCommandCount) continue;
    add(id, 'stale-number', `"${m[0].trim()}" — measured ${cliCommandCount}`);
  }
  // Appendices are `<div class="chapter" id="appendixA">` too — counting them
  // made the cover's "73 Chapters" look wrong by four.
  const liveChapters = chapters.filter((c) => !/^orig/.test(c.id) && !/^appendix/i.test(c.id)).length;
  for (const m of text.matchAll(/\b(\d[\d,]*) Chapters\b/g)) {
    if (num(m[1]) === liveChapters) continue;
    add(id, 'stale-number', `"${m[0]}" — measured ${liveChapters}`);
  }
}

// ── 5. command, flag and environment-variable claims ─────────────────────────
// A chapter that teaches `nuvira models unblock <provider>` is making a promise
// the CLI either keeps or does not. Every invocation is resolved against the
// LIVE command tree, and every `NUVIRA_*` key against the sources that read it.

const ENV_KNOWN = (() => {
  const words = new Set(sourceWords);
  for (const w of read('.env.example').match(/[A-Z][A-Z0-9_]{2,}/g) ?? []) words.add(w);
  return words;
})();

const GLOBAL_FLAGS = new Set(['--help', '-h', '--version', '-V', '--']);
/** Global flags that consume the next token (added from the root command tree). */
const GLOBAL_VALUE_FLAGS = new Set();

function scanCommands(id, text) {
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim();
    // Cheat-sheet rows put a description in a second column (`nuvira admin   <2+
    // spaces>   governance policy, RBAC roles`) and bash examples put one after
    // a `#`. Both are prose ABOUT the command, so only the command is scanned.
    if (/(^|\s)#/.test(line)) line = line.slice(0, line.search(/(^|\s)#/));
    const parts = line.split(/\s{2,}/);
    line = parts[0].replace(/^[\s$>]+/, '').trim();
    const m = /^(?:\$\s+)?nuvira\s+(.+)$/.exec(line);
    if (!m) continue;
    const tokens = m[1].match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
    if (!tokens.length) continue;
    if (tokens[0].startsWith('-')) continue; // `nuvira --help` — a global form
    if (/^[<[{(]/.test(tokens[0])) continue; // `nuvira <command>` — a placeholder

    let nodeKey = '(root)';
    let matched = 0;
    for (const t of tokens) {
      if (t.startsWith('-')) break;
      const node = commandTree.get(nodeKey);
      if (node?.children.has(t)) {
        nodeKey = node.id ? `${node.id} ${t}` : t;
        matched++;
        continue;
      }
      break;
    }

    const node = commandTree.get(nodeKey);
    const next = tokens[matched];
    if (!matched) {
      add(id, 'unknown-command', `${'nuvira'} ${tokens[0]} — no such command`);
      continue;
    }
    // A LONE lowercase word after a command that takes no positional arguments
    // is a typo, not an argument: `nuvira models list` (there is no `list` under
    // `models`) or `nuvira model watch` (the real path is `models watch`). A
    // command WITH arguments (`gateway send <target> <text>`) takes one next, and
    // a word followed by more words is prose about the command, not a path.
    // Only tokens BEFORE the first flag can be a mistyped subcommand — after a
    // flag they are its value (`bedrock test --region us-east-1`).
    const afterPath = tokens.slice(matched);
    const firstFlag = afterPath.findIndex((t) => t.startsWith('-'));
    const trailing = (firstFlag === -1 ? afterPath : afterPath.slice(0, firstFlag)).filter(
      (t) => !t.startsWith('-'),
    );
    if (
      trailing.length === 1 &&
      /^[a-z][a-z0-9-]*$/.test(trailing[0]) &&
      !node?.takesArgs &&
      !node?.children.has(trailing[0])
    ) {
      add(
        id,
        'unknown-subcommand',
        `nuvira ${node.id} ${trailing[0]} — ${node.id} has no '${trailing[0]}'`,
      );
    }

    const chain = [];
    for (let k = nodeKey; k; k = commandTree.get(k)?.parent) chain.push(k);
    const allowed = new Set([...GLOBAL_FLAGS]);
    const valueFlags = new Set([...GLOBAL_VALUE_FLAGS]);
    for (const k of chain) {
      for (const f of commandTree.get(k)?.flags ?? []) allowed.add(f);
      for (const f of commandTree.get(k)?.valueFlags ?? []) valueFlags.add(f);
    }
    let prev = null;
    for (const t of tokens.slice(matched)) {
      // `--arg --stdio` / `--env K=V`: this token is a flag's VALUE, not a flag.
      if (prev !== null && valueFlags.has(prev)) {
        prev = t;
        continue;
      }
      if (!/^--[a-zA-Z][\w-]*$/.test(t)) {
        prev = t;
        continue;
      }
      if (allowed.has(t)) {
        prev = t;
        continue;
      }
      add(id, 'unknown-flag', `nuvira ${node.id} ${t} — not a flag of that command`);
      prev = t;
    }
  }
}

// Commands are scanned only where the book PRESENTS one — inside a `<code>`
// element or a `<pre><code>` block. Scanning prose and tables produced false
// positives such as `nuvira admin governance` out of a two-column table whose
// second cell happened to start with the word "governance".
//
// CONVENTION: `<code class="wrong">` is NOT a bare `<code>`, so the regex below
// skips it by construction. That tag means "shown here because it is WRONG" — the
// book cites `nuvira models list` only to say the form never existed, and a
// checker that insisted the citation resolve would force the correction to be
// deleted to go green. The convention is not a loophole: every marked span is
// verified separately below, and one that DOES resolve is reported as a defect.
for (const [id, body] of [
  ['(front matter)', html.slice(0, marks.length ? marks[0].at : 0)],
  ...chapters.map((c) => [c.id, c.body]),
]) {
  if (!commandTree.size) continue;
  const codeText = [...body.matchAll(/<code>([\s\S]*?)<\/code>/g)]
    .map((m) => strip(m[1]))
    .join('\n');
  scanCommands(id, codeText);
}

// The other half of that convention: a span the book labels wrong must actually
// be wrong TODAY. If it resolves, the correction has gone stale (`models list`
// being added for real would mean the book is now lying) — so the mark cannot be
// used to smuggle a claim past the audit.
for (const [id, body] of [...chapters.map((c) => [c.id, c.body])]) {
  if (!commandTree.size) continue;
  for (const m of body.matchAll(/<code class="wrong"[^>]*>([\s\S]*?)<\/code>/g)) {
    const text = strip(m[1]);
    // Only a full command line can be cross-checked. A bare flag (`--skill`) is
    // cited as a fragment, and there is nothing to resolve it against.
    if (!/^\s*nuvira\b/.test(text)) continue;
    const before = defects.length;
    scanCommands('(wrong-marked)', text);
    const unexpected = defects.length > before;
    defects.length = before; // expected here: the surrounding text says so
    if (!unexpected) {
      add(
        id,
        'mislabeled-wrong',
        `${text.trim()} — marked as wrong, but it resolves against the live CLI today`,
      );
    }
  }
}

/**
 * Keys the book NAMES ONLY TO DENY. This is not a loophole: the old Part III
 * taught `process.env.BUFF_HOME || join(homedir(), '.nuvira')`, which no source
 * ever read, so the corrected chapter says in prose that no such variable
 * exists. Keeping the name here — one entry, with the reason on the line — is
 * how the book can warn a reader who remembers the old claim, while every
 * OTHER key in the book is still checked against the sources that read it.
 */
const ENV_NAMED_TO_DENY = new Set(['BUFF_HOME']);

for (const { id, text } of regions) {
  for (const m of text.matchAll(/\b(NUVIRA_[A-Z0-9_]+|BUFF_[A-Z0-9_]+)\b/g)) {
    if (ENV_KNOWN.has(m[1])) continue;
    if (ENV_NAMED_TO_DENY.has(m[1])) continue;
    add(id, 'unknown-env-var', `${m[1]} — no source reads this key`);
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const byKind = defects.reduce((acc, d) => ((acc[d.kind] = (acc[d.kind] ?? 0) + 1), acc), {});

if (JSON_OUT) {
  console.log(JSON.stringify({ book: BOOK, total: defects.length, byKind, defects }, null, 2));
  process.exit(defects.length ? 1 : 0);
}

console.log(`Book: ${BOOK}`);
console.log(`Source index: ${sourceFiles.length} files, ${sourceWords.size} distinct identifiers\n`);
const byChapter = new Map();
for (const d of defects) {
  if (!byChapter.has(d.chapter)) byChapter.set(d.chapter, []);
  byChapter.get(d.chapter).push(d);
}
if (!defects.length) {
  console.log('✓ no unsupported code claims found.');
} else {
  for (const [chapter, list] of [...byChapter.entries()]) {
    console.log(`  ${chapter} — ${list[0].title}`);
    for (const d of list) console.log(`      [${d.kind}] ${d.detail}`);
    console.log('');
  }
  console.log(`Total: ${defects.length}  (${Object.entries(byKind).map(([k, v]) => `${k}: ${v}`).join(', ')})`);
}
process.exit(defects.length ? 1 : 0);
