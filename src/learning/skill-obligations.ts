/**
 * P6 — Binding skill obligations (`src/learning/skill-obligations.ts`).
 *
 * THE PROBLEM THIS SOLVES (measured 2026-11-02). The bundled catalog is prose:
 * median 179 words per skill, 0/156 ship data, 5/156 ship a script, and 155/156
 * ship a `references/guide.md` that is a re-word of their own SKILL.md. A skill
 * like that can only change behaviour if it is more than advice — because a model
 * that has READ a checklist and a model that has FOLLOWED one are
 * indistinguishable from the outside.
 *
 * So a skill may now declare what "used" means:
 *
 *   ---
 *   name: db-migration
 *   obligations:
 *     must_read:    [references/checklist.md]   # harness verifies the read
 *     must_run:     [scripts/validate_migration.py]
 *     must_produce: [docs/migration-plan.md]    # verified on disk
 *     must_verify:  [tests]                     # verified by a green run
 *   ---
 *
 * The harness records evidence as the turn goes (a file read, a successful
 * command, a produced artifact) and `finish` refuses a `verified:true` claim
 * while an obligation from a LOADED skill is unmet — naming the exact gap. That
 * converts a skill from suggestion into requirement, which is the one thing a
 * skill-only surface (Claude Code, Copilot) cannot do: they have no completion
 * contract to bind to.
 *
 * Deliberate limits:
 *   - Only a skill LOADED IN THIS SESSION binds anything. Installing a skill
 *     obliges nothing; loading it is the contract.
 *   - `verified:false` is never blocked — an honest "I could not do it" ending is
 *     allowed and carries the unmet list to the user verbatim.
 *   - Evidence is kept per session id and capped, so a long session cannot grow
 *     an unbounded file, and a stale one is pruned on write.
 *   - Matching is intentionally simple (path suffix / command substring). A false
 *     NEGATIVE blocks a finish with a precise reason, which is recoverable; a
 *     false positive would silently let work through, which is not.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { resolveNuviraHome } from '../config/paths.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** What a skill requires to count as actually used. All fields optional. */
export interface SkillObligations {
  /** Paths that must be READ (relative to the skill dir or the workspace). */
  mustRead: string[];
  /** Commands/scripts that must RUN successfully (substring match). */
  mustRun: string[];
  /** Files that must EXIST when the turn closes (globs allowed). */
  mustProduce: string[];
  /** Checks that must pass (e.g. `tests`, `typecheck`). */
  mustVerify: string[];
}

export interface LoadedSkillObligation {
  id: string;
  name: string;
  /** Absolute skill directory — the base for skill-relative obligation paths. */
  dir: string;
  obligations: SkillObligations;
}

interface SessionRecord {
  sessionId: string;
  loaded: LoadedSkillObligation[];
  /** Files read this session (as given + as resolved). */
  reads: string[];
  /** Commands that SUCCEEDED this session. */
  commands: string[];
  updatedAt: number;
}

export interface ObligationReport {
  /** Number of declared obligations across every loaded skill. */
  total: number;
  satisfied: number;
  /** Human-readable unmet obligations (empty = clear). */
  unmet: string[];
  /** Skills that contributed obligations. */
  skills: string[];
}

// ─── Limits ─────────────────────────────────────────────────────────────────

const MAX_READS = 200;
const MAX_COMMANDS = 200;
const MAX_LOADED = 25;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A fresh, independent empty set. A FACTORY, not a shared constant: spreading a
 * constant copies its array REFERENCES, and every caller pushing into the result
 * would then mutate the shared arrays (found the hard way — one parse leaked into
 * the next until this was a function).
 */
export function emptyObligations(): SkillObligations {
  return { mustRead: [], mustRun: [], mustProduce: [], mustVerify: [] };
}

/** Frozen for comparison only — never mutate or spread-and-push. */
export const EMPTY_OBLIGATIONS: Readonly<SkillObligations> = Object.freeze({
  mustRead: Object.freeze([]) as unknown as string[],
  mustRun: Object.freeze([]) as unknown as string[],
  mustProduce: Object.freeze([]) as unknown as string[],
  mustVerify: Object.freeze([]) as unknown as string[],
});

