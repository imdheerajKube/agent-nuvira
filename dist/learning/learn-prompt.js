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
export const AUTHORING_STANDARDS = [
    'Author a single SKILL.md for the workflow. Follow the bundled-skill standards EXACTLY:',
    '1. Frontmatter: `name` (lowercase, hyphens only, ^[a-z0-9-]+$ — this is the id the skill tool loads by), `description` (ONE line: what the skill does + when to use it), optional `tags`.',
    '   - If the skill requires API keys or environment variables, add `required_environment_variables:` (YAML list of env var names).',
    '   - Example: `required_environment_variables: [OPENAI_API_KEY, STABILITY_API_KEY]`',
    '   - This enables automatic prompting: when the skill loads, the system prompts for missing vars and saves them to ~/.nuvira/.env.',
    '2. Body: a `## Steps` section with 3-7 ordered steps. Each step: `### Step N — [agentType] short title` then a paragraph describing what to DO (agentType from: context-gatherer, planner, runner, writer, reviewer, tester, security, debugger). Steps must list dependencies (`depends on: step N`) when order matters.',
    '3. A `## Parameters` section: each parameter with name, description, required (yes/no), type (string | file-path | choice).',
    '4. A `## Environment Variables` section (if the skill needs API keys or tokens): for each var, list its name, purpose, where to get it (URL), and whether required/optional. Then add the var names to `required_environment_variables` in frontmatter.',
    '5. END with a verification step: how to know the workflow ran correctly.',
    '6. Keep the methodology generic enough to reuse (no hardcoded names/paths from the source), but concrete enough to execute without asking.',
].join('\n');
/** Build a learn request from the user's words (default: this conversation). */
export function buildLearnPrompt(request) {
    const source = request && request.trim().length > 0
        ? request.trim()
        : 'the workflow just demonstrated in THIS conversation (read the recent turns)';
    return [
        'The user wants to capture a reusable workflow as a SKILL.',
        `Source to learn from: ${source}`,
        '',
        'Your job:',
        '1. GATHER the source with your tools — if it is a URL, read it (web_search / read_page); if it is a directory or files, read them; if it is "this conversation", use the transcript above. Ask the user (ask_user) only when the source is genuinely ambiguous.',
        '2. DRAFT the skill, then call the skill tool with action: create (skill_manage) passing the complete SKILL.md — it will be shown to the user as a preview card (accept / edit / reject). Do NOT save anything yourself.',
        '3. If the user rejects or asks for changes, revise the draft (skill_manage action: create again, or patch) and re-present.',
        '',
        AUTHORING_STANDARDS,
    ].join('\n');
}
//# sourceMappingURL=learn-prompt.js.map