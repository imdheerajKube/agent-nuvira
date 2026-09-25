#!/usr/bin/env node
/**
 * Build the PUBLIC documentation repo from the PRIVATE source tree.
 *
 * Why a generator instead of hand-copied files: a public doc site that is copied
 * by hand drifts the moment the private docs change, and a scrub that is done
 * once is a scrub that silently stops being applied. This script is the single
 * place where (a) source documents are selected, (b) personal data is removed,
 * and (c) the site scaffolding is emitted — so the published bundle is
 * reproducible from the private repo with one command:
 *
 *   node scripts/build-docs-repo.mjs --out ../agent-nuvira-documentation
 *   node scripts/build-docs-repo.mjs --check --out ../agent-nuvira-documentation
 *
 * The `--check` pass is the guard: it re-reads what was written and FAILS if any
 * secret-shaped token, phone number or home-directory path survived. The
 * generator and the guard share ONE pattern list, so the only way to add a
 * pattern the guard accepts is to also redact it.
 *
 * What is deliberately NOT published: CHANGELOG.md (it documents exact failure
 * paths and exploitable classes in detail), and the internal assessment/gap/
 * roadmap/tracker files. See PUBLISH_SET below for the allow-list.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─── arguments ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const outIdx = argv.indexOf('--out');
const OUT = resolve(
  repoRoot,
  outIdx >= 0 && argv[outIdx + 1]
    ? argv[outIdx + 1]
    : '../agent-nuvira-documentation',
);

const README_URL = 'https://github.com/imdheerajKube/agent-nuvira-documentation';

/**
 * The marketing site, published with the docs so its deploy runs for free.
 *
 * agent-nuvira.com is served by a Cloudflare Pages project wired to this public
 * repository through Cloudflare's GitHub App, with `website/` as the output
 * directory and no build command at all. A push is therefore the deploy: no
 * Actions workflow and no repository secrets are involved, which matters
 * because the private repo's metered Actions will not start jobs.
 */
const WEBSITE_SRC = resolve(repoRoot, 'website');

/**
 * The one place the public site's address is defined.
 *
 * Everything downstream derives from it: `mkdocs.yml`'s `site_url` (which is
 * what builds the canonical link and the absolute `og:image` URL), the `CNAME`
 * the Pages build publishes, and every absolute link in the landing page.
 * Change this, or set DOCS_SITE_URL, and the whole bundle follows.
 */
const SITE_URL = process.env.DOCS_SITE_URL || 'https://docs.agent-nuvira.com/';

/**
 * Addresses this site has been published under. Links to any of them are
 * rewritten to SITE_URL as the file is written, so moving the site never
 * leaves a trail of links pointing at the old address — including the landing
 * page, where those links are the primary navigation.
 */
const KNOWN_SITE_URLS = [
  'https://imdheerajkube.github.io/agent-nuvira-documentation/',
  'https://docs.agent-nuvira.com/',
];

function retargetSiteUrls(text) {
  let out = text;
  for (const base of KNOWN_SITE_URLS) {
    if (base !== SITE_URL) out = out.split(base).join(SITE_URL);
  }
  return out;
}

// ─── brand assets ───────────────────────────────────────────────────────────

const BRAND_SCRIPT = resolve(repoRoot, 'scripts', 'generate-docs-brand.mjs');
const BRAND_DIR = resolve(repoRoot, 'assets', 'docs-brand');
const BRAND_FILES = [
  'logo.svg',
  'favicon.svg',
  'favicon-32.png',
  'apple-touch-icon.png',
  'og-card.png',
];

/**
 * The logo, favicon and social card are build artifacts, not hand-exported
 * binaries. If they are missing, generate them rather than failing — one
 * command should be enough to rebuild the whole public bundle.
 */
function ensureBrand() {
  if (BRAND_FILES.every((f) => existsSync(join(BRAND_DIR, f)))) return;
  console.log('• brand assets missing — generating…');
  execFileSync(process.execPath, [BRAND_SCRIPT], { stdio: 'inherit' });
}

// ─── scrubbing ──────────────────────────────────────────────────────────────

/** The developer's real numbers → the placeholder the README already uses. */
const PHONE_REPLACEMENTS = [
  [/\+919958604222/g, '+919876543210'],
  [/919958604222/g, '919876543210'],
];

/** Home-directory paths → a neutral stand-in. */
const PATH_REPLACEMENTS = [
  [/\/Users\/[A-Za-z0-9_.-]+/g, '/Users/you'],
  [/\/home\/[A-Za-z0-9_.-]+/g, '/home/you'],
  [/C:\\Users\\[A-Za-z0-9_.-]+/g, 'C:\\Users\\you'],
];

