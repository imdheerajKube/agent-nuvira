/**
 * Bundled Skills — first-party skills shipped with the product.
 *
 * These follow the industry progressive-disclosure pattern (Agent Skills):
 * - Level 1 (metadata): name/description/goalPattern/tags are the lightweight
 *   catalog the planner and findMatch() see on every goal.
 * - Level 2 (instructions): the step descriptions carry the full methodology
 *   and are injected into the planner prompt ONLY when a goal matches the
 *   skill (model-selected activation — the agent decides, never blind auto-run).
 *
 * Bundled skills are seeded into ~/.nuvira/skills/ by SkillStore.seedBundledSkills()
 * so they also work with `nuvira skill run <name>` and the skill-runner agent.
 *
 * To add a provider to the website-deploy skill, add a section to the
 * relevant step description — no code change required.
 */
import { PHASE3_SKILLS } from './bundled-skills-phase3.js';
import { DOCKER_SKILLS } from './bundled-skills-docker.js';
import { EXTENDED_SKILLS } from './bundled-skills-extended.js';
/** Fixed timestamp so bundled skills never decay (re-seeded identical). */
const BUNDLED_CREATED_AT = 1_752_000_000_000;
/** Stable IDs for bundled skills (deterministic — re-seeding overwrites cleanly). */
export const BUNDLED_SKILL_ID_WEBSITE_DEPLOY = 'skill-website-deploy';
export const BUNDLED_SKILL_ID_DOCX = 'skill-docx';
/**
 * Website deployment skill — encodes deployment methodology for known hosting
 * providers. Built from the Cloudflare Pages gap-assessment (wrangler 4 does
 * NOT auto-create Pages projects; `pages project create --production-branch`
 * must precede the first `pages deploy`).
 */
