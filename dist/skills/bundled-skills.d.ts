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
import type { Skill } from '../learning/skill-types.js';
/** Stable IDs for bundled skills (deterministic — re-seeding overwrites cleanly). */
export declare const BUNDLED_SKILL_ID_WEBSITE_DEPLOY = "skill-website-deploy";
export declare const BUNDLED_SKILL_ID_DOCX = "skill-docx";
/**
 * Website deployment skill — encodes deployment methodology for known hosting
 * providers. Built from the Cloudflare Pages gap-assessment (wrangler 4 does
 * NOT auto-create Pages projects; `pages project create --production-branch`
 * must precede the first `pages deploy`).
 */
export declare const websiteDeploySkill: Skill;
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
export declare const BUNDLED_SKILL_ID_CODE_ASSESSMENT = "skill-code-assessment";
export declare const BUNDLED_SKILL_ID_TECHNICAL_ROADMAP = "skill-technical-roadmap";
export declare const BUNDLED_SKILL_ID_PLAN_CREATE_TRACK = "skill-plan-create-track";
export declare const BUNDLED_SKILL_ID_TEST_STRATEGY = "skill-test-strategy";
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
export declare const codeAssessmentSkill: Skill;
/**
 * Technical roadmap skill — current state → target state → phased plan.
 *
 * The P5b companion: after (or alongside) an assessment, produce a phased
 * technical roadmap with dependencies, effort, and risk per phase — the
 * "suggest technical roadmap" half of the named capability.
 */
export declare const technicalRoadmapSkill: Skill;
/**
 * Plan create + track skill — multi-step jobs with visible progress.
 *
 * Complements the P0.7 plan_todo tool: this skill is the METHODOLOGY for
 * breaking a job into tracked steps (declare via plan_todo, update statuses
 * as work progresses, mark blocked and continue), so every multi-step task
 * shows "N/M done" instead of a wall of lines.
 */
export declare const planCreateTrackSkill: Skill;
/**
 * Test strategy skill — plan and run a deep test pass.
 *
 * The "test not only by scripts but by actual invocation" capability as a
 * methodology: map the test surface, decide the matrix (unit/integration/e2e
 * + the runs that matter), execute the real commands, and deliver a verdict
 * with coverage evidence — the deep-backward-testing practice.
 */
export declare const testStrategySkill: Skill;
/**
 * DOCX skill — create, read, edit, and manipulate Word documents (.docx /
 * .dotx). A .docx is a ZIP archive of XML files; the methodology encodes the
 * task→approach choice (create with docx-js / edit the XML directly / read
 * with pandoc), the docx-js footguns (page size, tables, lists, TOC), the
 * edit pipeline (unzip → merge runs → edit in place → re-zip → XSD validate),
 * tracked-changes + comment mechanics, and render-based verification.
 */
export declare const docxSkill: Skill;
/** Stable IDs for the additional bundled skills. */
export declare const BUNDLED_SKILL_ID_SECURITY_AUDIT = "skill-security-audit";
export declare const BUNDLED_SKILL_ID_API_DESIGN = "skill-api-design";
export declare const BUNDLED_SKILL_ID_DB_MIGRATION = "skill-db-migration";
export declare const BUNDLED_SKILL_ID_PERF_PROFILE = "skill-perf-profile";
export declare const BUNDLED_SKILL_ID_DOC_GEN = "skill-doc-gen";
export declare const BUNDLED_SKILL_ID_CI_CD_SETUP = "skill-ci-cd-setup";
export declare const BUNDLED_SKILL_ID_DOCKER_CONFIG = "skill-docker-config";
export declare const BUNDLED_SKILL_ID_DEP_UPDATE = "skill-dep-update";
export declare const BUNDLED_SKILL_ID_CODE_REFACTOR = "skill-code-refactor";
export declare const BUNDLED_SKILL_ID_ENV_SETUP = "skill-env-setup";
/**
 * Security audit skill — scan, classify, prioritize, report, verify fix.
 *
 * Methodology: enumerate the attack surface (entry points, auth boundaries,
 * data flows), scan for common vulnerability classes (injection, secrets,
 * unsafe deserialization, SSRF, path traversal, XSS), classify by CVSS-like
 * severity, produce a fix plan, and verify fixes actually close the finding.
 */
