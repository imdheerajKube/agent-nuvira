/**
 * P6a — Skill drafts (`src/learning/skill-drafts.ts`).
 *
 * The /learn preview-card gate: the agent's `skill_manage create` writes a
 * DRAFT (pending) — never a live skill. The dashboard preview card shows
 * accept / edit / reject; only ACCEPT promotes the draft into the live
 * stores (hub SKILL.md + compiled SkillStore), so a bad draft is rejected,
 * never saved silently (the plan's quality gate for model-drafted skills).
 *
 * Storage: `~/.buff/skill-drafts/<name>/SKILL.md` (+ optional reference files
 * written via `skill_manage write_file`). Drafts are sandboxed like installs
 * (`^[a-z0-9-]+$` names) and best-effort by construction — a corrupt draft
 * contributes nothing and can never throw out of a read.
 *
 * Promotion (accept) writes BOTH live representations:
 *   - `~/.buff/skills/<name>/SKILL.md` — the hub catalog (skill tool loads it
 *     next turn, orchestrator matches it).
 *   - a COMPILED Skill in the SkillStore — `buff skill list` shows it, the
 *     orchestrator's findMatch sees it (the plan's expected working: after ✅
 *     the skill appears in `buff skill list` and loads via the skill tool).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, rmdirSync } from 'node:fs';
import { join, normalize, relative, dirname, sep } from 'node:path';
import { homedir } from 'node:os';

import { parseCatalogFrontmatter } from './hub-skill-catalog.js';
import { getSkillStore } from './skill-store.js';
import type { Skill, SkillStep, SkillParameter } from './skill-types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A pending authored skill (the preview-card payload). */
export interface SkillDraft {
  /** Sandboxed draft name (the future skill id). */
  name: string;
  /** Frontmatter description (one line). */
  description: string;
  /** The full SKILL.md (frontmatter + body). */
  markdown: string;
  /** When the draft was last written (epoch ms). */
  updatedAt: number;
}

/** Result of a draft write/delete (never throws — the tool reads it). */
export interface DraftWriteResult {
  ok: boolean;
  name: string;
  reason?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9-]+$/;

/**
 * Default drafts root: BUFF_MEMORY_DIR (when set) → ~/.buff/skill-drafts.
 * Resolved LAZILY so tests can set the env before the first read (the same
 * pattern cache.ts uses) — production is byte-identical when unset.
 */
export function defaultDraftsRoot(): string {
  return process.env.BUFF_MEMORY_DIR
    ? join(process.env.BUFF_MEMORY_DIR, 'skill-drafts')
    : join(homedir(), '.buff', 'skill-drafts');
}

/** Default hub-skills root for promotion (BUFF_MEMORY_DIR → ~/.buff/skills). */
export function defaultSkillsRoot(): string {
  return process.env.BUFF_MEMORY_DIR
    ? join(process.env.BUFF_MEMORY_DIR, 'skills')
    : join(homedir(), '.buff', 'skills');
}

// ─── Path helpers (dirs injectable for hermetic tests) ──────────────────────

function draftsDir(root: string): string {
  return root;
}

function draftDir(root: string, name: string): string {
  return join(root, name);
}

