/**
 * Learned commands — a per-OS command the MODEL worked out, kept so it is known
 * next time.
 *
 * WHY THIS EXISTS. The per-OS command map (Bundle 47) declares the command for
 * the two verbs where the OS determines it; machine facts (Bundle 50) say what is
 * installed. Neither can enumerate the long tail — every tool, every OS, every
 * version — and trying to would be a table that is wrong the day it ships. So the
 * table GROWS BY USE instead: when the model works out how to do a verb on this
 * OS (and, in the verify loop, it works), the command is recorded here, keyed by
 * `(verb, os)`, and surfaced to the next search and the next resolve.
 *
 * This is the "model-derived, harness-remembered" half of the loop. The MODEL
 * decides the command (it is the general intelligence); the harness persists it
 * and hands it back, so the same discovery is not paid for twice.
 *
 * ISOLATION. The store resolves through `resolveNuviraDataPath`, so
 * `$NUVIRA_CONFIG_DIR` isolates it — an isolated (test/CI/sandbox) process never
 * reads or writes the developer's real store (the bug `resolveNuviraHome` invites).
 *
 * BEST-EFFORT AND BOUNDED. Every read/write is wrapped; a corrupt or missing file
 * is simply an empty store, and the file is capped so a runaway cannot grow
 * forever (newest wins). A command never TRUSTS a learned entry blindly — the
 * caller still checks it against the machine — so a stale entry is a hint, not a
 * fact.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { resolveNuviraDataPath } from '../config/paths.js';
import { detectMachineFacts, type NormalizedOs } from './machine-facts.js';

/** One learned command: how to do `verb` on `os`, as the model derived it. */
export interface LearnedCommand {
  /** The verb it accomplishes, normalized (lowercased) — e.g. "install java". */
  verb: string;
  /** The OS it was derived for. */
  os: NormalizedOs;
  /** The command, exactly as it should run. */
  command: string;
  /** The executable the command starts with, when it has one. */
  binary?: string;
  /** Optional note (why, a caveat). */
  note?: string;
  /** Where it came from: the model's resolution, or an observed successful run. */
  source: 'model' | 'observed';
  /** When it was recorded (ms epoch). */
  learnedAt: number;
}

interface Store {
  commands: LearnedCommand[];
}

const FILE_NAME = 'learned-commands.json';
/** Cap the store: newest wins, so a runaway cannot grow without bound. */
const MAX_COMMANDS = 500;

function storePath(): string {
  return resolveNuviraDataPath(FILE_NAME);
}

function isValid(c: unknown): c is LearnedCommand {
  const e = c as Partial<LearnedCommand>;
  return !!e && typeof e.verb === 'string' && typeof e.os === 'string' && typeof e.command === 'string';
}

/** Read the store. A missing/corrupt file is an empty store, never a throw. */
export function listLearnedCommands(): LearnedCommand[] {
  try {
    if (!existsSync(storePath())) return [];
    const parsed = JSON.parse(readFileSync(storePath(), 'utf-8')) as Partial<Store>;
    return Array.isArray(parsed.commands) ? parsed.commands.filter(isValid) : [];
  } catch {
    return [];
  }
}

function writeStore(commands: LearnedCommand[]): void {
  try {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ commands } satisfies Store, null, 2), 'utf-8');
  } catch {
    // Best-effort — a failed write must never break the turn.
  }
}

function normalizeVerb(verb: string): string {
  return String(verb ?? '').trim().toLowerCase();
}

/** The learned command for `verb` on `os` (default: this machine's OS), or null. */
export function learnedCommandFor(
  verb: string,
  os: NormalizedOs = detectMachineFacts().os,
): LearnedCommand | null {
  const v = normalizeVerb(verb);
  if (!v) return null;
  return listLearnedCommands().find((c) => c.verb === v && c.os === os) ?? null;
}

/**
 * Record (or replace) the command for `(verb, os)`. Returns the stored entry, or
 * null when the input is unusable (no verb or no command). Best-effort: a failed
 * write returns the entry without persisting, never a throw.
 */
export function recordLearnedCommand(input: {
  verb: string;
  command: string;
  binary?: string;
  note?: string;
  source?: 'model' | 'observed';
  os?: NormalizedOs;
}): LearnedCommand | null {
  const verb = normalizeVerb(input.verb);
  const command = String(input.command ?? '').trim();
  if (!verb || !command) return null;
  const os = input.os ?? detectMachineFacts().os;
  const entry: LearnedCommand = {
    verb,
    os,
    command,
    ...(input.binary ? { binary: input.binary } : {}),
    ...(input.note ? { note: input.note } : {}),
    source: input.source ?? 'model',
    learnedAt: Date.now(),
  };
  const rest = listLearnedCommands().filter((c) => !(c.verb === verb && c.os === os));
  writeStore([entry, ...rest].slice(0, MAX_COMMANDS));
  return entry;
}

/** Forget the command for `verb` on `os` (default: this machine). True if removed. */
export function forgetLearnedCommand(verb: string, os?: NormalizedOs): boolean {
  const v = normalizeVerb(verb);
  const target = os ?? detectMachineFacts().os;
  const before = listLearnedCommands();
  const after = before.filter((c) => !(c.verb === v && c.os === target));
  if (after.length === before.length) return false;
  writeStore(after);
  return true;
}