export declare const securityAuditSkill: Skill;
/**
 * API design skill — requirements → endpoints → OpenAPI → implement → test.
 *
 * Methodology: gather requirements (what resources, what operations), design
 * RESTful endpoints with proper HTTP methods/status codes, produce an OpenAPI
 * spec, implement the routes, and write integration tests that verify the
 * contract matches the implementation.
 */
export declare const apiDesignSkill: Skill;
/**
 * Database migration skill — analyze schema → design migration → write SQL →
 * test backward compatibility → document.
 *
 * Methodology: read the current schema (ORM models, migration files, raw SQL),
 * design the migration (what changes, what order), write the migration SQL,
 * verify backward compatibility (old code still works during rollout), and
 * document the change.
 */
export declare const dbMigrationSkill: Skill;
/**
 * Performance profiling skill — identify hotspots → instrument → measure →
 * analyze → optimize → verify.
 *
 * Methodology: profile the application under realistic load, identify the
 * actual bottleneck (never guess), optimize the specific bottleneck, and
 * verify the improvement with measurements.
 */
export declare const perfProfileSkill: Skill;
/**
 * Documentation generation skill — scan codebase → extract API → generate docs
 * → validate links → publish.
 *
 * Methodology: scan the codebase for public APIs (exports, routes, CLI
 * commands), extract signatures and JSDoc/docstrings, generate structured
 * documentation (API reference + guides), validate internal links, and
 * produce publishable output.
 */
export declare const docGenSkill: Skill;
/**
 * CI/CD setup skill — detect platform → write workflow → add secrets →
 * test run → verify.
 *
 * Methodology: detect the CI platform (GitHub Actions, GitLab CI, etc.),
        detect the project stack (language, test command, build command), write
 * the workflow file, configure secrets/variables, trigger a test run, and
 * verify the pipeline passes.
 */
export declare const ciCdSetupSkill: Skill;
/**
 * Docker configuration skill — analyze deps → write Dockerfile → optimize
 * layers → test build → compose.
 *
 * Methodology: analyze the project dependencies and build process, write a
 * multi-stage Dockerfile (build + runtime), optimize layer caching, test
 * the build, and optionally add docker-compose for local dev.
 */
export declare const dockerConfigSkill: Skill;
/**
 * Dependency update skill — audit → select targets → update → test →
 * fix breaks → document.
 *
 * Methodology: audit current dependencies for outdated versions and known
 * vulnerabilities, select update targets (security-first, then minor, then
 * major), update, run the test suite, fix any breakages, and document the
 * changes.
 */
export declare const depUpdateSkill: Skill;
/**
 * Code refactor skill — analyze → identify patterns → plan changes → refactor
 * → test → verify.
 *
 * Methodology: analyze the target code to understand its structure and
 * dependencies, identify refactoring opportunities (extract, inline, rename,
 * restructure), plan the changes (what moves where, what breaks), apply the
 * refactoring surgically, and verify with tests.
 */
export declare const codeRefactorSkill: Skill;
/**
 * Environment setup skill — detect stack → install deps → configure →
 * verify → document.
 *
 * Methodology: detect the project stack (language, framework, tools), install
 * all dependencies (system + project), configure the environment (env vars,
 * database, services), verify everything works, and document the setup for
 * other contributors.
 */