function draftSkillPath(root: string, name: string): string {
  return join(draftDir(root, name), 'SKILL.md');
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate an authored SKILL.md: sandbox-safe name, frontmatter present with
 * a matching `name:` + `description:`, and a non-trivial body. Returns an
 * error string, or null when the draft is valid.
 */
export function validateAuthoredSkill(name: string, markdown: string): string | null {
  const clean = name.trim();
  if (!NAME_RE.test(clean)) {
    return `Refused: skill name '${clean}' is not in [a-z0-9-] (lowercase + hyphens — the id the skill tool loads by).`;
  }
  if (!markdown || !markdown.trim()) {
    return 'Refused: the SKILL.md body is empty — author the steps before creating the skill.';
  }
  const fm = parseCatalogFrontmatter(markdown);
  if (!fm.name) {
    return 'Refused: SKILL.md frontmatter is missing `name:` — the skill needs one (the id it is saved under).';
  }
  if (fm.name !== clean) {
    return `Refused: frontmatter declares name '${fm.name}' but the draft id is '${clean}' — they must match.`;
  }
  if (!fm.description || fm.description.length === 0) {
    return 'Refused: SKILL.md frontmatter is missing `description:` — one line describing what the skill does.';
  }
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  if (body.length < 40) {
    return 'Refused: the SKILL.md body is too thin to be a reusable methodology — add ordered steps with agent types.';
  }
  return null;
}

// ─── Draft store ────────────────────────────────────────────────────────────

/** List every draft (sorted by name). Never throws. */
export function listDrafts(root = defaultDraftsRoot()): SkillDraft[] {
  try {
    if (!existsSync(root)) return [];
    const out: SkillDraft[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !NAME_RE.test(entry.name)) continue;
      const d = getDraft(entry.name, root);
      if (d) out.push(d);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Get one draft by name (null when missing or corrupt). */
export function getDraft(name: string, root = defaultDraftsRoot()): SkillDraft | null {
  if (!NAME_RE.test(name)) return null;
  try {
    const path = draftSkillPath(root, name);
    if (!existsSync(path)) return null;
    const markdown = readFileSync(path, 'utf-8');
    const fm = parseCatalogFrontmatter(markdown);
    let mtime = Date.now();
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      /* keep now */
    }
    return {
      name,
      description: fm.description || 'No description in frontmatter.',
      markdown,
      updatedAt: mtime,
    };
  } catch {
    return null;
  }
}

/** Save (or overwrite) a draft. Validates before writing — never throws. */
export function writeDraft(name: string, markdown: string, root = defaultDraftsRoot()): DraftWriteResult {
  const invalid = validateAuthoredSkill(name, markdown);
  if (invalid) return { ok: false, name: name.trim(), reason: invalid };
  try {
    mkdirSync(draftDir(root, name.trim()), { recursive: true });
    writeFileSync(draftSkillPath(root, name.trim()), markdown, 'utf-8');
    return { ok: true, name: name.trim() };
  } catch (err) {
    return { ok: false, name: name.trim(), reason: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Add a reference file to a draft's dir (sandboxed: no traversal). */
export function writeDraftFile(
  name: string,
  file: string,
  content: string,
  root = defaultDraftsRoot(),
): DraftWriteResult {
  if (!NAME_RE.test(name)) return { ok: false, name, reason: `Refused: draft name '${name}' is not in [a-z0-9-].` };
  const rel = normalize(file).replace(/^([/\\])+/, '');
  if (!rel || rel.startsWith('..') || relative('', rel).startsWith('..')) {
    return { ok: false, name, reason: `Refused: reference file '${file}' escapes the draft dir.` };
  }
  try {
    const dir = draftDir(root, name);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, rel);
    const dirNorm = normalize(dir) + sep; // files may NOT escape the draft dir
    if (!normalize(target).startsWith(dirNorm)) {
      return { ok: false, name, reason: `Refused: reference file '${file}' escapes the draft dir.` };
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
    return { ok: true, name };
  } catch (err) {
    return { ok: false, name, reason: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Delete a draft (the preview card's reject). True when something was removed. */
export function deleteDraft(name: string, root = defaultDraftsRoot()): boolean {
  if (!NAME_RE.test(name)) return false;
  try {
    const dir = draftDir(root, name);
    if (!existsSync(dir)) return false;
    rmDirRecursive(dir);
    return true;
  } catch {
    return false;
  }
}

function rmDirRecursive(dir: string): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) rmDirRecursive(p);
      else unlinkSync(p);
    }
    rmdirSync(dir);
  } catch {
    /* best-effort */
  }
}

// ─── Promotion (accept) ─────────────────────────────────────────────────────

/**
 * Parse an authored SKILL.md into a compiled Skill (the `buff skill list`
 * representation). Steps come from `### Step N — [agentType] title` sections
 * in the body; parameters from the `## Parameters` section (bulleted
 * `name — description (required: yes/no, type: string|file-path|choice)`).
 * Best-effort: a body that does not follow the section grammar yields a
 * single runner step — the hub SKILL.md remains the full methodology.
 */
export function compileAuthoredSkill(
  name: string,
  markdown: string,
  opts?: { home?: string },
): Skill {
  const fm = parseCatalogFrontmatter(markdown);
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  const now = Date.now();

  // Steps from `### Step N — [agentType] title` sections (default runner).
  const steps: SkillStep[] = [];
  const stepRe = /^###\s+Step\s+\d+\s*—?\s*(?:\[([^\]]+)\])?\s*(.*)$/gm;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = stepRe.exec(body)) !== null) {
    const agentType = (match[1] || 'runner').trim();
    const title = (match[2] || '').trim();
    // The paragraph after the heading is the step body (until the next heading).
    const after = body.slice(match.index + match[0].length).trim();
    const nextHeading = /^#{2,3}\s/m.exec(after);
    const stepText = nextHeading ? after.slice(0, nextHeading.index).trim() : after.slice(0, 400).trim();
    const description = title
      ? `${title}${stepText ? ` — ${stepText.split('\n')[0].slice(0, 200)}` : ''}`
      : stepText.split('\n')[0].slice(0, 300);
    steps.push({
      agentType,
      description: description || `Step ${i + 1}: follow the methodology in the SKILL.md body.`,
      dependsOn: i > 0 ? [`step-${i - 1}`] : [],
    });
    i++;
  }
  if (steps.length === 0) {
    steps.push({
      agentType: 'runner',
      description: 'Execute the methodology described in the SKILL.md body, verifying the outcome as its final step describes.',
      dependsOn: [],
    });
  }

  // Parameters from a `## Parameters` bullet list (`name — description (required: yes|no, type: …)`).
  const parameters: SkillParameter[] = [];
  const paramsStart = /^##\s+Parameters\s*$/m.exec(body);
  if (paramsStart) {
    const after = body.slice(paramsStart.index + paramsStart[0].length);
    const nextHeading = /^##\s/m.exec(after);
    const section = after.slice(0, nextHeading ? nextHeading.index : after.length);
    const bulletRe = /^[-*]\s+([a-zA-Z0-9_-]+)\s*[—:]\s*(.+)$/gm;
    let pm: RegExpExecArray | null;
    while ((pm = bulletRe.exec(section)) !== null) {
      const pName = pm[1];
      const rest = pm[2].trim();
      const required = /required\s*:\s*yes|required\b/i.test(rest) && !/required\s*:\s*no/i.test(rest);
      const type = /type\s*:\s*(string|file-path|code-snippet|choice)/i.exec(rest)?.[1] as SkillParameter['type'] | undefined;
      const description = rest.replace(/\(.*\)/g, '').trim().slice(0, 200) || rest.slice(0, 200);
      parameters.push({
        name: pName,
        description,
        type: type ?? 'string',
        required,
      });
    }
  }

  const id = `skill-${name}-${now.toString(36)}`;
  return {
    id,
    name,
    description: fm.description || `Learned skill: ${name}`,
    version: '1.0.0',
    goalPattern: fm.description || name,
    steps,
    parameters,
    tags: (() => {
      try {
        const tagsLine = /^tags:\s*\[?([^\n\]]*)\]?$/m.exec(markdown)?.[1];
        return tagsLine ? tagsLine.split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean).slice(0, 5) : [];
      } catch {
        return [];
      }
    })(),
    sourceTrajectoryIds: ['learned'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: now,
    lastUsedAt: now,
  };
}

/**
 * ACCEPT a draft: promote it into the live stores — hub SKILL.md
 * (`~/.buff/skills/<name>/SKILL.md`, root injectable) + a compiled Skill in
 * the SkillStore — then delete the draft. Returns { ok, skill? }.
 */
export function acceptDraft(
  name: string,
  opts?: { draftsRoot?: string; skillsRoot?: string },
): { ok: boolean; name: string; skill?: Skill; reason?: string } {
  const draftsRoot = opts?.draftsRoot ?? defaultDraftsRoot();
  const skillsRoot = opts?.skillsRoot ?? defaultSkillsRoot();
  const draft = getDraft(name, draftsRoot);
  if (!draft) return { ok: false, name, reason: `Draft '${name}' not found — nothing to accept.` };
  const invalid = validateAuthoredSkill(name, draft.markdown);
  if (invalid) return { ok: false, name, reason: invalid };

  try {
    // 1. Hub SKILL.md (the skill tool loads it next turn).
    const hubDir = join(skillsRoot, name);
    mkdirSync(hubDir, { recursive: true });
    writeFileSync(join(hubDir, 'SKILL.md'), draft.markdown, 'utf-8');
    // 2. Compiled SkillStore (`buff skill list` shows it, findMatch sees it).
    const skill = compileAuthoredSkill(name, draft.markdown);
    getSkillStore().save(skill);
    // 3. Draft gone — it is now live.
    deleteDraft(name, draftsRoot);
    return { ok: true, name, skill };
  } catch (err) {
    return { ok: false, name, reason: `Accept failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