/**
 * Secret-shaped tokens. A match whose payload is a single repeated character is
 * a DOCUMENTATION PLACEHOLDER (`gsk_xxxxxxxxxxxx`, `AIzaSyxxx…`) and is left
 * alone — redacting those would destroy the very docs that teach key formats.
 */
const SECRET_PATTERNS = [
  /gsk_[A-Za-z0-9]{10,}/g,
  /sk-or-[A-Za-z0-9-]{10,}/g,
  /nvapi-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  /AKIA[A-Z0-9]{12,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AQ\.[A-Za-z0-9_-]{20,}/g,
];

function scrubSecrets(text) {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      const payload = match.slice(match.indexOf('_') + 1) || match;
      const isPlaceholder = payload.length > 0 && new Set(payload).size === 1;
      return isPlaceholder ? match : '<your-api-key>';
    });
  }
  return out;
}

function scrub(text) {
  let out = text;
  for (const [re, to] of PHONE_REPLACEMENTS) out = out.replace(re, to);
  for (const [re, to] of PATH_REPLACEMENTS) out = out.replace(re, to);
  return scrubSecrets(out);
}

// ─── link hygiene ───────────────────────────────────────────────────────────

/** Files that exist in the PUBLISHED repository. Anything else is a dead link. */
const PUBLISHED_FILES = new Set([
  'README.md',
  'LICENSE',
  'docs/index.md',
  'docs/user-manual.md',
  'docs/capabilities.md',
  'docs/commands.md',
  'docs/reference/commands-surface.md',
  'docs/architecture.md',
  'docs/whats-new.md',
  'docs/product-strategy.md',
  'docs/pitch-deck.md',
  'docs/demos/index.md',
  'docs/demos/nuvira-cli-tour.cast',
]);

/** A private path → its published equivalent. */
const LINK_REWRITES = [
  ['docs/COMMANDS.md', 'docs/commands.md'],
  ['docs/COMMANDS_SURFACE.md', 'docs/reference/commands-surface.md'],
  ['docs/USER_MANUAL.md', 'docs/user-manual.md'],
  ['docs/GATEWAY.md', 'docs/user-manual.md'],
  ['ARCHITECTURE.md', 'docs/architecture.md'],
  ['ARCHITECTURE_DIAGRAMS.md', 'docs/architecture.md'],
  ['PITCH_DECK.md', 'docs/pitch-deck.md'],
  ['PRODUCT_STRATEGY.md', 'docs/product-strategy.md'],
];

/** Links that are relative to the containing docs/ directory. */
const DOCS_LINK_REWRITES = [
  ['COMMANDS_SURFACE.md', 'reference/commands-surface.md'],
  ['COMMANDS.md', 'commands.md'],
  ['USER_MANUAL.md', 'user-manual.md'],
];

