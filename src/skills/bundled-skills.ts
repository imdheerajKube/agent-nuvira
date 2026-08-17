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
 * Bundled skills are seeded into ~/.buff/skills/ by SkillStore.seedBundledSkills()
 * so they also work with `buff skill run <name>` and the skill-runner agent.
 *
 * To add a provider to the website-deploy skill, add a section to the
 * relevant step description — no code change required.
 */

import type { Skill } from '../learning/skill-types.js';

/** Fixed timestamp so bundled skills never decay (re-seeded identical). */
const BUNDLED_CREATED_AT = 1_752_000_000_000;

/** Stable IDs for bundled skills (deterministic — re-seeding overwrites cleanly). */
export const BUNDLED_SKILL_ID_WEBSITE_DEPLOY = 'skill-website-deploy';

/**
 * Website deployment skill — encodes deployment methodology for known hosting
 * providers. Built from the Cloudflare Pages gap-assessment (wrangler 4 does
 * NOT auto-create Pages projects; `pages project create --production-branch`
 * must precede the first `pages deploy`).
 */
export const websiteDeploySkill: Skill = {
  id: BUNDLED_SKILL_ID_WEBSITE_DEPLOY,
  name: 'website-deploy',
  description:
    'Deploy a static site or built web app to a hosting provider (Cloudflare Pages, Netlify, Vercel, GitHub Pages, AWS S3+CloudFront, Azure Static Web Apps, Firebase Hosting) and verify the live URL. Use when the goal asks to deploy, publish, host, or ship a website or web app to a hosting provider.',
  version: '1.0.0',
  goalPattern:
    'deploy publish host website web app site landing page cloudflare pages netlify vercel github pages hosting static',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Inspect the site directory to identify the built output (index.html or a framework build folder like dist/ or build/), detect which hosting CLIs are installed and authenticated on this machine (wrangler, netlify, vercel, gh, aws, firebase), and report the site type and output directory.',
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
      description:
        'Verify the deployed site is live: fetch the deployment URL printed by the deploy step with curl and confirm it returns HTTP 200 and the site HTML. For example: Run `curl -s -o /dev/null -w "%{http_code}" <deployed-url>` then Run `curl -s <deployed-url> | head -c 400`',
      dependsOn: ['step-2'],
    },
    {
      agentType: 'reviewer',
      description:
        'Review the deployment: confirm the live URL returns HTTP 200 with the expected page content, and that the deployed files (HTML/CSS/JS) are present and correctly referenced.',
      dependsOn: ['step-3'],
    },
  ],
  parameters: [
    {
      name: 'provider',
      description:
        'Hosting provider to deploy to: cloudflare-pages, netlify, vercel, github-pages, aws-s3, azure-swa, or firebase-hosting',
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
export const codeAssessmentSkill: Skill = {
  id: BUNDLED_SKILL_ID_CODE_ASSESSMENT,
  name: 'code-assessment',
  description:
    'Perform a structured codebase assessment: read the project, evaluate it across correctness/security/performance/architecture/testability dimensions, produce a gap-findings list, and deliver prioritized recommendations with effort estimates. Use when the goal asks to assess, evaluate, review, audit, or analyze code quality.',
  version: '1.0.0',
  goalPattern:
    'assess evaluate review audit analyze code quality codebase project architecture security performance correctness gaps recommendations',
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
      description:
        'Verify the artifact: every critical/major finding has a file:line reference (no vague "somewhere in the codebase" claims), severities are consistent, and the recommendations are actionable (a concrete change, not a platitude). Revise the artifact if any finding lacks evidence.',
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
export const technicalRoadmapSkill: Skill = {
  id: BUNDLED_SKILL_ID_TECHNICAL_ROADMAP,
  name: 'technical-roadmap',
  description:
    'Build a phased technical roadmap from the current state to a target state: capture the current architecture, define the target, then produce ordered phases with dependencies, effort, risk, and success criteria. Use when the goal asks for a roadmap, migration plan, technical plan, or phased upgrade path.',
  version: '1.0.0',
  goalPattern:
    'roadmap migration plan technical plan phased upgrade path target state current state phases dependencies milestones',
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
export const planCreateTrackSkill: Skill = {
  id: BUNDLED_SKILL_ID_PLAN_CREATE_TRACK,
  name: 'plan-create-track',
  description:
    'Plan and track a multi-step job: break the goal into ordered, verifiable steps, declare them with plan_todo, work through them updating status (running → done, or blocked with a note), and finish with a summary. Use for any job with 2+ steps where progress visibility matters.',
  version: '1.0.0',
  goalPattern:
    'plan create track steps todo checklist progress multi-step job execute work through order',
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
export const testStrategySkill: Skill = {
  id: BUNDLED_SKILL_ID_TEST_STRATEGY,
  name: 'test-strategy',
  description:
    'Plan and run a deep test pass: map the test surface, choose the right matrix (unit / integration / e2e, focused runs for changed code), execute the real commands (npm test, vitest, pytest, etc.), and deliver a verdict with evidence. Use when the goal asks to test, verify, check for regressions, or prove a change is safe.',
  version: '1.0.0',
  goalPattern:
    'test verify regression check coverage suite unit integration e2e pass run tests prove safe',
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

/** All bundled skills (new first-party skills append here). */
export const BUNDLED_SKILLS: Skill[] = [
  websiteDeploySkill,
  codeAssessmentSkill,
  technicalRoadmapSkill,
  planCreateTrackSkill,
  testStrategySkill,
];
