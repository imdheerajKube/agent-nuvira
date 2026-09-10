/**
 * P6a — Learn-style skill authoring prompt (`src/learning/learn-prompt.ts`).
 *
 * The dashboard chat's /learn: the user types "learn the workflow I just
 * did" or "learn from https://docs.example.com/api/quickstart" and the agent
 * turns it into a SKILL.md following the bundled-skill authoring standards.
 * This module builds the AUTHORING PROMPT — the standards + the source
 * (transcript / URL / dir) — so the draft variance is narrow enough for the
 * preview card (accept / edit / reject) to be the gate.
 *
 * Why a PROMPT and not a pipeline (plan phase-7 principle): the agent already
 * has the tools to gather the source (ask_user, read/list/glob/code_search,
 * web_search/read_page) and to save the result (the skill_manage tool
 * action). Nothing new executes; the prompt is the methodology.
 *
 * The authoring standards mirror the bundled skills (src/skills/bundled-skills.ts):
 * description ≤ 1 line, ordered steps with agent types + dependsOn,
 * parameters with required flags, a verification step, tags, and a
 * `^[a-z0-9-]+$` name (the same sandbox allowlist as installs).
 */
/** The authoring-standards block — shared by every learn request. */
export declare const AUTHORING_STANDARDS: string;
/** Build a learn request from the user's words (default: this conversation). */
export declare function buildLearnPrompt(request?: string): string;
//# sourceMappingURL=learn-prompt.d.ts.map