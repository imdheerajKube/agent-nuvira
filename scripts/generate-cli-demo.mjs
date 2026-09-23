#!/usr/bin/env node
/**
 * Generate reproducible CLI demo recordings (asciinema v2 casts) from REAL
 * command runs.
 *
 * WHY A CAST AND NOT AN MP4. A hand-recorded video of this CLI is wrong the
 * moment a command is renamed, and it cannot be re-made on a build machine. A
 * cast is text: it is diffable, it is kilobytes, it is regenerable from the live
 * CLI, and it can be embedded on the website with a player. Nothing here is
 * hand-written output — every line is captured from an actual process.
 *
 * ═══ SAFETY — THE RULE THIS SCRIPT OBEYS ══════════════════════════════════
 * This runs on a developer's own machine, against their own config, and the
 * OUTPUT IS COMMITTED AND PUBLISHED, so it must neither cause an effect nor
 * reveal private data. Three rules:
 *
 *   1. NO COMMAND THAT SPENDS, SENDS, PUBLISHES OR MUTATES. No `chat`,
 *      `execute`, `gateway send`, `publish`, `memory add/delete`, `skill gc`,
 *      `config set`, `npm publish`. Those are represented by `--help` (the
 *      action is never run).
 *   2. NO COMMAND WHOSE OUTPUT IS THE DEVELOPER'S OWN PROSE OR STATE. `stats`,
 *      `history list`, `trace list`, `memory list/facts`, `nlu learnings` and
 *      `gateway logs` print real session titles, prompts, memories and message
 *      metadata — a transcript cannot be reliably redacted, so those commands
 *      are kept out of the tour entirely rather than scrubbed.
 *   3. EVERYTHING RUNS IN A THROWAWAY CWD, so a command that writes a stray
 *      file writes it where we delete it, not in the repo.
 *
 * What is left — model ids, provider status, tool/skill/plugin listings, policy
 * and the gateway's platform matrix — is still real, and the few remaining real
 * values (home paths, masked keys, phone numbers) are removed by `redact()`.
 *
 * The curated list below is drawn from read-only commands (status, list, report,
 * inspect) plus `--help` for everything with a side effect.
 *
 * Usage:
 *   node scripts/generate-cli-demo.mjs [--bin dist/index.js] [--out docs/demos]
 *                                      [--only highlight|all]
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const bin = arg('--bin', join(repoRoot, 'dist', 'index.js'));
const outDir = arg('--out', join(repoRoot, 'docs', 'demos'));
const only = arg('--only', '');

/** Terminal geometry for the recording. */
const WIDTH = 104;
const HEIGHT = 32;

/** Per-character typing delay, and the pause after a command's output. */
const TYPE_MS = 18;
const CHAR_PAUSE_MS = 0;
const AFTER_MS = 420;
const NOTE_MS = 90;

if (!existsSync(bin)) {
  console.error(`✗ CLI entry not found: ${bin}\n  Run \`npm run build\` first.`);
  process.exit(1);
}

/**
 * The curated tour. Ordered deliberately: identity → health → the routing
 * matrix → what the agent knows → safety/compliance → the GUI.
 *
 * Every entry is either read-only or `--help`. See the SAFETY block above.
 */
const HIGHLIGHT = [
  ['--version'],
  ['doctor'],
  ['models', 'status'],
  ['models', 'excluded'],
  ['models', 'staleness'],
  ['provider', 'health'],
  ['config', 'list'],
  ['skills'],
  ['tools'],
  ['plugins'],
  ['admin', 'policy'],
  ['audit', 'verify', '--help'],
  ['sbom', '--help'],
  ['security', '--help'],
  ['learn', 'quality'],
  ['intent', 'eval'],
  ['gateway', 'status'],
  // Anything with a side effect is shown as its help text — the action NEVER runs.
  ['execute', '--help'],
  ['chat', '--help'],
  ['dashboard', '--help'],
  ['benchmark', '--help'],
  ['publish', '--help'],
];

/** Every command path in the documented surface, for the full sweep. */
function allCommands() {
  const surface = readFileSync(join(repoRoot, 'docs', 'COMMANDS_SURFACE.md'), 'utf-8');
  return [...surface.matchAll(/^### `([^`]+)`$/gm)]
    .map((m) => m[1].replace(/^nuvira\s*/, '').trim())
    .filter(Boolean)
    .map((p) => [...p.split(' '), '--help']);
}

/** Run one command, capturing combined output. Never throws. */
function run(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      {
        cwd,
        timeout: 45_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
      },
      (_err, stdout, stderr) => resolve(`${stdout ?? ''}${stderr ?? ''}`),
    );
  });
}

/** asciinema v2 needs `\r\n` for correct line returns. */
function toTerminal(text) {
  return text.replace(/\r?\n/g, '\r\n');
}

/** Drop the noisy banner every CLI invocation prints, and trailing blanks. */
function clean(text) {
  const lines = text.split('\n').filter((l) => !/Agent-Nuvira starting/.test(l));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

function cap(text, maxLines) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `  … (${lines.length - maxLines} more lines)`].join('\n');
}

