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
 * values (home paths, keys, phone numbers, emails) are removed by `redact()`,
 * which is the SAME `SECRET_PATTERNS` list `--check-cast` audits the committed
 * cast with. One definition, so the scrubber and the guard cannot drift.
 *
 * ═══ GUARDS — `npm test` runs both ════════════════════════════════════════
 *   node scripts/generate-cli-demo.mjs --check
 *     Runs every curated command against the BUILT CLI and fails if a newly
 *     curated command prints local state, or if its redacted output still
 *     matches a secret pattern. Needs `npm run build`.
 *   node scripts/generate-cli-demo.mjs --check-cast docs/demos/<file>.cast
 *     Validates a committed cast: asciinema v2 header, SECONDS-scale monotonic
 *     timestamps (the millisecond bug below), no secret patterns, and a
 *     recorded `--version` that still matches package.json (staleness).
 *
 * Usage:
 *   node scripts/generate-cli-demo.mjs [--bin dist/index.js] [--out docs/demos]
 *                                      [--only highlight|all]
 *   node scripts/generate-cli-demo.mjs --check
 *   node scripts/generate-cli-demo.mjs --check-cast docs/demos/nuvira-cli-tour.cast
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

/**
 * A committed tour is seconds long; anything past this is a unit mistake, not a
 * long recording. The millisecond bug made the ~45s tour declare 44,944.
 */
const MAX_TOUR_SECONDS = 900;

/**
 * How many curated commands `--check` runs at once. The commands themselves are
 * mostly reads, but several probe provider APIs, so the wall clock is dominated
 * by the slowest few — enough concurrency to overlap them, bounded so the guard
 * cannot be mistaken for a load test.
 */
const CHECK_CONCURRENCY = 8;

/**
 * The curated tour. Ordered deliberately: identity → health → the routing
 * matrix → what the agent knows → safety/compliance → the gateway → the GUI.
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
  ['gateway', 'status'],
  // `intent eval` is deliberately NOT here: it runs a model-backed eval that
  // takes >45s and prints nothing, so it added a silent stall to the recording
  // AND made `--check` wait out its whole timeout on it.
  // Anything with a side effect is shown as its help text — the action NEVER runs.
  ['execute', '--help'],
  ['chat', '--help'],
  ['dashboard', '--help'],
  ['benchmark', '--help'],
  ['publish', '--help'],
];

/**
 * Command families whose OUTPUT is the developer's own prose or state (rule 2).
 * Kept as a denylist the `--check` guard enforces, because `redact()` cannot
 * safely scrub a transcript — the only correct handling is to not record it.
 */
const STATE_PRINTING_COMMANDS = [
  ['stats'],
  ['history', 'list'],
  ['trace', 'list'],
  ['memory', 'list'],
  ['memory', 'facts'],
  ['nlu', 'learnings'],
  ['gateway', 'logs'],
];

/**
 * The ONE list of things that must never reach a published cast, used both to
 * SCRUB (redact) and to DETECT (findLeaks). Order matters: a WhatsApp JID is
 * matched before the generic email rule so it keeps its own label.
 */
const SECRET_PATTERNS = [
  { name: 'home directory path', pattern: /\/(?:Users|home)\/[^\s/\\]+/g, replace: '~' },
  {
    name: 'API key',
    pattern: /\b(?:gsk|sk|sk-ant|nvapi|xai|pplx|hf|r8)[_-][A-Za-z0-9._-]{4,}/g,
    replace: (m) => `${m.slice(0, 4)}••••••`,
  },
  { name: 'Google API key', pattern: /\bAIza[A-Za-z0-9_-]{20,}/g, replace: 'AIza••••••' },
  { name: 'phone number', pattern: /\+\d{8,15}\b/g, replace: '+••••••••••' },
  { name: 'WhatsApp JID', pattern: /\d{7,}@s\.whatsapp\.net/g, replace: '•••••@s.whatsapp.net' },
  { name: 'email address', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, replace: '•••@•••' },
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
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [bin, ...args],
      {
        cwd,
        timeout: 45_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
      },
      (_err, stdout, stderr) => resolvePromise(`${stdout ?? ''}${stderr ?? ''}`),
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
  let out = text;
  for (const { pattern, replace } of SECRET_PATTERNS) out = out.replace(pattern, replace);
  return out;
}