/** The markdown link target pattern, shared by the fixer and the guard. */
const MD_LINK = /\[([^\]]+)\]\((?:\.\/)?([A-Za-z0-9_./-]+\.md)(#[^)]*)?\)/g;

/** Every relative link target (any extension) — used by the guard. */
const ANY_LINK = /\]\((?![a-z]+:|#)([^)\s#]+)(?:#[^)]*)?\)/gi;

/** Resolve a link target against the directory that contains the file. */
function resolveLink(path, base) {
  return (base ? `${base}/${path}` : path).replace(/\.\//g, '');
}

/**
 * Replace links to private paths with their published targets, then DE-LINK any
 * remaining relative markdown link to a file this repository does not contain.
 * A link to a missing file is a 404 for every reader, and it also leaks the name
 * of an internal document — so plain text is strictly better.
 *
 * `base` is the file's directory relative to the published root ('' at the root,
 * 'docs' for docs/*.md, 'docs/reference' for the generated reference).
 */
function fixLinks(text, base = '') {
  let out = text;
  const rewrites = base === '' ? LINK_REWRITES : base === 'docs' ? DOCS_LINK_REWRITES : [];
  for (const [from, to] of rewrites) {
    out = out.split(`](${from})`).join(`](${to})`);
    out = out.split(`](./${from})`).join(`](${to})`);
  }
  out = out.replace(MD_LINK, (match, label, path) =>
    PUBLISHED_FILES.has(resolveLink(path, base)) ? match : label,
  );
  return out;
}

// ─── the manual's §13 → "Limitations and roadmap" ───────────────────────────

const LIMITATIONS = `## 13. Limitations and roadmap

Honest scope notes: what is deliberately narrow today, and where it is heading.

**Multi-account key rotation is scoped to \`plan\` and \`edit\`.** A provider can hold several
keys (\`apiKeys[]\`), and the single-shot walk rotates through every non-parked key of that
provider before it switches providers. The interactive \`chat\` and \`execute\` surfaces
currently fail over by *provider*. Unifying every surface onto one account-aware walk — with
account-scoped failure attribution, so a rate limit on one key never deprioritises the
provider — is the next milestone.

**First runs are slow.** Initial model discovery walks every provider you hold a credential
for. Later runs use the cache.

**Provider coverage is broad, so polish is uneven.** Twenty-two providers speak the same
interface; the most-used ones are exercised hardest.

**Model selection is dynamic, so a rejected pair is possible.** Pairs the provider refuses
are retired and re-probed. Cross-provider propagation of a model id on the orchestrator path
is on the roadmap; pinning \`--provider\` and \`--model\` is the reliable workaround today.

**No telemetry, by design.** Nothing leaves your machine except the requests to the model
providers you configure — which also means there is no cloud dashboard. The local dashboard
is the source of truth.

**Messaging channels need credentials and policy.** Who may *trigger* the agent and who may
direct it to *send* to other people are two separate permission lists, because conflating
them is a security bug.

`;

const MANUAL_FIXES = [
  // The private manual's relationship note names a file that is not published.
  [
    '> **Relationship to `User_Manual.md` (repo root, v1.62.2).** That file is the previous\n> manual. This one supersedes it: it is regenerated against the live tree, and every\n> number and command in it was executed and captured. The old file is left in place,\n> untouched, as an archive.',
    '> **Every example in this manual was executed against build v3.3.0 before it was written.**\n> Where a command needs a credential, a paid provider or an optional binary, that is stated\n> inline rather than assumed.',
  ],
  // …and this one names an internal design document.
  [
    '> **Honest scope note:** today the key rotation runs in the `plan` and `edit` walks.\n> `chat`, `execute` and the pipeline fail over by *provider*. For the design that unifies\n> this — and the account-scoped failure-attribution defect behind it — see\n> `proposed-apikeymultirouting.md` in the repo root.',
    '> **Honest scope note:** today the key rotation runs in the `plan` and `edit` walks.\n> `chat`, `execute` and the pipeline fail over by *provider*. Unifying every surface onto\n> one account-aware walk is the next milestone — see\n> [Limitations and roadmap](#13-limitations-and-roadmap).',
  ],
  [
    '| `docs/COMMANDS_SURFACE.md` | **Generated** from the live commander tree — 289 entries, the authoritative list. |',
    '| [Full Command Surface](reference/commands-surface.md) | **Generated** from the live commander tree — 289 entries, the authoritative list. |',
  ],
  [
    '| `docs/COMMANDS.md` | Curated prose: objective, command, example per entry (88 sections). |',
    '| [Command reference](commands.md) | Curated prose: objective, command, example per entry (88 sections). |',
  ],
  // A private build script cannot be invoked from the published repository.
  [
    'Keep the surface doc honest with its drift guard:\n\n```bash\nnode scripts/generate-commands-surface.mjs --check\n# ✓ COMMANDS_SURFACE.md is in sync with the live CLI.\n```',
    'That document is generated from the live command tree by the project\'s own build, and a\ndrift guard fails CI if a command is added or renamed without regenerating it — so the\nreference cannot describe a command that does not exist.',
  ],
  [
    '`node scripts/generate-commands-surface.mjs --check`',
    'the published Full Command Surface',
  ],
];

function publicManual(src) {
  let text = fixLinks(scrub(src), 'docs');

  for (const [from, to] of MANUAL_FIXES) text = text.split(from).join(to);

  // 1. the table-of-contents entry
  text = text.replace(
    /13\. \[Known issues found while validating this manual\]\(#13-known-issues-found-while-validating-this-manual\)/,
    '13. [Limitations and roadmap](#13-limitations-and-roadmap)',
  );

  // 2. the section body itself (everything up to section 14)
  const start = text.indexOf('## 13. Known issues found while validating this manual');
  const end = text.indexOf('## 14. Troubleshooting');
  if (start < 0 || end < 0 || end < start) {
    throw new Error(
      'manual: could not locate §13/§14 — the source manual changed shape; update this transform.',
    );
  }
  text = text.slice(0, start) + LIMITATIONS + text.slice(end);

  // 3. the verification-log row that recorded the live defect
  text = text.replace(
    /^\| Sub-agent model id leaks across providers.*\n/m,
    '',
  );

  // 4. the intro cross-reference to the (now differently-named) section
  text = text.replace(
    '**Relationship to `User_Manual.md`',
    '**Relationship to `User_Manual.md`',
  );

  return text;
}

// ─── generated content ──────────────────────────────────────────────────────

function whatsNew(changelog) {
  // Curated, not dumped: only FEATURE releases enter the public index, because a
  // fix-level title names the defect it fixes ("dashboard blank page on load"),
  // and a public list of your past defects is a target list, not a changelog.
  const releases = [...changelog.matchAll(/^## (v\d+\.\d+\.\d+) — (.+)$/gm)]
    .map((m) => ({ version: m[1], title: m[2].trim() }))
    .filter((r) => /^feat:/i.test(r.title))
    .map((r) => ({ ...r, title: r.title.replace(/^feat:\s*/i, '').trim() }));

  const index = releases
    .map((r) => `| \`${r.version}\` | ${r.title.charAt(0).toUpperCase()}${r.title.slice(1)} |`)
    .join('\n');

  return `# What's new

A curated index of **feature** releases. Fix-level detail stays in the private repository:
those entries name the exact defect they repair, which is useful to an engineer and a target
list to anyone else.

## What the current line is about

- **The agent verifies its own work.** An edit that nothing checked can no longer be
  reported as done; an unverified edit is recorded and the agent gets one corrective nudge
  naming what would settle it.
- **Long unattended jobs finish, and account for themselves.** Per-batch cost and latency
  are reported on every completion path — including a request that arrived over a messaging
  channel, so a job run from WhatsApp is as measurable as one run from the terminal.
- **Every number means what it says.** A listing count is never presented as a capability,
  and a progress percentage means the deliverable exists rather than that a counter ran out.
- **Routing is consistent and honest.** The rationale, the decision and the ranked table
  always agree, and a provider/model pair that cannot work is retired and re-probed instead
  of costing a doomed round trip.
- **One engine behind every surface.** CLI, dashboard and all messaging channels share the
  same pipeline, tool surface and router.

## Feature releases

| Version | Headline |
|---|---|
${index}

## Versioning

Agent-Nuvira follows semantic versioning. The CLI reports its version with
\`nuvira --version\`.
`;
}

const CAPABILITIES = `# Capabilities

What Agent-Nuvira can do beyond "write a file". Every count here is produced by a command
you can run yourself.

| Surface | Size | Command |
|---|---|---|
| Agent tools | **110** | \`nuvira tools list\` |
| CLI command entries | **289** across **48** groups | see [Full Command Surface](reference/commands-surface.md) |
| Inference providers | **22** | \`nuvira provider list\` |
| Messaging platforms | **22** | \`nuvira gateway status\` |
| Skills | **155** on disk | \`nuvira skills list\` |
| Workflow templates | **10** built in | \`nuvira workflow list\` |
| Dashboard pages | **22** | see the [User Manual](user-manual.md#5-the-dashboard) |

## Coding

Plan, implement, review, test and publish. \`nuvira execute\` runs a multi-agent pipeline;
\`nuvira workflow run\` runs a fixed one; \`nuvira chat\` is the interactive surface. Every
mode shares one tool surface and one router.

## Beyond coding

- **Browser automation** — drive a real page: open, click, type, extract, screenshot.
- **Vision** — describe screenshots, diagrams and photos via a local Ollama model or a free
  vision tier.
- **Image and video generation** — from a prompt, saved to the artifact directory.
- **Voice in both directions** — synthesize speech and transcribe audio locally.
- **Desktop control** — screenshot, mouse and keyboard without stealing focus.
- **Sandboxed code execution** — run code under time and resource limits.
- **Document extraction** — PDF, DOCX, XLSX, PPTX, HTML, CSV.
- **Assessment of other repositories** — shallow-clone a repo into an ephemeral cache and
  work on it without touching your own workspace.
- **Integrations** — Docker, Microsoft Graph (mail/calendar/OneDrive), Home Assistant,
  Discord, Feishu docs and drive, kanban boards.
- **Scheduling and supervision** — cron jobs and long-lived daemons under the agent's
  control.
- **Sub-agents** — delegate a focused subtask to a fresh, isolated context and get the
  summary back.

## Messaging

Twenty-two platforms, from Telegram and Slack to SMS, IRC and Home Assistant. Inbound
messages are dispatched through the **same pipeline** as the CLI, and progress plus the
final result are sent back to the channel. Two independent permission lists govern who may
*trigger* the agent and who may direct it to *send* to other people.

## Knowledge and memory

Trajectory memory, fact memory, coding-pattern extraction and failure lessons. Vector
retrieval keeps long contexts affordable — the reference machine measured **142,493 tokens
saved at a 65.6% average reduction** across 64 calls.

## Extension

- **Skills** — reusable, parameterised execution plans.
- **Workflows** — fixed pipelines you can search, install, publish.
- **MCP** — connect external tool servers, or expose the agent's own tools *as* an MCP server.
- **Plugins** — providers, agents and workflow templates.
- **SDK** — build custom agents.
- **Federation** — connect remote agent instances, including A2A.

## Verification and governance

Per-step traces, an evaluation framework, model benchmarks, a CycloneDX software bill of
materials, security scanning for injection and PII, an admin governance policy (allow/deny
providers and models, hard cost cap, privacy floor), and RBAC.

## Try it without spending a token

\`\`\`bash
nuvira doctor                              # full environment diagnosis
nuvira tools list                          # the 110 tools, with descriptions
nuvira skills search docker                # find a skill by need
nuvira skill run security-audit --dry-run  # print the plan, run nothing
nuvira workflow list                       # the ten built-in pipelines
nuvira intent resolve "stop the dashboard" # plain English -> exact command
nuvira code-map src                        # symbol map of a directory
nuvira retrieval stats                     # measured token savings
\`\`\`
`;

function indexPage() {
  return `![Agent-Nuvira](assets/logo.svg){ width="76" }

# Agent-Nuvira — Documentation

Agent-Nuvira is a **multi-agent AI coding CLI**. It plans, writes, reviews, tests and
publishes code using local models (Ollama) or cloud APIs, and it is reachable from a
terminal, a web dashboard, or any of 22 messaging platforms.

> **This repository is documentation only.** The source code lives in a private repository.
> Everything here is written to be runnable and checkable against a published build.

## Start here

- **[User Manual](user-manual.md)** — install, configure, and use every surface in depth.
- **[Capabilities](capabilities.md)** — what it can do beyond writing code.
- **[Command Reference](commands.md)** — curated commands with examples.
- **[Full Command Surface](reference/commands-surface.md)** — all 289 command entries,
  generated from the live CLI tree.
- **[Architecture](architecture.md)** — how the execution engine is put together.
- **[What's New](whats-new.md)** — the 3.x release index.

## The shape of it

| Surface | Size |
|---|---|
| Agent tools | **110** |
| CLI command entries | **289** across **48** groups |
| Inference providers | **22** |
| Messaging platforms | **22** |
| Skills | **155** |
| Built-in workflow templates | **10** |
| Dashboard pages | **22** |

## Design commitments

1. **Verify before claiming.** The agent may not report work it has not checked.
2. **No telemetry.** Requests go to the model providers you configure and nowhere else.
3. **Local-first.** Ollama and local models are a first-class path, not a fallback.
4. **One engine, every surface.** The CLI, the dashboard and every messaging channel share
   the same pipeline, tools and router.

## Install

\`\`\`bash
npm install -g agent-nuvira
nuvira doctor
nuvira chat "explain what this project does"
\`\`\`

Requires Node **>= 18.18.0**.

- This repository: [${README_URL.replace('https://', '')}](${README_URL})

> There is no public source repository. The site and this page are the published surface;
> issues and corrections are welcome here.
`;
}

const OVERRIDES_MAIN = `{% extends "base.html" %}

{#
  Social metadata lives in one override so every page carries a preview card.
  The image is the generated og-card.png (1200x630) — the size every major
  platform crops least badly. Literal colours below mirror the product
  website's tokens so a shared link looks like the product, not like a theme.
#}
{% block extrahead %}
  {{ super() }}
  <meta name="theme-color" content="#06060e">
  {# Modern browsers prefer the vector icon; the PNG from theme.favicon is the fallback. #}
  <link rel="icon" type="image/svg+xml" href="{{ 'assets/favicon.svg' | url }}">
  <link rel="apple-touch-icon" href="{{ 'assets/apple-touch-icon.png' | url }}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Agent-Nuvira Documentation">
  <meta property="og:title" content="{% if page and page.is_homepage %}Agent-Nuvira Documentation{% elif page and page.title %}{{ page.title }} · Agent-Nuvira{% else %}Agent-Nuvira Documentation{% endif %}">
  <meta property="og:description" content="{{ config.site_description }}">
  <meta property="og:url" content="{% if page and page.canonical_url %}{{ page.canonical_url }}{% else %}{{ config.site_url }}{% endif %}">
  <meta property="og:image" content="{{ config.site_url }}assets/og-card.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Agent-Nuvira — multi-agent AI coding CLI">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{% if page and page.is_homepage %}Agent-Nuvira Documentation{% elif page and page.title %}{{ page.title }} · Agent-Nuvira{% else %}Agent-Nuvira Documentation{% endif %}">
  <meta name="twitter:description" content="{{ config.site_description }}">
  <meta name="twitter:image" content="{{ config.site_url }}assets/og-card.png">
{% endblock %}
`;

const MKDOCS = `site_name: Agent-Nuvira Documentation
site_description: Multi-agent AI coding CLI — user manual, command reference, architecture.
site_url: ${SITE_URL}
repo_url: ${README_URL}
repo_name: imdheerajKube/agent-nuvira-documentation
edit_uri: edit/main/docs/

theme:
  name: material
  logo: assets/logo.svg
  favicon: assets/favicon-32.png
  custom_dir: overrides
  features:
    - navigation.sections
    - navigation.top
    - navigation.indexes
    - content.code.copy
    - search.suggest
    - search.highlight
    - toc.follow
  palette:
    - media: "(prefers-color-scheme: light)"
      scheme: default
      primary: indigo
      accent: indigo
      toggle:
        icon: material/weather-night
        name: Switch to dark mode
    - media: "(prefers-color-scheme: dark)"
      scheme: slate
      primary: indigo
      accent: indigo
      toggle:
        icon: material/weather-sunny
        name: Switch to light mode

markdown_extensions:
  - admonition
  - attr_list
  - def_list
  - footnotes
  - tables
  - toc:
      permalink: true
  - pymdownx.details
  - pymdownx.highlight
  - pymdownx.superfences
  - pymdownx.tabbed:
      alternate_style: true

nav:
  - Home: index.md
  - User Manual: user-manual.md
  - Capabilities: capabilities.md
  - Command Reference: commands.md
  - Full Command Surface: reference/commands-surface.md
  - Architecture: architecture.md
  - What's New: whats-new.md
  - CLI Tour: demos/index.md
  - Product Strategy: product-strategy.md
  - Pitch Deck: pitch-deck.md

plugins:
  - search

# The CLI tour is a .cast asset, not a page, so links to it are expected and must
# not fail the build. Broken page-to-page links are caught by the build script's
# own guard (scripts/build-docs-repo.mjs --check) before anything is pushed.
validation:
  links:
    not_found: warn
    absolute_links: ignore
    unrecognized_links: ignore

copyright: MIT License · Copyright (c) 2026 Dheeraj Sharma
`;

/**
 * The marketing site's deploy workflow, published into the documentation
 * repository alongside the site itself.
 *
 * WHY IT LIVES HERE. The private repository cannot run it: its Actions are
 * metered and currently refuse to start jobs at all, while a public
 * repository's Actions are free. So the site travels with the docs, and a push
 * here is what puts it live.
 *
 * WHY NOT THE CLOUDFLARE GIT INTEGRATION. A `source: github` Pages project can
 * be created against this repository and it will build when asked, but pushes
 * to main never produce a deployment — Cloudflare does not react to the push at
 * all. So the Git integration cannot be the thing that ships the site; an
 * explicit upload from this workflow is the mechanism that actually fires.
 *
 * Prerequisites (repository secrets):
 *   CLOUDFLARE_API_TOKEN   "Cloudflare Pages: Edit" on the account below
 *   CLOUDFLARE_ACCOUNT_ID  7bfea81d4bfe569521359bb90b608ff4
 */
const WEBSITE_WORKFLOW = `name: Deploy website

on:
  push:
    branches: [main]
    # Only the site matters here, not the documentation pages beside it.
    paths:
      - 'website/**'
      - '.github/workflows/deploy-website.yml'
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: website
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Verify the Cloudflare credentials are configured
        env:
          CF_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CF_ACCOUNT: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          if [ -z "$CF_TOKEN" ] || [ -z "$CF_ACCOUNT" ]; then
            echo "::error::CLOUDFLARE_API_TOKEN and/or CLOUDFLARE_ACCOUNT_ID are not set."
            echo "Add them under Settings -> Secrets and variables -> Actions."
            exit 1
          fi

      # No build step: website/ is already the artifact, and it is the version
      # the generator writes (with content-hashed CSS and JS URLs). Cloudflare
      # serves it as-is.
      - name: Deploy website to Cloudflare Pages
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy website --project-name agent-nuvira --commit-dirty=true
`;

const PAGES_WORKFLOW = `name: Publish docs

# The docs site is a pure render of this repository. Code never enters this
# pipeline — mkdocs only reads markdown under docs/.
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -r requirements.txt
      - run: mkdocs build

      # docs.agent-nuvira.com is served by a Cloudflare Pages project. Its Git
      # integration does not build on push, so the rendered site is uploaded
      # from here instead — the same build that feeds GitHub Pages, which is
      # kept only because it redirects github.io to the live address.
      - name: Publish to Cloudflare Pages
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy site --project-name agent-nuvira-docs --commit-dirty=true

      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
`;

const REQUIREMENTS = 'mkdocs-material>=9.5\n';

const GITIGNORE = `site/
.venv/
__pycache__/
.DS_Store
`;

// ─── the publish set ────────────────────────────────────────────────────────

const PUBLISH_SET = [
  {
    // The public landing page, not the private README: that one is a 2,500-line
    // engineering document — right for the people who already run this, wrong as
    // a first impression. Its whole job is to earn the next click.
    from: 'docs/PUBLIC_README.md',
    to: 'README.md',
    transform: (s, base) => fixLinks(scrub(s), base),
  },
  { from: 'LICENSE', to: 'LICENSE', transform: (s) => s },
  {
    from: 'ARCHITECTURE.md',
    to: 'docs/architecture.md',
    transform: (s, base) => fixLinks(scrub(s), base),
  },
  {
    from: 'docs/COMMANDS.md',
    to: 'docs/commands.md',
    transform: (s, base) => fixLinks(scrub(s), base),
  },
  {
    from: 'docs/COMMANDS_SURFACE.md',
    to: 'docs/reference/commands-surface.md',
    transform: (s, base) => fixLinks(scrub(s), base),
  },
  {
    from: 'docs/USER_MANUAL.md',
    to: 'docs/user-manual.md',
    transform: publicManual,
  },
  {
    from: 'PRODUCT_STRATEGY.md',
    to: 'docs/product-strategy.md',
    transform: (s, base) => fixLinks(scrub(s), base),
  },
  {
    from: 'PITCH_DECK.md',
    to: 'docs/pitch-deck.md',
    transform: (s, base) => fixLinks(scrub(s), base),
  },
  {
    // The CLI tour is an asciinema v2 cast — text, diffable, and generated with
    // a redaction pass that already strips keys, home paths and phone numbers.
    from: 'docs/demos/nuvira-cli-tour.cast',
    to: 'docs/demos/nuvira-cli-tour.cast',
    transform: (s) => scrub(s),
  },
  {
    from: 'docs/demos/README.md',
    to: 'docs/demos/index.md',
    transform: (s, base) => fixLinks(scrub(s), base),
  },
];

/** Directory (relative to the published root) for each emitted file. */
const OUT_BASE = {
  'README.md': '',
  'LICENSE': '',
  'docs/architecture.md': 'docs',
  'docs/commands.md': 'docs',
  'docs/reference/commands-surface.md': 'docs/reference',
  'docs/user-manual.md': 'docs',
  'docs/product-strategy.md': 'docs',
  'docs/pitch-deck.md': 'docs',
  'docs/demos/nuvira-cli-tour.cast': 'docs/demos',
  'docs/demos/index.md': 'docs/demos',
};

const GENERATED = [
  { to: 'docs/index.md', content: () => indexPage() },
  { to: 'docs/capabilities.md', content: () => CAPABILITIES },
  {
    to: 'docs/whats-new.md',
    content: () => whatsNew(readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8')),
  },
  { to: 'mkdocs.yml', content: () => MKDOCS },
  { to: 'overrides/main.html', content: () => OVERRIDES_MAIN },
  {
    // Pages reads the custom domain from repository settings, but the file is
    // what keeps a branch-based build — and a clone — pointed the same way.
    to: 'docs/CNAME',
    content: () => `${new URL(SITE_URL).host}\n`,
  },
  { to: 'requirements.txt', content: () => REQUIREMENTS },
  { to: '.github/workflows/pages.yml', content: () => PAGES_WORKFLOW },
  { to: '.github/workflows/deploy-website.yml', content: () => WEBSITE_WORKFLOW },
  { to: '.gitignore', content: () => GITIGNORE },
];

// ─── the guard ──────────────────────────────────────────────────────────────

function audit(dir) {
  const findings = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const p = join(abs, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(md|yml|txt|json|cast|svg)$/.test(entry.name)) {
        const text = readFileSync(p, 'utf8');
        const rel = relative(dir, p);
        for (const [re, label] of [
          [/\+?919958604222/, 'developer phone number'],
          // `you` is the neutral stand-in the scrubber substitutes in, so it is
          // expected to be present and is not a finding.
          [/\/Users\/(?!you\b)[A-Za-z0-9_.-]+/, 'home-directory path'],
          [/\/home\/(?!you\b)[A-Za-z0-9_.-]+/, 'home-directory path'],
        ]) {
          if (re.test(text)) findings.push(`${rel}: ${label}`);
        }
        for (const re of SECRET_PATTERNS) {
          for (const m of text.match(re) || []) {
            const payload = m.slice(m.indexOf('_') + 1) || m;
            if (new Set(payload).size === 1) continue; // documentation placeholder
            findings.push(`${rel}: secret-shaped token`);
          }
        }
        // Any relative link whose target does not EXIST in the published
        // repository is a 404 for every reader — and it names an internal
        // document besides. Verified against the filesystem, not a list, so a
        // .cast, an image or any other asset is checked the same way.
        const fileDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        for (const m of text.matchAll(ANY_LINK)) {
          const target = m[1];
          if (!target || target.startsWith('#') || target.startsWith('/')) continue;
          const resolved = resolve(dir, fileDir, target.replace(/^<|>$/g, ''));
          if (!existsSync(resolved)) findings.push(`${rel}: dead link -> ${target}`);
        }
      }
    }
  };
  walk(dir);
  return findings;
}

// ─── run ────────────────────────────────────────────────────────────────────

if (CHECK) {
  if (!existsSync(OUT)) {
    console.error(`✗ ${OUT} does not exist — run without --check first.`);
    process.exit(1);
  }
  const findings = audit(OUT);
  if (findings.length) {
    console.error(`✗ ${findings.length} finding(s) in the published bundle:`);
    for (const f of findings) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✓ ${OUT} is clean (no secrets, phone numbers or home paths).`);
  process.exit(0);
}

// Never wipe a directory that is itself a git clone — that would delete .git and
// the repository's history. A plain staging directory is safe to reset.
if (!existsSync(join(OUT, '.git'))) {
  rmSync(OUT, { recursive: true, force: true });
}

ensureBrand();

const written = [];

// Brand assets are copied as binaries — they are generated, never hand-edited.
for (const name of BRAND_FILES) {
  const dest = join(OUT, 'docs', 'assets', name);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(join(BRAND_DIR, name)));
  written.push(`docs/assets/${name}`);
}

for (const { from, to, transform } of PUBLISH_SET) {
  const src = join(repoRoot, from);
  if (!existsSync(src)) {
    console.error(`✗ missing source file: ${from}`);
    process.exit(1);
  }
  const dest = join(OUT, to);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(
    dest,
    retargetSiteUrls(transform(readFileSync(src, 'utf8'), OUT_BASE[to] ?? '')),
    'utf8',
  );
  written.push(to);
}

for (const { to, content } of GENERATED) {
  const dest = join(OUT, to);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, retargetSiteUrls(scrub(content())), 'utf8');
  written.push(to);
}

/**
 * Copy a directory verbatim.
 *
 * The marketing site is copied, never transformed: it is already a public
 * artifact (the whole point of it is being served to strangers), so there is
 * nothing to scrub, and running HTML through the markdown link fixer would
 * corrupt it.
 */
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else writeFileSync(dest, readFileSync(src));
  }
}

/**
 * Tag the stylesheet and script with their own content hash.
 *
 * agent-nuvira.com sits behind a zone whose Browser Cache TTL is four hours,
 * and that setting wins over anything the `_headers` file says — so a browser
 * that loaded the site just before a stylesheet change keeps the old sheet for
 * hours afterwards and renders the page with the previous layout. Purging is
 * not available to this toolchain, so the only reliable lever is the URL: a
 * changed stylesheet becomes a different cache key and the stale copy is simply
 * never asked for again.
 *
 * Only the bare `="styles.css"` / `="script.js"` references are rewritten, so
 * this cannot stack a second query string on a re-run, and nothing under
 * `assets/` is touched.
 */
function versionAssets(dir) {
  const stamp = (name) => {
    const file = join(dir, name);
    return existsSync(file)
      ? createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
      : null;
  };
  const assets = { 'styles.css': stamp('styles.css'), 'script.js': stamp('script.js') };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
    const file = join(dir, entry.name);
    let html = readFileSync(file, 'utf8');
    for (const [name, hash] of Object.entries(assets)) {
      if (hash) html = html.replaceAll(`="${name}"`, `="${name}?v=${hash}"`);
    }
    writeFileSync(file, html, 'utf8');
  }
}

if (!existsSync(WEBSITE_SRC)) {
  console.error('✗ missing source directory: website/');
  process.exit(1);
}
const WEBSITE_OUT = join(OUT, 'website');
copyDir(WEBSITE_SRC, WEBSITE_OUT);
versionAssets(WEBSITE_OUT);
written.push('website/**');

const findings = audit(OUT);
console.log(`✓ wrote ${written.length} file(s) to ${OUT}`);
for (const f of written) console.log(`   • ${f}`);
if (findings.length) {
  console.error(`\n✗ ${findings.length} finding(s) survived scrubbing:`);
  for (const f of findings) console.error(`   • ${f}`);
  process.exit(1);
}
console.log('\n✓ audit clean — no secrets, phone numbers or home paths.');
