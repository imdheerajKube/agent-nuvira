/**
 * P6a — Skill drafts (`src/learning/skill-drafts.ts`).
 *
 * The /learn preview-card gate: the agent's `skill_manage create` writes a
 * DRAFT (pending) — never a live skill. The dashboard preview card shows
 * accept / edit / reject; only ACCEPT promotes the draft into the live
 * stores (hub SKILL.md + compiled SkillStore), so a bad draft is rejected,
 * never saved silently (the plan's quality gate for model-drafted skills).
 *
 * Storage: `~/.nuvira/skill-drafts/<name>/SKILL.md` (+ optional reference files
 * written via `skill_manage write_file`). Drafts are sandboxed like installs
 * (`^[a-z0-9-]+$` names) and best-effort by construction — a corrupt draft
 * contributes nothing and can never throw out of a read.
 *
 * Promotion (accept) writes BOTH live representations:
 *   - `~/.nuvira/skills/<name>/SKILL.md` — the hub catalog (skill tool loads it
 *     next turn, orchestrator matches it).
 *   - a COMPILED Skill in the SkillStore — `nuvira skill list` shows it, the
 *     orchestrator's findMatch sees it (the plan's expected working: after ✅
 *     the skill appears in `nuvira skill list` and loads via the skill tool).
 */
import type { Skill } from './skill-types.js';
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
/**
 * Default drafts root: NUVIRA_MEMORY_DIR (when set) → ~/.nuvira/skill-drafts.
 * Resolved LAZILY so tests can set the env before the first read (the same
 * pattern cache.ts uses) — production is byte-identical when unset.
 */
export declare function defaultDraftsRoot(): string;
/** Default hub-skills root for promotion (NUVIRA_MEMORY_DIR → ~/.nuvira/skills). */
export declare function defaultSkillsRoot(): string;
/**
 * Validate an authored SKILL.md: sandbox-safe name, frontmatter present with
 * a matching `name:` + `description:`, and a non-trivial body. Returns an
 * error string, or null when the draft is valid.
 */
export declare function validateAuthoredSkill(name: string, markdown: string): string | null;
/** List every draft (sorted by name). Never throws. */
export declare function listDrafts(root?: string): SkillDraft[];
/** Get one draft by name (null when missing or corrupt). */
export declare function getDraft(name: string, root?: string): SkillDraft | null;
/** Save (or overwrite) a draft. Validates before writing — never throws. */
export declare function writeDraft(name: string, markdown: string, root?: string): DraftWriteResult;
/** Add a reference file to a draft's dir (sandboxed: no traversal). */
export declare function writeDraftFile(name: string, file: string, content: string, root?: string): DraftWriteResult;
/** Delete a draft (the preview card's reject). True when something was removed. */
export declare function deleteDraft(name: string, root?: string): boolean;
/**
 * Parse an authored SKILL.md into a compiled Skill (the `nuvira skill list`
 * representation). Steps come from `### Step N — [agentType] title` sections
 * in the body; parameters from the `## Parameters` section (bulleted
 * `name — description (required: yes/no, type: string|file-path|choice)`).
 * Best-effort: a body that does not follow the section grammar yields a
 * single runner step — the hub SKILL.md remains the full methodology.
 */
export declare function compileAuthoredSkill(name: string, markdown: string, opts?: {
    home?: string;
}): Skill;
/**
 * ACCEPT a draft: promote it into the live stores — hub SKILL.md
 * (`~/.nuvira/skills/<name>/SKILL.md`, root injectable) + a compiled Skill in
 * the SkillStore — then delete the draft. Returns { ok, skill? }.
 */
export declare function acceptDraft(name: string, opts?: {
    draftsRoot?: string;
    skillsRoot?: string;
}): {
    ok: boolean;
    name: string;
    skill?: Skill;
    reason?: string;
};
//# sourceMappingURL=skill-drafts.d.ts.map