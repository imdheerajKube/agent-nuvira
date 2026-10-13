#!/usr/bin/env node
/**
 * Validate the `nuvira …` command lines written by hand in the user-facing docs.
 *
 * WHY THIS EXISTS (and why `docs:commands:check` does not cover it)
 * -----------------------------------------------------------------
 * Two different files document the CLI, and only one of them was checked:
 *
 *   docs/COMMANDS_SURFACE.md — GENERATED from the live command tree, guarded by
 *                              `npm run docs:commands:check`. It cannot drift.
 *   docs/COMMANDS.md         — the CURATED, hand-written half: the objective and
 *                              the copy-pasteable examples. Nothing validated it.
 *   docs/USER_MANUAL.md …    — hand-written too, same exposure.
 *
 * The cost was measured, not assumed. `docs/COMMANDS.md` shipped
 * `nuvira models list` (there is no `list` under `models` — the bare command
 * lists), `nuvira skills install acme/skills --skill release --yes` (there is no
 * `--skill` and no `--yes`; the form is `nuvira skills install <name>`), and the
 * user manual told readers to run `nuvira gateway run` — a command that has never
 * existed (`nuvira gateway start` runs the adapters in the foreground).
 *
 * The commands were also *verifiable* the whole time: `verify:commands` walks the
 * generated surface, so injecting a non-existent command into COMMANDS.md left it
 * passing. This script closes that hole by resolving each written command against
 * the live commander tree — the same tree the generated surface comes from.
 *
 * WHAT IT CHECKS
 *   1. The command path resolves (`nuvira models status`, not `nuvira models list`).
 *   2. A lone lowercase word after a command that takes no positional arguments is
 *      a mistyped subcommand, not an argument.
 *   3. Every long flag belongs to that command (or to the program: `--debug`).
 *      A flag that CONSUMES a value is honoured, so `--arg --stdio` passes the
 *      child process its own flag instead of being read as `mcp add --stdio`.
 *
 * WHAT IT DELIBERATELY SKIPS
 *   Planning and assessment documents (`PLAN_*`, `*_ASSESSMENT*`, `DESIGN_*`,
 *   `ASSESSMENT*`) describe commands that are PROPOSALS, not behaviour — e.g.
 *   `nuvira mcp import --from`, `nuvira models identity`. Holding them to the
 *   shipped tree would be false precision. Everything a user is told to TYPE is
 *   in scope.
 *
 *   Fences tagged ```text are also skipped. That tag means "this is not a shell":
 *   it is how a doc can SHOW a wrong form — `docs/USER_MANUAL.md` §13.3 keeps the
 *   `nuvira models list` / `nuvira gateway run` mistakes visible next to their
 *   replacements, and deleting them would lose the correction. A ```bash fence is
 *   an instruction and is always checked.
 *
 * Usage:  node scripts/check-docs-commands.mjs [--verbose]
 * Exit:   0 = every documented command resolves, 1 = at least one does not,
 *         2 = the built CLI is missing (run `npm run build:cli`).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
const distCli = join(repoRoot, 'dist', 'cli', 'cli-program.js');

if (!existsSync(distCli)) {
  console.error('✗ dist/cli/cli-program.js not found — run `npm run build:cli` first.');
  process.exit(2);
}

// The tree must be built the way the CLI builds it in production: the import
// happens AFTER process.argv is the help invocation it expects, and discovery is
// skipped so this never reaches for the developer's real MCP configs or profile.
process.env.NUVIRA_SKIP_DISCOVERY = '1';
process.env.NUVIRA_NO_DASHBOARD = '1';
const argv = process.argv;
process.argv = [argv[0], 'nuvira', '--help'];
const { createCLI } = await import(pathToFileURL(distCli).href);
const program = createCLI();
process.argv = argv;

/** A document that PROPOSES commands instead of shipping them is out of scope. */
const PROPOSAL_DOC = /^(PLAN_|DESIGN_|DESIGN-)|_ASSESSMENT|^ASSESSMENT|^AGENT_COMPASSESSMENT|-assessment/i;

const docs = readdirSync(join(repoRoot, 'docs'))
  .filter((f) => f.endsWith('.md'))
  .filter((f) => !PROPOSAL_DOC.test(f))
  .map((f) => join('docs', f));
// Top-level docs a user is expected to read.
for (const extra of ['README.md', 'SSH-SETUP.md']) {
  if (existsSync(join(repoRoot, extra))) docs.push(extra);
}