/** Which secret patterns still appear in `text` (empty array = clean). */
function findLeaks(text) {
  const leaks = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (text.match(pattern)) leaks.push(name);
  }
  return leaks;
}

/** Run `fn` over `items` with a bounded number of concurrent runners. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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

/** The printable text a cast's events produce (for leak/version checks). */
function castText(events) {
  return events
    .filter((e) => Array.isArray(e) && e[1] === 'o' && typeof e[2] === 'string')
    .map((e) => e[2])
    .join('');
}

async function record(commands, { title, maxLines, pauseAfterNote }) {
  const scratch = mkdtempSync(join(tmpdir(), 'nuvira-demo-'));
  const events = [];
  let clock = 0;

  const out = (text) => {
    // asciinema v2 timestamps are SECONDS, `clock` is milliseconds. Emitting ms
    // made a ~45s tour declare a 44,944-second (12.5h) duration — a player
    // renders that as a freeze on the first event.
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

/**
 * The leak guard: run every curated command against the built CLI and fail if a
 * command's REDACTED output still matches a secret pattern — or if a newly
 * curated command belongs to a state-printing family entirely.
 *
 * This is the check that a future edit cannot quietly publish a key: adding a
 * command that prints one fails here, naming the command and the pattern.
 */
async function check() {
  const problems = [];

  for (const args of HIGHLIGHT) {
    const stateful = STATE_PRINTING_COMMANDS.find((prefix) =>
      prefix.every((token, i) => args[i] === token),
    );
    if (stateful) {
      problems.push(
        `\`nuvira ${args.join(' ')}\` prints local state (matches \`nuvira ${stateful.join(' ')}\`) — ` +
          'keep it out of the tour, or its output cannot be published.',
      );
    }
  }

  const scratch = mkdtempSync(join(tmpdir(), 'nuvira-demo-check-'));
  try {
    const results = await pool(HIGHLIGHT, CHECK_CONCURRENCY, async (args) => ({
      args,
      leaks: findLeaks(redact(await run(args, scratch))),
    }));
    for (const { args, leaks } of results) {
      if (leaks.length > 0) {
        problems.push(
          `\`nuvira ${args.join(' ')}\` still shows ${leaks.join(', ')} after redact() — ` +
            'extend SECRET_PATTERNS to cover it.',
        );
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error(`✗ CLI demo leak check failed — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`   - ${p}`);
    return false;
  }
  console.log(
    `✓ CLI demo leak check — ${HIGHLIGHT.length} curated commands, no home paths, keys, ` +
      'phone numbers or emails in their output.',
  );
  return true;
}

/**
 * Validate a COMMITTED cast: the artifact is checked in, so it must be
 * plausible asciinema v2, measured in seconds (not milliseconds), free of the
 * secrets `redact()` exists to remove, and still be from the current version.
 *
 * Each of these was a real defect found by hand: the millisecond timestamps made
 * a 45-second tour declare 12.5 hours, and a tour curated from the developer's
 * own state published real prompts and a partially-masked key.
 */
function checkCast(file) {
  const problems = [];
  if (!existsSync(file)) {
    console.error(`✗ cast not found: ${file}`);
    return false;
  }

  const lines = readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '');

  let header = null;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    problems.push('header line is not valid JSON');
  }
  if (header && typeof header === 'object') {
    if (header.version !== 2) problems.push(`header version is ${header.version}, expected 2`);
    if (!Number.isInteger(header.width) || header.width <= 0) {
      problems.push('header width is not a positive integer');
    }
    if (!Number.isInteger(header.height) || header.height <= 0) {
      problems.push('header height is not a positive integer');
    }
  }

  const events = [];
  for (let i = 1; i < lines.length; i += 1) {
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      problems.push(`line ${i + 1} is not valid JSON`);
      continue;
    }
    if (!Array.isArray(event) || event.length !== 3) {
      problems.push(`line ${i + 1} is not a [time, code, text] tuple`);
      continue;
    }
    events.push(event);
  }

  let previous = -1;
  for (const [time] of events) {
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
      problems.push(`event timestamp ${time} is not a non-negative finite number`);
      break;
    }
    if (time < previous) {
      problems.push(`event timestamps go backwards (${previous} → ${time})`);
      break;
    }
    previous = time;
  }

  const duration = events.length > 0 ? Math.max(...events.map((e) => e[0])) : 0;
  if (duration > MAX_TOUR_SECONDS) {
    problems.push(
      `cast declares a ${Math.round(duration)}s duration (max ${MAX_TOUR_SECONDS}s) — timestamps are ` +
        'probably MILLISECONDS; asciinema v2 specifies SECONDS.',
    );
  }

  const text = castText(events);
  const leaks = findLeaks(text);
  if (leaks.length > 0) {
    problems.push(`cast still shows ${leaks.join(', ')} — regenerate it after extending redact().`);
  }

  const recorded = text.match(/nuvira --version\r?\n\s*([0-9]+\.[0-9]+\.[0-9]+)/);
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
  if (!recorded) {
    problems.push('cast does not record `nuvira --version` — staleness cannot be checked');
  } else if (recorded[1] !== pkg.version) {
    problems.push(
      `cast records v${recorded[1]} but package.json is v${pkg.version} — regenerate with ` +
        '`npm run demo:cli`.',
    );
  }

  if (problems.length > 0) {
    console.error(`✗ CLI demo cast check failed — ${problems.length} problem(s) in ${file}:`);
    for (const p of problems) console.error(`   - ${p}`);
    return false;
  }
  console.log(
    `✓ CLI demo cast check — ${file}: asciinema v2, ${events.length} events, ` +
      `${duration.toFixed(1)}s, no secrets, version ${pkg.version}.`,
  );
  return true;
}

async function main() {
  const castFile = arg('--check-cast', '');
  if (castFile) {
    process.exit(checkCast(resolve(castFile)) ? 0 : 1);
  }

  if (!existsSync(bin)) {
    console.error(`✗ CLI entry not found: ${bin}\n  Run \`npm run build\` first.`);
    process.exit(1);
  }

  if (process.argv.includes('--check')) {
    process.exit((await check()) ? 0 : 1);
  }

  mkdirSync(outDir, { recursive: true });

  if (!only || only === 'highlight') {
    const cast = await record(HIGHLIGHT, {
      title: 'nuvira — CLI tour',
      maxLines: 26,
    });
    const file = join(outDir, 'nuvira-cli-tour.cast');
    writeFileSync(file, cast, 'utf-8');
    const seconds = (cast.match(/^\[(\d+\.\d+)/gm) ?? []).reduce(
      (m, s) => Math.max(m, Number(s.slice(1))),
      0,
    );
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
    const seconds = (cast.match(/^\[(\d+\.\d+)/gm) ?? []).reduce(
      (m, s) => Math.max(m, Number(s.slice(1))),
      0,
    );
    console.log(
      `✓ ${file} — ${commands.length} commands, ${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s, ${(cast.length / 1024).toFixed(0)} KB`,
    );
  }
}

export {
  HIGHLIGHT,
  STATE_PRINTING_COMMANDS,
  SECRET_PATTERNS,
  MAX_TOUR_SECONDS,
  allCommands,
  buildCast,
  cap,
  castText,
  clean,
  findLeaks,
  redact,
  record,
  run,
};

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) await main();
