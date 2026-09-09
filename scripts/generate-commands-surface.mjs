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

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const DOC_PATH = join(repoRoot, 'docs', 'COMMANDS_SURFACE.md');
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
<!-- Source of truth: src/cli/router.ts (createCLI) — generated from the live commander tree. -->

# CLI Command Surface

Every command, subcommand, alias, and flag the CLI exposes, derived from the
live command tree (not maintained by hand). For task-oriented, copy-pasteable
usage see the curated [COMMANDS.md](./COMMANDS.md).

`;

/** Recursively walk a commander command node into renderable rows. */
function walk(cmd, prefix, rows) {
  const name = prefix === '' ? cmd.name() : `${prefix} ${cmd.name()}`;
  const aliases = cmd.aliases().length > 0 ? ` (aliases: ${cmd.aliases().map((a) => `\`${a}\``).join(', ')})` : '';
  const description = (cmd.description() || '').trim();
  rows.push({ name, aliases, description });

  // Options per command, sorted for determinism (commander's implicit help
  // option excluded — it exists on every command and adds noise).
  const opts = (cmd.options ?? [])
    .filter((o) => o.long !== '--help' && o.short !== '-h')
    .map((o) => `${o.long ?? o.short}${o.required ? ` <${(o.name() || '').replace(/-/g, '_')}>` : ''}${o.optional ? ` [${(o.name() || '').replace(/-/g, '_')}]` : ''}`)
    .sort((a, b) => a.localeCompare(b));
  if (opts.length > 0) rows.push({ optionLine: opts.join(', '), name });

  for (const sub of cmd.commands ?? []) {
    walk(sub, name, rows);
  }
}

function renderDoc(program) {
  const rows = [];
  walk(program, '', rows);

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
    ({ createCLI } = await import(join(repoRoot, 'dist', 'cli', 'router.js')));
  } catch (err) {
    console.error('✗ could not import dist/cli/router.js — run `npm run build` first.');
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

  if (CHECK) {
    let current;
    try {
      current = readFileSync(DOC_PATH, 'utf-8');
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
  const commandCount = (doc.match(/^### /gm) ?? []).length;
  console.log(`✓ Wrote ${DOC_PATH} (${commandCount} command sections).`);
}

main();