/** Does this skill declare anything at all? */
export function hasObligations(o: SkillObligations | undefined): boolean {
  if (!o) return false;
  return o.mustRead.length + o.mustRun.length + o.mustProduce.length + o.mustVerify.length > 0;
}

// ─── Frontmatter parsing ────────────────────────────────────────────────────

function unquote(v: string): string {
  return v.trim().replace(/^["']|["']$/g, '');
}

function inlineList(v: string): string[] {
  const inner = v.trim().replace(/^\[|\]$/g, '');
  if (!inner.trim()) return [];
  return inner.split(',').map(unquote).filter(Boolean);
}

/**
 * Parse the `obligations:` block out of a SKILL.md.
 *
 * Accepts both shapes so an author does not have to learn our exact grammar:
 *
 *   obligations:
 *     must_read:
 *       - references/checklist.md      # block list
 *     must_run: [scripts/validate.py]  # inline list
 *
 *   must_read: [references/checklist.md]   # flat, no `obligations:` header
 *
 * Everything is best-effort: malformed content contributes nothing rather than
 * throwing inside a catalog scan.
 */
export function parseObligations(markdown: string): SkillObligations {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!fm) return emptyObligations();
  const lines = fm[1].split(/\r?\n/);

  const KEY: Record<string, keyof SkillObligations> = {
    must_read: 'mustRead',
    must_run: 'mustRun',
    must_produce: 'mustProduce',
    must_verify: 'mustVerify',
  };
  const out: SkillObligations = emptyObligations();
  let inBlock = false; // inside an `obligations:` block
  let active: keyof SkillObligations | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const indented = /^\s+/.test(line);

    // Block-list item for the active key.
    if (active && /^\s*-\s+/.test(line)) {
      const item = unquote(line.replace(/^\s*-\s+/, ''));
      if (item && !out[active].includes(item)) out[active].push(item);
      continue;
    }

    const kv = /^(\s*)([a-zA-Z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!kv) {
      active = null;
      continue;
    }
    const [, indent, key, rawValue] = kv;
    const value = rawValue.trim();

    if (!indented) {
      // A top-level key ends any obligations block.
      if (key === 'obligations') {
        inBlock = value === '';
        active = null;
        continue;
      }
      // Flat convenience form: `must_read: [...]` at top level.
      const mapped = KEY[key];
      if (mapped) {
        inBlock = false;
        active = value ? null : mapped;
        for (const item of inlineList(value)) {
          if (!out[mapped].includes(item)) out[mapped].push(item);
        }
        continue;
      }
      inBlock = false;
      active = null;
      continue;
    }

    // Indented key: only meaningful inside `obligations:`.
    if (inBlock) {
      const mapped = KEY[key] ?? (key.startsWith('-') ? null : null);
      if (mapped) {
        active = value ? null : mapped;
        for (const item of inlineList(value)) {
          if (!out[mapped].includes(item)) out[mapped].push(item);
        }
      }
    }
  }
  return out;
}

// ─── Session state ──────────────────────────────────────────────────────────

/** The session this process is acting for. */
export function obligationsSessionId(): string {
  const fromEnv = (process.env.NUVIRA_SESSION_ID ?? '').trim();
  return fromEnv || 'cli';
}

function storeDir(): string {
  return join(resolveNuviraHome(), 'memory', 'skill-obligations');
}

function storePath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return join(storeDir(), `${safe}.json`);
}

function emptyRecord(sessionId: string): SessionRecord {
  return { sessionId, loaded: [], reads: [], commands: [], updatedAt: Date.now() };
}