const tree = new Map();
/** The program itself is keyed '(root)' so `''` never has to mean two things. */
const nodeOf = (key) => tree.get(key || '(root)');
const visit = (c, id) => {
  tree.set(id || '(root)', {
    children: new Set((c.commands ?? []).map((s) => s.name())),
    aliases: new Set(c.aliases?.() ?? []),
    takesArgs: (c.registeredArguments ?? c._args ?? []).length > 0,
    flags: new Set((c.options ?? []).flatMap((o) => [o.short, o.long]).filter((f) => typeof f === 'string')),
    valueFlags: new Set(
      (c.options ?? [])
        .filter((o) => o.required || o.optional || o.variadic)
        .flatMap((o) => [o.short, o.long])
        .filter((f) => typeof f === 'string'),
    ),
  });
  for (const s of c.commands ?? []) visit(s, id ? `${id} ${s.name()}` : s.name());
};
visit(program, '');

const root = tree.get('(root)');
const GLOBAL_FLAGS = new Set(['--help', '-h', '--version', '-V', ...(root?.flags ?? [])]);
const GLOBAL_VALUE_FLAGS = new Set([...(root?.valueFlags ?? [])]);

const defects = [];
const add = (file, line, text, detail) => defects.push({ file, line, text, detail });

for (const rel of docs) {
  const lines = readFileSync(join(repoRoot, rel), 'utf-8').split('\n');
  let fence = null; // the info string of the fence we are inside, or null
  lines.forEach((line, i) => {
    const fenceMatch = /^\s*```+\s*(.*)$/.exec(line);
    if (fenceMatch) {
      fence = fence === null ? fenceMatch[1].trim().toLowerCase() : null;
      return;
    }
    if (fence !== null && fence.startsWith('text')) return; // "not a shell" — see header
    // Prose mentions the product ("nuvira does not embed it"); a command line is
    // an inline-code span or a shell example that STARTS with the binary name.
    for (const m of line.matchAll(/`?nuvira ((?:[a-z][\w-]*)(?: [^\s`|]+)*)/g)) {
      const raw = m[1].split('#')[0].trim().replace(/\\$/, '');
      if (!raw) continue;
      const tokens = raw.split(/[\s,]+/).filter(Boolean);
      // Only a line whose FIRST word is a real top-level command is a command.
      if (!root?.children.has(tokens[0]) && !root?.aliases?.has(tokens[0])) continue;
      if (!/^[a-z]/.test(tokens[0])) continue;

      let key = '';
      let matched = 0;
      for (const t of tokens) {
        if (t.startsWith('-')) break;
        if (!/^[a-zA-Z][\w-]*$/.test(t)) break;
      const node = nodeOf(key);
      const isChild = key === '' ? tree.has(t) : node?.children.has(t) || node?.aliases?.has(t);
        if (!isChild) break;
        key = key ? `${key} ${t}` : t;
        matched++;
      }
      const node = nodeOf(key);
      if (!node) continue;

      const after = tokens.slice(matched);
      const firstFlag = after.findIndex((t) => t.startsWith('-'));
      const trailing = (firstFlag === -1 ? after : after.slice(0, firstFlag)).filter((t) => !t.startsWith('-'));
      if (
        trailing.length === 1 &&
        /^[a-z][a-z0-9-]*$/.test(trailing[0]) &&
        !node.takesArgs &&
        !node.children.has(trailing[0]) &&
        !node.aliases.has(trailing[0])
      ) {
        add(rel, i + 1, `nuvira ${raw}`, `'${key}' has no '${trailing[0]}'`);
      }

      const allowed = new Set([...GLOBAL_FLAGS, ...node.flags]);
      const valueFlags = new Set([...GLOBAL_VALUE_FLAGS, ...node.valueFlags]);
      let prev = null;
      for (const t of after) {
        if (prev !== null && valueFlags.has(prev)) {
          prev = t;
          continue;
        }
        prev = t;
        if (!/^--[a-zA-Z][\w-]*$/.test(t)) continue;
        if (allowed.has(t)) continue;
        add(rel, i + 1, `nuvira ${raw}`, `'${t}' is not a flag of '${key}'`);
      }
    }
  });
}

console.log(`docs-commands: ${docs.length} hand-written doc(s) checked against the live CLI tree`);
if (VERBOSE) for (const d of docs) console.log(`  · ${d}`);

if (defects.length === 0) {
  console.log('✓ every documented command resolves, and every flag belongs to its command.');
  process.exit(0);
}

console.log('');
for (const d of defects) {
  console.log(`  ${d.file}:${d.line}`);
  console.log(`      ${d.detail}`);
  console.log(`      ${d.text}`);
}
console.log(`\n✗ ${defects.length} documented command(s) do not resolve.`);
process.exit(1);
