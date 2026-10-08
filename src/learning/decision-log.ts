/**
 * Decision log — the decisions a project's turns asked the user to make, kept as
 * artifacts the user can go back through, refer to, and REVISE.
 *
 * WHY THIS EXISTS. When the agent must ask (`ask_user`), the question and the
 * user's answer currently live only in that turn's transcript and the in-memory
 * run trace. Close the terminal and the decision is gone — nobody can see later
 * WHAT was decided, or WHY, and there is no way to change it. A must-ask is the
 * one place the user's intent is explicit, so it is the worst thing to lose.
 *
 * WHAT IT WRITES. `<project>/.nuvira/decisions.jsonl` — one JSON record per
 * decision, append-only, the machine-readable source of truth — and a generated
 * `<project>/.nuvira/DECISIONS.md` a person can read in a PR. `.nuvira/` is
 * ignored by git, so a decision log never dirties a repo.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *  - It is never a SUBSTITUTE for asking. Nothing here suppresses an `ask_user`
 *    call or auto-answers one; it records what was asked and answered.
 *  - It never fabricates an answer. The `unattended` default an unreachable user
 *    gets is an ASSUMPTION, and is not recorded here as a decision — only a
 *    genuine, shown question with a real reply is.
 *  - It never blocks. Every write is best-effort; a failed decision-log write
 *    must never break a turn.
 *  - It redacts obvious secrets before writing anything to disk.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** One decision the user was asked to make, and what they chose. */
export interface DecisionRecord {
  id: string;
  /** Epoch ms when the decision was recorded. */
  at: number;
  /** The question the agent could not answer for the user. */
  question: string;
  /** The choice the user made (a label, or their own words). */
  answer: string;
  /** The choices offered, for context when the answer is one of them. */
  choices?: string[];
  /** Which surface asked (`cli` | `dashboard` | `gateway` | `unknown`). */
  source: string;
  /** `decided` until it is revised; `revised` once a later answer supersedes it. */
  status: 'decided' | 'revised';
  /** Append-only revision history, newest last. */
  revisions?: Array<{ at: number; answer: string; note?: string }>;
}

/** Cap the log so one busy project cannot grow without bound (oldest drop first). */
export const MAX_DECISIONS = 500;

export function decisionsDir(dir: string): string {
  return join(resolve(dir), '.nuvira');
}

export function decisionLogPath(dir: string): string {
  return join(decisionsDir(dir), 'decisions.jsonl');
}

export function decisionsDocPath(dir: string): string {
  return join(decisionsDir(dir), 'DECISIONS.md');
}

/**
 * Whether decision recording is on. Off under a test runner (an injected
 * `askUser` renderer in a test is not a person making a decision) and when
 * `NUVIRA_DECISION_LOG=off` is set explicitly.
 */
export function decisionsRecordingEnabled(): boolean {
  if (process.env.NUVIRA_DECISION_LOG === 'off') return false;
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') return false;
  return true;
}

/**
 * Mask obvious secrets before they reach disk. The log is meant to be readable
 * and shareable, so a token the user pasted into an answer must not be stored
 * verbatim. Deliberately conservative: it masks clear credential SHAPES, not
 * anything that merely looks random.
 */
export function redactDecisionText(text: string): string {
  let out = String(text ?? '');
  // Provider / vendor keys with a recognizable prefix.
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{12,})/g, 'sk-***');
  out = out.replace(/\b(ghp_[A-Za-z0-9]{20,})/g, 'ghp_***');
  out = out.replace(/\b(github_pat_[A-Za-z0-9_]{20,})/g, 'github_pat_***');
  out = out.replace(/\b(AKIA[0-9A-Z]{12,})/g, 'AKIA***');
  out = out.replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})/g, 'xox***');
  // A bearer token in a header.
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1***');
  // `password: hunter2` / `api_key=...` — keep the key name, mask the value.
  out = out.replace(
    /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*(\S+)/gi,
    '$1: ***',
  );
  return out;
}