function readRecord(sessionId: string): SessionRecord {
  try {
    const raw = readFileSync(storePath(sessionId), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SessionRecord>;
    return {
      sessionId,
      loaded: Array.isArray(parsed.loaded) ? parsed.loaded : [],
      reads: Array.isArray(parsed.reads) ? parsed.reads : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return emptyRecord(sessionId);
  }
}

function writeRecord(record: SessionRecord): void {
  try {
    mkdirSync(storeDir(), { recursive: true });
    record.updatedAt = Date.now();
    const target = storePath(record.sessionId);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), 'utf-8');
    renameSync(tmp, target);
  } catch {
    /* best-effort: obligations must never break a turn */
  }
}

/** Drop session files that have not been touched in a week. */
function pruneStale(): void {
  try {
    const dir = storeDir();
    if (!existsSync(dir)) return;
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > STALE_MS) writeFileSync(path, '', 'utf-8');
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
}

// ─── Evidence recording ─────────────────────────────────────────────────────

/**
 * Record that a skill was LOADED this session — the act that makes its
 * obligations binding. Idempotent per skill id (a re-load updates the record).
 */
export function recordSkillLoad(
  skill: { id: string; name: string; dir?: string; obligations?: SkillObligations },
  sessionId = obligationsSessionId(),
): void {
  // EVERY load is recorded, not only the binding ones. This store is also how
  // the finish gate names the skills a turn used (and how the outcome ledger
  // credits them), so a skill with nothing declared must still appear. An empty
  // obligations map satisfies every loop in `evaluateObligations` vacuously, so
  // recording it can never trap a turn.
  const record = readRecord(sessionId);
  const entry: LoadedSkillObligation = {
    id: skill.id,
    name: skill.name,
    dir: skill.dir ?? process.cwd(),
    obligations: skill.obligations ?? emptyObligations(),
  };
  record.loaded = record.loaded.filter((s) => s.id !== skill.id);
  record.loaded.push(entry);
  if (record.loaded.length > MAX_LOADED) record.loaded = record.loaded.slice(-MAX_LOADED);
  writeRecord(record);
  pruneStale();
}

/** Record file paths that were READ this session (skill evidence). */
export function recordReadEvidence(
  paths: string | string[],
  sessionId = obligationsSessionId(),
): void {
  const list = (Array.isArray(paths) ? paths : [paths])
    .map((p) => String(p ?? '').trim())
    .filter(Boolean);
  if (list.length === 0) return;
  const record = readRecord(sessionId);
  for (const p of list) if (!record.reads.includes(p)) record.reads.push(p);
  if (record.reads.length > MAX_READS) record.reads = record.reads.slice(-MAX_READS);
  writeRecord(record);
}

/** Record a command that RAN, with its outcome (only successes count). */
export function recordCommandEvidence(
  command: string,
  ok: boolean,
  sessionId = obligationsSessionId(),
): void {
  const cmd = String(command ?? '').trim();
  if (!cmd || !ok) return;
  const record = readRecord(sessionId);
  if (!record.commands.includes(cmd)) record.commands.push(cmd);
  if (record.commands.length > MAX_COMMANDS) record.commands = record.commands.slice(-MAX_COMMANDS);
  writeRecord(record);
}

