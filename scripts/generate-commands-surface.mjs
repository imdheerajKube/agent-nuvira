#!/usr/bin/env node
/**
 * Generate `docs/COMMANDS_SURFACE.md` from the LIVE commander tree.
 *
 * Why: `docs/COMMANDS.md` is curated prose (objective / command / example per
 * entry) — valuable for humans, but it drifts silently when commands are
 * added or renamed (observed: the v1.74.x footer drift lived for five minor
 * releases). This generator produces the authoritative, machine-derived
 * surface straight from `createCLI()` — every top-level command, subcommand
 * path, alias, and description — and is committed next to the curated doc:
 *
 *   - `node scripts/generate-commands-surface.mjs`            (re)writes the doc
 *   - `node scripts/generate-commands-surface.mjs --check`    CI drift guard:
 *       exit 0 when the committed doc matches the live tree, exit 1 with a
 *       diff hint when a command was added/renamed/documented without
 *       regenerating.
 *
 * Deterministic by construction: the tree is walked in registration order,
 * options are rendered sorted, and the output has no timestamps — so an
 * unchanged CLI produces a byte-identical doc (the drift guard's premise).
 *
 * Safety: importing `dist/cli/router.js` must not start servers, daemons, or
 * discovery loops. The module-level side effects in the entry chain are
 * gated behind env pins (`NUVIRA_SKIP_DISCOVERY`, `NUVIRA_NO_DASHBOARD`)
 * — if a future import regresses into spawning work, this script's process
 * would hang and the test/CI timeout fails loudly instead of writing docs.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const DOC_PATH = join(repoRoot, 'docs', 'COMMANDS_SURFACE.md');

/**
 * The same surface, as data, for the dashboard's Command Console picker.
 *
 * WHY A SECOND OUTPUT FROM ONE GENERATOR. The console lets a user browse
 * commands by group and insert one into the run box. Hand-typing those commands
 * into a component would create a second list that describes commands which no
 * longer exist — the exact drift this script exists to prevent, reintroduced in
 * the UI. Emitting from the live tree means the picker CANNOT offer a command
 * the CLI does not expose, and `--check` guards both outputs together.
 *
 * It lives inside the dashboard source so it is bundled: an installed package
 * then carries the catalogue, with no file to ship alongside it and no runtime
 * fetch that can 404.
 */
const CATALOG_PATH = join(repoRoot, 'src', 'web-dashboard', 'src', 'generated', 'commands.json');
const CHECK = process.argv.includes('--check');

// Guard rails: never let a doc-generation run kick off discovery or the
// dashboard, and pin the CLI name so help text renders as `buff` (the
// canonical binary name in docs).
process.env.NUVIRA_SKIP_DISCOVERY = '1';
process.env.NUVIRA_NO_DASHBOARD = '1';
process.env.NUVIRA_CLI_NAME = process.env.NUVIRA_CLI_NAME || 'buff';

const header = `<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate: node scripts/generate-commands-surface.mjs -->
<!-- Drift guard: node scripts/generate-commands-surface.mjs --check -->
<!-- Source of truth: src/cli/cli-program.ts (createCLI) — generated from the live commander tree. -->

# CLI Command Surface

Every command, subcommand, alias, and flag the CLI exposes, derived from the
live command tree (not maintained by hand). For task-oriented, copy-pasteable
usage see the curated [COMMANDS.md](./COMMANDS.md).

`;

/**
 * Recursively walk a commander command node into renderable rows.
 *
 * `entries` collects the same walk as structured data (path / description /
 * flags), so the doc and the dashboard catalogue are two renderings of ONE
 * traversal rather than two traversals that can disagree.
 */
