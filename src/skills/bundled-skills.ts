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

/** All bundled skills (new first-party skills append here). */
export const BUNDLED_SKILLS: Skill[] = [websiteDeploySkill];