export declare const envSetupSkill: Skill;
/** ─── data-analysis ─── */
export declare const dataAnalysisSkill: Skill;
/** ─── api-testing ─── */
export declare const apiTestingSkill: Skill;
/** ─── perf-test ─── */
export declare const perfTestSkill: Skill;
/** ─── a11y-audit ─── */
export declare const a11yAuditSkill: Skill;
/** ─── search-setup ─── */
export declare const searchSetupSkill: Skill;
/** ─── email-setup ─── */
export declare const emailSetupSkill: Skill;
/** ─── payment-setup ─── */
export declare const paymentSetupSkill: Skill;
/** ─── auth-setup ─── */
export declare const authSetupSkill: Skill;
/** ─── monitoring-setup ─── */
export declare const monitoringSetupSkill: Skill;
/** ─── backup-recovery ─── */
export declare const backupRecoverySkill: Skill;
/** ─── schema-design ─── */
export declare const schemaDesignSkill: Skill;
/** ─── i18n-setup ─── */
export declare const i18nSetupSkill: Skill;
/** ─── graphql-api ─── */
export declare const graphqlApiSkill: Skill;
/** ─── git-release ─── */
export declare const gitReleaseSkill: Skill;
/** ─── design-system ─── */
export declare const designSystemSkill: Skill;
/** ─── legal-compliance ─── */
export declare const legalComplianceSkill: Skill;
/** ─── cron-setup ─── */
export declare const cronSetupSkill: Skill;
/** ─── image-optimize ─── */
export declare const imageOptimizeSkill: Skill;
/** ─── pdf-generate ─── */
export declare const pdfGenerateSkill: Skill;
/** ─── cache-setup ─── */
export declare const cacheSetupSkill: Skill;
/** ─── queue-setup ─── */
export declare const queueSetupSkill: Skill;
/** ─── rate-limit ─── */
export declare const rateLimitSkill: Skill;
/** ─── cors-setup ─── */
export declare const corsSetupSkill: Skill;
/** ─── error-tracking ─── */
export declare const errorTrackingSkill: Skill;
/** ─── feature-flags ─── */
export declare const featureFlagsSkill: Skill;
/** ─── webhook-setup ─── */
export declare const webhookSetupSkill: Skill;
/** ─── form-builder ─── */
export declare const formBuilderSkill: Skill;
/** ─── data-sync ─── */
export declare const dataSyncSkill: Skill;
/** ─── state-machine ─── */
export declare const stateMachineSkill: Skill;
/** ─── websocket-setup ─── */
export declare const websocketSetupSkill: Skill;
/** ─── api-versioning ─── */
export declare const apiVersioningSkill: Skill;
/** ─── multi-tenancy ─── */
export declare const multiTenancySkill: Skill;
/** ─── blob-storage ─── */
export declare const blobStorageSkill: Skill;
/** ─── notification-setup ─── */
export declare const notificationSetupSkill: Skill;
export declare const webScrapingSkill: Skill;
export declare const dataProcessingSkill: Skill;
export declare const mlModelSkill: Skill;
export declare const cloudDeploySkill: Skill;
export declare const kubernetesSkill: Skill;
export declare const githubActionsSkill: Skill;
export declare const prometheusSkill: Skill;
export declare const structuredLoggingSkill: Skill;
export declare const redisCacheSkill: Skill;
export declare const kafkaQueueSkill: Skill;
export declare const terraformSkill: Skill;
export declare const nginxConfigSkill: Skill;
export declare const sslCertSkill: Skill;
export declare const dnsSetupSkill: Skill;
export declare const cronJobSkill: Skill;
export declare const backupStrategySkill: Skill;
export declare const logRotationSkill: Skill;
export declare const secretsManagerSkill: Skill;
export declare const loadBalancerSkill: Skill;
export declare const cdnSetupSkill: Skill;
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
export declare const gameDevelopmentSkill: Skill;
/**
 * CLI tool creation skill — scaffold, implement, test, and publish CLI tools.
 * Covers: argument parsing, help text, subcommands, config files,
 * npm/cargo/go publishing, shell completions.
 */
export declare const cliToolSkill: Skill;
/**
 * API creation skill — full lifecycle: design → implement → test → document → deploy.
 * Covers: REST/GraphQL endpoints, authentication, rate limiting,
 * OpenAPI spec, integration tests, deployment.
 * Extends the existing api-design skill with implementation and deployment.
 */
export declare const apiCreationSkill: Skill;
/** All bundled skills (new first-party skills append here). */
export declare const BUNDLED_SKILLS: Skill[];
export { PHASE3_SKILLS } from './bundled-skills-phase3.js';
/** Combined list of all bundled skills. */
export declare const ALL_BUNDLED_SKILLS: Skill[];
//# sourceMappingURL=bundled-skills.d.ts.map