function walk(cmd, prefix, rows, entries) {
  const name = prefix === '' ? cmd.name() : `${prefix} ${cmd.name()}`;
  const aliasList = cmd.aliases();
  const aliases = aliasList.length > 0 ? ` (aliases: ${aliasList.map((a) => `\`${a}\``).join(', ')})` : '';
  const description = (cmd.description() || '').trim();
  rows.push({ name, aliases, description });

  // Options per command, sorted for determinism (commander's implicit help
  // option excluded — it exists on every command and adds noise).
  const opts = (cmd.options ?? [])
    .filter((o) => o.long !== '--help' && o.short !== '-h')
    .map((o) => `${o.long ?? o.short}${o.required ? ` <${(o.name() || '').replace(/-/g, '_')}>` : ''}${o.optional ? ` [${(o.name() || '').replace(/-/g, '_')}]` : ''}`)
    .sort((a, b) => a.localeCompare(b));
  if (opts.length > 0) rows.push({ optionLine: opts.join(', '), name });

  entries.push({ path: name.split(' '), description, aliases: aliasList, flags: opts });

  for (const sub of cmd.commands ?? []) {
    walk(sub, name, rows, entries);
  }
}

/**
 * The catalogue the Command Console renders, grouped by top-level command.
 *
 * Grouped by the FIRST path token rather than by a curated category: that
 * grouping already exists in the CLI, it is what `--help` shows, and inventing
 * a second taxonomy would be one more thing to keep in sync. Deterministic by
 * construction (registration order, no timestamps) so `--check` can compare it.
 */
function renderCatalog(program) {
  const rows = [];
  const entries = [];
  walk(program, '', rows, entries);

  // path[0] is the PROGRAM (`nuvira`), not a command: the console runs the CLI
  // as `node dist/index.js <args>`, so what a user types omits that prefix
  // entirely. So the group is path[1] and a row's name is everything after the
  // program name — which is also why a freshly pasted name runs as-is.
  const ownRows = entries.filter((entry) => entry.path.length >= 2);

  const groups = [];
  const byName = new Map();
  for (const entry of ownRows) {
    const root = entry.path[1];
    let group = byName.get(root);
    if (!group) {
      // A group's blurb is its top-level command's description, so the picker
      // can label a group without a second table of prose to keep in sync.
      group = { name: root, description: entry.path.length === 2 ? entry.description : '', commands: [] };
      byName.set(root, group);
      groups.push(group);
    }
    // The top-level command is the group heading; only its children are rows.
    if (entry.path.length === 2) continue;
    group.commands.push({
      name: entry.path.slice(1).join(' '),
      description: entry.description,
      flags: entry.flags,
    });
  }

  const commandCount = ownRows.length - groups.length;
  const catalog = {
    source: 'src/cli/cli-program.ts (createCLI) — do not edit by hand',
    regenerate: 'node scripts/generate-commands-surface.mjs',
    prefixNote: 'Names omit the program name: the console runs `node dist/index.js <name>`.',
    commandCount,
    groupCount: groups.length,
    groups,
  };
  return JSON.stringify(catalog, null, 2) + '\n';
}

function renderDoc(program) {
  const rows = [];
  walk(program, '', rows, []);

  const lines = [header];
  let inOptions = false;
  for (const row of rows) {
    if (row.optionLine) {
      if (!inOptions) {
        lines.push(`   - flags: \`${row.optionLine}\``);
        inOptions = true;
      } else {
        lines.push(`   - flags: \`${row.optionLine}\``);
      }
      continue;
    }
    inOptions = false;
    lines.push(`### \`${row.name}\`${row.aliases}`);
    lines.push('');
    if (row.description) {
      lines.push(row.description);
      lines.push('');
    }
  }

  const commandCount = rows.filter((r) => r.name).length;
  lines.push('---');
  lines.push('');
  lines.push(`*${commandCount} commands (incl. subcommands) · generated from the live CLI — this file is the drift-guarded surface.*`);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  let createCLI;
  try {
    // createCLI lives in its own module since 2026-09-16: `router.ts` became a
    // pure provider-resolution service so the command dispatcher's ~35 command
    // imports no longer formed a 28-module import cycle with it.
    // pathToFileURL: a bare Windows path (`D:\\a\\...`) is not a valid ESM
    // specifier, so on the windows runner this import threw and the script
    // exited 2 ("could not import dist/cli/cli-program.js") even though the
    // build had run — which the drift guard then reported as a CLI drift.
    ({ createCLI } = await import(pathToFileURL(join(repoRoot, 'dist', 'cli', 'cli-program.js')).href));
  } catch (err) {
    console.error('✗ could not import dist/cli/cli-program.js — run `npm run build` first.');
    console.error(String(err?.message ?? err));
    process.exit(2);
  }

  // Pin argv so commander's implicit version/help parsing never sees this
  // script's own flags.
  const argvPin = process.argv;
  process.argv = [argvPin[0], 'buff', '--help'];
  let program;
  try {
    program = createCLI();
  } finally {
    process.argv = argvPin;
  }

  const doc = renderDoc(program);
  const catalog = renderCatalog(program);

  if (CHECK) {
    let catalogCurrent;
    try {
      catalogCurrent = readFileSync(CATALOG_PATH, 'utf-8').replace(/\r\n/g, '\n');
    } catch {
      console.error(`✗ ${CATALOG_PATH} missing — run: node scripts/generate-commands-surface.mjs`);
      process.exit(1);
    }
    if (catalogCurrent !== catalog) {
      console.error('✗ the dashboard command catalogue drifted from the live CLI tree.');
      console.error('  The Command Console picker would offer commands that do not exist.');
      console.error('  Fix: node scripts/generate-commands-surface.mjs && git add ' + CATALOG_PATH);
      process.exit(1);
    }

    let current;
    try {
      // Normalise CRLF. A Windows checkout (core.autocrlf=true, and there is no
      // .gitattributes pinning eol) reads this file with \r\n while the
      // generator builds with \n, so an exact comparison reported drift on every
      // Windows run for a doc that was in fact identical.
      current = readFileSync(DOC_PATH, 'utf-8').replace(/\r\n/g, '\n');
    } catch {
      console.error(`✗ ${DOC_PATH} missing — run: node scripts/generate-commands-surface.mjs`);
      process.exit(1);
    }
    if (current === doc) {
      console.log('✓ COMMANDS_SURFACE.md is in sync with the live CLI.');
      process.exit(0);
    }
    console.error('✗ COMMANDS_SURFACE.md drifted from the live CLI tree.');
    console.error('  A command/subcommand/flag was added, renamed, or removed without regenerating.');
    console.error('  Fix: node scripts/generate-commands-surface.mjs && git add docs/COMMANDS_SURFACE.md');
    process.exit(1);
  }

  writeFileSync(DOC_PATH, doc, 'utf-8');
  mkdirSync(dirname(CATALOG_PATH), { recursive: true });
  writeFileSync(CATALOG_PATH, catalog, 'utf-8');
  const commandCount = (doc.match(/^### /gm) ?? []).length;
  const catalogData = JSON.parse(catalog);
  console.log(`✓ Wrote ${DOC_PATH} (${commandCount} command sections).`);
  console.log(
    `✓ Wrote ${CATALOG_PATH} (${catalogData.commandCount} commands in ${catalogData.groupCount} groups).`,
  );
}

main();