export const websiteDeploySkill = {
    id: BUNDLED_SKILL_ID_WEBSITE_DEPLOY,
    name: 'website-deploy',
    description: 'Deploy a static site or built web app to a hosting provider (Cloudflare Pages, Netlify, Vercel, GitHub Pages, AWS S3+CloudFront, Azure Static Web Apps, Firebase Hosting) and verify the live URL. Use when the goal asks to deploy, publish, host, or ship a website or web app to a hosting provider.',
    version: '1.0.0',
    goalPattern: 'deploy publish host website web app site landing page cloudflare pages netlify vercel github pages hosting static',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Inspect the site directory to identify the built output (index.html or a framework build folder like dist/ or build/), detect which hosting CLIs are installed and authenticated on this machine (wrangler, netlify, vercel, gh, aws, firebase), and report the site type and output directory.',
            dependsOn: [],
        },
        {
            agentType: 'runner',
            description: [
                'Ensure the hosting project is ready for the target provider (skip creation if the project already exists):',
                '- cloudflare-pages: wrangler 4 does NOT auto-create Pages projects, so create it first (ignore the error if it already exists): Run `wrangler pages project create {{projectName}} --production-branch {{productionBranch}}`',
                '- netlify: no setup needed — the CLI creates the site on first deploy',
                '- vercel: no setup needed — the CLI creates the project on first deploy',
                '- github-pages: ensure the folder is a git repo with a remote and a .nojekyll file: Run `git init 2>/dev/null; touch .nojekyll; git add -A && git commit -m "init" 2>/dev/null || true`',
                '- aws-s3: ensure the S3 bucket exists with static website hosting enabled: Run `aws s3api create-bucket --bucket {{projectName}} --region us-east-1 2>/dev/null || true; aws s3 website s3://{{projectName}} --index-document index.html --error-document 404.html 2>/dev/null || true`',
                '- azure-swa: no setup needed — the CLI creates the app',
                '- firebase-hosting: ensure firebase.json exists with a public directory set to {{outputDir}} (create it if missing).',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: [
                `Deploy the built site in '{{outputDir}}' to the '{{provider}}' provider and capture the deployment URL printed by the command:`,
                '- cloudflare-pages: Run `wrangler pages deploy {{outputDir}} --project-name {{projectName}}`',
                '- netlify: Run `npx netlify-cli deploy --prod --dir={{outputDir}}`',
                '- vercel: Run `npx vercel --prod --yes`',
                '- github-pages: Run `git add -A && git commit -m "deploy: website" && git push origin {{productionBranch}}` (or `npx gh-pages -d {{outputDir}}` to push a gh-pages branch)',
                '- aws-s3: Run `aws s3 sync {{outputDir}} s3://{{projectName}} --delete` (deployment URL is https://{{projectName}}.s3-website-<region>.amazonaws.com)',
                '- azure-swa: Run `npx @azure/static-web-apps-cli deploy --env production`',
                '- firebase-hosting: Run `npx firebase-tools deploy --only hosting`',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'runner',
            description: 'Verify the deployed site is live: fetch the deployment URL printed by the deploy step with curl and confirm it returns HTTP 200 and the site HTML. For example: Run `curl -s -o /dev/null -w "%{http_code}" <deployed-url>` then Run `curl -s <deployed-url> | head -c 400`',
            dependsOn: ['step-2'],
        },
        {
            agentType: 'reviewer',
            description: 'Review the deployment: confirm the live URL returns HTTP 200 with the expected page content, and that the deployed files (HTML/CSS/JS) are present and correctly referenced.',
            dependsOn: ['step-3'],
        },
    ],
    parameters: [
        {
            name: 'provider',
            description: 'Hosting provider to deploy to: cloudflare-pages, netlify, vercel, github-pages, aws-s3, azure-swa, or firebase-hosting',
            type: 'choice',
            required: true,
            options: [
                'cloudflare-pages',
                'netlify',
                'vercel',
                'github-pages',
                'aws-s3',
                'azure-swa',
                'firebase-hosting',
            ],
        },
        {
            name: 'projectName',
            description: 'Provider project/site/bucket name',
            type: 'string',
            required: false,
        },
        {
            name: 'outputDir',
            description: 'Directory containing the built site files (default: current directory)',
            type: 'file-path',
            required: false,
            defaultValue: '.',
        },
        {
            name: 'productionBranch',
            description: 'Production branch for the hosting project (default: main)',
            type: 'string',
            required: false,
            defaultValue: 'main',
        },
    ],
    tags: [
        'deploy',
        'website',
        'hosting',
        'cloudflare',
        'netlify',
        'vercel',
        'github-pages',
        'aws',
        'azure',
        'firebase',
        'publish',
    ],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * P5 — first-party capability skills at the website-deploy depth bar.
 *
 * Round-3 audit (matrix rows 29–33): a skill "existing" meant ONE bundled
 * skill and an empty registry — the named capabilities (code assessment,
 * roadmap, plan tracking, test strategy) had no methodology. These close
 * that: each carries real step-by-step methodology (what to read, how to
 * judge, what to produce), ordered dependencies, parameters, and a
 * verification step — the same depth bar as website-deploy, so the P0.8
 * skill tool has substantive content to load from the dashboard chat.
 */
/** Stable IDs for the P5 capability skills. */
export const BUNDLED_SKILL_ID_CODE_ASSESSMENT = 'skill-code-assessment';
export const BUNDLED_SKILL_ID_TECHNICAL_ROADMAP = 'skill-technical-roadmap';
export const BUNDLED_SKILL_ID_PLAN_CREATE_TRACK = 'skill-plan-create-track';
export const BUNDLED_SKILL_ID_TEST_STRATEGY = 'skill-test-strategy';
/**
 * Code assessment skill — structured codebase evaluation.
 *
 * The ask (P5b): *"understanding a task of code assessment, evaluating code
 * and recommendations, generate gaps and suggest technical roadmap"* as
 * structured artifacts, not black-box pipeline summaries. The interactive
 * read→judge→recommend loop exists (P0.2–P0.5 tools); this skill gives the
 * agent the METHODOLOGY: what to read, how to score each dimension, and how
 * to deliver gap findings + prioritized recommendations as an artifact.
 */
export const codeAssessmentSkill = {
    id: BUNDLED_SKILL_ID_CODE_ASSESSMENT,
    name: 'code-assessment',
    description: 'Perform a structured codebase assessment: read the project, evaluate it across correctness/security/performance/architecture/testability dimensions, produce a gap-findings list, and deliver prioritized recommendations with effort estimates. Use when the goal asks to assess, evaluate, review, audit, or analyze code quality.',
    version: '1.0.0',
    goalPattern: 'assess evaluate review audit analyze code quality codebase project architecture security performance correctness gaps recommendations',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Map the project first — read the top level (list_dir) and key manifests: package.json / pyproject.toml / go.mod, README, tsconfig / eslint config, and the test layout. Determine:',
                '- the language/framework stack and entry points',
                '- the build/test/typecheck commands (from package.json scripts or equivalent)',
                '- the module boundaries (src/, lib/, app/ dirs) and their sizes',
                'Record the file count and rough LOC per top-level area so the assessment has scope context.',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'reviewer',
            description: [
                'Evaluate the code across these dimensions — read real files (read_file / code_search), never guess:',
                '- correctness: error handling, edge cases, null/undefined paths, boundary conditions',
                '- security: secrets in code, injection (SQL/command/HTML), authn/authz gaps, unsafe deserialization, dependency risk',
                '- performance: obvious O(n^2) patterns, N+1 queries, blocking calls in hot paths, unbounded caches',
                '- architecture: coupling, god modules, duplicate logic, missing interfaces, config sprawl, dead code',
                '- testability: coverage gaps, untestable functions (hidden side effects), missing unit/integration boundaries',
                'For each finding record: file:line, the issue, why it matters, and a severity (critical / major / minor).',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'writer',
            description: [
                'Produce the assessment artifact with this exact structure:',
                '1. Scope — what was assessed (stack, size, areas)',
                '2. Gap findings — each with file:line, severity, and why it matters (sorted critical → minor)',
                '3. Strengths — what is already done well (keep it honest)',
                '4. Prioritized recommendations — grouped by quick wins / this quarter / later, each with effort (S/M/L) and risk',
                '5. Suggested next step — the single highest-leverage action to take first',
                'Deliver it as a structured markdown artifact (heading per section, bullets per finding).',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify the artifact: every critical/major finding has a file:line reference (no vague "somewhere in the codebase" claims), severities are consistent, and the recommendations are actionable (a concrete change, not a platitude). Revise the artifact if any finding lacks evidence.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [
        {
            name: 'target',
            description: 'Path or scope to assess (default: the whole project)',
            type: 'file-path',
            required: false,
            defaultValue: '.',
        },
        {
            name: 'focus',
            description: 'Optional comma-separated dimension focus (e.g. security, performance)',
            type: 'string',
            required: false,
        },
    ],
    tags: ['assessment', 'code-review', 'audit', 'quality', 'gaps', 'recommendations'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * Technical roadmap skill — current state → target state → phased plan.
 *
 * The P5b companion: after (or alongside) an assessment, produce a phased
 * technical roadmap with dependencies, effort, and risk per phase — the
 * "suggest technical roadmap" half of the named capability.
 */
export const technicalRoadmapSkill = {
    id: BUNDLED_SKILL_ID_TECHNICAL_ROADMAP,
    name: 'technical-roadmap',
    description: 'Build a phased technical roadmap from the current state to a target state: capture the current architecture, define the target, then produce ordered phases with dependencies, effort, risk, and success criteria. Use when the goal asks for a roadmap, migration plan, technical plan, or phased upgrade path.',
    version: '1.0.0',
    goalPattern: 'roadmap migration plan technical plan phased upgrade path target state current state phases dependencies milestones',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Establish the CURRENT state with evidence: read the architecture-relevant files (entry points, config, module boundaries, package manifests), and note the stack, key flows, and known constraints (legacy pieces, hard dependencies, team-visible risk). Keep it factual — cite files.',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'writer',
            description: [
                'Define the TARGET state as concrete outcomes, not slogans: for each area (stack, architecture, quality, operations) state what changes and what the measurable success criterion is (e.g. "typecheck passes with noEmit", "deploys are under 5 minutes").',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'planner',
            description: [
                'Design the PHASES between current and target. Each phase must have:',
                '- a clear outcome and exit criteria',
                '- dependencies on other phases (explicit dependsOn)',
                '- effort estimate (S/M/L) and risk (low/medium/high)',
                '- what is explicitly OUT of scope (so phases stay small and shippable)',
                'Order them so each phase leaves the system working (never a long broken window). Typically 3–5 phases.',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'writer',
            description: [
                'Produce the roadmap artifact: current state (cited) → target state (measurable) → phases (each with outcome, dependencies, effort, risk, out-of-scope), plus a critical-path note (which phases gate everything else) and a first-step recommendation.',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
    ],
    parameters: [
        {
            name: 'target',
            description: 'Path or scope for the roadmap (default: the whole project)',
            type: 'file-path',
            required: false,
            defaultValue: '.',
        },
        {
            name: 'horizon',
            description: 'Roadmap horizon, e.g. "6 months" or "this quarter" (default: 6 months)',
            type: 'string',
            required: false,
            defaultValue: '6 months',
        },
    ],
    tags: ['roadmap', 'planning', 'migration', 'architecture', 'phases', 'strategy'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * Plan create + track skill — multi-step jobs with visible progress.
 *
 * Complements the P0.7 plan_todo tool: this skill is the METHODOLOGY for
 * breaking a job into tracked steps (declare via plan_todo, update statuses
 * as work progresses, mark blocked and continue), so every multi-step task
 * shows "N/M done" instead of a wall of lines.
 */
export const planCreateTrackSkill = {
    id: BUNDLED_SKILL_ID_PLAN_CREATE_TRACK,
    name: 'plan-create-track',
    description: 'Plan and track a multi-step job: break the goal into ordered, verifiable steps, declare them with plan_todo, work through them updating status (running → done, or blocked with a note), and finish with a summary. Use for any job with 2+ steps where progress visibility matters.',
    version: '1.0.0',
    goalPattern: 'plan create track steps todo checklist progress multi-step job execute work through order',
    steps: [
        {
            agentType: 'planner',
            description: [
                'Break the goal into 3–7 ordered steps. Each step must be:',
                '- independently verifiable (you will know it is done by running/reading something)',
                '- small enough to complete in one working session',
                '- ordered so dependencies come first (but no stricter than necessary)',
                'Give each step a short stable id (reproduce, fix, verify) and a one-line description. Declare them with the plan_todo tool (action: create, goal + steps).',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'runner',
            description: [
                'Work the steps IN ORDER, updating plan_todo (action: update, id + status) at each transition:',
                '- mark the current step running before starting it',
                '- mark it done only after its exit criterion is verified (a test passed, a file reads correctly, a command succeeded)',
                '- if a step is blocked (an external dependency, a failure you cannot fix now), mark it blocked and CONTINUE with the next step — never stall the whole plan on one step',
                'Use the coding tools (read_file / edit_file / run_terminal) to actually do the work — the plan is a map, not the work itself.',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'reviewer',
            description: [
                'Close the loop: confirm every step is done or explicitly blocked, re-check the exit criteria for the done steps (run the final verification once more if cheap), and write a closing summary: what was completed, what is blocked (if anything), and the natural next step.',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
    ],
    parameters: [
        {
            name: 'goal',
            description: 'The goal to plan and execute',
            type: 'string',
            required: true,
        },
    ],
    tags: ['plan', 'todo', 'tracking', 'checklist', 'progress', 'execution'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * Test strategy skill — plan and run a deep test pass.
 *
 * The "test not only by scripts but by actual invocation" capability as a
 * methodology: map the test surface, decide the matrix (unit/integration/e2e
 * + the runs that matter), execute the real commands, and deliver a verdict
 * with coverage evidence — the deep-backward-testing practice.
 */
export const testStrategySkill = {
    id: BUNDLED_SKILL_ID_TEST_STRATEGY,
    name: 'test-strategy',
    description: 'Plan and run a deep test pass: map the test surface, choose the right matrix (unit / integration / e2e, focused runs for changed code), execute the real commands (npm test, vitest, pytest, etc.), and deliver a verdict with evidence. Use when the goal asks to test, verify, check for regressions, or prove a change is safe.',
    version: '1.0.0',
    goalPattern: 'test verify regression check coverage suite unit integration e2e pass run tests prove safe',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Map the test surface with evidence: read the test config (vitest/jest/pytest config in the manifests), list the test files (glob "**/*.test.*" or tests/), and note the commands that run them (from package.json scripts or equivalent). Identify:',
                '- the unit test entry points and how fast they are',
                '- any integration/e2e suites and their prerequisites (services, fixtures, env vars)',
                '- which areas changed and deserve a focused run first',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: [
                'Choose the matrix — never just "run everything":',
                '- focused: the tests touching the changed code (fastest, run FIRST)',
                '- unit: the full unit suite (the main regression net)',
                '- integration: the suites that exercise real boundaries (DB, HTTP, filesystem)',
                '- e2e: the slow end-to-end flows — run only when unit+integration are green',
                '- typecheck/build: static verification alongside the tests',
                'Record the exact commands and the order, with the reason each level matters.',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: [
                'Execute the matrix IN ORDER with the real commands via run_terminal (never claim tests pass without running them):',
                '- start with the focused run — a failure here tells you the change broke something before the slow suites waste time',
                '- then the full unit suite',
                '- then integration (and e2e only if the cheaper levels are green)',
                '- run typecheck/build as the static gate',
                'On a failure: read the failing test + the code (read_file), fix, and re-run that focused test until green before moving up the matrix.',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: [
                'Deliver the verdict with evidence: what ran (exact commands + pass/fail counts), what passed, what failed and why (file:line), coverage gaps that matter, and a clear recommendation (safe to merge / needs fixes / needs more tests). Never state "tests pass" without the actual run output.',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
    ],
    parameters: [
        {
            name: 'scope',
            description: 'Scope of the test pass: focused | unit | integration | full (default: full)',
            type: 'choice',
            required: false,
            options: ['focused', 'unit', 'integration', 'full'],
            defaultValue: 'full',
        },
        {
            name: 'target',
            description: 'Path or files to focus on (for scope=focused)',
            type: 'file-path',
            required: false,
        },
    ],
    tags: ['test', 'testing', 'verification', 'regression', 'coverage', 'quality'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * DOCX skill — create, read, edit, and manipulate Word documents (.docx /
 * .dotx). A .docx is a ZIP archive of XML files; the methodology encodes the
 * task→approach choice (create with docx-js / edit the XML directly / read
 * with pandoc), the docx-js footguns (page size, tables, lists, TOC), the
 * edit pipeline (unzip → merge runs → edit in place → re-zip → XSD validate),
 * tracked-changes + comment mechanics, and render-based verification.
 */
export const docxSkill = {
    id: BUNDLED_SKILL_ID_DOCX,
    name: 'docx',
    description: 'Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files) or Word templates (.dotx files). Triggers include: any mention of Word doc, word document, .docx, .dotx, or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx or .dotx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a report, memo, letter, template, or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation.',
    version: '1.0.0',
    goalPattern: 'docx doc word document template dotx create read edit manipulate convert report memo letter toc tracked changes comments',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Determine the task and choose the approach — a .docx is a ZIP archive of XML files:',
                '- Create a new document → write a `docx` (npm) script (see the create step for the footguns)',
                '- Edit an existing document → `unzip` → edit `word/document.xml` → re-zip (docx-js cannot open existing files)',
                '- Read content → `pandoc -t markdown file.docx`',
                'Gather the deliverable spec: document type (report / memo / letter / template), target format (.docx vs .dotx), US Letter vs A4 page size, and whether tracked changes or comments are required.',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'runner',
            description: [
                'Create a new document with docx-js. `docx` is preinstalled — do NOT run `npm install` first; write the script and `require(\'docx\')` directly. Only if that require fails: `npm install docx`. Known footguns:',
                '- Page size defaults to A4. For US Letter set `page: { size: { width: 12240, height: 15840 } }` (DXA; 1440 = 1\u2033)',
                '- Landscape: pass portrait dimensions and `orientation: PageOrientation.LANDSCAPE` — docx-js swaps width/height internally',
                '- Tables need dual widths: set `columnWidths` on the table AND `width` on every cell, both in `WidthType.DXA` (PERCENTAGE breaks in Google Docs); column widths must sum to the table width',
                '- Table shading: use `ShadingType.CLEAR`, never `SOLID` (renders black)',
                '- Lists: never insert `\u2022` literally; use a `numbering` config with `LevelFormat.BULLET`',
                '- `ImageRun` requires `type:` ("png", "jpg", …)',
                '- `PageBreak` must be inside a `Paragraph`',
                '- Never use `\n` — use separate `Paragraph` elements',
                '- TOC: headings must use built-in `HeadingLevel.*`; custom heading styles need `outlineLevel` set or they won\'t appear',
                '- Don\'t use a table as a horizontal rule — use a paragraph bottom border instead',
                '- Dot-leader / right-aligned-on-same-line: use `PositionalTab` (`alignment: PositionalTabAlignment.RIGHT`, `leader: PositionalTabLeader.DOT`) inside a `TextRun`, not literal `.` or space padding',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: [
                'Edit an existing document. Legacy `.doc` files must be converted first: `python scripts/office/soffice.py --headless --convert-to docx file.doc`. Then:',
                '1. `unzip -q doc.docx -d unpacked/`',
                '2. `find unpacked -type l -delete` — strip symlink entries; docx from external parties is untrusted',
                '3. `python scripts/merge_runs.py unpacked/` — coalesce fragmented runs so text is findable. Word splits text across many `<w:r>` runs (revision ids, spell-check markers), so a phrase you can see often doesn\'t exist as a contiguous string in the XML; merge_runs merges adjacent identically-formatted runs without changing content or rendering (it also accepts a `.docx` directly: `python scripts/merge_runs.py doc.docx -o merged.docx`)',
                '4. Edit `unpacked/word/document.xml` in place — do NOT reformat or pretty-print',
                '5. Re-zip: `(cd unpacked && rm -f ../out.docx && zip -Xr ../out.docx .)`',
                '6. Validate: `python scripts/office/validate.py out.docx --original doc.docx` — XSD checks; `--auto-repair` fixes common issues',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: [
                'Tracked changes and comments. Redlining: validate with `--author "<the name you redlined under>"` (needs `--original`) — it reports any text you changed without a `<w:ins>`/`<w:del>` around it, which is easy to do by accident and invisible in the accepted view. Wrap runs in `<w:ins>`/`<w:del>` with `w:id`, `w:author`, `w:date` attributes. Inside `<w:del>`, the text element is `<w:delText>`, not `<w:t>`. A deleted paragraph mark (`<w:pPr><w:rPr><w:del w:id=".." w:author=".." w:date=".."/></w:rPr></w:pPr>`) means merge this paragraph into the next — deleting a paragraph outright is that plus a `<w:del>` around every run. The `<w:del/>` must come before the rPr\'s other children; their order is schema-enforced. To produce a clean copy with all tracked changes accepted: `python scripts/accept_changes.py in.docx out.docx`. Caveat: accepting a deleted paragraph mark should join that paragraph to the one below it, but `accept_changes.py` and `pandoc --track-changes=accept` don\'t always — they strip the deleted text but leave the emptied paragraph behind (a stray empty bullet when it was auto-numbered); `pandoc` never joins the paragraphs, `accept_changes.py` joins them correctly except when the deleted paragraph is followed by an empty spacer paragraph. An empty bullet in either view is an artifact of that view, not a defect in the document — check paragraph deletions in the XML.',
                '',
                'Comments require six cross-linked files — use the helper. Directory mode when you\'ll also be editing `document.xml` (saves an unzip/rezip cycle): `python scripts/comment.py unpacked/ "Fees & expenses cap is too low"`, `python scripts/comment.py unpacked/ "Agreed" --parent 0`. Against a `.docx` directly: `python scripts/comment.py contract.docx "This cap is too low" -o annotated.docx`. The script writes `comments.xml`, `commentsExtended.xml`, `commentsIds.xml`, `commentsExtensible.xml`, the relationships, and the content-type overrides; comment IDs are auto-assigned. It then prints the `<w:commentRangeStart>`/`<w:commentRangeEnd>`/`<w:commentReference>` snippet to add to `word/document.xml` so the comment anchors to specific text — until you place those markers, the comment exists but is not visible.',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
        {
            agentType: 'reviewer',
            description: [
                'Verify the output — render it and look at it:',
                '`python scripts/office/soffice.py --headless --convert-to pdf output.docx` then `pdftoppm -jpeg -r 100 output.pdf page` then `ls page-*.jpg` and Read the images (`pdftoppm` zero-pads page numbers to the width of the page count: `page-01.jpg`…`page-12.jpg`).',
                'Run `python scripts/office/validate.py out.docx` (XSD checks) after any edit. Dependencies: `docx` (npm, preinstalled — install only if `require(\'docx\')` fails), `pandoc`, LibreOffice (`soffice`), `pdftoppm` (Poppler).',
            ].join('\n'),
            dependsOn: ['step-1', 'step-2', 'step-3'],
        },
    ],
    parameters: [],
    tags: ['docx', 'word', 'documents', 'office'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
// ─── P5b — additional first-party skills (depth bar = website-deploy) ──────
/** Stable IDs for the additional bundled skills. */
export const BUNDLED_SKILL_ID_SECURITY_AUDIT = 'skill-security-audit';
export const BUNDLED_SKILL_ID_API_DESIGN = 'skill-api-design';
export const BUNDLED_SKILL_ID_DB_MIGRATION = 'skill-db-migration';
export const BUNDLED_SKILL_ID_PERF_PROFILE = 'skill-perf-profile';
export const BUNDLED_SKILL_ID_DOC_GEN = 'skill-doc-gen';
export const BUNDLED_SKILL_ID_CI_CD_SETUP = 'skill-ci-cd-setup';
export const BUNDLED_SKILL_ID_DOCKER_CONFIG = 'skill-docker-config';
export const BUNDLED_SKILL_ID_DEP_UPDATE = 'skill-dep-update';
export const BUNDLED_SKILL_ID_CODE_REFACTOR = 'skill-code-refactor';
export const BUNDLED_SKILL_ID_ENV_SETUP = 'skill-env-setup';
/**
 * Security audit skill — scan, classify, prioritize, report, verify fix.
 *
 * Methodology: enumerate the attack surface (entry points, auth boundaries,
 * data flows), scan for common vulnerability classes (injection, secrets,
 * unsafe deserialization, SSRF, path traversal, XSS), classify by CVSS-like
 * severity, produce a fix plan, and verify fixes actually close the finding.
 */
export const securityAuditSkill = {
    id: BUNDLED_SKILL_ID_SECURITY_AUDIT,
    name: 'security-audit',
    description: 'Perform a security audit: scan the codebase for vulnerabilities (injection, secrets, unsafe deserialization, SSRF, path traversal, XSS), classify by severity, produce a prioritized fix plan, and verify fixes. Use when the goal asks to audit security, find vulnerabilities, harden the app, or review for OWASP Top 10.',
    version: '1.0.0',
    goalPattern: 'security audit vulnerability scan OWASP injection secrets harden SSRF XSS path traversal authz unsafe deserialization CVE',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Map the attack surface with evidence:',
                '- Read entry points: HTTP handlers, CLI commands, webhook endpoints, message consumers',
                '- Identify auth boundaries: login, session, JWT, API keys, RBAC checks',
                '- Trace data flows: user input → parsing → storage → output',
                '- Note the dependency list (package.json / requirements.txt) and any known-CVE candidates',
                'Record every entry point with its file:line so findings have evidence.',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'security',
            description: [
                'Scan for vulnerability classes — read real files (read_file / code_search), never guess:',
                '- injection: SQL (string concat in queries), command (exec/spawn with user input), template (unescaped user data in HTML)',
                '- secrets: hardcoded API keys, passwords, tokens, connection strings (grep for patterns like AKIA, sk-, password=, token=)',
                '- unsafe deserialization: JSON.parse on untrusted input without schema validation, pickle.loads, eval()',
                '- SSRF: user-controlled URLs passed to fetch/http.get without allowlist',
                '- path traversal: user input in file paths without normalization/chroot',
                '- XSS: unescaped output in HTML responses, dangerouslySetInnerHTML without sanitization',
                '- authz: missing authorization checks on sensitive endpoints, IDOR (user can access other users\' resources by changing an ID)',
                'For each finding record: file:line, the vulnerability class, the exact code pattern, and a PoC sketch (what input triggers it).',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'reviewer',
            description: [
                'Classify and prioritize findings using a CVSS-like severity scale:',
                '- critical: RCE, auth bypass, SQL injection with data exfil, hardcoded root credentials',
                '- high: SSRF, stored XSS, IDOR with PII access, unsafe deserialization leading to code exec',
                '- medium: reflected XSS, path traversal (read-only), missing rate limiting, verbose errors leaking internals',
                '- low: missing security headers, information disclosure via debug endpoints, verbose logging of sensitive data',
                'For each finding assign: severity, exploitability (trivial / requires craft / theoretical), and blast radius (what data/systems are affected).',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'writer',
            description: [
                'Produce the security audit artifact:',
                '1. Executive summary — total findings by severity, top risk',
                '2. Findings table — file:line, class, severity, exploitability, blast radius, evidence snippet',
                '3. Fix plan — ordered by severity, each fix with: the code change (concrete, not vague), the file to edit, and verification step',
                '4. Quick wins — fixes under 5 minutes that eliminate the most risk',
                '5. Deferred items — findings that are low-severity or require architectural changes',
                'Deliver as structured markdown.',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
        {
            agentType: 'runner',
            description: [
                'Apply the quick-win fixes and verify each one:',
                '- For each quick-win fix: edit the file (edit_file), then verify the fix by re-scanning the specific pattern (code_search) or running the affected code path',
                '- Run the test suite to confirm no regressions: Run `npm test` or equivalent',
                'Report which fixes were applied and which require deeper architectural work.',
            ].join('\n'),
            dependsOn: ['step-3'],
        },
    ],
    parameters: [
        {
            name: 'scope',
            description: 'Path or scope to audit (default: the whole project)',
            type: 'file-path',
            required: false,
            defaultValue: '.',
        },
        {
            name: 'focus',
            description: 'Optional comma-separated focus areas (e.g. injection, secrets, authz)',
            type: 'string',
            required: false,
        },
    ],
    tags: ['security', 'audit', 'vulnerability', 'OWASP', 'injection', 'secrets', 'harden'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * API design skill — requirements → endpoints → OpenAPI → implement → test.
 *
 * Methodology: gather requirements (what resources, what operations), design
 * RESTful endpoints with proper HTTP methods/status codes, produce an OpenAPI
 * spec, implement the routes, and write integration tests that verify the
 * contract matches the implementation.
 */
export const apiDesignSkill = {
    id: BUNDLED_SKILL_ID_API_DESIGN,
    name: 'api-design',
    description: 'Design and implement a REST API: gather requirements, design endpoints with proper HTTP methods/status codes, produce an OpenAPI spec, implement routes, and write integration tests. Use when the goal asks to create an API, design endpoints, build a REST service, or scaffold an HTTP backend.',
    version: '2.0.0',
    goalPattern: 'API design REST endpoint route HTTP backend server create implement OpenAPI swagger',
    // Hermes-style: detailed when-to-use sections
    whenToUse: [
        'User wants to create a REST API for a web application',
        'User wants to design endpoints for a mobile app backend',
        'User wants to build a microservice with HTTP endpoints',
        'User mentions "REST", "API", "endpoints", "routes"',
        'User wants OpenAPI/Swagger documentation',
        'User wants to add CRUD operations for resources',
    ],
    whenNotToUse: [
        'User wants a GraphQL API (use graphql skill instead)',
        'User wants a WebSocket server (use realtime skill instead)',
        'User wants a gRPC service (use grpc skill instead)',
        'User wants a CLI tool (use cli-tool skill instead)',
        'User wants a desktop app (use electron-app skill instead)',
    ],
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                '## Step 1: Gather User Preferences',
                '',
                'Before designing the API, ask the user for:',
                '- **Resources**: What entities does the API manage? (users, orders, products)',
                '- **Operations**: What actions can be performed? (CRUD, custom actions)',
                '- **Auth**: What authentication method? (API key, JWT, OAuth2, none)',
                '- **Format**: What data format? (JSON, XML, form-encoded)',
                '- **Pagination**: How to handle large lists? (cursor-based, offset, none)',
                '',
                'Use sensible defaults if the user doesn\'t care, but always ask before designing.',
                '',
                '## Step 2: Detect Project State',
                '',
                'Check the working directory:',
                '```bash',
                'ls -la',
                'cat package.json 2>/dev/null || cat pyproject.toml 2>/dev/null || echo "No project config found"',
                '```',
                '',
                'If greenfield (empty directory):',
                '- Choose framework based on language preference',
                '- Initialize project structure',
                '- Set up build tools',
                '',
                'If existing project:',
                '- Use the same framework',
                '- Follow existing code style',
                '- Integrate with existing build system',
                '',
                '## Step 3: Identify Resources',
                '',
                'Map resources to endpoints:',
                '```',
                'Resource     Operations                    Endpoint',
                '─────────────────────────────────────────────────────',
                'Users        List, Get, Create, Update, Delete  /api/users',
                '             Get user by ID                      /api/users/:id',
                '             Get user orders                     /api/users/:id/orders',
                'Orders       List, Get, Create, Cancel           /api/orders',
                '             Get order by ID                     /api/orders/:id',
                '             Cancel order                        /api/orders/:id/cancel',
                'Products     List, Get, Create, Update, Delete   /api/products',
                '             Search products                     /api/products/search',
                '```',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: [
                '## Step 4: Design Endpoint Contract',
                '',
                '### 4.1 REST Conventions',
                '',
                '| Verb   | HTTP Method | Path              | Status Code | Description |',
                '|--------|-------------|-------------------|-------------|-------------|',
                '| List   | GET         | /api/resources    | 200         | Get all     |',
                '| Get    | GET         | /api/resources/:id| 200         | Get one     |',
                '| Create | POST        | /api/resources    | 201         | Create one  |',
                '| Update | PUT         | /api/resources/:id| 200         | Update one  |',
                '| Delete | DELETE      | /api/resources/:id| 204         | Delete one  |',
                '',
                '### 4.2 Request/Response Schemas',
                '',
                '**Create User Request:**',
                '```json',
                '{',
                '  "name": "John Doe",',
                '  "email": "john@example.com",',
                '  "password": "secure123"',
                '}',
                '```',
                '',
                '**Create User Response (201):**',
                '```json',
                '{',
                '  "id": "usr_123",',
                '  "name": "John Doe",',
                '  "email": "john@example.com",',
                '  "createdAt": "2026-08-27T10:00:00Z"',
                '}',
                '```',
                '',
                '**Error Response (400):**',
                '```json',
                '{',
                '  "error": {',
                '    "code": "VALIDATION_ERROR",',
                '    "message": "Email is required",',
                '    "details": [',
                '      {"field": "email", "message": "Email is required"}',
                '    ]',
                '  }',
                '}',
                '```',
                '',
                '### 4.3 Pagination',
                '',
                '**Cursor-based (recommended):**',
                '```',
                'GET /api/users?limit=20&cursor=usr_123',
                '',
                'Response:',
                '{',
                '  "data": [...],',
                '  "pagination": {',
                '    "nextCursor": "usr_456",',
                '    "hasMore": true',
                '  }',
                '}',
                '```',
                '',
                '**Offset-based:**',
                '```',
                'GET /api/users?offset=20&limit=20',
                '',
                'Response:',
                '{',
                '  "data": [...],',
                '  "pagination": {',
                '    "offset": 20,',
                '    "limit": 20,',
                '    "total": 100',
                '  }',
                '}',
                '```',
                '',
                '### 4.4 Auth Middleware',
                '',
                '**JWT Authentication:**',
                '```javascript',
                '// middleware/auth.js',
                'function authenticate(req, res, next) {',
                '  const token = req.headers.authorization?.split(" ")[1];',
                '  if (!token) return res.status(401).json({ error: "No token" });',
                '  ',
                '  try {',
                '    const decoded = jwt.verify(token, process.env.JWT_SECRET);',
                '    req.user = decoded;',
                '    next();',
                '  } catch (err) {',
                '    res.status(401).json({ error: "Invalid token" });',
                '  }',
                '}',
                '```',
                '',
                '**API Key Authentication:**',
                '```javascript',
                '// middleware/auth.js',
                'function authenticateApiKey(req, res, next) {',
                '  const apiKey = req.headers["x-api-key"];',
                '  if (!apiKey || apiKey !== process.env.API_KEY) {',
                '    return res.status(401).json({ error: "Invalid API key" });',
                '  }',
                '  next();',
                '}',
                '```',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'writer',
            description: [
                '## Step 5: Write OpenAPI Spec',
                '',
                'Create `openapi.yaml` or `openapi.json`:',
                '',
                '```yaml',
                'openapi: 3.0.3',
                'info:',
                '  title: My API',
                '  version: 1.0.0',
                '  description: REST API for managing users and orders',
                'servers:',
                '  - url: http://localhost:3000',
                '    description: Development',
                '  - url: https://api.example.com',
                '    description: Production',
                'paths:',
                '  /api/users:',
                '    get:',
                '      summary: List all users',
                '      tags: [Users]',
                '      parameters:',
                '        - name: limit',
                '          in: query',
                '          schema:',
                '            type: integer',
                '            default: 20',
                '        - name: cursor',
                '          in: query',
                '          schema:',
                '            type: string',
                '      responses:',
                '        "200":',
                '          description: Successful response',
                '          content:',
                '            application/json:',
                '              schema:',
                '                $ref: "#/components/schemas/UserList"',
                '    post:',
                '      summary: Create a user',
                '      tags: [Users]',
                '      requestBody:',
                '        required: true',
                '        content:',
                '          application/json:',
                '            schema:',
                '              $ref: "#/components/schemas/CreateUserRequest"',
                '      responses:',
                '        "201":',
                '          description: User created',
                '          content:',
                '            application/json:',
                '              schema:',
                '                $ref: "#/components/schemas/User"',
                '        "400":',
                '          description: Validation error',
                'components:',
                '  schemas:',
                '    User:',
                '      type: object',
                '      properties:',
                '        id:',
                '          type: string',
                '        name:',
                '          type: string',
                '        email:',
                '          type: string',
                '          format: email',
                '        createdAt:',
                '          type: string',
                '          format: date-time',
                '    CreateUserRequest:',
                '      type: object',
                '      required: [name, email, password]',
                '      properties:',
                '        name:',
                '          type: string',
                '        email:',
                '          type: string',
                '          format: email',
                '        password:',
                '          type: string',
                '          minLength: 8',
                '  securitySchemes:',
                '    bearerAuth:',
                '      type: http',
                '      scheme: bearer',
                '      bearerFormat: JWT',
                'security:',
                '  - bearerAuth: []',
                '```',
                '',
                'Validate the spec:',
                '```bash',
                'npx swagger-cli validate openapi.yaml',
                '# Or',
                'npx @redocly/cli lint openapi.yaml',
                '```',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
        {
            agentType: 'runner',
            description: [
                '## Step 6: Implement Routes',
                '',
                '### 6.1 Project Structure',
                '```',
                'src/',
                '├── routes/',
                '│   ├── users.ts',
                '│   ├── orders.ts',
                '│   └── index.ts',
                '├── middleware/',
                '│   ├── auth.ts',
                '│   ├── validate.ts',
                '│   └── errorHandler.ts',
                '├── models/',
                '│   ├── user.ts',
                '│   └── order.ts',
                '├── services/',
                '│   ├── userService.ts',
                '│   └── orderService.ts',
                '└── app.ts',
                '```',
                '',
                '### 6.2 Express Example',
                '```typescript',
                '// src/routes/users.ts',
                'import { Router, Request, Response } from "express";',
                'import { UserService } from "../services/userService.js";',
                'import { authenticate } from "../middleware/auth.js";',
                'import { validate } from "../middleware/validate.js";',
                'import { CreateUserSchema } from "../schemas/user.js";',
                '',
                'const router = Router();',
                'const userService = new UserService();',
                '',
                '// GET /api/users',
                'router.get("/", async (req: Request, res: Response) => {',
                '  const { limit = 20, cursor } = req.query;',
                '  const users = await userService.list(Number(limit), cursor as string);',
                '  res.json(users);',
                '});',
                '',
                '// GET /api/users/:id',
                'router.get("/:id", async (req: Request, res: Response) => {',
                '  const user = await userService.getById(req.params.id);',
                '  if (!user) {',
                '    return res.status(404).json({ error: "User not found" });',
                '  }',
                '  res.json(user);',
                '});',
                '',
                '// POST /api/users',
                'router.post("/",',
                '  authenticate,',
                '  validate(CreateUserSchema),',
                '  async (req: Request, res: Response) => {',
                '    const user = await userService.create(req.body);',
                '    res.status(201).json(user);',
                '  }',
                ');',
                '',
                '// PUT /api/users/:id',
                'router.put("/:id",',
                '  authenticate,',
                '  async (req: Request, res: Response) => {',
                '    const user = await userService.update(req.params.id, req.body);',
                '    if (!user) {',
                '      return res.status(404).json({ error: "User not found" });',
                '    }',
                '    res.json(user);',
                '  }',
                ');',
                '',
                '// DELETE /api/users/:id',
                'router.delete("/:id",',
                '  authenticate,',
                '  async (req: Request, res: Response) => {',
                '    const deleted = await userService.delete(req.params.id);',
                '    if (!deleted) {',
                '      return res.status(404).json({ error: "User not found" });',
                '    }',
                '    res.status(204).send();',
                '  }',
                ');',
                '',
                'export default router;',
                '```',
                '',
                '### 6.3 FastAPI Example',
                '```python',
                '# src/routes/users.py',
                'from fastapi import APIRouter, HTTPException, Depends',
                'from pydantic import BaseModel',
                'from typing import List, Optional',
                'from datetime import datetime',
                '',
                'router = APIRouter(prefix="/api/users", tags=["users"])',
                '',
                'class User(BaseModel):',
                '    id: str',
                '    name: str',
                '    email: str',
                '    created_at: datetime',
                '',
                'class CreateUserRequest(BaseModel):',
                '    name: str',
                '    email: str',
                '    password: str',
                '',
                '@router.get("/", response_model=List[User])',
                'async def list_users(limit: int = 20, cursor: Optional[str] = None):',
                '    users = await user_service.list(limit, cursor)',
                '    return users',
                '',
                '@router.get("/{user_id}", response_model=User)',
                'async def get_user(user_id: str):',
                '    user = await user_service.get_by_id(user_id)',
                '    if not user:',
                '        raise HTTPException(status_code=404, detail="User not found")',
                '    return user',
                '',
                '@router.post("/", response_model=User, status_code=201)',
                'async def create_user(request: CreateUserRequest):',
                '    user = await user_service.create(request)',
                '    return user',
                '```',
            ].join('\n'),
            dependsOn: ['step-3'],
        },
        {
            agentType: 'tester',
            description: [
                '## Step 7: Write Integration Tests',
                '',
                '### 7.1 Test Structure',
                '```',
                'tests/',
                '├── users.test.ts',
                '├── orders.test.ts',
                '├── helpers.ts',
                '└── setup.ts',
                '```',
                '',
                '### 7.2 Test Examples',
                '',
                '**Express + Vitest:**',
                '```typescript',
                '// tests/users.test.ts',
                'import { describe, it, expect, beforeAll, afterAll } from "vitest";',
                'import request from "supertest";',
                'import { app } from "../src/app.js";',
                '',
                'describe("Users API", () => {',
                '  let authToken: string;',
                '',
                '  beforeAll(async () => {',
                '    // Get auth token',
                '    const res = await request(app)',
                '      .post("/auth/login")',
                '      .send({ email: "test@example.com", password: "password" });',
                '    authToken = res.body.token;',
                '  });',
                '',
                '  describe("GET /api/users", () => {',
                '    it("should return list of users", async () => {',
                '      const res = await request(app)',
                '        .get("/api/users")',
                '        .set("Authorization", `Bearer ${authToken}`)',
                '        .expect(200);',
                '',
                '      expect(res.body).toHaveProperty("data");',
                '      expect(Array.isArray(res.body.data)).toBe(true);',
                '    });',
                '',
                '    it("should return 401 without auth", async () => {',
                '      await request(app)',
                '        .get("/api/users")',
                '        .expect(401);',
                '    });',
                '  });',
                '',
                '  describe("POST /api/users", () => {',
                '    it("should create a user", async () => {',
                '      const res = await request(app)',
                '        .post("/api/users")',
                '        .set("Authorization", `Bearer ${authToken}`)',
                '        .send({',
                '          name: "Test User",',
                '          email: "test@example.com",',
                '          password: "password123"',
                '        })',
                '        .expect(201);',
                '',
                '      expect(res.body).toHaveProperty("id");',
                '      expect(res.body.name).toBe("Test User");',
                '    });',
                '',
                '    it("should return 400 for invalid data", async () => {',
                '      await request(app)',
                '        .post("/api/users")',
                '        .set("Authorization", `Bearer ${authToken}`)',
                '        .send({ name: "" })',
                '        .expect(400);',
                '    });',
                '  });',
                '});',
                '```',
                '',
                '### 7.3 Run Tests',
                '',
                '```bash',
                '# Run all tests',
                'npm test',
                '',
                '# Run with coverage',
                'npm run test:coverage',
                '',
                '# Run specific test file',
                'npm test tests/users.test.ts',
                '```',
                '',
                '### 7.4 Verify Contract',
                '',
                '- All endpoints return correct status codes',
                '- Response shapes match OpenAPI spec',
                '- Auth works correctly (401 for missing token, 403 for invalid)',
                '- Validation works (400 for invalid input)',
                '- Pagination works (cursor/offset)',
            ].join('\n'),
            dependsOn: ['step-4'],
        },
    ],
    parameters: [
        {
            name: 'framework',
            description: 'HTTP framework (auto-detected from package.json if not specified)',
            type: 'choice',
            required: false,
            options: ['express', 'fastify', 'hono', 'flask', 'fastapi', 'auto'],
            defaultValue: 'auto',
        },
        {
            name: 'authType',
            description: 'Authentication method (default: API key)',
            type: 'choice',
            required: false,
            options: ['api-key', 'jwt', 'session', 'oauth2', 'none'],
            defaultValue: 'api-key',
        },
    ],
    tags: ['api', 'rest', 'openapi', 'swagger', 'http', 'backend', 'endpoints'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * Database migration skill — analyze schema → design migration → write SQL →
 * test backward compatibility → document.
 *
 * Methodology: read the current schema (ORM models, migration files, raw SQL),
 * design the migration (what changes, what order), write the migration SQL,
 * verify backward compatibility (old code still works during rollout), and
 * document the change.
 */
export const dbMigrationSkill = {
    id: BUNDLED_SKILL_ID_DB_MIGRATION,
    name: 'db-migration',
    description: 'Design and implement a database migration: analyze the current schema, design the migration (what changes, in what order), write the migration SQL/scripts, test backward compatibility, and document the change. Use when the goal asks to migrate a database, add/modify columns, change schema, or restructure tables.',
    version: '1.0.0',
    goalPattern: 'database migration schema SQL column table alter add modify restructure backward compatible',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Analyze the current schema with evidence:',
                '- Read ORM models (Prisma schema, SQLAlchemy models, Django models, TypeORM entities)',
                '- Read existing migration files (prisma/migrations/, alembic/versions/, db/migrate/)',
                '- Note the database type (PostgreSQL, MySQL, SQLite) and the migration tool in use',
                '- Identify the current tables, columns, indexes, and constraints',
                'Produce a schema snapshot: table → columns (type, nullable, default, index).',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: [
                'Design the migration with backward compatibility in mind:',
                '- Additive changes (new columns with defaults) are safe — old code ignores them',
                '- Column renames: add new column → copy data → drop old (never rename in-place — old code breaks)',
                '- Column type changes: add new column with new type → migrate data → swap → drop old',
                '- New indexes: create concurrently (PostgreSQL) to avoid locking',
                '- Breaking changes: require a multi-step rollout (deploy code that works with BOTH schemas, then migrate, then deploy code that uses the new schema)',
                'Produce a migration plan: ordered steps, each with forward + rollback SQL.',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: [
                'Write the migration using the project\'s migration tool:',
                '- Prisma: `npx prisma migrate dev --name <description>` (generates SQL + updates client)',
                '- Alembic: `alembic revision --autogenerate -m <description>` then review generated SQL',
                '- Raw SQL: write a numbered SQL file (001_add_column.sql) with UP + DOWN sections',
                '- Apply: run the migration against a dev/test database: Run `npx prisma migrate dev` or `alembic upgrade head` or `psql -f migration.sql`',
                'Verify the migration applies cleanly (no errors) and rolls back cleanly.',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'tester',
            description: [
                'Test backward compatibility:',
                '- Run the existing test suite against the new schema: Run `npm test` or equivalent',
                '- Verify old code paths still work (the ORM models must be compatible with both old and new schema during rollout)',
                '- Check for data loss: query the affected tables before/after migration',
                '- Verify indexes were created (check with `EXPLAIN ANALYZE` on slow queries)',
                'Report: what changed, what broke (if anything), and whether the migration is safe to deploy.',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
        {
            agentType: 'writer',
            description: [
                'Document the migration:',
                '- What changed (table:column, type, default, index)',
                '- Why (the business/technical reason)',
                '- Rollback procedure (the DOWN migration)',
                '- Deployment notes (order of operations: migrate → deploy code, or deploy code → migrate)',
                'Add to CHANGELOG.md or a migration-specific doc.',
            ].join('\n'),
            dependsOn: ['step-3'],
        },
    ],
    parameters: [
        {
            name: 'dbType',
            description: 'Database type (auto-detected from project config if not specified)',
            type: 'choice',
            required: false,
            options: ['postgresql', 'mysql', 'sqlite', 'auto'],
            defaultValue: 'auto',
        },
        {
            name: 'migrationTool',
            description: 'Migration tool (auto-detected from project if not specified)',
            type: 'choice',
            required: false,
            options: ['prisma', 'alembic', 'knex', 'raw-sql', 'auto'],
            defaultValue: 'auto',
        },
    ],
    tags: ['database', 'migration', 'schema', 'SQL', 'backward-compatible', 'postgreSQL', 'mysql'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * Performance profiling skill — identify hotspots → instrument → measure →
 * analyze → optimize → verify.
 *
 * Methodology: profile the application under realistic load, identify the
 * actual bottleneck (never guess), optimize the specific bottleneck, and
 * verify the improvement with measurements.
 */
export const perfProfileSkill = {
    id: BUNDLED_SKILL_ID_PERF_PROFILE,
    name: 'perf-profile',
    description: 'Profile and optimize performance: identify hotspots with real measurements, instrument the code, analyze bottlenecks, apply targeted optimizations, and verify improvement. Use when the goal asks to profile, optimize, speed up, reduce latency, fix slow queries, or improve throughput.',
    version: '1.0.0',
    goalPattern: 'performance profile optimize speed slow latency throughput hotspot bottleneck N+1 query cache memory',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Identify the performance concern with evidence:',
                '- Read the code path in question (entry point → hot path → exit)',
                '- Note the language runtime (Node.js, Python, Go) and available profiling tools',
                '- Identify what "slow" means: latency (p50/p95/p99), throughput (req/s), memory (heap usage), CPU (utilization)',
                '- Check for known anti-patterns: N+1 queries, synchronous I/O in loops, unbounded caches, missing indexes',
                'Produce: the code path, the metric to optimize, and the baseline measurement to beat.',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'runner',
            description: [
                'Measure the baseline with real tools:',
                '- Node.js: `node --prof` + `--prof-process`, or `clinic flame` / `clinic doctor`, or built-in `console.time`',
                '- Python: `cProfile` + `snakeviz`, or `py-spy`, or `line_profiler`',
                '- Go: `go test -bench`, `go tool pprof`, `benchstat`',
                '- Database: `EXPLAIN ANALYZE` on slow queries',
                '- HTTP: `wrk` or `hey` for load testing',
                'Record the baseline numbers so improvements are measurable (not主观).',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'reviewer',
            description: [
                'Analyze the profiler output to find the ACTUAL bottleneck:',
                '- CPU flame graph: the widest frames are the hot functions',
                '- Memory profile: the largest allocations are the leak/growth source',
                '- Database queries: the slowest queries (by time or frequency) are the I/O bottleneck',
                '- HTTP timing: the slowest middleware/handler is the latency source',
                'Classify the bottleneck: CPU-bound, I/O-bound, memory-bound, or network-bound. The fix depends on the class.',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'runner',
            description: [
                'Apply targeted optimizations for the bottleneck class:',
                '- CPU-bound: algorithm optimization, caching, worker threads, native addons',
                '- I/O-bound: batch queries (eliminate N+1), connection pooling, async/await, pagination',
                '- Memory: fix leaks (unreleased references), reduce allocations (object pools), streaming (process large data incrementally)',
                '- Network: reduce round-trips (batching), compression, CDN, connection keep-alive',
                'Make ONE optimization at a time — measure after each change so you know what helped.',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
        {
            agentType: 'reviewer',
            description: [
                'Verify the improvement with measurements:',
                '- Re-run the SAME profiling command from step-1',
                '- Compare baseline vs optimized: latency improvement, throughput gain, memory reduction',
                '- Run the test suite to confirm no regressions: Run `npm test` or equivalent',
                'Report: what was slow, what was the root cause, what optimization was applied, and the measured improvement (baseline → optimized).',
            ].join('\n'),
            dependsOn: ['step-3'],
        },
    ],
    parameters: [
        {
            name: 'language',
            description: 'Language/runtime (auto-detected from project if not specified)',
            type: 'choice',
            required: false,
            options: ['node', 'python', 'go', 'rust', 'auto'],
            defaultValue: 'auto',
        },
        {
            name: 'target',
            description: 'Specific code path or endpoint to profile (default: the whole app)',
            type: 'string',
            required: false,
        },
    ],
    tags: ['performance', 'profiling', 'optimization', 'latency', 'throughput', 'bottleneck', 'flame-graph'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * Documentation generation skill — scan codebase → extract API → generate docs
 * → validate links → publish.
 *
 * Methodology: scan the codebase for public APIs (exports, routes, CLI
 * commands), extract signatures and JSDoc/docstrings, generate structured
 * documentation (API reference + guides), validate internal links, and
 * produce publishable output.
 */
export const docGenSkill = {
    id: BUNDLED_SKILL_ID_DOC_GEN,
    name: 'doc-gen',
    description: 'Generate documentation from code: scan for public APIs, extract signatures and docstrings, generate structured docs (API reference + guides), validate links, and produce publishable output. Use when the goal asks to document, generate docs, write API reference, create a README, or produce developer documentation.',
    version: '1.0.0',
    goalPattern: 'documentation generate docs API reference README JSDoc docstring developer guide publish',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Scan the codebase for documentation targets:',
                '- Read package.json / pyproject.toml for the project name, description, and existing doc scripts',
                '- Find public APIs: exported functions/classes/types (TypeScript: `export`, Python: `__all__`), CLI commands, HTTP routes',
                '- Note existing docs (README.md, docs/, JSDoc/docstrings already present)',
                '- Identify the target audience: API consumers, contributors, end users',
                'Produce: a map of what needs documenting, what already has docs, and the output format.',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'writer',
            description: [
                'Generate the API reference documentation:',
                '- For each exported function/class: name, parameters (type + description), return type, example usage',
                '- For CLI commands: name, description, arguments, options, examples',
                '- For HTTP routes: method, path, request/response schema, status codes',
                '- Preserve existing JSDoc/docstrings — supplement, don\'t overwrite',
                'Output as structured markdown with consistent formatting.',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'writer',
            description: [
                'Write the guides and README:',
                '- README.md: project name, one-line description, installation, quick start, key features, license',
                '- CONTRIBUTING.md: setup, development workflow, code style, PR process',
                '- Architecture guide (if complex): module map, data flow, design decisions',
                'Keep guides concise — link to the API reference for details, don\'t duplicate.',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: [
                'Validate the documentation:',
                '- Check internal links: every `[text](path)` resolves to an existing file',
                '- Check code examples: every snippet should be syntactically valid',
                '- Verify accuracy: cross-reference documented parameters against actual code',
                '- Check for completeness: every public API has a doc entry',
                'Fix any broken links, invalid examples, or missing entries.',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
    ],
    parameters: [
        {
            name: 'format',
            description: 'Output format (default: markdown)',
            type: 'choice',
            required: false,
            options: ['markdown', 'html', 'json'],
            defaultValue: 'markdown',
        },
        {
            name: 'audience',
            description: 'Target audience (default: API consumers)',
            type: 'choice',
            required: false,
            options: ['api-consumers', 'contributors', 'end-users', 'all'],
            defaultValue: 'api-consumers',
        },
    ],
    tags: ['documentation', 'API-reference', 'README', 'JSDoc', 'docstring', 'developer-docs'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * CI/CD setup skill — detect platform → write workflow → add secrets →
 * test run → verify.
 *
 * Methodology: detect the CI platform (GitHub Actions, GitLab CI, etc.),
        detect the project stack (language, test command, build command), write
 * the workflow file, configure secrets/variables, trigger a test run, and
 * verify the pipeline passes.
 */
export const ciCdSetupSkill = {
    id: BUNDLED_SKILL_ID_CI_CD_SETUP,
    name: 'ci-cd-setup',
    description: 'Set up CI/CD: detect the platform and project stack, write the workflow/pipeline file, configure secrets, trigger a test run, and verify the pipeline passes. Use when the goal asks to set up CI/CD, add GitHub Actions, configure pipelines, automate tests, or set up continuous integration.',
    version: '1.0.0',
    goalPattern: 'CI CD continuous integration GitHub Actions GitLab CI pipeline workflow automate test build deploy',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Detect the platform and stack:',
                '- Check for `.github/workflows/` (GitHub Actions), `.gitlab-ci.yml` (GitLab CI), `Jenkinsfile` (Jenkins), `bitbucket-pipelines.yml` (Bitbucket)',
                '- Read package.json / pyproject.toml / go.mod for: language, test command, build command, lint command',
                '- Check for existing CI config (may need to extend, not replace)',
                '- Note the Node/Python/Go version, and whether Docker is needed',
                'Produce: platform, language, commands, and the workflow file path.',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'writer',
            description: [
                'Write the CI workflow file:',
                '- GitHub Actions: `.github/workflows/ci.yml` with triggers (push to main, PR), jobs (lint, typecheck, test, build), caching (node_modules, pip cache), and matrix (Node versions if needed)',
                '- GitLab CI: `.gitlab-ci.yml` with stages (lint, test, build), cache, and artifacts',
                '- Include: checkout, setup, install deps, lint, typecheck, test, build (in that order)',
                '- Add status badges to README.md',
                'Each job should fail fast (lint before test, test before build) to save CI minutes.',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: [
                'Configure secrets and variables:',
                '- List required secrets (API keys, tokens, env vars needed for tests)',
                '- Document where to set them (GitHub: Settings → Secrets → Actions; GitLab: Settings → CI/CD → Variables)',
                '- Add any required environment variables to the workflow (NODE_ENV=test, etc.)',
                'Never hardcode secrets in the workflow file — always use secrets/variables.',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'runner',
            description: [
                'Trigger a test run and verify:',
                '- Push the workflow file to a branch: Run `git add .github/workflows/ci.yml && git commit -m "ci: add CI pipeline"`',
                '- Create a PR or push to main to trigger the workflow',
                '- Monitor the run (GitHub: `gh run watch` or GitLab: check the pipeline page)',
                '- If it fails: read the logs, fix the issue, push again',
                'The pipeline must pass before the setup is complete.',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
    ],
    parameters: [
        {
            name: 'platform',
            description: 'CI platform (auto-detected from repo if not specified)',
            type: 'choice',
            required: false,
            options: ['github-actions', 'gitlab-ci', 'jenkins', 'bitbucket', 'auto'],
            defaultValue: 'auto',
        },
        {
            name: 'languages',
            description: 'Languages/runtimes to test (auto-detected from project if not specified)',
            type: 'string',
            required: false,
        },
    ],
    tags: ['CI', 'CD', 'GitHub-Actions', 'GitLab-CI', 'pipeline', 'workflow', 'automation'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * Docker configuration skill — analyze deps → write Dockerfile → optimize
 * layers → test build → compose.
 *
 * Methodology: analyze the project dependencies and build process, write a
 * multi-stage Dockerfile (build + runtime), optimize layer caching, test
 * the build, and optionally add docker-compose for local dev.
 */
export const dockerConfigSkill = {
    id: BUNDLED_SKILL_ID_DOCKER_CONFIG,
    name: 'docker-config',
    description: 'Configure Docker for a project: analyze dependencies, write a multi-stage Dockerfile, optimize layer caching, test the build, and optionally add docker-compose. Use when the goal asks to containerize, add Docker, create a Dockerfile, or set up docker-compose for local development.',
    version: '1.0.0',
    goalPattern: 'Docker Dockerfile containerize docker-compose multi-stage build image layer optimize',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Analyze the project dependencies:',
                '- Read package.json / pyproject.toml / go.mod for: language, runtime version, build command, start command',
                '- Check for existing Dockerfile or docker-compose.yml',
                '- Identify the build output (dist/, build/, .next/, etc.)',
                '- Note any native dependencies (node-gyp, system libs) that need build tools in the image',
                'Produce: language, runtime version, build command, start command, and native deps list.',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'writer',
            description: [
                'Write a multi-stage Dockerfile:',
                '- Stage 1 (builder): install deps + build — include devDependencies for the build',
                '- Stage 2 (runtime): copy only the build output + production deps — minimal final image',
                '- Use official base images (node:20-alpine, python:3.12-slim, golang:1.22-alpine)',
                '- Order layers by change frequency: OS deps → project deps → source code (rarely changes → often changes)',
                '- Add .dockerignore (node_modules, .git, dist, *.md)',
                'The multi-stage pattern keeps the final image small (no dev tools, no source code).',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: [
                'Test the Docker build:',
                '- Build: Run `docker build -t <project> .`',
                '- Verify the image runs: Run `docker run --rm -p 3000:3000 <project>`',
                '- Check the image size: Run `docker images <project>` — aim for < 200MB for Node.js, < 100MB for Go',
                '- Verify the app works inside the container (curl the health endpoint)',
                'If the build fails: read the error, fix the Dockerfile, rebuild.',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'writer',
            description: [
                'Write docker-compose.yml for local development (if needed):',
                '- Define services (app + any dependencies: database, cache, queue)',
                '- Mount source code as a volume for hot-reload during dev',
                '- Set environment variables (DATABASE_URL, REDIS_URL, etc.)',
                '- Add health checks for dependent services',
                'Test: Run `docker-compose up` and verify all services start and communicate.',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
    ],
    parameters: [
        {
            name: 'baseImage',
            description: 'Base Docker image (auto-detected from project language if not specified)',
            type: 'string',
            required: false,
        },
        {
            name: 'multiStage',
            description: 'Use multi-stage build (default: yes)',
            type: 'choice',
            required: false,
            options: ['yes', 'no'],
            defaultValue: 'yes',
        },
    ],
    tags: ['Docker', 'Dockerfile', 'containerize', 'docker-compose', 'multi-stage', 'image'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * Dependency update skill — audit → select targets → update → test →
 * fix breaks → document.
 *
 * Methodology: audit current dependencies for outdated versions and known
 * vulnerabilities, select update targets (security-first, then minor, then
 * major), update, run the test suite, fix any breakages, and document the
 * changes.
 */
export const depUpdateSkill = {
    id: BUNDLED_SKILL_ID_DEP_UPDATE,
    name: 'dep-update',
    description: 'Update dependencies safely: audit for outdated versions and vulnerabilities, select update targets, update, run tests, fix breakages, and document changes. Use when the goal asks to update deps, upgrade packages, fix vulnerabilities, or modernize dependencies.',
    version: '1.0.0',
    goalPattern: 'dependency update upgrade packages outdated vulnerability fix npm pip go mod modernize',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Audit the current dependency state:',
                '- Run `npm outdated` / `pip list --outdated` / `go list -m -u all` to see what\'s behind',
                '- Run `npm audit` / `pip audit` / `govulncheck` for known vulnerabilities',
                '- Read package.json / requirements.txt for pinned versions',
                '- Note which deps are production vs dev (production deps affect the shipped product)',
                'Produce: a list of outdated deps with current → latest version, and any with known CVEs.',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: [
                'Select update targets in priority order:',
                '- P0: security fixes (any dep with a known CVE — update immediately)',
                '- P1: patch updates (bug fixes, no breaking changes — safe to batch)',
                '- P2: minor updates (new features, backward-compatible — usually safe)',
                '- P3: major updates (breaking changes — one at a time, with migration guide)',
                'For major updates: read the changelog/migration guide first, note what breaks, and plan the code changes.',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: [
                'Apply updates in batches:',
                '- P0 (security): update all vulnerable deps immediately',
                '- P1+P2 (patch+minor): batch update — Run `npm update` / `pip install --upgrade` / `go get -u`',
                '- P3 (major): update ONE major dep at a time, fix breakages before moving to the next',
                'After each batch: run the test suite to catch breakages early.',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'tester',
            description: [
                'Verify after each update batch:',
                '- Run the full test suite: Run `npm test` or equivalent',
                '- Run the build to catch compile-time breakages: Run `npm run build` or equivalent',
                '- Check for deprecation warnings in the output',
                '- If a test fails: read the error, fix the code (not the dep version), re-run',
                'Never roll back a dep version to fix a test — fix the code to work with the new version.',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
        {
            agentType: 'writer',
            description: [
                'Document the updates:',
                '- Update CHANGELOG.md with the dep changes (name, old version → new version, reason)',
                '- Note any breaking changes that require code updates',
                '- Update the lock file (package-lock.json, poetry.lock, go.sum) — commit it',
                'The lock file is the source of truth for reproducible builds.',
            ].join('\n'),
            dependsOn: ['step-3'],
        },
    ],
    parameters: [
        {
            name: 'strategy',
            description: 'Update strategy: patch (safe), minor (features), major (breaking)',
            type: 'choice',
            required: false,
            options: ['patch', 'minor', 'major', 'security-only'],
            defaultValue: 'patch',
        },
    ],
    tags: ['dependency', 'update', 'upgrade', 'outdated', 'vulnerability', 'npm', 'pip', 'go-mod'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * Code refactor skill — analyze → identify patterns → plan changes → refactor
 * → test → verify.
 *
 * Methodology: analyze the target code to understand its structure and
 * dependencies, identify refactoring opportunities (extract, inline, rename,
 * restructure), plan the changes (what moves where, what breaks), apply the
 * refactoring surgically, and verify with tests.
 */
export const codeRefactorSkill = {
    id: BUNDLED_SKILL_ID_CODE_REFACTOR,
    name: 'code-refactor',
    description: 'Refactor code safely: analyze the target, identify patterns to improve, plan the changes, apply the refactoring surgically, and verify with tests. Use when the goal asks to refactor, restructure, extract, inline, rename, clean up, or improve code organization.',
    version: '1.0.0',
    goalPattern: 'refactor restructure extract inline rename clean up code organization DRY SOLID improve pattern',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Analyze the target code with evidence:',
                '- Read the file(s) to refactor — understand the current structure, dependencies, and callers',
                '- Use code_search to find all callers/references to the code being refactored',
                '- Note the test coverage: are there existing tests for this code? (glob for *.test.* matching the file)',
                '- Identify the refactoring type: extract function/class, inline, rename, move, restructure',
                'Produce: the current structure, all callers, test coverage, and the refactoring type.',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: [
                'Plan the refactoring changes:',
                '- What moves where (old location → new location)',
                '- What breaks (callers that need updating)',
                '- The order of operations (rename first, then extract, then update callers)',
                '- Whether to do it in one commit or multiple (atomic refactors are safer)',
                'Write a step-by-step plan with file paths and the specific changes.',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: [
                'Apply the refactoring surgically:',
                '- Make one change at a time (don\'t rename + extract + move in one edit)',
                '- After each change: save and verify the file still parses (no syntax errors)',
                '- Update all callers (use code_search to find every reference)',
                '- Run the test suite after each meaningful change: Run `npm test` or equivalent',
                'If a test breaks: the refactoring changed behavior — fix the refactoring, not the test.',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'tester',
            description: [
                'Verify the refactoring:',
                '- Run the full test suite: Run `npm test` or equivalent',
                '- Run the type checker: Run `npx tsc --noEmit` or equivalent',
                '- Verify behavior is identical: the refactoring must not change external behavior',
                '- If new tests are needed (the refactoring exposed untested paths), add them',
                'The refactoring is complete only when all tests pass and the code is cleaner.',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
    ],
    parameters: [
        {
            name: 'refactorType',
            description: 'Type of refactoring (auto-detected from code analysis if not specified)',
            type: 'choice',
            required: false,
            options: ['extract', 'inline', 'rename', 'move', 'restructure', 'auto'],
            defaultValue: 'auto',
        },
        {
            name: 'target',
            description: 'File or function to refactor',
            type: 'file-path',
            required: false,
        },
    ],
    tags: ['refactor', 'restructure', 'extract', 'inline', 'rename', 'DRY', 'SOLID', 'clean-code'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * Environment setup skill — detect stack → install deps → configure →
 * verify → document.
 *
 * Methodology: detect the project stack (language, framework, tools), install
 * all dependencies (system + project), configure the environment (env vars,
 * database, services), verify everything works, and document the setup for
 * other contributors.
 */
export const envSetupSkill = {
    id: BUNDLED_SKILL_ID_ENV_SETUP,
    name: 'env-setup',
    description: 'Set up a development environment: detect the stack, install dependencies, configure services, verify everything works, and document the setup. Use when the goal asks to set up the environment, configure dev tools, bootstrap a project, or get the project running locally.',
    version: '1.0.0',
    goalPattern: 'environment setup configure dev install dependencies bootstrap local development get running',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Detect the project stack:',
                '- Read package.json / pyproject.toml / go.mod / Cargo.toml for: language, framework, scripts, dependencies',
                '- Read README.md for setup instructions (often has the exact steps)',
                '- Check for .env.example / .env.template for required environment variables',
                '- Check for docker-compose.yml / Makefile for setup commands',
                '- Note required system tools (Node, Python, Go, Docker, PostgreSQL, Redis, etc.)',
                'Produce: the stack, the required tools, and the setup sequence.',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'runner',
            description: [
                'Install dependencies in order:',
                '- System deps: install missing runtimes/tools (nvm, pyenv, go install, brew/apt)',
                '- Project deps: Run `npm install` / `pip install -e .` / `go mod download` / `cargo build`',
                '- Dev tools: linter, formatter, type checker (often in devDependencies)',
                '- Verify each install succeeded (check exit codes, no errors in output)',
                'Install system deps first, then project deps, then dev tools — in that order.',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: [
                'Configure the environment:',
                '- Copy .env.example to .env (or create .env from the template)',
                '- Set required env vars (database URL, API keys for dev services, ports)',
                '- Start required services (database, cache, queue) — via docker-compose or local install',
                '- Run database migrations if applicable: Run `npx prisma migrate dev` / `alembic upgrade head`',
                'The environment must be in a working state before verification.',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'tester',
            description: [
                'Verify the setup works:',
                '- Run the dev server: Run `npm run dev` / `python manage.py runserver` / etc.',
                '- Verify it starts without errors (check the output for crash/error)',
                '- Run the test suite: Run `npm test` or equivalent',
                '- Run the build: Run `npm run build` or equivalent',
                'If anything fails: diagnose the issue (missing dep, wrong env var, port conflict) and fix it.',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
        {
            agentType: 'writer',
            description: [
                'Document the setup:',
                '- Update README.md with: prerequisites, install steps, env var setup, how to run dev/test/build',
                '- Add a TROUBLESHOOTING section for common issues (port conflicts, missing env vars, DB connection)',
                '- Note any platform-specific steps (macOS vs Linux vs Windows)',
                'Future contributors should be able to set up from the README alone.',
            ].join('\n'),
            dependsOn: ['step-3'],
        },
    ],
    parameters: [
        {
            name: 'stack',
            description: 'Technology stack (auto-detected from project if not specified)',
            type: 'choice',
            required: false,
            options: ['node', 'python', 'go', 'rust', 'full-stack', 'auto'],
            defaultValue: 'auto',
        },
    ],
    tags: ['environment', 'setup', 'bootstrap', 'dependencies', 'configure', 'local-dev'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── data-analysis ─── */
export const dataAnalysisSkill = {
    id: 'skill-data-analysis',
    name: 'data-analysis',
    description: 'Analyze datasets, identify trends, generate insights, and produce visualizations (charts, summaries, dashboards). Use when the goal asks to explore, analyze, summarize, or visualize data from CSV, JSON, databases, or APIs.',
    version: '1.0.0',
    goalPattern: 'data analysis csv json dataset trends visualization chart summary explore data analysis dashboard insights',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Profile the data: load the dataset, check shape (rows/columns), dtypes, missing values, and basic statistics (mean, median, std, min, max).',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Clean the data: handle missing values (drop/fill/interpolate), remove duplicates, normalize types, and flag outliers.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Explore patterns: compute correlations, group-by aggregations, time-series decompositions, or distribution shapes as appropriate for the data type.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Generate visualizations: produce the most informative charts (bar, line, scatter, heatmap, box-plot). Save as PNG/SVG or embed in an HTML dashboard.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Write a summary report: top-5 insights with evidence (charts + stats), data quality notes, and recommended next steps.',
        },
    ],
    parameters: [
        { name: 'format', description: 'Output format', type: 'choice', required: false, options: ['html', 'markdown', 'jupyter', 'csv'], defaultValue: 'html' },
    ],
    tags: ['data', 'analysis', 'visualization', 'charts', 'insights', 'statistics'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── api-testing ─── */
export const apiTestingSkill = {
    id: 'skill-api-testing',
    name: 'api-testing',
    description: 'Test REST and GraphQL APIs: write automated tests for endpoints, validate status codes, response schemas, auth flows, and edge cases. Use when the goal asks to test, validate, or verify an API.',
    version: '1.0.0',
    goalPattern: 'test api endpoint rest graphql http request validate response status auth',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Discover endpoints: parse OpenAPI/Swagger specs, route files, or scan source code for route definitions. List all endpoints with methods, paths, and expected parameters.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Group tests by endpoint: happy path, error cases (400, 401, 403, 404, 500), boundary values, and auth scenarios (unauthenticated, expired token, insufficient scope).',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Write test files using the project test framework (vitest, jest, pytest, go test). Include setup for test DB, mocks for external services, and fixtures for request bodies.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Run tests and fix failures iteratively. Cover edge cases: empty bodies, invalid JSON, missing required fields, SQL-injection payloads in params.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Generate coverage report: total endpoints tested, pass/fail counts, response-time assertions, and schema validation results.',
        },
    ],
    parameters: [
        { name: 'framework', description: 'Test framework', type: 'choice', required: false, options: ['vitest', 'jest', 'pytest', 'go-test', 'curl', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['api', 'testing', 'rest', 'graphql', 'http', 'validation', 'endpoints'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── perf-test ─── */
export const perfTestSkill = {
    id: 'skill-perf-test',
    name: 'perf-test',
    description: 'Load test and benchmark web applications or APIs: measure throughput, latency percentiles (p50/p95/p99), and error rates under concurrent load. Use when the goal asks to load test, stress test, or benchmark performance.',
    version: '1.0.0',
    goalPattern: 'load test stress test benchmark performance throughput latency concurrent users k6 wrk ab artillery',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Define test scenarios: identify critical endpoints, expected concurrent users, test duration, and pass/fail thresholds (e.g. p95 < 200ms, error rate < 1%).',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Set up the load-testing tool (k6, Artillery, autocannon, wrk). Write the test script with configurable VUs, ramp-up, and think-time.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Run the baseline test (warm-up + measurement). Capture metrics: requests/sec, latency distribution, error counts, and resource usage.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Analyze results: identify bottlenecks (slow queries, connection pool exhaustion, memory leaks). Compare against thresholds.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Write a report with charts (latency over time, throughput vs VUs), bottleneck analysis, and optimization recommendations. Save the test script for CI regression.',
        },
    ],
    parameters: [
        { name: 'tool', description: 'Load-testing tool', type: 'choice', required: false, options: ['k6', 'artillery', 'autocannon', 'wrk', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['performance', 'load-test', 'stress-test', 'benchmark', 'throughput', 'latency'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── a11y-audit ─── */
export const a11yAuditSkill = {
    id: 'skill-a11y-audit',
    name: 'a11y-audit',
    description: 'Audit web applications for accessibility (WCAG 2.1 AA compliance): check color contrast, keyboard navigation, screen-reader compatibility, ARIA attributes, and semantic HTML. Use when the goal asks to audit, fix, or improve accessibility.',
    version: '1.0.0',
    goalPattern: 'accessibility a11y wcag audit screen reader keyboard nav aria contrast wcag',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Scan the codebase for accessibility issues: run automated tools (axe-core, pa11y, lighthouse) or inspect JSX for missing alt text, labels, ARIA roles, and semantic landmarks.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Categorize issues by severity: critical (blocks users), serious (hard to use), moderate (annoying), minor (cosmetic). Map to WCAG success criteria.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Fix critical and serious issues: add missing alt text, labels, ARIA attributes, keyboard handlers, focus management, and color contrast adjustments.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Test fixes: verify keyboard-only navigation, screen-reader output, and color contrast ratios. Re-run automated scanner.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Write an accessibility report: WCAG 2.1 AA conformance status, remaining issues by severity, and an accessibility statement for the project.',
        },
    ],
    parameters: [
        { name: 'scope', description: 'Audit scope', type: 'choice', required: false, options: ['full', 'critical-pages', 'components'], defaultValue: 'full' },
    ],
    tags: ['accessibility', 'a11y', 'wcag', 'screen-reader', 'keyboard', 'aria', 'compliance'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── search-setup ─── */
export const searchSetupSkill = {
    id: 'skill-search-setup',
    name: 'search-setup',
    description: 'Set up full-text search for a web application using Algolia, Meilisearch, Typesense, or Elasticsearch. Includes indexing pipeline, query optimization, and autocomplete. Use when the goal asks to add search, indexing, or autocomplete to an app.',
    version: '1.0.0',
    goalPattern: 'search indexing autocomplete algolia meilisearch elasticsearch typesense full-text search',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Choose the search engine based on data volume, latency requirements, and budget. Set up the service (local Docker or hosted).',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Design the index schema: define searchable fields, filters, sorting attributes, and ranking rules. Configure synonyms and stopwords.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Build the indexing pipeline: write a script or webhook to sync data from the primary source (DB, CMS, API) to the search index. Handle creates, updates, and deletes.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Implement the search UI: add a search input with debounced queries, autocomplete dropdown, faceted filters, and pagination. Handle empty and error states.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Test and optimize: verify query relevance (hit quality), response times (< 100ms), and index freshness. Write analytics hooks to track popular queries.',
        },
    ],
    parameters: [
        { name: 'engine', description: 'Search engine', type: 'choice', required: false, options: ['algolia', 'meilisearch', 'typesense', 'elasticsearch', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['search', 'indexing', 'autocomplete', 'full-text', 'algolia', 'meilisearch'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── email-setup ─── */
export const emailSetupSkill = {
    id: 'skill-email-setup',
    name: 'email-setup',
    description: 'Set up transactional email: design responsive HTML templates, configure SMTP/API delivery (SendGrid, Resend, Mailgun, Postmark), and build email sending functions. Use when the goal asks to send emails, build email templates, or configure email delivery.',
    version: '1.0.0',
    goalPattern: 'email send template smtp resend sendgrid mailgun postmark newsletter transactional email',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Choose the email provider and create an account. Install the SDK (e.g. resend, @sendgrid/mail). Set up env vars for API keys.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Design HTML email templates: create responsive templates for transactional emails (welcome, password reset, notifications). Use tables for email client compatibility.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Build the send function: wrap the provider SDK with a typed send() function that handles from/to/subject/template/variables. Add retry logic for transient failures.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Test end-to-end: send a test email, verify delivery, check spam score, and validate that links and tracking work. Test with multiple email clients.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Add webhook handlers for delivery events (delivered, opened, clicked, bounced). Log events for analytics and monitoring.',
        },
    ],
    parameters: [
        { name: 'provider', description: 'Email provider', type: 'choice', required: false, options: ['resend', 'sendgrid', 'mailgun', 'postmark', 'smtp', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['email', 'smtp', 'template', 'transactional', 'sendgrid', 'resend', 'delivery'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── payment-setup ─── */
export const paymentSetupSkill = {
    id: 'skill-payment-setup',
    name: 'payment-setup',
    description: 'Integrate payment processing with Stripe: implement checkout, subscriptions, webhooks, and invoice handling. Use when the goal asks to add payments, billing, subscriptions, or checkout to an app.',
    version: '1.0.0',
    goalPattern: 'payment stripe checkout subscription billing invoice payment processing recurring charge',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Set up Stripe: create an account, install the SDK, configure API keys (test + live), and define products/prices in the Stripe dashboard.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Implement checkout: create a checkout session endpoint, handle success/cancel redirects, and store the session ID for reconciliation.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Handle webhooks: register endpoint for checkout.session.completed, invoice.paid, subscription.deleted events. Verify webhook signatures for security.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Implement subscriptions: create pricing tables, handle plan changes (upgrade/downgrade), proration, and cancellation flows.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Test end-to-end: use Stripe test cards, verify webhook delivery, test failure scenarios (declined cards, failed payments), and validate receipt emails.',
        },
    ],
    parameters: [
        { name: 'mode', description: 'Integration mode', type: 'choice', required: false, options: ['checkout', 'subscriptions', 'invoices', 'full'], defaultValue: 'full' },
    ],
    tags: ['payment', 'stripe', 'checkout', 'subscription', 'billing', 'webhooks'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── auth-setup ─── */
export const authSetupSkill = {
    id: 'skill-auth-setup',
    name: 'auth-setup',
    description: 'Implement authentication and authorization: OAuth2 (Google, GitHub), magic links, JWT sessions, role-based access control. Use when the goal asks to add login, signup, auth, SSO, or RBAC to an app.',
    version: '1.0.0',
    goalPattern: 'auth login signup oauth sso jwt session rbac role access control authentication authorization magic link google github',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Choose auth strategy: OAuth2 providers, magic links, social login, or self-hosted. Install the auth library (NextAuth, Lucia, Passport, etc.).',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Configure providers: register OAuth apps with Google/GitHub/etc., set callback URLs, configure scopes, and store credentials securely.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Implement user flows: signup, login, logout, password reset, email verification. Handle session creation and JWT token refresh.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Add RBAC: define roles (admin, editor, viewer), protect routes with middleware, and handle permission checks in the UI.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Test and harden: verify CSRF protection, rate-limit login attempts, test role escalation scenarios, and audit token expiration.',
        },
    ],
    parameters: [
        { name: 'strategy', description: 'Auth strategy', type: 'choice', required: false, options: ['oauth2', 'magic-link', 'jwt', 'session', 'rbac', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['auth', 'login', 'oauth', 'jwt', 'session', 'rbac', 'security'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── monitoring-setup ─── */
export const monitoringSetupSkill = {
    id: 'skill-monitoring-setup',
    name: 'monitoring-setup',
    description: 'Set up application monitoring: structured logging, metrics collection, alerting rules, and health checks. Use when the goal asks to add logging, monitoring, observability, or alerting.',
    version: '1.0.0',
    goalPattern: 'monitoring logging metrics alerting observability health check prometheus grafana datadog structured logs',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Choose the monitoring stack: logging (Pino, Winston, structured JSON), metrics (Prometheus, OpenTelemetry), and dashboards (Grafana, Datadog).',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Add structured logging: instrument all key code paths with log levels (debug, info, warn, error). Include request ID, user ID, and duration for every request.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Add metrics: instrument HTTP requests (latency, status codes), business metrics (signups, orders), and system metrics (memory, CPU, event loop lag).',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Create alerting rules: define alerts for error rate spikes, latency degradation, high memory usage, and dependency failures.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Build a health-check endpoint: verify DB, cache, and external service connectivity. Add readiness and liveness probes.',
        },
    ],
    parameters: [
        { name: 'stack', description: 'Monitoring stack', type: 'choice', required: false, options: ['pino', 'winston', 'opentelemetry', 'datadog', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['monitoring', 'logging', 'metrics', 'alerting', 'observability', 'health-check'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── backup-recovery ─── */
export const backupRecoverySkill = {
    id: 'skill-backup-recovery',
    name: 'backup-recovery',
    description: 'Design and implement backup and disaster recovery: automated database backups, point-in-time recovery, S3 snapshots, and runbook documentation. Use when the goal asks to set up backups, recovery, or disaster resilience.',
    version: '1.0.0',
    goalPattern: 'backup recovery disaster recovery database backup restore snapshots runbook resilience',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Audit current state: identify all data stores (DB, file storage, cache), their backup capabilities, and current RPO/RTO targets.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Design backup strategy: define frequency (continuous, hourly, daily), retention policy, storage location (S3, GCS, separate region), and encryption.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Implement automated backups: write cron jobs or scheduled tasks for database dumps, file snapshots, and configuration backups. Verify checksums.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Test recovery: perform a full restore to an isolated environment, verify data integrity, measure recovery time.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Write a disaster recovery runbook: step-by-step recovery procedures, contact list, escalation path, and post-mortem template.',
        },
    ],
    parameters: [
        { name: 'scope', description: 'Backup scope', type: 'choice', required: false, options: ['database', 'full-stack', 'incremental', 'point-in-time'], defaultValue: 'full-stack' },
    ],
    tags: ['backup', 'recovery', 'disaster-recovery', 'resilience', 'runbook', 'rpo', 'rto'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── schema-design ─── */
export const schemaDesignSkill = {
    id: 'skill-schema-design',
    name: 'schema-design',
    description: 'Design database schemas and data models: entities, relationships, indexes, constraints, and normalization. Use when the goal asks to design, model, or restructure a database schema.',
    version: '1.0.0',
    goalPattern: 'schema design database model entity relationship normalize index migration erd data model',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Gather requirements: identify the business entities, their attributes, and the relationships between them (1:1, 1:N, N:M).',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Create an ER diagram: draw entities with attributes, cardinalities, and optional/mandatory participation. Identify primary and foreign keys.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Normalize to 3NF: eliminate redundancy, decompose composite attributes, and ensure every non-key attribute depends on the full primary key.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Add performance optimizations: design indexes for common queries, add composite indexes for multi-column lookups, and consider denormalization for read-heavy paths.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Generate the migration SQL and ORM models. Write the schema documentation with examples of common queries.',
        },
    ],
    parameters: [
        { name: 'dbType', description: 'Target database', type: 'choice', required: false, options: ['postgresql', 'mysql', 'sqlite', 'mongodb', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['schema', 'database', 'model', 'erd', 'normalization', 'indexing', 'sql'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── i18n-setup ─── */
export const i18nSetupSkill = {
    id: 'skill-i18n-setup',
    name: 'i18n-setup',
    description: 'Set up internationalization (i18n): extract translatable strings, configure a translation framework, and add RTL support. Use when the goal asks to add multi-language support, translations, or localization.',
    version: '1.0.0',
    goalPattern: 'i18n internationalization localization translation multilingual language rtl l10n',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Choose an i18n framework: next-intl, react-i18next, vue-i18n, or similar. Install and configure it with the project framework.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Extract translatable strings: scan source files for hardcoded text, move them to translation files (JSON/YAML), and replace with translation keys.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Set up locale management: configure supported locales, locale detection (browser, URL, cookie), and locale switching UI.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Handle plurals, dates, numbers, and currencies: configure ICU message format, and add locale-specific formatting for dates and numbers.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Add RTL support: configure CSS logical properties, test layout with Arabic/Hebrew, and verify that all components render correctly in both directions.',
        },
    ],
    parameters: [
        { name: 'framework', description: 'i18n framework', type: 'choice', required: false, options: ['next-intl', 'react-i18next', 'vue-i18n', 'i18next', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['i18n', 'localization', 'translation', 'multilingual', 'rtl', 'locale'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── graphql-api ─── */
export const graphqlApiSkill = {
    id: 'skill-graphql-api',
    name: 'graphql-api',
    description: 'Design and implement GraphQL APIs: schema definition, resolvers, subscriptions, N+1 prevention, and query complexity limiting. Use when the goal asks to build a GraphQL API or migrate from REST to GraphQL.',
    version: '1.0.0',
    goalPattern: 'graphql schema resolver subscription apollo yoga n+1 dataloader codegen',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Design the GraphQL schema: define types, queries, mutations, and subscriptions using SDL. Include input types, enums, and union types.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Implement resolvers: map each field to a data source. Use DataLoader for N+1 prevention on nested queries. Handle errors with GraphQL error extensions.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Add query complexity and depth limiting: prevent abuse by limiting query depth, field count, and computed complexity scores.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Set up subscriptions (WebSocket or SSE): implement real-time updates for mutations that should push to clients.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Generate TypeScript types from the schema (GraphQL Codegen), write integration tests, and document the API with example queries.',
        },
    ],
    parameters: [
        { name: 'runtime', description: 'GraphQL runtime', type: 'choice', required: false, options: ['apollo', 'yoga', 'mercurius', 'graphql-yoga', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['graphql', 'schema', 'resolver', 'subscription', 'dataloader', 'codegen'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── git-release ─── */
export const gitReleaseSkill = {
    id: 'skill-git-release',
    name: 'git-release',
    description: 'Manage git releases: changelog generation, semantic versioning, release branches, tagging, and publishing to package registries. Use when the goal asks to cut a release, create a changelog, or publish a package.',
    version: '1.0.0',
    goalPattern: 'release changelog semantic version semver tag publish npm github release hotfix',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Determine the version bump: analyze commit messages since last release, classify as major/minor/patch using conventional commits.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Generate the changelog: group commits by type (feat, fix, chore, docs), write release notes with contributor attributions.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Create a release branch (release/X.Y.Z), update version in package.json / Cargo.toml / pyproject.toml, and commit.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Tag the release (vX.Y.Z), push the tag and branch, and create a GitHub/GitLab release with the changelog body.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Publish: run npm publish / cargo publish / twine upload. Verify the package appears in the registry. Merge the release branch back to main.',
        },
    ],
    parameters: [
        { name: 'type', description: 'Release type', type: 'choice', required: false, options: ['npm', 'cargo', 'pypi', 'github', 'docker', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['release', 'changelog', 'semver', 'tag', 'publish', 'git', 'github'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── design-system ─── */
export const designSystemSkill = {
    id: 'skill-design-system',
    name: 'design-system',
    description: 'Build a component library / design system: tokens, base components, composition patterns, documentation, and testing. Use when the goal asks to create a design system, component library, or shared UI kit.',
    version: '1.0.0',
    goalPattern: 'design system component library ui kit tokens storybook tailwind shadcn radix',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Define design tokens: color palette, typography scale, spacing units, border radius, shadows. Export as CSS variables and JS/TS constants.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Build base components: Button, Input, Select, Checkbox, Radio, Switch, Textarea, Modal. Each with variants (size, color), states (disabled, loading, error), and accessibility.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Build composition components: Card, Table, Tabs, Accordion, Dropdown, Tooltip, Toast. Each using the base components.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Set up Storybook (or similar): write stories for every component with all variants and states. Add interaction tests.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Publish the library: configure build (tsup/rollup), add package.json exports, write a README with usage examples, and publish to npm.',
        },
    ],
    parameters: [
        { name: 'framework', description: 'UI framework', type: 'choice', required: false, options: ['react', 'vue', 'svelte', 'web-components', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['design-system', 'components', 'tokens', 'storybook', 'ui-kit', 'library'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── legal-compliance ─── */
export const legalComplianceSkill = {
    id: 'skill-legal-compliance',
    name: 'legal-compliance',
    description: 'Add legal compliance: privacy policy, terms of service, cookie consent, GDPR/CCPA data handling, and cookie banners. Use when the goal asks to add legal pages, privacy policy, cookie consent, or compliance with privacy regulations.',
    version: '1.0.0',
    goalPattern: 'legal compliance privacy policy terms of service cookie consent gdpr ccpa cookie banner gdpr',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Audit data collection: identify what personal data is collected (forms, cookies, analytics), how it is stored, and who it is shared with.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Create a cookie consent banner: implement a GDPR-compliant consent manager that blocks non-essential cookies until explicit consent is given.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Draft privacy policy and terms of service: use a template generator or legal framework, customize for the app specific data practices.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Implement data export and deletion (right to be forgotten): build endpoints for users to download or delete their personal data.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Add consent logging: record when and what the user consented to. Set up a data processing agreement template for third-party services.',
        },
    ],
    parameters: [
        { name: 'regulation', description: 'Target regulation', type: 'choice', required: false, options: ['gdpr', 'ccpa', 'both', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['legal', 'compliance', 'gdpr', 'ccpa', 'privacy', 'cookies', 'consent'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── cron-setup ─── */
export const cronSetupSkill = {
    id: 'skill-cron-setup',
    name: 'cron-setup',
    description: 'Set up scheduled tasks and cron jobs: periodic reports, cleanup jobs, data sync, and monitoring probes. Use when the goal asks to schedule tasks, set up cron jobs, or automate periodic work.',
    version: '1.0.0',
    goalPattern: 'cron schedule task periodic timer interval report cleanup sync automation scheduled',
    steps: [
        {
            agentType: 'analyst',
            dependsOn: [],
            description: 'Define the schedule: determine frequency (every minute, hourly, daily, weekly), timezone, and whether the job needs to run on a specific server or distributed.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-1'],
            description: 'Choose the scheduler: node-cron, bull/bullmq, system crontab, or cloud scheduler (Cloud Functions, Lambda, GitHub Actions).',
        },
        {
            agentType: 'analyst', dependsOn: ['step-2'],
            description: 'Implement the job: write the task logic with proper error handling, idempotency (safe to re-run), and logging. Include a heartbeat.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-3'],
            description: 'Add monitoring: log start/end, duration, and outcome. Set up alerts for missed runs or excessive duration.',
        },
        {
            agentType: 'analyst', dependsOn: ['step-4'],
            description: 'Test the schedule: run the job manually, verify it handles failures gracefully, and document the job for future maintainers.',
        },
    ],
    parameters: [
        { name: 'scheduler', description: 'Scheduler', type: 'choice', required: false, options: ['node-cron', 'bullmq', 'crontab', 'github-actions', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['cron', 'schedule', 'automation', 'periodic', 'timer', 'jobs'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── image-optimize ─── */
export const imageOptimizeSkill = {
    id: 'skill-image-optimize',
    name: 'image-optimize',
    description: 'Optimize images for web: compress, resize, convert formats (WebP, AVIF), generate thumbnails, and set up responsive images. Use when the goal asks to optimize images, reduce image size, or add responsive images.',
    version: '1.0.0',
    goalPattern: 'image optimize compress resize webp avif thumbnail responsive image optimization',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Audit current images: identify formats, sizes, and dimensions. Find oversized or unoptimized assets.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Choose optimization strategy: lossy vs lossless, target formats (WebP/AVIF), max dimensions, and quality settings.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Implement optimization pipeline: use sharp, imagemin, or squoosh to batch-compress images. Generate responsive variants (1x, 2x, 3x).' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Set up lazy loading: add loading=lazy attributes, intersection observer fallback, and placeholder blur-up images.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Verify: compare file sizes before/after, check visual quality, test on slow connections, and document the pipeline.' },
    ],
    parameters: [
        { name: 'format', description: 'Target format', type: 'choice', required: false, options: ['webp', 'avif', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['image', 'optimize', 'compress', 'webp', 'avif', 'responsive', 'performance'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── pdf-generate ─── */
export const pdfGenerateSkill = {
    id: 'skill-pdf-generate',
    name: 'pdf-generate',
    description: 'Generate PDFs from HTML, Markdown, or data: invoices, reports, certificates, and documents. Use when the goal asks to create, generate, or export PDF files.',
    version: '1.0.0',
    goalPattern: 'pdf generate create export invoice report document print html markdown',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Identify the PDF type: invoice, report, certificate, receipt. Choose the generation library (puppeteer, pdfkit, jspdf).' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Design the layout: create an HTML template or programmatic layout with headers, footers, tables, and page breaks.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Implement generation: wrap the library with a typed generatePdf() function that accepts data and returns a Buffer.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Add styling: CSS for print media, page margins, fonts, and colors. Test with different data sizes.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Test and verify: generate sample PDFs, check file size, validate content, and test edge cases (empty data, long text).' },
    ],
    parameters: [
        { name: 'library', description: 'PDF library', type: 'choice', required: false, options: ['puppeteer', 'pdfkit', 'jspdf', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['pdf', 'generate', 'export', 'invoice', 'report', 'document'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── cache-setup ─── */
export const cacheSetupSkill = {
    id: 'skill-cache-setup',
    name: 'cache-setup',
    description: 'Set up caching: Redis, Memcached, or in-memory caching for API responses, sessions, and expensive computations. Use when the goal asks to add caching, improve response times, or reduce database load.',
    version: '1.0.0',
    goalPattern: 'cache redis memcached caching performance speed up response time',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Identify cache targets: expensive queries, API responses, session data, and computed results. Choose the cache backend.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Set up the cache client: install Redis/Memcached driver, configure connection, add health checks.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Implement caching patterns: cache-aside, write-through, or write-behind. Define TTLs and invalidation strategies.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Add cache warming: pre-populate hot keys on startup. Add cache stampede protection (locks/lease).' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Monitor and tune: add hit/miss metrics, measure latency improvement, and tune TTLs based on access patterns.' },
    ],
    parameters: [
        { name: 'backend', description: 'Cache backend', type: 'choice', required: false, options: ['redis', 'memcached', 'memory', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['cache', 'redis', 'memcached', 'performance', 'caching', 'speed'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── queue-setup ─── */
export const queueSetupSkill = {
    id: 'skill-queue-setup',
    name: 'queue-setup',
    description: 'Set up message queues: BullMQ, RabbitMQ, or SQS for background jobs, task processing, and event-driven architecture. Use when the goal asks to add background jobs, task queues, or async processing.',
    version: '1.0.0',
    goalPattern: 'queue job background worker bullmq rabbitmq sqs async processing task',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Identify job types: email sending, image processing, data sync, report generation. Choose the queue backend.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Set up the queue: install the library, configure Redis/connection, define job schemas with TypeScript types.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Implement producers: add enqueue functions with retry logic, priority, delays, and deduplication.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Implement consumers: write worker processors with concurrency limits, error handling, and dead-letter queues.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Add monitoring: dashboard for queue depth, processing times, failures. Set up alerts for stuck jobs.' },
    ],
    parameters: [
        { name: 'backend', description: 'Queue backend', type: 'choice', required: false, options: ['bullmq', 'rabbitmq', 'sqs', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['queue', 'job', 'background', 'worker', 'async', 'bullmq', 'rabbitmq'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── rate-limit ─── */
export const rateLimitSkill = {
    id: 'skill-rate-limit',
    name: 'rate-limit',
    description: 'Implement rate limiting: per-IP, per-user, or per-API-key limits with sliding window, token bucket, or fixed window algorithms. Use when the goal asks to add rate limiting, throttle requests, or prevent abuse.',
    version: '1.0.0',
    goalPattern: 'rate limit throttle abuse prevention api protection sliding window token bucket',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Define rate limit policies: limits per endpoint, per user/IP, window size, and response headers (X-RateLimit-*).' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Choose the algorithm: sliding window (Redis), token bucket, or fixed window. Pick the storage backend.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Implement middleware: Express/Fastify middleware that checks limits, increments counters, and returns 429 with Retry-After.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Add bypass rules: whitelist admin IPs, exempt health checks, and support dynamic limits per tier.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Test: verify limits trigger correctly, check 429 responses, measure overhead, and test distributed scenarios.' },
    ],
    parameters: [
        { name: 'algorithm', description: 'Algorithm', type: 'choice', required: false, options: ['sliding-window', 'token-bucket', 'fixed-window', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['rate-limit', 'throttle', 'abuse', 'protection', 'api', 'middleware'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── cors-setup ─── */
export const corsSetupSkill = {
    id: 'skill-cors-setup',
    name: 'cors-setup',
    description: 'Configure CORS: cross-origin resource sharing for APIs, web apps, and embedded content. Use when the goal asks to fix CORS errors, configure cross-origin access, or set up CORS headers.',
    version: '1.0.0',
    goalPattern: 'cors cross-origin access origin header preflight error fix configuration',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Audit current CORS setup: check which origins are allowed, what headers are exposed, and identify any CORS errors in the browser.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Define the CORS policy: allowed origins, methods, headers, credentials, max-age, and preflight behavior.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Implement CORS middleware: use the cors package or custom middleware. Handle preflight OPTIONS requests.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Test cross-origin requests: verify preflight works, credentials are sent, and headers are exposed correctly.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Harden: restrict origins in production, add Vary: Origin header, and document the CORS policy.' },
    ],
    parameters: [
        { name: 'framework', description: 'Framework', type: 'choice', required: false, options: ['express', 'fastify', 'nextjs', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['cors', 'cross-origin', 'api', 'security', 'headers', 'preflight'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── error-tracking ─── */
export const errorTrackingSkill = {
    id: 'skill-error-tracking',
    name: 'error-tracking',
    description: 'Set up error tracking: Sentry, Bugsnag, or Rollbar for frontend and backend error monitoring. Use when the goal asks to add error tracking, exception monitoring, or crash reporting.',
    version: '1.0.0',
    goalPattern: 'error tracking sentry bugsnag rollbar crash monitoring exception reporting',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Choose the error tracking service: Sentry (most popular), Bugsnag, or Rollbar. Create an account and get the DSN.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Install and configure the SDK: add to both frontend and backend. Configure source maps, release tracking, and environment.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Add context: user info, breadcrumbs, tags, and extra data. Set up error grouping rules.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Configure alerts: email/Slack alerts for new errors, regression detection, and volume spikes.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Test: throw test errors in dev, verify they appear in the dashboard, and check source maps work.' },
    ],
    parameters: [
        { name: 'service', description: 'Error tracking service', type: 'choice', required: false, options: ['sentry', 'bugsnag', 'rollbar', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['error', 'tracking', 'sentry', 'monitoring', 'crash', 'exception'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── feature-flags ─── */
export const featureFlagsSkill = {
    id: 'skill-feature-flags',
    name: 'feature-flags',
    description: 'Implement feature flags: LaunchDarkly, Unleash, or custom flags for gradual rollouts, A/B testing, and kill switches. Use when the goal asks to add feature flags, gradual rollouts, or toggle features.',
    version: '1.0.0',
    goalPattern: 'feature flag toggle rollout ab testing kill switch launchdarkly unleash',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Choose the feature flag system: LaunchDarkly, Unleash, Flipt, or a custom in-memory store. Install and configure.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Define flags: create flag definitions with types (boolean, string, number), default values, and targeting rules.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Integrate in code: wrap feature checks in flag evaluation functions. Add server-side and client-side SDKs.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Set up gradual rollout: percentage-based rollouts, user segmentation, and environment-specific overrides.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Monitor and clean up: track flag usage, remove stale flags, and document the flag lifecycle process.' },
    ],
    parameters: [
        { name: 'provider', description: 'Feature flag provider', type: 'choice', required: false, options: ['launchdarkly', 'unleash', 'flipt', 'custom', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['feature-flags', 'toggle', 'rollout', 'ab-testing', 'gradual', 'kill-switch'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── webhook-setup ─── */
export const webhookSetupSkill = {
    id: 'skill-webhook-setup',
    name: 'webhook-setup',
    description: 'Set up webhooks: receive and verify incoming webhooks from third-party services (Stripe, GitHub, Twilio). Use when the goal asks to handle webhooks, verify webhook signatures, or process webhook events.',
    version: '1.0.0',
    goalPattern: 'webhook receive verify signature stripe github twilio event callback',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Identify webhook sources: list the third-party services sending webhooks and their event types.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Implement the endpoint: create a POST handler that receives raw body, verifies the signature, and parses the event.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Add signature verification: implement HMAC-SHA256 verification for each provider. Handle timestamp tolerance.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Process events: route events to handlers, implement idempotency (dedup by event ID), and acknowledge quickly.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Add resilience: retry logic for failed processing, dead-letter queue for poison events, and monitoring.' },
    ],
    parameters: [
        { name: 'provider', description: 'Webhook source', type: 'choice', required: false, options: ['stripe', 'github', 'twilio', 'generic', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['webhook', 'signature', 'verify', 'event', 'callback', 'integration'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── form-builder ─── */
export const formBuilderSkill = {
    id: 'skill-form-builder',
    name: 'form-builder',
    description: 'Build dynamic forms: validation, conditional fields, multi-step wizards, and file uploads. Use when the goal asks to create forms, add form validation, or build multi-step forms.',
    version: '1.0.0',
    goalPattern: 'form builder validation wizard multi-step file upload input dynamic fields',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Define the form schema: fields, types, validation rules, conditional visibility, and default values.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Choose the form library: react-hook-form, formik, zod validation, or HTML5 native. Install and configure.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Implement the form: build field components, add validation, handle multi-step navigation, and manage state.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Add file uploads: implement drag-and-drop, preview, progress bars, and server-side storage.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Test and polish: verify validation messages, test edge cases, add loading states, and ensure accessibility.' },
    ],
    parameters: [
        { name: 'framework', description: 'UI framework', type: 'choice', required: false, options: ['react', 'vue', 'svelte', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['form', 'validation', 'wizard', 'multi-step', 'upload', 'input'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── data-sync ─── */
export const dataSyncSkill = {
    id: 'skill-data-sync',
    name: 'data-sync',
    description: 'Set up data synchronization between systems: ETL pipelines, API sync, database replication, and real-time streaming. Use when the goal asks to sync data, build ETL pipelines, or connect data sources.',
    version: '1.0.0',
    goalPattern: 'data sync etl pipeline replicate stream transform migrate connect sources',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Map data sources: identify source and destination systems, data formats, sync frequency, and conflict resolution strategy.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Choose the sync approach: batch ETL, CDC (change data capture), API polling, or real-time streaming (WebSocket/SSE).' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Implement the pipeline: write extract/transform/load functions with error handling, idempotency, and logging.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Add scheduling: cron-based runs, event-driven triggers, or manual invocation. Handle partial failures and retries.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Monitor: track sync status, record metrics (rows synced, duration, errors), and set up alerts for failures.' },
    ],
    parameters: [
        { name: 'approach', description: 'Sync approach', type: 'choice', required: false, options: ['batch-etl', 'cdc', 'api-polling', 'streaming', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['data', 'sync', 'etl', 'pipeline', 'replicate', 'stream', 'transform'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── state-machine ─── */
export const stateMachineSkill = {
    id: 'skill-state-machine',
    name: 'state-machine',
    description: 'Design and implement state machines: order lifecycle, approval workflows, and complex business logic. Use when the goal asks to add state management, workflow automation, or business process logic.',
    version: '1.0.0',
    goalPattern: 'state machine workflow lifecycle order approval process automation transition',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Define states and transitions: map all possible states, events that trigger transitions, and guard conditions.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Choose the library: xstate, robot, or a custom implementation. Define the statechart with context and actions.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Implement the machine: create states, transitions, actions, and guards. Add side effects for entry/exit.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Integrate with the app: connect the machine to UI components, API calls, and database state.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Test: verify all transitions, test guard conditions, check side effects, and handle error states.' },
    ],
    parameters: [
        { name: 'library', description: 'State machine library', type: 'choice', required: false, options: ['xstate', 'robot', 'custom', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['state-machine', 'workflow', 'lifecycle', 'process', 'automation', 'transition'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── websocket-setup ─── */
export const websocketSetupSkill = {
    id: 'skill-websocket-setup',
    name: 'websocket-setup',
    description: 'Set up WebSocket connections: real-time chat, notifications, live updates, and collaboration features. Use when the goal asks to add real-time features, WebSocket connections, or live data.',
    version: '1.0.0',
    goalPattern: 'websocket realtime live chat notification collaboration socket real-time update',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Choose the WebSocket library: ws, Socket.IO, or native WebSocket. Consider scaling needs (sticky sessions, Redis adapter).' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Implement the server: create WebSocket server with connection handling, rooms/channels, and message routing.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Implement the client: connect, handle reconnection, send/receive messages, and manage connection state.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Add authentication: verify tokens on connection, implement per-room permissions, and handle disconnections.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Scale and monitor: add Redis adapter for multi-instance, track connections, and monitor message throughput.' },
    ],
    parameters: [
        { name: 'library', description: 'WebSocket library', type: 'choice', required: false, options: ['ws', 'socket-io', 'native', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['websocket', 'realtime', 'chat', 'notification', 'live', 'collaboration'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── api-versioning ─── */
export const apiVersioningSkill = {
    id: 'skill-api-versioning',
    name: 'api-versioning',
    description: 'Implement API versioning: URL path, header, or content-type versioning with deprecation notices and migration guides. Use when the goal asks to version an API, handle breaking changes, or add deprecation notices.',
    version: '1.0.0',
    goalPattern: 'api version versioning deprecation breaking change migration url header',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Choose versioning strategy: URL path (/v1/), header (API-Version), or content-type negotiation. Define version lifecycle.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Restructure routes: move existing endpoints under a version prefix. Set up version-aware middleware.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Add deprecation support: implement Sunset header, deprecation warnings in responses, and version negotiation.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Write migration guides: document breaking changes between versions, provide code examples for upgrades.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Test version coexistence: verify v1 and v2 endpoints work simultaneously, check deprecation headers appear.' },
    ],
    parameters: [
        { name: 'strategy', description: 'Versioning strategy', type: 'choice', required: false, options: ['url-path', 'header', 'content-type', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['api', 'versioning', 'deprecation', 'migration', 'breaking-change', 'rest'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── multi-tenancy ─── */
export const multiTenancySkill = {
    id: 'skill-multi-tenancy',
    name: 'multi-tenancy',
    description: 'Implement multi-tenancy: tenant isolation, shared databases with row-level security, or separate schemas. Use when the goal asks to add multi-tenancy, tenant isolation, or SaaS data separation.',
    version: '1.0.0',
    goalPattern: 'multi-tenancy tenant isolation saas data separation row-level security shared database',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Choose the tenancy model: shared database (row-level), schema-per-tenant, or database-per-tenant. Assess isolation requirements.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Implement tenant context: add tenant ID to all requests via middleware, JWT claims, or subdomain routing.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Enforce isolation: add row-level security policies, schema switching, or database routing based on tenant context.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Handle tenant lifecycle: implement tenant creation, suspension, deletion, and data migration between tiers.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Test isolation: verify tenant A cannot access tenant B data, test cross-tenant queries fail, and audit the security.' },
    ],
    parameters: [
        { name: 'model', description: 'Tenancy model', type: 'choice', required: false, options: ['shared-db', 'schema-per-tenant', 'db-per-tenant', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['multi-tenancy', 'tenant', 'isolation', 'saas', 'security', 'data-separation'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── blob-storage ─── */
export const blobStorageSkill = {
    id: 'skill-blob-storage',
    name: 'blob-storage',
    description: 'Set up blob/file storage: S3, Cloudflare R2, or Azure Blob for uploads, assets, and backups. Use when the goal asks to add file uploads, cloud storage, or asset hosting.',
    version: '1.0.0',
    goalPattern: 'blob storage s3 cloudflare r2 azure upload file asset hosting bucket',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Choose the storage provider: S3, R2, Azure Blob, or MinIO. Set up the bucket/container with appropriate permissions.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Implement upload: create presigned URLs for client-side upload, or server-side upload with streaming.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Add access control: implement signed URLs for read, bucket policies for public assets, and ACL for private files.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Handle processing: add image resizing on upload, virus scanning, and metadata extraction.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Test and optimize: verify uploads work, test file serving, add CDN caching, and monitor storage costs.' },
    ],
    parameters: [
        { name: 'provider', description: 'Storage provider', type: 'choice', required: false, options: ['s3', 'r2', 'azure', 'minio', 'auto'], defaultValue: 'auto' },
    ],
    tags: ['blob', 'storage', 's3', 'upload', 'file', 'asset', 'cdn'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/** ─── notification-setup ─── */
export const notificationSetupSkill = {
    id: 'skill-notification-setup',
    name: 'notification-setup',
    description: 'Build a notification system: push notifications, in-app alerts, email digests, and preference management. Use when the goal asks to add notifications, alerts, or user notification preferences.',
    version: '1.0.0',
    goalPattern: 'notification push alert in-app email digest preference bell notification center',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Define notification types: in-app, email, push, SMS. Map events to notification templates and delivery channels.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Build the notification store: create the schema for notifications (user_id, type, title, body, read, created_at).' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Implement delivery: send in-app notifications via API, queue email/SMS for async delivery, register push tokens.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Add preference management: let users toggle notification types, set quiet hours, and choose channels.' },
        { agentType: 'analyst', dependsOn: ['step-3'], description: 'Build the UI: notification bell with unread count, notification center with filters, and mark-as-read.' },
    ],
    parameters: [
        { name: 'channels', description: 'Notification channels', type: 'choice', required: false, options: ['in-app', 'email', 'push', 'all'], defaultValue: 'all' },
    ],
    tags: ['notification', 'alert', 'push', 'email', 'in-app', 'preferences'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
// ── Phase 2: 20 additional skills ─────────────────────────────────────
export const webScrapingSkill = {
    id: 'skill-web-scraping',
    name: 'web-scraping',
    description: 'Build web scrapers using BeautifulSoup, Playwright, or Puppeteer. Use when the goal asks to scrape, crawl, or extract data from websites.',
    version: '1.0.0',
    goalPattern: 'scrape crawl extract data website html parse',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Identify target URLs and data to extract. Choose scraping tool (BeautifulSoup for simple HTML, Playwright/Puppeteer for dynamic sites).' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Implement HTTP fetching with rate limiting, retry logic, and user-agent rotation.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Parse HTML and extract data using CSS selectors or XPath. Handle pagination and nested content.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Store extracted data (JSON, CSV, database). Add deduplication and data validation.' },
    ],
    parameters: [
        { name: 'tool', description: 'Scraping tool', type: 'choice', required: false, options: ['beautifulsoup', 'playwright', 'puppeteer'], defaultValue: 'beautifulsoup' },
    ],
    tags: ['scraping', 'crawl', 'web', 'data-extraction', 'html'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const dataProcessingSkill = {
    id: 'skill-data-processing',
    name: 'data-processing',
    description: 'Process and transform data using Pandas, NumPy, or Polars. Use when the goal asks to clean, transform, aggregate, or analyze datasets.',
    version: '1.0.0',
    goalPattern: 'data process transform clean aggregate analyze pandas numpy',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Load data from source (CSV, JSON, database). Inspect schema, missing values, and data types.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Clean data: handle missing values, remove duplicates, fix data types, normalize formats.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Transform data: filter rows, add computed columns, merge datasets, pivot/aggregate.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Output results: save to file, generate reports, create visualizations.' },
    ],
    parameters: [
        { name: 'library', description: 'Data processing library', type: 'choice', required: false, options: ['pandas', 'polars', 'numpy'], defaultValue: 'pandas' },
    ],
    tags: ['data', 'pandas', 'numpy', 'transform', 'clean', 'aggregate'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const mlModelSkill = {
    id: 'skill-ml-model',
    name: 'ml-model',
    description: 'Build and train ML models using scikit-learn, TensorFlow, or PyTorch. Use when the goal asks to train, evaluate, or deploy machine learning models.',
    version: '1.0.0',
    goalPattern: 'machine learning model train predict classify regress ml ai',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Load and explore dataset. Perform feature engineering and selection.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Split data into train/test sets. Choose model architecture and hyperparameters.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Train model with cross-validation. Evaluate metrics (accuracy, precision, recall, F1).' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Save model, create inference pipeline, document results.' },
    ],
    parameters: [
        { name: 'framework', description: 'ML framework', type: 'choice', required: false, options: ['scikit-learn', 'tensorflow', 'pytorch'], defaultValue: 'scikit-learn' },
    ],
    tags: ['ml', 'machine-learning', 'train', 'predict', 'classify', 'regress'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const cloudDeploySkill = {
    id: 'skill-cloud-deploy',
    name: 'cloud-deploy',
    description: 'Deploy applications to AWS, GCP, or Azure. Use when the goal asks to deploy, host, or infrastructure-as-code for cloud platforms.',
    version: '1.0.0',
    goalPattern: 'deploy cloud aws gcp azure serverless lambda ec2',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Choose cloud provider and deployment strategy (serverless, containers, VMs).' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Configure IAM roles, VPCs, security groups, and networking.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Set up CI/CD pipeline for automated deployments with rollback support.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Configure monitoring, logging, and alerting for the deployed application.' },
    ],
    parameters: [
        { name: 'provider', description: 'Cloud provider', type: 'choice', required: false, options: ['aws', 'gcp', 'azure'], defaultValue: 'aws' },
    ],
    tags: ['cloud', 'deploy', 'aws', 'gcp', 'azure', 'serverless', 'infrastructure'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const kubernetesSkill = {
    id: 'skill-kubernetes',
    name: 'kubernetes',
    description: 'Configure and manage Kubernetes clusters. Use when the goal asks to deploy, scale, or manage containerized applications on Kubernetes.',
    version: '1.0.0',
    goalPattern: 'kubernetes k8s cluster pod deployment service ingress helm',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Create Kubernetes manifests: Deployment, Service, ConfigMap, Secret, Ingress.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Configure resource limits, health checks (liveness/readiness probes), and autoscaling (HPA).' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Set up Helm charts for templated deployments with environment-specific values.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Configure RBAC, network policies, and monitoring (Prometheus/Grafana).' },
    ],
    parameters: [
        { name: 'tool', description: 'K8s management tool', type: 'choice', required: false, options: ['kubectl', 'helm', 'kustomize'], defaultValue: 'kubectl' },
    ],
    tags: ['kubernetes', 'k8s', 'containers', 'orchestration', 'helm', 'deploy'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const githubActionsSkill = {
    id: 'skill-github-actions',
    name: 'github-actions',
    description: 'Set up GitHub Actions CI/CD workflows. Use when the goal asks to automate testing, building, or deployment via GitHub Actions.',
    version: '1.0.0',
    goalPattern: 'github actions ci cd workflow pipeline automate test build deploy',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Define workflow triggers (push, PR, schedule) and job matrix (OS, language versions).' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Add steps: checkout, setup, install, lint, test, build, deploy. Use caching for dependencies.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Add secrets management, artifact uploads, and environment-specific deployments.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Add status checks, branch protection, and deployment gates.' },
    ],
    parameters: [
        { name: 'language', description: 'Primary language', type: 'choice', required: false, options: ['typescript', 'python', 'go', 'rust'], defaultValue: 'typescript' },
    ],
    tags: ['github', 'actions', 'ci-cd', 'workflow', 'pipeline', 'automate'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const prometheusSkill = {
    id: 'skill-prometheus',
    name: 'prometheus',
    description: 'Set up Prometheus monitoring and alerting. Use when the goal asks to add metrics collection, dashboards, or alerting rules.',
    version: '1.0.0',
    goalPattern: 'prometheus monitoring metrics alert grafana dashboard promql',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Define key metrics: request rate, error rate, latency percentiles, resource utilization.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Instrument application with Prometheus client library (counters, histograms, gauges).' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Configure Prometheus scrape targets, retention, and storage.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Create Grafana dashboards and alerting rules ( PagerDuty, Slack, email).' },
    ],
    parameters: [
        { name: 'alertChannel', description: 'Alert notification channel', type: 'choice', required: false, options: ['slack', 'email', 'pagerduty'], defaultValue: 'slack' },
    ],
    tags: ['prometheus', 'monitoring', 'metrics', 'alerting', 'grafana', 'observability'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const structuredLoggingSkill = {
    id: 'skill-structured-logging',
    name: 'structured-logging',
    description: 'Implement structured logging with JSON output. Use when the goal asks to add logging, log aggregation, or log-based debugging.',
    version: '1.0.0',
    goalPattern: 'logging structured json log aggregation elk loki Winston pino',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Choose logging library (Winston, Pino, bunyan). Define log levels and structured fields.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Implement request context logging (request ID, user ID, trace ID) for correlation.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Add log transport: stdout for dev, file/ELK/Loki for production.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Add log-based alerting and debugging dashboards.' },
    ],
    parameters: [
        { name: 'library', description: 'Logging library', type: 'choice', required: false, options: ['winston', 'pino', 'bunyan'], defaultValue: 'pino' },
    ],
    tags: ['logging', 'structured', 'json', 'elk', 'loki', 'observability'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const redisCacheSkill = {
    id: 'skill-redis-cache',
    name: 'redis-cache',
    description: 'Set up Redis caching layer. Use when the goal asks to add caching, session storage, or rate limiting with Redis.',
    version: '1.0.0',
    goalPattern: 'redis cache session store rate limit pub sub queue',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Choose caching strategy: cache-aside, write-through, write-behind. Define cache keys and TTLs.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Implement Redis connection with pooling, retry logic, and cluster support.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Add cache invalidation: TTL-based, event-based, manual invalidation.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Monitor cache hit rate, memory usage, and evictions. Add warming strategies.' },
    ],
    parameters: [
        { name: 'strategy', description: 'Caching strategy', type: 'choice', required: false, options: ['cache-aside', 'write-through', 'write-behind'], defaultValue: 'cache-aside' },
    ],
    tags: ['redis', 'cache', 'session', 'rate-limit', 'pub-sub'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const kafkaQueueSkill = {
    id: 'skill-kafka-queue',
    name: 'kafka-queue',
    description: 'Set up Kafka message queues. Use when the goal asks to add event streaming, message queues, or async processing with Kafka.',
    version: '1.0.0',
    goalPattern: 'kafka message queue event streaming async processing producer consumer',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Design topic schema and partition strategy. Define producer and consumer groups.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Implement producers with batching, compression, and idempotent writes.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Implement consumers with offset management, dead-letter queues, and retry logic.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Monitor consumer lag, throughput, and set up alerts.' },
    ],
    parameters: [
        { name: 'serialization', description: 'Message format', type: 'choice', required: false, options: ['json', 'avro', 'protobuf'], defaultValue: 'json' },
    ],
    tags: ['kafka', 'queue', 'event-streaming', 'async', 'message'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const terraformSkill = {
    id: 'skill-terraform',
    name: 'terraform',
    description: 'Write Terraform infrastructure-as-code. Use when the goal asks to provision, manage, or version cloud infrastructure.',
    version: '1.0.0',
    goalPattern: 'terraform infrastructure iac provision cloud resource module state',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Define infrastructure resources, data sources, and variables. Choose state backend (S3, GCS, TF Cloud).' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Write resource configurations with proper tagging, encryption, and networking.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Add modules for reusable components. Implement workspace isolation.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Set up plan/apply pipeline with approval gates. Add drift detection.' },
    ],
    parameters: [
        { name: 'provider', description: 'Cloud provider', type: 'choice', required: false, options: ['aws', 'gcp', 'azure', 'multi'], defaultValue: 'aws' },
    ],
    tags: ['terraform', 'iac', 'infrastructure', 'cloud', 'provision'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const nginxConfigSkill = {
    id: 'skill-nginx-config',
    name: 'nginx-config',
    description: 'Configure Nginx as reverse proxy, load balancer, or web server. Use when the goal asks to set up Nginx, configure SSL, or optimize web serving.',
    version: '1.0.0',
    goalPattern: 'nginx reverse proxy load balancer web server ssl tls',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Define server blocks, upstream pools, and location routing rules.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Configure SSL/TLS with certificates, OCSP stapling, and HSTS.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Add rate limiting, request buffering, and gzip compression.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Set up health checks, graceful shutdown, and log rotation.' },
    ],
    parameters: [
        { name: 'role', description: 'Nginx role', type: 'choice', required: false, options: ['reverse-proxy', 'load-balancer', 'web-server'], defaultValue: 'reverse-proxy' },
    ],
    tags: ['nginx', 'reverse-proxy', 'load-balancer', 'ssl', 'web-server'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const sslCertSkill = {
    id: 'skill-ssl-cert',
    name: 'ssl-cert',
    description: 'Manage SSL/TLS certificates with Let Encrypt or commercial CAs. Use when the goal asks to set up HTTPS, renew certificates, or fix SSL issues.',
    version: '1.0.0',
    goalPattern: 'ssl tls certificate letsencrypt https renew acme',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Choose certificate provider (Let Encrypt, commercial CA). Generate CSR and private key.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Complete domain validation (HTTP-01, DNS-01 challenge). Install certificate.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Configure auto-renewal with certbot or acme.sh. Set up renewal hooks.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Test SSL configuration with SSL Labs. Fix any vulnerabilities.' },
    ],
    parameters: [
        { name: 'provider', description: 'Certificate provider', type: 'choice', required: false, options: ['letsencrypt', 'commercial', 'self-signed'], defaultValue: 'letsencrypt' },
    ],
    tags: ['ssl', 'tls', 'certificate', 'https', 'letsencrypt', 'security'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const dnsSetupSkill = {
    id: 'skill-dns-setup',
    name: 'dns-setup',
    description: 'Configure DNS records and domains. Use when the goal asks to set up DNS, configure domains, or manage DNS records.',
    version: '1.0.0',
    goalPattern: 'dns domain records aaaaaa cname mx txt spf dkim',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Choose DNS provider (Cloudflare, Route53, Google DNS). Transfer or register domain.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Configure A/AAAA, CNAME, MX, TXT records. Set up SPF, DKIM, DMARC for email.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Add CDN configuration, DNS caching, and geo-routing.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Monitor DNS propagation, uptime, and set up alerts for DNS failures.' },
    ],
    parameters: [
        { name: 'provider', description: 'DNS provider', type: 'choice', required: false, options: ['cloudflare', 'route53', 'google-dns'], defaultValue: 'cloudflare' },
    ],
    tags: ['dns', 'domain', 'records', 'cloudflare', 'route53'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const cronJobSkill = {
    id: 'skill-cron-job',
    name: 'cron-job',
    description: 'Set up scheduled tasks and cron jobs. Use when the goal asks to automate recurring tasks, schedule jobs, or set up crons.',
    version: '1.0.0',
    goalPattern: 'cron schedule job recurring task automated periodic timer',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Define task schedule (cron expression, interval). Identify task dependencies and retry logic.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Implement task with idempotency, timeout handling, and distributed locking.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Add logging, metrics, and alerting for job failures.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Set up monitoring dashboard showing job history, success rate, and duration.' },
    ],
    parameters: [
        { name: 'scheduler', description: 'Scheduling tool', type: 'choice', required: false, options: ['cron', 'node-cron', 'bull'], defaultValue: 'cron' },
    ],
    tags: ['cron', 'schedule', 'job', 'automate', 'timer'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const backupStrategySkill = {
    id: 'skill-backup-strategy',
    name: 'backup-strategy',
    description: 'Design and implement backup strategies. Use when the goal asks to set up backups, disaster recovery, or data protection.',
    version: '1.0.0',
    goalPattern: 'backup disaster recovery retention snapshot restore data protection',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Define RPO (Recovery Point Objective) and RTO (Recovery Time Objective). Identify critical data.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Implement backup strategy: full, incremental, differential. Choose storage (S3, GCS, tape).' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Add encryption, compression, and versioning. Implement retention policies.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Test restore procedures regularly. Document runbooks and verify backups.' },
    ],
    parameters: [
        { name: 'strategy', description: 'Backup strategy', type: 'choice', required: false, options: ['full', 'incremental', 'differential'], defaultValue: 'incremental' },
    ],
    tags: ['backup', 'disaster-recovery', 'retention', 'snapshot', 'restore'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const logRotationSkill = {
    id: 'skill-log-rotation',
    name: 'log-rotation',
    description: 'Set up log rotation and management. Use when the goal asks to configure log rotation, manage log files, or prevent disk filling.',
    version: '1.0.0',
    goalPattern: 'log rotation compress archive truncate syslog journald',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Identify log sources and estimate daily volume. Choose rotation strategy (size, time, count).' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Configure logrotate for system logs, application logs, and access logs.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Set up compression, archival, and deletion policies. Configure remote shipping.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Monitor disk usage and set up alerts for unusual log volume.' },
    ],
    parameters: [
        { name: 'strategy', description: 'Rotation strategy', type: 'choice', required: false, options: ['size', 'time', 'count'], defaultValue: 'time' },
    ],
    tags: ['log', 'rotation', 'compress', 'archive', 'disk'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const secretsManagerSkill = {
    id: 'skill-secrets-manager',
    name: 'secrets-manager',
    description: 'Set up secrets management with Vault, AWS Secrets Manager, or similar. Use when the goal asks to manage secrets, rotate credentials, or secure sensitive data.',
    version: '1.0.0',
    goalPattern: 'secrets manager vault credentials rotate sensitive password key',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Choose secrets manager (HashiCorp Vault, AWS Secrets Manager, Azure Key Vault).' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Define secret structure, access policies, and rotation schedules.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Implement secret injection into applications (env vars, mounted files, API calls).' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Set up audit logging, access reviews, and emergency revocation procedures.' },
    ],
    parameters: [
        { name: 'provider', description: 'Secrets manager', type: 'choice', required: false, options: ['vault', 'aws-secrets-manager', 'azure-keyvault'], defaultValue: 'vault' },
    ],
    tags: ['secrets', 'vault', 'credentials', 'rotate', 'security'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const loadBalancerSkill = {
    id: 'skill-load-balancer',
    name: 'load-balancer',
    description: 'Configure load balancing with Nginx, HAProxy, or cloud LBs. Use when the goal asks to distribute traffic, set up health checks, or configure failover.',
    version: '1.0.0',
    goalPattern: 'load balancer nginx haproxy traffic distribute health check failover',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Choose load balancer (Nginx, HAProxy, ALB/NLB). Define backend pools and routing rules.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Configure health checks, session affinity, and connection draining.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Add SSL termination, rate limiting, and DDoS protection.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Monitor traffic distribution, latency, and error rates. Set up alerts.' },
    ],
    parameters: [
        { name: 'provider', description: 'Load balancer type', type: 'choice', required: false, options: ['nginx', 'haproxy', 'cloud-alb'], defaultValue: 'nginx' },
    ],
    tags: ['load-balancer', 'nginx', 'haproxy', 'traffic', 'health-check'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
export const cdnSetupSkill = {
    id: 'skill-cdn-setup',
    name: 'cdn-setup',
    description: 'Configure CDN for static assets. Use when the goal asks to set up CDN, optimize asset delivery, or reduce latency.',
    version: '1.0.0',
    goalPattern: 'cdn cloudflare cloudfront fastly cache static assets edge',
    steps: [
        { agentType: 'analyst', dependsOn: [], description: 'Choose CDN provider (Cloudflare, CloudFront, Fastly). Configure custom domain and SSL.' },
        { agentType: 'analyst', dependsOn: ['step-0'], description: 'Set up cache rules: TTLs, purge strategies, and cache-by-header.' },
        { agentType: 'analyst', dependsOn: ['step-1'], description: 'Configure origin shielding, mid-tier caching, and failover origins.' },
        { agentType: 'analyst', dependsOn: ['step-2'], description: 'Monitor cache hit ratio, bandwidth savings, and latency improvements.' },
    ],
    parameters: [
        { name: 'provider', description: 'CDN provider', type: 'choice', required: false, options: ['cloudflare', 'cloudfront', 'fastly'], defaultValue: 'cloudflare' },
    ],
    tags: ['cdn', 'cache', 'static-assets', 'cloudflare', 'cloudfront'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9, usageCount: 0, createdAt: BUNDLED_CREATED_AT, lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * Game development skill — create GUI games from scratch.
 * Covers: project setup, game logic, UI rendering, input handling,
 * packaging for distribution (exe/installer).
 * Works for: snake-and-ladder, tic-tac-toe, chess, puzzle games,
 * 2D platformers, card games, board games.
 *
 * Hermes-level depth: platform-specific guides, real commands,
 * troubleshooting, reference docs, progressive disclosure.
 */
export const gameDevelopmentSkill = {
    id: 'skill-game-development',
    name: 'game-development',
    description: 'Create a GUI game with graphics, input handling, game logic, and packaging. Use when the goal asks to create, build, or develop a game (board games, card games, puzzle games, 2D games, snake-and-ladder, tic-tac-toe, chess, etc.).',
    version: '2.0.0',
    goalPattern: 'game create build develop snake ladder tic tac toe chess board card puzzle 2d platformer GUI play win lose',
    // Hermes-style: detailed when-to-use sections
    whenToUse: [
        'User wants to create a board game (snake-and-ladder, chess, checkers, backgammon)',
        'User wants to create a card game (poker, solitaire, bridge, uno)',
        'User wants to create a puzzle game (sudoku, crossword, tetris, 2048)',
        'User wants to create a 2D game (platformer, shooter, racer, platformer)',
        'User mentions "GUI" + "game" + "Windows"',
        'User wants an executable (.exe) or installable package',
        'User wants a game with graphics, animations, and sound',
    ],
    whenNotToUse: [
        'User wants a web game (use web-development skills instead)',
        'User wants a mobile game (use mobile-bridge skills instead)',
        'User wants game analytics or leaderboards (use data-analysis skills)',
        'User wants a text-only game (no GUI needed, simpler approach)',
        'User wants a 3D game (requires Unity/Unreal, beyond this skill)',
    ],
    // Hermes-style: detailed steps with real commands
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                '## Step 1: Gather User Preferences',
                '',
                'Before writing any code, ask the user for:',
                '- **Game type**: board, card, puzzle, 2D, arcade?',
                '- **Target platform**: Windows GUI, web browser, cross-platform?',
                '- **Language preference**: Python, JavaScript, C#, C++?',
                '- **Deliverable**: executable (.exe), web app, installable package?',
                '- **Features**: multiplayer, AI opponent, animations, sound?',
                '',
                'Use sensible defaults if the user doesn\'t care, but always ask before generating the code.',
                '',
                '## Step 2: Detect Project State',
                '',
                'Check the working directory:',
                '```bash',
                'ls -la',
                'cat package.json 2>/dev/null || cat pyproject.toml 2>/dev/null || echo "No project config found"',
                '```',
                '',
                'If greenfield (empty directory):',
                '- Create project structure',
                '- Initialize package manager',
                '- Set up build tools',
                '',
                'If existing project:',
                '- Use the same language/framework',
                '- Follow existing code style',
                '- Integrate with existing build system',
                '',
                '## Step 3: Produce Game Design Brief',
                '',
                'Create a brief with:',
                '- Game type and mechanics',
                '- Platform and language',
                '- Core features (list)',
                '- Deliverable format',
                '- Estimated complexity (simple/moderate/complex)',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'writer',
            description: [
                '## Step 4: Implement Core Game Engine',
                '',
                'Create the game logic as a single module/class:',
                '',
                '### 4.1 Game State Management',
                '```python',
                'class GameState:',
                '    def __init__(self):',
                '        self.players = []',
                '        self.current_turn = 0',
                '        self.scores = {}',
                '        self.is_game_over = False',
                '        self.winner = None',
                '```',
                '',
                '### 4.2 Core Mechanics',
                '- Dice roll: `random.randint(1, 6)`',
                '- Card draw: `random.shuffle(deck)` + `deck.pop()`',
                '- Piece movement: `position += dice_value`',
                '- Collision detection: `if piece1.position == piece2.position`',
                '',
                '### 4.3 Rules Engine',
                '```python',
                'def is_valid_move(self, player, move):',
                '    # Check if move is legal',
                '    return move in self.get_legal_moves(player)',
                '',
                'def apply_move(self, player, move):',
                '    # Apply the move and update state',
                '    self.board[move] = player',
                '    self.check_win_condition(player)',
                '```',
                '',
                '### 4.4 Win Condition',
                '```python',
                'def check_win_condition(self, player):',
                '    # Check rows, columns, diagonals',
                '    if self.check_row_win(player):',
                '        self.is_game_over = True',
                '        self.winner = player',
                '```',
                '',
                'Write as a single module that can be tested independently of the UI.',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'writer',
            description: [
                '## Step 5: Implement GUI/Rendering Layer',
                '',
                '### 5.1 Window Setup',
                '',
                '**Python+tkinter:**',
                '```python',
                'import tkinter as tk',
                '',
                'root = tk.Tk()',
                'root.title("Snake and Ladder")',
                'root.geometry("800x600")',
                'canvas = tk.Canvas(root, width=800, height=600)',
                'canvas.pack()',
                '```',
                '',
                '**Python+pygame:**',
                '```python',
                'import pygame',
                '',
                'pygame.init()',
                'screen = pygame.display.set_mode((800, 600))',
                'pygame.display.set_caption("Snake and Ladder")',
                '```',
                '',
                '**JavaScript+Canvas:**',
                '```javascript',
                'const canvas = document.getElementById("gameCanvas");',
                'const ctx = canvas.getContext("2d");',
                'canvas.width = 800;',
                'canvas.height = 600;',
                '```',
                '',
                '**C#+WinForms:**',
                '```csharp',
                'var form = new Form()',
                '{',
                '    Text = "Snake and Ladder",',
                '    Size = new Size(800, 600)',
                '};',
                'var canvas = new PictureBox()',
                '{',
                '    Dock = DockStyle.Fill,',
                '    Image = new Bitmap(800, 600)',
                '};',
                'form.Controls.Add(canvas);',
                '```',
                '',
                '### 5.2 Game Board Rendering',
                '',
                'Draw the board grid:',
                '```python',
                '# Python+tkinter example',
                'def draw_board(canvas):',
                '    cell_size = 60',
                '    for row in range(10):',
                '        for col in range(10):',
                '            x1 = col * cell_size',
                '            y1 = row * cell_size',
                '            x2 = x1 + cell_size',
                '            y2 = y1 + cell_size',
                '            canvas.create_rectangle(x1, y1, x2, y2, fill="white", outline="black")',
                '            # Draw cell number',
                '            cell_num = row * 10 + col + 1',
                '            canvas.create_text(x1 + 30, y1 + 30, text=str(cell_num))',
                '```',
                '',
                '### 5.3 Input Handling',
                '',
                '**Mouse clicks:**',
                '```python',
                'canvas.bind("<Button-1>", on_click)',
                'def on_click(event):',
                '    # Handle click at (event.x, event.y)',
                '    pass',
                '```',
                '',
                '**Keyboard:**',
                '```python',
                'root.bind("<Key>", on_key)',
                'def on_key(event):',
                '    if event.keysym == "space":',
                '        roll_dice()',
                '```',
                '',
                '### 5.4 UI Elements',
                '',
                'Add buttons, labels, and status displays:',
                '```python',
                '# Roll dice button',
                'roll_btn = tk.Button(root, text="Roll Dice", command=roll_dice)',
                'roll_btn.pack()',
                '',
                '# Score display',
                'score_label = tk.Label(root, text="Score: 0")',
                'score_label.pack()',
                '',
                '# Status message',
                'status_label = tk.Label(root, text="Player 1\'s turn")',
                'status_label.pack()',
                '```',
                '',
                '### 5.5 Animations',
                '',
                'Add simple animations for dice roll and piece movement:',
                '```python',
                'def animate_dice_roll(canvas, callback):',
                '    for i in range(10):',
                '        # Show random face',
                '        face = random.randint(1, 6)',
                '        draw_dice(canvas, face)',
                '        canvas.update()',
                '        canvas.after(50)',
                '    # Final result',
                '    final = random.randint(1, 6)',
                '    draw_dice(canvas, final)',
                '    callback(final)',
                '```',
                '',
                'Connect the GUI to the game engine from Step 4.',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'runner',
            description: [
                '## Step 6: Test the Game',
                '',
                '### 6.1 Run the Game',
                '',
                '**Python:**',
                '```bash',
                'python game.py',
                '```',
                '',
                '**JavaScript:**',
                '```bash',
                'open index.html  # macOS',
                'xdg-open index.html  # Linux',
                'start index.html  # Windows',
                '```',
                '',
                '**C#:**',
                '```bash', 'dotnet run',
                '```',
                '',
                '### 6.2 Test Win/Lose Conditions',
                '',
                '- Play through a complete game',
                '- Verify winner is correctly detected',
                '- Test with multiple players',
                '',
                '### 6.3 Test Edge Cases',
                '',
                '- Invalid moves (out of turn, illegal position)',
                '- Restart game',
                '- Draw conditions (if applicable)',
                '- Window resize',
                '',
                '### 6.4 Test Packaging',
                '',
                '**Python+PyInstaller:**',
                '```bash',
                'pip install pyinstaller',
                'pyinstaller --onefile game.py',
                'ls -la dist/game  # Verify executable exists',
                '```',
                '',
                '**Python+cx_Freeze:**',
                '```bash',
                'pip install cx_Freeze',
                'python setup.py build',
                '```',
                '',
                '**C#:**',
                '```bash',
                'dotnet publish -c Release -r win-x64 --self-contained',
                'ls -la bin/Release/net8.0/win-x64/publish/  # Verify executable',
                '```',
                '',
                '**Electron (JavaScript):**',
                '```bash',
                'npm install electron --save-dev',
                'npx electron-builder --win',
                '```',
                '',
                '### 6.5 Verify Deliverable',
                '',
                '- Run the executable on a clean machine (or VM)',
                '- Verify it launches without errors',
                '- Verify all features work',
                '- Check file size (aim for < 50MB)',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
        {
            agentType: 'reviewer',
            description: [
                '## Step 7: Final Review',
                '',
                '### 7.1 Code Quality',
                '',
                '- Game logic is separated from UI',
                '- Code is well-commented',
                '- No hardcoded values (use constants)',
                '- Error handling is present',
                '',
                '### 7.2 Game Play',
                '',
                '- Game is fun and engaging',
                '- Rules are clear',
                '- Controls are intuitive',
                '- Visual feedback is present',
                '',
                '### 7.3 Documentation',
                '',
                '- README.md with:',
                '  - Game description',
                '  - How to play',
                '  - How to build',
                '  - Controls',
                '',
                '### 7.4 Deliverable',
                '',
                '- Executable works on target platform',
                '- File size is reasonable',
                '- No missing dependencies',
            ].join('\n'),
            dependsOn: ['step-3'],
        },
    ],
    // Hermes-style: parameters with defaults
    parameters: [
        {
            name: 'gameType',
            description: 'Type of game to create',
            type: 'choice',
            required: false,
            options: ['board', 'card', 'puzzle', '2d', 'arcade', 'auto'],
            defaultValue: 'auto',
        },
        {
            name: 'platform',
            description: 'Target platform',
            type: 'choice',
            required: false,
            options: ['windows-gui', 'web', 'cross-platform', 'auto'],
            defaultValue: 'auto',
        },
        {
            name: 'language',
            description: 'Programming language (auto-detected from project if not specified)',
            type: 'choice',
            required: false,
            options: ['python', 'javascript', 'typescript', 'csharp', 'cpp', 'auto'],
            defaultValue: 'auto',
        },
    ],
    // Hermes-style: tags for categorization
    tags: ['game', 'gui', 'board-game', '2d', 'interactive', 'entertainment', 'pyinstaller', 'electron', 'tkinter', 'pygame'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * CLI tool creation skill — scaffold, implement, test, and publish CLI tools.
 * Covers: argument parsing, help text, subcommands, config files,
 * npm/cargo/go publishing, shell completions.
 */
export const cliToolSkill = {
    id: 'skill-cli-tool',
    name: 'cli-tool',
    description: 'Create a command-line tool with argument parsing, help text, subcommands, and packaging. Use when the goal asks to create a CLI tool, command-line utility, or terminal application.',
    version: '1.0.0',
    goalPattern: 'CLI command line tool terminal utility terminal app argparse cobra click yargs commander',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Analyze the CLI tool requirements:',
                '- What does the tool do? (one-liner description)',
                '- What language? (Node.js, Python, Go, Rust)',
                '- What arguments/flags/options?',
                '- Does it need subcommands?',
                '- Does it need a config file?',
                '- How will it be distributed? (npm, pip, cargo, go install, standalone binary)',
                'Produce: a CLI specification with commands, flags, and distribution plan.',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'writer',
            description: [
                'Implement the CLI tool:',
                '- Set up the project structure (package.json / pyproject.toml / go.mod / Cargo.toml)',
                '- Implement argument parsing (commander.js / argparse / cobra / clap)',
                '- Add help text and usage examples',
                '- Implement subcommands if needed',
                '- Add config file support (if needed)',
                '- Add input validation and error handling',
                'Write clean, well-documented code with proper error messages.',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'tester',
            description: [
                'Write and run tests:',
                '- Unit tests for core logic',
                '- Integration tests for argument parsing',
                '- Test help output and error messages',
                '- Test edge cases (missing args, invalid input, --version)',
                'Run the test suite and fix any failures.',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'runner',
            description: [
                'Package and publish:',
                '- npm: set bin field in package.json, run `npm publish`',
                '- Python: create setup.py/pyproject.toml, run `python -m build`',
                '- Go: run `go install` or create a release with `goreleaser`',
                '- Rust: run `cargo publish`',
                '- Add shell completions (if supported)',
                'Verify the tool installs and runs correctly.',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
    ],
    parameters: [
        {
            name: 'language',
            description: 'Programming language (auto-detected from project if not specified)',
            type: 'choice',
            required: false,
            options: ['node', 'python', 'go', 'rust', 'auto'],
            defaultValue: 'auto',
        },
    ],
    tags: ['cli', 'command-line', 'terminal', 'tool', 'utility', 'publish'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/**
 * API creation skill — full lifecycle: design → implement → test → document → deploy.
 * Covers: REST/GraphQL endpoints, authentication, rate limiting,
 * OpenAPI spec, integration tests, deployment.
 * Extends the existing api-design skill with implementation and deployment.
 */
export const apiCreationSkill = {
    id: 'skill-api-creation',
    name: 'api-creation',
    description: 'Create a complete API: design endpoints, implement routes, add auth/rate-limiting, write tests, generate OpenAPI docs, and deploy. Use when the goal asks to create an API, build a backend service, or scaffold an HTTP server with routes.',
    version: '1.0.0',
    goalPattern: 'API create build backend service REST GraphQL HTTP server routes endpoints implement deploy',
    steps: [
        {
            agentType: 'context-gatherer',
            description: [
                'Analyze the project and API requirements:',
                '- Read package.json / pyproject.toml for framework (Express, Fastify, Hono, Flask, FastAPI, Spring Boot)',
                '- Identify resources (nouns → endpoints) and operations (CRUD)',
                '- Note auth requirements (API key, JWT, OAuth2)',
                '- Note database (PostgreSQL, MongoDB, SQLite, in-memory)',
                '- Note deployment target (local, Docker, cloud)',
                'Produce: resource list, framework choice, auth strategy, and database plan.',
            ].join('\n'),
            dependsOn: [],
        },
        {
            agentType: 'writer',
            description: [
                'Implement the API:',
                '- Set up the project structure (routes/, models/, middleware/, utils/)',
                '- Implement route handlers for each resource',
                '- Add input validation (Joi, Zod, Pydantic, express-validator)',
                '- Add error handling middleware (consistent error response format)',
                '- Add auth middleware (JWT verification, API key check)',
                '- Add rate limiting (express-rate-limit, slowapi)',
                '- Wire everything into the app entry point',
                'Follow REST conventions: proper HTTP methods, status codes, and response shapes.',
            ].join('\n'),
            dependsOn: ['step-0'],
        },
        {
            agentType: 'writer',
            description: [
                'Generate OpenAPI/Swagger documentation:',
                '- Create openapi.yaml or openapi.json with all endpoints',
                '- Define request/response schemas',
                '- Add authentication definitions',
                '- Add example requests and responses',
                '- Set up Swagger UI (if web framework supports it)',
                'The spec is the contract — implementation must match it exactly.',
            ].join('\n'),
            dependsOn: ['step-1'],
        },
        {
            agentType: 'tester',
            description: [
                'Write and run integration tests:',
                '- Test each endpoint: happy path, error paths (400, 401, 404, 500)',
                '- Test auth: unauthenticated → 401, unauthorized → 403',
                '- Test validation: invalid input → 400 with error details',
                '- Test edge cases: empty body, missing fields, duplicate resources',
                '- Run the full test suite: `npm test` or `pytest`',
                'All tests must pass before proceeding.',
            ].join('\n'),
            dependsOn: ['step-2'],
        },
        {
            agentType: 'runner',
            description: [
                'Set up deployment:',
                '- Create Dockerfile (multi-stage build)',
                '- Create docker-compose.yml (if database needed)',
                '- Add health check endpoint (GET /health)',
                '- Add environment variable configuration',
                '- Create a README with API documentation and usage examples',
                '- Verify the app starts and responds to requests',
            ].join('\n'),
            dependsOn: ['step-3'],
        },
    ],
    parameters: [
        {
            name: 'framework',
            description: 'HTTP framework (auto-detected from project)',
            type: 'choice',
            required: false,
            options: ['express', 'fastify', 'hono', 'flask', 'fastapi', 'spring', 'auto'],
            defaultValue: 'auto',
        },
        {
            name: 'database',
            description: 'Database to use',
            type: 'choice',
            required: false,
            options: ['postgresql', 'mongodb', 'sqlite', 'mysql', 'in-memory', 'auto'],
            defaultValue: 'auto',
        },
        {
            name: 'auth',
            description: 'Authentication method',
            type: 'choice',
            required: false,
            options: ['jwt', 'api-key', 'oauth2', 'session', 'none'],
            defaultValue: 'jwt',
        },
    ],
    tags: ['api', 'rest', 'backend', 'http', 'server', 'endpoints', 'deploy'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: BUNDLED_CREATED_AT,
    lastUsedAt: BUNDLED_CREATED_AT,
};
/** All bundled skills (new first-party skills append here). */
export const BUNDLED_SKILLS = [
    websiteDeploySkill,
    codeAssessmentSkill,
    technicalRoadmapSkill,
    planCreateTrackSkill,
    testStrategySkill,
    docxSkill,
    securityAuditSkill,
    apiDesignSkill,
    dbMigrationSkill,
    perfProfileSkill,
    docGenSkill,
    ciCdSetupSkill,
    dockerConfigSkill,
    depUpdateSkill,
    codeRefactorSkill,
    envSetupSkill,
    dataAnalysisSkill,
    apiTestingSkill,
    perfTestSkill,
    a11yAuditSkill,
    searchSetupSkill,
    emailSetupSkill,
    paymentSetupSkill,
    authSetupSkill,
    monitoringSetupSkill,
    backupRecoverySkill,
    schemaDesignSkill,
    i18nSetupSkill,
    graphqlApiSkill,
    gitReleaseSkill,
    designSystemSkill,
    legalComplianceSkill,
    cronSetupSkill,
    imageOptimizeSkill,
    pdfGenerateSkill,
    cacheSetupSkill,
    queueSetupSkill,
    rateLimitSkill,
    corsSetupSkill,
    errorTrackingSkill,
    featureFlagsSkill,
    webhookSetupSkill,
    formBuilderSkill,
    dataSyncSkill,
    stateMachineSkill,
    websocketSetupSkill,
    apiVersioningSkill,
    multiTenancySkill,
    blobStorageSkill,
    notificationSetupSkill,
    // ── Phase 2: 20 additional skills ─────────────────────────────────────
    webScrapingSkill,
    dataProcessingSkill,
    mlModelSkill,
    cloudDeploySkill,
    kubernetesSkill,
    githubActionsSkill,
    prometheusSkill,
    structuredLoggingSkill,
    redisCacheSkill,
    kafkaQueueSkill,
    terraformSkill,
    nginxConfigSkill,
    sslCertSkill,
    dnsSetupSkill,
    cronJobSkill,
    backupStrategySkill,
    logRotationSkill,
    secretsManagerSkill,
    loadBalancerSkill,
    cdnSetupSkill,
    gameDevelopmentSkill,
    cliToolSkill,
    apiCreationSkill,
];
// ── Phase 3: 55 additional skills (Hermes parity + Windows + MCP) ──────────
export { PHASE3_SKILLS } from './bundled-skills-phase3.js';
/** Combined list of all bundled skills. */
export const ALL_BUNDLED_SKILLS = [
    ...BUNDLED_SKILLS,
    ...PHASE3_SKILLS,
    ...DOCKER_SKILLS,
    ...EXTENDED_SKILLS,
];
//# sourceMappingURL=bundled-skills.js.map