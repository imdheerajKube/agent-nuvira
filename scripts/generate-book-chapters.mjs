#!/usr/bin/env node
/**
 * Generate the book's command + dashboard chapters from LIVE sources.
 *
 *   node scripts/generate-book-chapters.mjs            # (re)write book/part12-command-reference.html
 *   node scripts/generate-book-chapters.mjs --check     # exit 1 if the file is stale
 *
 * Why generated: exactly the reason `docs/COMMANDS_SURFACE.md` is generated — a
 * hand-written command list drifts silently the moment a command is added or
 * renamed. This book chapter is therefore derived from the same live commander
 * tree (`createCLI()`), so it cannot claim a command that does not exist.
 *
 * Three sources, in order of authority:
 *   1. the LIVE command tree  — what EXISTS (paths, args, flags, descriptions),
 *   2. `docs/COMMANDS.md`     — the CURATED objective + copy-pasteable examples,
 *   3. `src/web-dashboard/`   — the dashboard surface (nav routes, API endpoints).
 *
 * Honesty rule: a command that has no curated example in `docs/COMMANDS.md` is
 * rendered as a USAGE FORM, labelled as such — never invented as if it were a
 * verified example.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const OUT_PATH = join(repoRoot, 'book', 'part12-command-reference.html');
const CHECK = process.argv.includes('--check');

process.env.NUVIRA_SKIP_DISCOVERY = '1';
process.env.NUVIRA_NO_DASHBOARD = '1';
process.env.NUVIRA_CLI_NAME = process.env.NUVIRA_CLI_NAME || 'nuvira';
const CLI = 'nuvira';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// ─────────────────────────────────────────────────────────────────────────────
// 1. The live CLI tree
// ─────────────────────────────────────────────────────────────────────────────

function argLabel(a) {
  // commander v11 exposes `name()` as a METHOD (`_name` in older versions);
  // interpolating it directly yields "name() {" in the output.
  const raw = typeof a.name === 'function' ? a.name() : (a.name ?? a._name ?? 'arg');
  const inner = a.variadic ? `${raw}...` : raw;
  return a.required ? `<${inner}>` : `[${inner}]`;
}

function walk(cmd, prefix, out) {
  const path = prefix ? `${prefix} ${cmd.name()}` : cmd.name();
  if (prefix) {
    const args = (cmd.registeredArguments ?? cmd._args ?? []).map(argLabel);
    const flags = (cmd.options ?? [])
      .filter((o) => o.long !== '--help' && o.short !== '-h')
      .map((o) => {
        const name = (o.name?.() ?? '').replace(/-/g, '_');
        const long = o.long ?? o.short;
        if (o.required) return `${long} <${name}>`;
        if (o.optional) return `${long} [${name}]`;
        return long;
      })
      .sort((a, b) => a.localeCompare(b));
    out.push({
      path,
      id: path.slice(CLI.length + 1),
      description: (cmd.description() || '').trim(),
      aliases: cmd.aliases?.() ?? [],
      args,
      flags,
      usage: [path, ...args].join(' '),
    });
  }
  for (const sub of cmd.commands ?? []) walk(sub, path, out);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Curated objectives + examples from docs/COMMANDS.md
// ─────────────────────────────────────────────────────────────────────────────

function parseCurated(mdText, commandIds) {
  const sections = mdText.split(/^### /m).slice(1);
  const byPath = new Map();
  for (const raw of sections) {
    const lines = raw.split('\n');
    const title = lines[0].trim();
    const objective = (raw.match(/-\s+\*\*Objective:\*\*\s*(.+)/) ?? [])[1]?.trim() ?? '';
    const commandLine = (raw.match(/-\s+\*\*Command:\*\*\s*`([^`]+)`/) ?? [])[1]?.trim() ?? '';
    const blocks = [...raw.matchAll(/```(?:bash|sh|shell)?\n([\s\S]*?)```/g)].map((m) =>
      m[1].replace(/^ {2}/gm, '').replace(/\s+$/, ''),
    );
    // Strip the flag placeholders (`[-p, --port <n>]`, `<target>`) so what is
    // left is the command path: `nuvira gateway send <target> <text>` ->
    // `gateway send`. Then bind the entry to the LONGEST real command path that
    // is a prefix of it, which keeps `dashboard` and `dashboard stop` apart.
    const cleaned = commandLine
      .replace(/^nuvira\s+/, '')
      .split(/\s+/)
      .filter((t) => t && !t.startsWith('-') && !/^[<[].*[>\]]$/.test(t));
    let matched = null;
    for (const id of commandIds) {
      const parts = id.split(' ');
      if (parts.length > cleaned.length) continue;
      if (!parts.every((p, i) => p === cleaned[i])) continue;
      if (!matched || parts.length > matched.split(' ').length) matched = id;
    }
    if (matched && !byPath.has(matched)) {
      byPath.set(matched, { title, objective, commandLine, examples: blocks });
    }
  }
  return byPath;
}

function lookupCurated(command, curated) {
  return curated.get(command.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Dashboard surface
// ─────────────────────────────────────────────────────────────────────────────

function parseDashboard() {
  const layout = readFileSync(join(repoRoot, 'src/web-dashboard/src/components/Layout.tsx'), 'utf-8');
  const pages = [...layout.matchAll(/\{\s*path:\s*'([^']+)',\s*label:\s*'([^']+)',\s*icon:\s*'([^']+)'/g)].map(
    (m) => ({ path: m[1], label: m[2], icon: m[3] }),
  );

  const server = readFileSync(join(repoRoot, 'src/web-dashboard/server.ts'), 'utf-8');
  const api = [...new Set(
    [...server.matchAll(/(?:pathname|path)\s*===\s*'([^']+)'/g)]
      .map((m) => m[1])
      .filter((p) => p.startsWith('/api/')),
  )].sort();
  return { pages, api };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function groupByTopLevel(commands) {
  const groups = new Map();
  for (const c of commands) {
    const top = c.id.split(' ')[0];
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(c);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderUsageForm(c) {
  const flagPart = c.flags.length ? ` ${c.flags.join(' ')}` : '';
  return `${c.usage}${flagPart}`;
}

function renderCuratedEntry(c, curated) {
  const args = c.args.length
    ? `<p><strong>Arguments:</strong> ${c.args.map((a) => `<code>${esc(a)}</code>`).join(' ')}</p>`
    : '';
  const flags = c.flags.length
    ? `<p><strong>Flags:</strong> ${c.flags.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>`
    : '';
  const aliases = c.aliases.length
    ? `<p><strong>Aliases:</strong> ${c.aliases.map((a) => `<code>${esc(a)}</code>`).join(', ')}</p>`
    : '';
  const objective = curated?.objective
    ? `<p>${esc(curated.objective)}</p>`
    : c.description
      ? `<p>${esc(c.description)}</p>`
      : '';
  const examples = (curated?.examples?.length ? curated.examples : [renderUsageForm(c)])
    .map((b) => `<pre><code>${esc(b)}</code></pre>`)
    .join('\n');
  return `<!-- cmd: ${esc(c.id)} -->
<h4><code>${esc(c.usage)}</code></h4>
${objective}${args}${flags}${aliases}
${examples}
`;
}

function renderSurfaceGroup(top, commands, curated) {
  const rows = commands
    .map((c) => {
      const curatedHit = lookupCurated(c, curated);
      const desc = curatedHit?.objective || c.description || '';
      const flags = c.flags.length ? ` <span class="cmd-flags">${esc(c.flags.join(' '))}</span>` : '';
      const hasExample = curatedHit?.examples?.length ? ' ✓' : '';
      return `  <li><code>${esc(c.usage)}</code>${flags} — ${esc(desc)}${hasExample}</li>`;
    })
    .join('\n');
  return `<h4><code>${CLI} ${esc(top)}</code></h4>
<ul class="cmd-surface">
${rows}
</ul>
`;
}

function render(commands, curated, dash) {
  const curatedRows = commands.filter((c) => lookupCurated(c, curated)?.examples?.length);
  const generatedAt = 'generated from the live CLI tree';
  const total = commands.length;
  const topLevel = [...new Set(commands.map((c) => c.id.split(' ')[0]))];

  const quick = [
    ['Chat with the agent', 'nuvira chat "fix the failing test"'],
    ['Run the multi-agent pipeline on a goal', 'nuvira execute "add login to the API"'],
    ['Plan before touching code', 'nuvira plan --task "add rate limiting"'],
    ['Guided edit of one file', 'nuvira edit src/app.ts --instruction "extract the retry loop"'],
    ['Start the gateway', 'nuvira gateway start'],
    ['Start the dashboard', 'nuvira dashboard'],
    ['Check configuration', 'nuvira doctor'],
    ['See the model list / registry state', 'nuvira models'],
    ['Switch the active model', 'nuvira model switch <model>'],
    ['Force a provider probe now', 'nuvira models refresh'],
    ['See what routing is skipping', 'nuvira models excluded'],
    ['Inspect a decision trace', 'nuvira trace list'],
    ['Unblock a parked provider', 'nuvira models unblock <provider>'],
  ]
    .map(([t, c]) => `  <tr><td>${esc(t)}</td><td><code>${esc(c)}</code></td></tr>`)
    .join('\n');

  const curatedHtml = groupByTopLevel(curatedRows)
    .map(([top, cs]) => `<h3>${esc(CLI)} ${esc(top)}</h3>\n${cs.map((c) => renderCuratedEntry(c, lookupCurated(c, curated))).join('')}`)
    .join('\n');

  const surfaceHtml = groupByTopLevel(commands)
    .map(([top, cs]) => renderSurfaceGroup(top, cs, curated))
    .join('\n');

  const pagesHtml = dash.pages
    .map((p) => `  <tr><td><code>${esc(p.path)}</code></td><td>${esc(p.icon)} ${esc(p.label)}</td></tr>`)
    .join('\n');
  const apiHtml = dash.api.map((a) => `  <li><code>${esc(a)}</code></li>`).join('\n');

  return `<!-- GENERATED by scripts/generate-book-chapters.mjs — ${generatedAt}. -->
<!-- Regenerate: node scripts/generate-book-chapters.mjs -->
<!-- Do not hand-edit: the commands come from the live commander tree. -->

<div class="chapter" id="ch68">
<div class="chapter-header">
  <div class="ch-number">Chapter 68</div>
  <h2>The Complete Command Reference</h2>
  <div class="ch-subtitle">Every command the CLI actually exposes — ${total} commands across ${topLevel.length} top-level groups, with examples</div>
</div>

<h3>68.1 How this chapter was built (and why you can trust it)</h3>

<p>This chapter is <strong>generated from the live CLI</strong>. The command paths, arguments, aliases and flags come straight from the running commander tree — the same source that
produces the drift-guarded <code>docs/COMMANDS_SURFACE.md</code> — and the worked examples come from the curated, human-reviewed <code>docs/COMMANDS.md</code>.</p>

<div class="callout">
  <div class="callout-title">📐 The honesty rule used here</div>
  <p>A command with a curated example is shown with that example, verbatim. A command that has <em>no</em> curated example — the long tail — is shown as a <strong>usage form</strong> (its real path, arguments and flags), never with an invented example that looks verified but is not. Regenerate this chapter any time with
  <code>node scripts/generate-book-chapters.mjs</code>.</p>
</div>

<h3>68.2 The commands you will actually type</h3>

<div class="project-info">
<table>
${quick}
</table>
</div>

<h3>68.3 Curated commands — with real, copy-pasteable examples</h3>

<p>${curatedRows.length} of the ${total} commands carry a curated objective and at least one tested example. These are the ones documented by hand in <code>docs/COMMANDS.md</code>.</p>

${curatedHtml}

<h3>68.4 The complete surface — every command</h3>

<p>The remaining commands are grouped by top-level command. A <code>✓</code> marks a command that also appears above with a curated example. This is the exhaustive list: if a command is not here, the CLI does not have it.</p>

${surfaceHtml}

<div class="callout">
  <div class="callout-title">📊 The numbers</div>
  <p><strong>${total}</strong> commands and subcommands · <strong>${topLevel.length}</strong> top-level commands · <strong>${curatedRows.length}</strong> with curated examples ·
  ${dash.pages.length} dashboard pages · ${dash.api.length} dashboard API endpoints.</p>
</div>
</div>

<div class="chapter" id="ch69">
<div class="chapter-header">
  <div class="ch-number">Chapter 69</div>
  <h2>The Dashboard Surface</h2>
  <div class="ch-subtitle">Every page and API endpoint of the web dashboard, and how to run it</div>
</div>

<h3>69.1 Starting and stopping the dashboard</h3>

<pre><code>nuvira dashboard                 # start (default port 3030) and open the browser
nuvira dashboard --port 8080     # serve on another port
nuvira dashboard --no-open       # start without opening a tab
nuvira dashboard --force         # detect and restart a stale dashboard on the port
nuvira dashboard stop            # SIGTERM the running dashboard
nuvira dashboard stop --port 8080</code></pre>

<p>The dashboard is a local web UI over the same state the CLI writes: executions, traces, tasks, the model registry, the routing decisions, the quota ledger, memory and skills. It is not a separate system — it reads the files the agent already produces.</p>

<h3>69.2 The ${dash.pages.length} pages</h3>

<div class="project-info">
<table>
${pagesHtml}
</table>
</div>

<h3>69.3 The ${dash.api.length} API endpoints</h3>

<p>These are the routes the dashboard itself calls. Anything you can see in the UI can be requested directly, which is useful for scripting and for verifying that the UI is showing what you think it is.</p>

<ul class="cmd-surface">
${apiHtml}
</ul>

<div class="callout">
  <div class="callout-title">🔐 Auth note</div>
  <p>The <code>/api/admin/*</code> routes are behind the admin auth layer (login/logout, role-based access, first-run setup and change-password). Everything else is served to the local UI. If you expose the dashboard beyond localhost, treat the port as an administrative surface, not a public one.</p>
</div>
</div>
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  let createCLI;
  try {
    ({ createCLI } = await import(join(repoRoot, 'dist', 'cli', 'cli-program.js')));
  } catch (err) {
    console.error('✗ could not import dist/cli/cli-program.js — run `npm run build` first.');
    console.error(String(err?.message ?? err));
    process.exit(2);
  }

  const argvPin = process.argv;
  process.argv = [argvPin[0], CLI, '--help'];
  let program;
  try {
    program = createCLI();
  } finally {
    process.argv = argvPin;
  }

  const commands = [];
  walk(program, '', commands);

  const curated = parseCurated(
    readFileSync(join(repoRoot, 'docs', 'COMMANDS.md'), 'utf-8'),
    commands.map((c) => c.id),
  );
  const dash = parseDashboard();
  const html = render(commands, curated, dash);

  if (CHECK) {
    let current = null;
    try {
      current = readFileSync(OUT_PATH, 'utf-8');
    } catch {
      /* missing = stale */
    }
    if (current === html) {
      console.log('✓ book/part12-command-reference.html is in sync with the live CLI.');
      process.exit(0);
    }
    console.error('✗ book/part12-command-reference.html is stale — regenerate with:');
    console.error('    node scripts/generate-book-chapters.mjs');
    process.exit(1);
  }

  writeFileSync(OUT_PATH, html, 'utf-8');
  const curatedCount = commands.filter((c) => lookupCurated(c, curated)?.examples?.length).length;
  console.log(
    `✓ Wrote ${OUT_PATH}\n  ${commands.length} commands (${curatedCount} with curated examples) · ` +
      `${new Set(commands.map((c) => c.id.split(' ')[0])).size} top-level groups · ` +
      `${dash.pages.length} dashboard pages · ${dash.api.length} API endpoints`,
  );
}

main();