/**
 * Scrub anything that is the DEVELOPER'S rather than the product's.
 *
 * The recording runs against the real `~/.nuvira`, so a few commands still print
 * real values: home directory paths, a Twilio number, a WhatsApp session path,
 * and the CLI's own partially-masked API keys — a `gsk_cy...S9ak` still leaks
 * five characters on each side, and this repo sells "privacy-first, no
 * telemetry", so publishing any of it would contradict the pitch.
 *
 * A conservative TEXT scrub, not a semantic one: it removes key-shaped tokens,
 * home paths, phone numbers and emails, and leaves every product name, model id,
 * count and latency untouched. Commands whose output is inherently private prose
 * (transcripts, traces, memory, gateway logs) are NOT scrubbed — they are kept
 * out of the tour by rule 2 above, because prose cannot be reliably redacted.
 */
function redact(text) {
  return (
    text
      // Home directories: /Users/<name> and /home/<name> → ~
      .replace(/\/(?:Users|home)\/[^\s/\\]+/g, '~')
      // API keys — full, or the CLI's own masked form (`gsk_cy...S9ak`).
      .replace(/\b(?:gsk|sk|sk-ant|nvapi|xai|pplx|hf|r8)[_-][A-Za-z0-9._-]{4,}/g, (m) =>
        `${m.slice(0, 4)}••••••`,
      )
      .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, 'AIza••••••')
      // E.164 phone numbers and WhatsApp JIDs.
      .replace(/\+\d{8,15}\b/g, '+••••••••••')
      .replace(/\d{7,}@s\.whatsapp\.net/g, '•••••@s.whatsapp.net')
      // Email addresses.
      .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '•••@•••')
  );
}

function buildCast(events, title) {
  const header = {
    version: 2,
    width: WIDTH,
    height: HEIGHT,
    timestamp: Math.floor(Date.now() / 1000),
    title,
    env: { SHELL: '/bin/bash', TERM: 'xterm-256color' },
  };
  return [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n';
}

async function record(commands, { title, maxLines, pauseAfterNote }) {
  const scratch = mkdtempSync(join(tmpdir(), 'nuvira-demo-'));
  const events = [];
  let clock = 0;

  const out = (text) => {
    // asciinema v2 timestamps are SECONDS, `clock` is milliseconds. Emitting ms
    // made a ~61s tour declare a 61,370-second duration — a player renders that
    // as a 17-hour freeze on the first event.
    events.push([Number((clock / 1000).toFixed(3)), 'o', toTerminal(text)]);
  };
  const wait = (ms) => {
    clock += ms;
  };

  out('$ ');
  wait(300);

  for (const args of commands) {
    const printable = `nuvira ${args.join(' ')}`;

    // Type the command, one keystroke at a time — a recording where commands
    // appear instantly does not read as a terminal session.
    for (let i = 0; i < printable.length; i++) {
      out(printable[i]);
      wait(TYPE_MS);
    }
    out('\r\n');
    wait(120);

    const raw = await run(args, scratch);
    const text = redact(cap(clean(raw), maxLines));
    if (text.trim()) {
      out(text + '\n');
      // Long output scrolls at reading speed; short output just needs a beat.
      const lines = text.split('\n').length;
      wait(Math.min(2600, 260 + lines * 55));
    }
    out('\r\n$ ');
    wait(pauseAfterNote ?? AFTER_MS);
    if (args.includes('--help') && maxLines <= 4) wait(NOTE_MS);
  }

  out('\r\n');
  rmSync(scratch, { recursive: true, force: true });
  return buildCast(events, title);
}

mkdirSync(outDir, { recursive: true });

if (!only || only === 'highlight') {
  const cast = await record(HIGHLIGHT, {
    title: 'nuvira — CLI tour',
    maxLines: 26,
  });
  const file = join(outDir, 'nuvira-cli-tour.cast');
  writeFileSync(file, cast, 'utf-8');
  const seconds = (cast.match(/^\[(\d+\.\d+)/gm) ?? []).reduce((m, s) => Math.max(m, Number(s.slice(1))), 0);
  console.log(`✓ ${file} — ${HIGHLIGHT.length} commands, ${Math.round(seconds)}s, ${(cast.length / 1024).toFixed(0)} KB`);
}

if (!only || only === 'all') {
  const commands = allCommands();
  const cast = await record(commands, {
    title: `nuvira — all ${commands.length} commands`,
    maxLines: 8,
  });
  const file = join(outDir, 'nuvira-commands-all.cast');
  writeFileSync(file, cast, 'utf-8');
  const seconds = (cast.match(/^\[(\d+\.\d+)/gm) ?? []).reduce((m, s) => Math.max(m, Number(s.slice(1))), 0);
  console.log(
    `✓ ${file} — ${commands.length} commands, ${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s, ${(cast.length / 1024).toFixed(0)} KB`,
  );
}
