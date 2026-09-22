#!/usr/bin/env node
/**
 * Verify every command in `docs/COMMANDS_SURFACE.md` is actually RUNNABLE by the
 * `nuvira` binary.
 *
 * WHY. The surface doc is generated from the commander tree, so it can only tell
 * you a command is *registered*. It cannot tell you the command resolves at
 * runtime — which is exactly what breaks when a command is defined on a
 * sub-parser that never gets attached, or when an import throws only on the code
 * path that command takes. This walks the real CLI and runs each command with
 * `--help`, which forces commander to resolve the full path.
 *
 * WHY `--help` and not the real thing. Running the actual action would send
 * messages, publish packages, delete memory entries and rewrite configs. `--help`
 * proves the path resolves and the process exits cleanly, and is safe to run on a
 * developer's own machine.
 *
 * Usage:
 *   node scripts/verify-commands.mjs [--bin <path>] [--concurrency <n>] [--verbose]
 *
 * Exit code 0 when every command resolves; 1 with a list of the failures.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const bin = arg('--bin', join(repoRoot, 'dist', 'index.js'));
const concurrency = Number.parseInt(arg('--concurrency', '8'), 10);
const verbose = process.argv.includes('--verbose');
const surfacePath = join(repoRoot, 'docs', 'COMMANDS_SURFACE.md');

if (!existsSync(bin)) {
  console.error(`✗ CLI entry not found: ${bin}\n  Run \`npm run build\` first.`);
  process.exit(1);
}
if (!existsSync(surfacePath)) {
  console.error(`✗ Surface doc not found: ${surfacePath}`);
  process.exit(1);
}

const surface = readFileSync(surfacePath, 'utf-8');
const commands = [...surface.matchAll(/^### `([^`]+)`$/gm)]
  .map((m) => m[1])
  .map((c) => c.replace(/^nuvira\s*/, '').trim())
  .filter(Boolean);

console.log(`Verifying ${commands.length} commands against ${bin}\n`);

/** Run one command path with --help. Resolves {path, ok, detail}. */
function check(path) {
  const argv = [...(path ? path.split(' ') : []), '--help'];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [bin, ...argv],
      { cwd: repoRoot, timeout: 30_000, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout, stderr) => {
        if (!err) {
          // A clean exit is not enough: commander exits 0 and prints the PARENT
          // help when a subcommand name is unknown to it, which would hide a
          // genuinely missing command. Require the help text to mention the
          // command's own last segment.
          const text = `${stdout}${stderr}`;
          const leaf = path.split(' ').pop();
          if (path && !text.includes(leaf)) {
            resolve({ path, ok: false, detail: 'exited 0 but printed no help for this command' });
            return;
          }
          resolve({ path, ok: true });
          return;
        }
        const detail = String(stderr || stdout || err.message)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)[0];
        resolve({ path, ok: false, detail: detail ?? `exit ${err.code}` });
      },
    );
  });
}

const failures = [];
let index = 0;
let done = 0;

async function worker() {
  while (index < commands.length) {
    const path = commands[index++];
    const result = await check(path);
    done += 1;
    if (!result.ok) {
      failures.push(result);
      console.log(`  ✗ nuvira ${path} — ${result.detail}`);
    } else if (verbose) {
      console.log(`  ✓ nuvira ${path}`);
    }
    if (!verbose && done % 50 === 0) console.log(`  … ${done}/${commands.length}`);
  }
}

await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

console.log('');
if (failures.length === 0) {
  console.log(`✓ All ${commands.length} commands resolve and print help.`);
  process.exit(0);
}
console.log(`✗ ${failures.length} of ${commands.length} commands failed to resolve:`);
for (const f of failures) console.log(`    nuvira ${f.path} — ${f.detail}`);
process.exit(1);
