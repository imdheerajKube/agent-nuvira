/**
 * Skill outcomes — what a skill actually DELIVERED, on this machine.
 *
 * WHY (2026-11-03). Skill selection is the model's job (see `loop-skill-hint`),
 * so the harness no longer ranks candidates by keyword. But the index it hands
 * over is in NAME order: a skill that has shipped work here ten times sits in
 * exactly the same place as one that has never been loaded, and a skill whose
 * last five loads ended in "could not finish" reads exactly as attractive as one
 * that keeps landing. Nothing recorded whether loading a skill HELPED.
 *
 * This module records the one thing that can answer that without a model judging
 * a model: the turn's own ending. A loaded skill is credited with a DELIVERY
 * when the turn ended with a claim the completion gate accepted and marked
 * verified; it is credited with a MISS when the turn ended unverified. The index
 * is ordered by the resulting rate, so experience accumulates without a keyword
 * list, a similarity score, or a prompt that guesses.
 *
 * Deliberately conservative:
 *   - only a LOADED skill accrues an outcome (installing obliges nothing);
 *   - a refusal is not a miss — the turn continues, and a skill punished for
 *     work-in-progress would learn to stay silent;
 *   - an unseen skill scores the neutral 0.5, so a new skill is never buried by
 *     the ones that happen to have history;
 *   - Laplace smoothing, so 1/1 (0.67) does not outrank 40/50 (0.79), and a
 *     single bad run cannot condemn a skill that has delivered before.
 *
 * Best-effort by construction: any I/O failure leaves the ranking neutral and
 * never breaks a turn.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveNuviraDataPath } from '../config/paths.js';

/** One skill's running tally. */
export interface SkillTally {
  /** Times the skill was loaded. */
  loads: number;
  /** Loads whose turn ended with a verified, accepted claim. */
  delivered: number;
  /** Last time either counter moved (epoch ms). */
  updatedAt: number;
}

interface OutcomeStore {
  version: 1;
  skills: Record<string, SkillTally>;
}

/** Cap on tracked skills — a long-lived home dir must not grow without bound. */
const MAX_SKILLS = 800;

// `resolveNuviraDataPath` (not `~/.nuvira`) because it honours
// `$NUVIRA_CONFIG_DIR`: an isolated run — a test, a bench arm, a second profile —
// must never read or write the real home's ledger.
function storeDir(): string {
  return resolveNuviraDataPath('memory');
}

function storePath(): string {
  return join(storeDir(), 'skill-outcomes.json');
}

function emptyStore(): OutcomeStore {
  return { version: 1, skills: {} };
}

function readStore(): OutcomeStore {
  try {
    const path = storePath();
    if (!existsSync(path)) return emptyStore();
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<OutcomeStore>;
    if (!parsed || typeof parsed !== 'object' || !parsed.skills) return emptyStore();
    const skills: Record<string, SkillTally> = {};
    for (const [name, raw] of Object.entries(parsed.skills)) {
      const t = raw as Partial<SkillTally>;
      const loads = Number.isFinite(t.loads) ? Math.max(0, Math.trunc(t.loads as number)) : 0;
      const delivered = Number.isFinite(t.delivered) ? Math.max(0, Math.trunc(t.delivered as number)) : 0;
      if (loads === 0 && delivered === 0) continue;
      skills[name] = {
        loads,
        // A delivery is always one of the loads, whatever the file says.
        delivered: Math.min(delivered, loads),
        updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : Date.now(),
      };
    }
    return { version: 1, skills };
  } catch {
    return emptyStore();
  }
}

function writeStore(store: OutcomeStore): void {
  try {
    const entries = Object.entries(store.skills);
    if (entries.length > MAX_SKILLS) {
      // Keep the most recently touched — old, unused skills lose their history
      // rather than pushing out the ones in play.
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      store.skills = Object.fromEntries(entries.slice(0, MAX_SKILLS));
    }
    mkdirSync(storeDir(), { recursive: true });
    const target = storePath();
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    renameSync(tmp, target);
  } catch {
    /* best-effort: an outcome ledger must never break a turn */
  }
}

/** Record that a skill was LOADED (the denominator). */
export function recordSkillUse(name: string): void {
  const skill = String(name ?? '').trim();
  if (!skill) return;
  const store = readStore();
  const tally = store.skills[skill] ?? { loads: 0, delivered: 0, updatedAt: Date.now() };
  tally.loads += 1;
  tally.updatedAt = Date.now();
  store.skills[skill] = tally;
  writeStore(store);
}

/**
 * Record the ENDING of a turn that loaded `names`.
 *
 * `delivered` is the turn's own verdict, not a judgement of the skill: a skill
 * can be correct and the work still not land. That is why this only ever moves
 * the skill's position in a list and never blocks, gates or hides anything.
 */
export function recordSkillSession(names: readonly string[], delivered: boolean): void {
  const clean = [...new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))];
  if (clean.length === 0) return;
  const store = readStore();
  let touched = false;
  for (const name of clean) {
    const tally = store.skills[name] ?? { loads: 0, delivered: 0, updatedAt: Date.now() };
    if (delivered) {
      tally.delivered += 1;
      // A delivery implies a load, even when the load was recorded by an older
      // build (or the session file was cleared between the two writes).
      if (tally.delivered > tally.loads) tally.loads = tally.delivered;
      tally.updatedAt = Date.now();
      store.skills[name] = tally;
      touched = true;
    } else if (store.skills[name]) {
      tally.updatedAt = Date.now();
      store.skills[name] = tally;
      touched = true;
    }
  }
  if (touched) writeStore(store);
}

/** Laplace-smoothed delivery rate — 0.5 for a skill with no history. */
export function skillScore(tally: SkillTally | undefined): number {
  const loads = tally?.loads ?? 0;
  const delivered = tally?.delivered ?? 0;
  return (delivered + 1) / (loads + 2);
}

/** The tally for one skill (zeros when unknown). */
export function skillTally(name: string): SkillTally {
  return readStore().skills[String(name ?? '').trim()] ?? { loads: 0, delivered: 0, updatedAt: 0 };
}

/** Every tally, for a surface that wants to show the record. */
export function allSkillTallies(): Record<string, SkillTally> {
  return readStore().skills;
}

/** `delivered 7/9` — the record in the form a human reads. */
export function trackRecord(name: string): string | null {
  const t = skillTally(name);
  if (t.loads === 0) return null;
  return `delivered ${t.delivered}/${t.loads}`;
}

/**
 * Order candidates by delivered results — the ranking the index uses.
 *
 * Ties keep their incoming (name) order, so a fresh install stays predictable
 * instead of shuffling on every read.
 */
export function orderByOutcome<T extends { name: string }>(entries: readonly T[]): T[] {
  const store = readStore();
  return [...entries]
    .map((entry, index) => ({ entry, index, score: skillScore(store.skills[entry.name]) }))
    .sort((a, b) => (b.score - a.score) || a.entry.name.localeCompare(b.entry.name) || a.index - b.index)
    .map((row) => row.entry);
}

/** Clear the ledger (tests, and an explicit "start over"). */
export function resetSkillOutcomes(): void {
  writeStore(emptyStore());
}