/** Clear this session's obligations (tests, and an explicit "start over"). */
export function resetObligations(sessionId = obligationsSessionId()): void {
  writeRecord(emptyRecord(sessionId));
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

function normalize(p: string): string {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/** Does a recorded read satisfy `token` (workspace- or skill-relative)? */
function readSatisfies(recorded: string, token: string, skillDir: string): boolean {
  const r = normalize(recorded);
  const t = normalize(token);
  if (!r || !t) return false;
  if (r === t) return true;
  if (r.endsWith(`/${t}`)) return true;
  try {
    if (resolve(skillDir, t) === resolve(recorded)) return true;
    if (resolve(t) === resolve(recorded)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** Does a produced file exist (exact path, or a `*` glob in the basename)? */
function producedExists(token: string, cwd: string): boolean {
  const t = normalize(token);
  if (!t) return false;
  const abs = resolve(cwd, t);
  if (!t.includes('*')) return existsSync(abs);
  try {
    const dir = dirname(abs);
    if (!existsSync(dir)) return false;
    const pattern = new RegExp(
      `^${basename(abs).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    return readdirSync(dir).some((name) => pattern.test(name));
  } catch {
    return false;
  }
}

/**
 * Is the obligation GATE on? **OFF by default.**
 *
 * WHY OFF (2026-11-03). The gate refuses an unqualified `verified:true` claim
 * while a loaded skill's obligation is unmet. It is the only change in this
 * batch that can alter a turn mid-flight, and it has NOT been measured in a
 * bench where a skill actually loads — the v1 harness runs in a workspace with
 * no `.agents/skills`, and the four measured runs made zero `skill` tool calls,
 * so the mechanism never fired. Shipping a mid-turn refusal on an unmeasured
 * mechanism is how a feature makes the agent worse: `api-design` declares
 * `scripts/validate_openapi.py`, which `import yaml` and died on a bare
 * environment, so the gate could demand work that cannot be done.
 *
 * So: inert until someone opts in for a measured A/B. Declaration, evidence
 * collection and the unmet report all still run — an unmet obligation is still
 * SHOWN to the model and carried to the user, it just cannot refuse an ending.
 *
 * Opt in with `NUVIRA_ENFORCE_SKILL_OBLIGATIONS=1`.
 */
export function obligationsEnforced(): boolean {
  const raw = String(process.env.NUVIRA_ENFORCE_SKILL_OBLIGATIONS ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/**
 * Evaluate every obligation of every skill loaded this session.
 *
 * `cwd` is the workspace used for `must_produce` (defaults to process.cwd()).
 * Returns `total === 0` when nothing is loaded, so a turn without skills is
 * never slowed or blocked.
 */
export function evaluateObligations(
  opts: { sessionId?: string; cwd?: string } = {},
): ObligationReport {
  const sessionId = opts.sessionId ?? obligationsSessionId();
  const cwd = opts.cwd ?? process.cwd();
  const record = readRecord(sessionId);
  const unmet: string[] = [];
  let total = 0;
  let satisfied = 0;

  for (const skill of record.loaded) {
    for (const token of skill.obligations.mustRead) {
      total += 1;
      const ok = record.reads.some((r) => readSatisfies(r, token, skill.dir));
      if (ok) satisfied += 1;
      else unmet.push(`read \`${token}\` (${skill.name}) — the skill instructs reading it before finishing`);
    }
    for (const token of skill.obligations.mustRun) {
      total += 1;
      const ok = record.commands.some((c) => c.toLowerCase().includes(token.toLowerCase()));
      if (ok) satisfied += 1;
      else unmet.push(`run \`${token}\` successfully (${skill.name})`);
    }
    for (const token of skill.obligations.mustProduce) {
      total += 1;
      const ok = producedExists(token, cwd);
      if (ok) satisfied += 1;
      else unmet.push(`produce \`${token}\` (${skill.name}) — the file is not in the workspace`);
    }
    for (const token of skill.obligations.mustVerify) {
      total += 1;
      const ok = record.commands.some((c) => c.toLowerCase().includes(token.toLowerCase()));
      if (ok) satisfied += 1;
      else unmet.push(`verify with a passing \`${token}\` run (${skill.name})`);
    }
  }

  return {
    total,
    satisfied,
    unmet,
    skills: record.loaded.map((s) => s.name),
  };
}

/** A one-line-per-skill summary for the `skill` tool output. */
export function describeObligations(o: SkillObligations | undefined): string[] {
  if (!o) return [];
  const lines: string[] = [];
  if (o.mustRead.length > 0) lines.push(`must read: ${o.mustRead.join(', ')}`);
  if (o.mustRun.length > 0) lines.push(`must run: ${o.mustRun.join(', ')}`);
  if (o.mustProduce.length > 0) lines.push(`must produce: ${o.mustProduce.join(', ')}`);
  if (o.mustVerify.length > 0) lines.push(`must verify: ${o.mustVerify.join(', ')}`);
  return lines;
}