function newId(now: number): string {
  return `dec-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Parse the JSONL store, skipping corrupt lines (a dataset must not be a landmine). */
export function readDecisions(dir: string): DecisionRecord[] {
  try {
    if (!existsSync(decisionLogPath(dir))) return [];
    const out: DecisionRecord[] = [];
    for (const line of readFileSync(decisionLogPath(dir), 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed) as Partial<DecisionRecord>;
        if (!raw || typeof raw !== 'object' || !raw.id || !raw.question) continue;
        out.push({
          id: String(raw.id),
          at: Number(raw.at) || 0,
          question: String(raw.question),
          answer: String(raw.answer ?? ''),
          ...(Array.isArray(raw.choices) ? { choices: raw.choices.map(String) } : {}),
          source: String(raw.source ?? 'unknown'),
          status: raw.status === 'revised' ? 'revised' : 'decided',
          ...(Array.isArray(raw.revisions) ? { revisions: raw.revisions } : {}),
        });
      } catch {
        // Corrupt line — skip.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeStore(dir: string, records: DecisionRecord[]): void {
  const trimmed = records.slice(-MAX_DECISIONS);
  if (!existsSync(decisionsDir(dir))) mkdirSync(decisionsDir(dir), { recursive: true });
  writeFileSync(
    decisionLogPath(dir),
    trimmed.map((r) => JSON.stringify(r)).join('\n') + (trimmed.length > 0 ? '\n' : ''),
    'utf-8',
  );
  writeFileSync(decisionsDocPath(dir), renderDecisionsDoc(trimmed), 'utf-8');
}

/**
 * Record one decision a shown `ask_user` produced. Returns the record, or null
 * when there is nothing to record (an empty question) or the write failed.
 * The question and answer are redacted first.
 */
export function recordDecision(input: {
  question: string;
  answer: string;
  choices?: string[];
  source?: string;
  dir: string;
  now?: number;
}): DecisionRecord | null {
  const question = redactDecisionText(input.question).trim();
  if (!question) return null;
  const now = input.now ?? Date.now();
  const record: DecisionRecord = {
    id: newId(now),
    at: now,
    question,
    answer: redactDecisionText(String(input.answer ?? '').trim()),
    ...(input.choices && input.choices.length > 0
      ? { choices: input.choices.slice(0, 8).map((c) => redactDecisionText(c)) }
      : {}),
    source: input.source ?? 'unknown',
    status: 'decided',
  };
  try {
    writeStore(input.dir, [...readDecisions(input.dir), record]);
  } catch {
    // Best-effort — a decision-log write must never break a turn.
    return null;
  }
  return record;
}

/**
 * Revise a decision. The new answer becomes the record's answer and is appended
 * to its history, so the OLD choice is still visible — a decision that changed is
 * more useful documented than overwritten.
 */
export function reviseDecision(
  dir: string,
  id: string,
  answer: string,
  note?: string,
  now: number = Date.now(),
): DecisionRecord | null {
  const records = readDecisions(dir);
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const prev = records[idx];
  const revised: DecisionRecord = {
    ...prev,
    answer: redactDecisionText(answer.trim()),
    status: 'revised',
    revisions: [
      ...(prev.revisions ?? []),
      {
        at: now,
        answer: redactDecisionText(answer.trim()),
        ...(note ? { note: redactDecisionText(note.trim()) } : {}),
      },
    ],
  };
  records[idx] = revised;
  try {
    writeStore(dir, records);
  } catch {
    return null;
  }
  return revised;
}

function iso(at: number): string {
  return at > 0 ? new Date(at).toISOString() : 'unknown';
}

/** The human-readable companion, regenerated on every write. */
export function renderDecisionsDoc(records: DecisionRecord[]): string {
  const lines: string[] = [];
  lines.push('# Decisions');
  lines.push('');
  lines.push(
    'Decisions this project asked YOU to make (`ask_user`), recorded so they can be',
  );
  lines.push(
    'referred to and revised later. Generated from `.nuvira/decisions.jsonl` — do not',
  );
  lines.push(
    `edit by hand; change a decision with \`nuvira decisions revise <id> --answer "…"\`.`,
  );
  lines.push('');
  if (records.length === 0) {
    lines.push('_No decisions recorded yet._');
    lines.push('');
    return lines.join('\n');
  }
  for (const r of records) {
    lines.push(`## ${r.question}`);
    lines.push('');
    lines.push(`- **Answer:** ${r.answer || '_(none)_'}`);
    lines.push(`- **Recorded:** ${iso(r.at)} · ${r.source} · \`${r.id}\``);
    if (r.status === 'revised') lines.push('- **Status:** revised');
    if (r.choices && r.choices.length > 0) {
      lines.push(`- **Choices offered:** ${r.choices.map((c) => `\`${c}\``).join(', ')}`);
    }
    if (r.revisions && r.revisions.length > 0) {
      lines.push('- **History:**');
      for (const rev of r.revisions) {
        lines.push(
          `  - ${iso(rev.at)} → ${rev.answer || '_(none)_'}${rev.note ? ` — ${rev.note}` : ''}`,
        );
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** One-line summaries for a CLI list. */
export function formatDecisionSummaries(records: DecisionRecord[]): string[] {
  if (records.length === 0) return ['(no decisions recorded for this project yet)'];
  return records.map((r) => {
    const mark = r.status === 'revised' ? '✏️' : '✅';
    return `${mark} ${r.id}  ${iso(r.at)}  [${r.source}]  ${r.question.slice(0, 90)} → ${r.answer.slice(0, 60)}`;
  });
}

/**
 * Token set for a lightweight relevance match (no phrase lists, no model).
 * Only tokens of 4+ characters count, so the short function words that would
 * otherwise match every question ("the", "use", "and") do not drown the real
 * subject; the user still sees each question and judges for themselves.
 */
function tokenSet(text: string): Set<string> {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4),
  );
}

/**
 * Decisions relevant to an ask, ranked by shared significant tokens — the
 * READ-BACK half: so a later turn can be shown what was already decided about a
 * related ask instead of re-asking. Best-effort; an empty list is a real answer.
 */
export function recallDecisions(dir: string, text: string, limit = 5): DecisionRecord[] {
  const want = tokenSet(text);
  if (want.size === 0) return [];
  const scored = readDecisions(dir)
    .map((r) => {
      const have = tokenSet(r.question);
      let shared = 0;
      for (const t of want) if (have.has(t)) shared++;
      return { r, shared };
    })
    .filter((s) => s.shared > 0)
    .sort((a, b) => b.shared - a.shared || b.r.at - a.r.at);
  return scored.slice(0, Math.max(1, limit)).map((s) => s.r);
}
