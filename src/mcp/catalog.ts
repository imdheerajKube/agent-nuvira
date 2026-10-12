/**
 * I7 P2 — Curated MCP catalog (`src/mcp/catalog.ts`).
 *
 * A catalog entry is a CAPABILITY SLOT (`github`, `fetch`, `docs`), not one
 * hardcoded package. A slot offers ranked VARIANTS — ways to run that
 * capability on this machine — and every variant declares what it requires
 * (`requires`) and what the user gets (`offers`).
 *
 * WHY THE SHAPE CHANGED (2026-10-12). The first version was `name → one exact
 * npm pin`. Four of its six pins did not resolve on npm at all
 * (`docs/mcp-assessment.md` §2), so `nuvira mcp install context7` wrote a config
 * whose stdio command could never spawn — a two-command, no-code install that
 * could not work as advertised. A single pin per capability can only ever be as
 * reachable as that one pin.
 *
 * The slot/variant shape fixes the class of defect rather than the instances:
 *   • `github` — the hosted remote endpoint by default (OAuth/PAT, no install),
 *     with the official local binary kept behind an explicit opt-in, and the
 *     npm package REMOVED (npm marks it "no longer supported").
 *   • `context7` — the current 4.3.0 pin, which needs Node ≥ 20.18.1 while the
 *     product runs on ≥ 18.18, so the floor is met by a per-server RUNTIME
 *     OVERRIDE instead of raising the global floor; a Node-18-safe release is
 *     offered as a second variant rather than leaving those machines stranded.
 *   • `fetch` — the package the old catalog pinned does not exist on npm.
 *     Three real ways to run it (`npx`, `uvx`, docker), each with its own
 *     prerequisite, so a machine that has any one of them has the capability.
 *
 * Install rules this module enforces (see `installCatalogServer`):
 *   1. Prerequisites are probed BEFORE anything is written; a variant that
 *      cannot run is refused loudly, naming what is missing and how to get it.
 *   2. An exact npm pin is only written after a resolvability check the CALLER
 *      performed (async, network); when it could not run, the result says so
 *      (`unverifiedPins`) instead of implying a verification that never happened.
 *   3. Secrets are resolved from the environment or an explicit value, never
 *      echoed, never written to `buffconfig.json`, and the config file is
 *      written `0600` when it carries one.
 *
 * CLI surface (src/cli/mcp.ts):
 *   nuvira mcp catalog [--search <q>]        — slots, variants, what they need
 *   nuvira mcp install <name> [--variant id] [--runtime <cmd>]
 *   nuvira mcp uninstall <name>
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { resolveMcpConfigDir } from '../config/paths.js';
import { logger } from '../utils/logger.js';
import { type MCPServerConfig, type MCPOAuthServerConfig } from './types.js';
import {
  type MCPPrereq,
  type MCPProbeOptions,
  type MCPPrereqStatus,
  commandExists,
  describeMissingPrereqs,
  describePrereqProblems,
  probePrereqs,
} from './prereqs.js';

// ─── Catalog entry ──────────────────────────────────────────────────────────

/** How much a variant's publisher is trusted — stated, never implied. */
export type MCPVariantTrust = 'first-party' | 'official' | 'community';

/** The result of the (network) npm resolvability check, computed by the caller. */
export interface PinVerdict {
  /** Did the check actually run? `false` = offline / not attempted. */
  checked: boolean;
  ok: boolean;
  /** Human reason when `ok` is false or the check could not run. */
  reason?: string;
  /** npm's own deprecation note for the exact version, when it resolves but is unmaintained. */
  deprecated?: string;
}

/** One way to run a capability. */
export interface MCPCatalogVariant {
  /** Stable id within the slot: 'remote' | 'npx' | 'binary' | 'uvx' | 'docker'. */
  id: string;
  label: string;
  transport: 'stdio' | 'sse';
  /** stdio command (e.g. "npx"). */
  command?: string;
  /** stdio args. Exact-version pinned for npm (`pkg@1.2.3`). */
  args?: string[];
  /** SSE endpoint URL. */
  url?: string;
  /** HTTP headers; `${VAR}` is expanded from the resolved env/secret values. */
  headers?: Record<string, string>;
  /**
   * OAuth 2.0 for a remote server that takes a TOKEN rather than a static key.
   * `clientId`/`clientSecret` may be `${VAR}` references, expanded at install
   * time like `headers` — so a client secret can come from the environment and
   * still land only in the 0600 config file.
   */
  oauth?: MCPOAuthServerConfig;
  /** Env vars written into the config. Value "prompt-secret" → required, resolved at install. */
  env?: Record<string, string>;
  /** Env vars written only when resolvable (never a reason to fail an install). */
  envOptional?: Record<string, string>;
  /**
   * Per-server runtime override: run this variant's command through a
   * DIFFERENT interpreter (e.g. a newer Node) — `runtime.command runtime.args…
   * <command> <args…>`. The escape hatch that avoids raising the global floor.
   */
  runtime?: { command: string; args?: string[] };
  /** What must exist on this machine before the variant can run. */
  requires: MCPPrereq[];
  /** Preference order (lower wins) among variants that are not `optIn`. */
  rank: number;
  /** Never auto-selected — the user must name it with `--variant <id>`. */
  optIn?: boolean;
  trust: MCPVariantTrust;
  vettedBy: string;
  /** A caveat worth printing at install time (an unpinned tag, an old release…). */
  note?: string;
}

export interface MCPCatalogEntry {
  name: string;
  description: string;
  /** What the user actually gets — the reason to enable it. */
  offers: string[];
  /** Ranked ways to run it (see `chooseVariant`). */
  variants: MCPCatalogVariant[];
  /** A pin that no longer works / is deprecated, kept for the audit trail. */
  supersedes?: string;
}

/** A variant plus its probed prerequisite status. */
export interface MCPVariantChoice {
  variant: MCPCatalogVariant;
  status: MCPPrereqStatus;
}

/** Vetted catalog. Every npm spec is exact-version pinned so a stale pin is visible. */
export const MCP_CATALOG: MCPCatalogEntry[] = [
  {
    name: 'filesystem',
    description: 'Filesystem access (read/write/search within allowed roots)',
    offers: [
      'Read, write and edit files under the directories you allow',
      'Directory listing, globbing and content search, locally',
    ],
    variants: [
      {
        id: 'npx',
        label: 'npx (Node ≥18.18)',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0'],
        requires: [
          { kind: 'command', name: 'npx', hint: 'Install Node.js ≥18.18 — npx ships with it' },
          { kind: 'node', name: 'node', minVersion: '18.18.0', hint: 'Install Node.js ≥18.18' },
        ],
        rank: 1,
        trust: 'official',
        vettedBy: 'nous-catalog',
        note: 'Pass allowed roots as extra args (see mcp.servers.filesystem.args) — without one the server exposes nothing.',
      },
    ],
  },
  {
    name: 'github',
    description: 'GitHub API via MCP (repos, issues, PRs, search)',
    offers: [
      'Read and search repositories, issues, pull requests and code',
      'Comment, open issues/PRs and update branches with your token’s permissions',
    ],
    supersedes:
      '@modelcontextprotocol/server-github@0.6.2 / @2025.4.8 — npm marks the package "no longer supported"; install can never succeed from it reliably',
    variants: [
      {
        id: 'remote',
        label: 'Hosted remote endpoint (no install)',
        transport: 'sse',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' },
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'prompt-secret' },
        requires: [
          {
            kind: 'env',
            name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
            hint: 'Create a token at github.com/settings/tokens (repo + read:org for most work)',
          },
        ],
        rank: 1,
        trust: 'official',
        vettedBy: 'nous-catalog',
        note: 'GitHub’s own remote MCP endpoint — nothing is installed locally.',
      },
      {
        id: 'local-binary',
        label: 'Official local binary (github-mcp-server stdio)',
        transport: 'stdio',
        command: 'github-mcp-server',
        args: ['stdio'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'prompt-secret' },
        requires: [
          {
            kind: 'command',
            name: 'github-mcp-server',
            hint: 'Install GitHub’s Go binary: brew install github-mcp-server, or a release from github/github-mcp-server',
          },
          {
            kind: 'env',
            name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
            hint: 'Create a token at github.com/settings/tokens',
          },
        ],
        rank: 2,
        // Q1 decision: a local stdio server stays an explicit opt-in; the
        // remote endpoint is the default.
        optIn: true,
        trust: 'official',
        vettedBy: 'nous-catalog',
        note: 'Runs entirely locally; requires the binary on PATH and the token in the config file.',
      },
    ],
  },
  {
    name: 'fetch',
    description: 'Fetch a URL and convert it to readable markdown',
    offers: [
      'Turn a web page into clean markdown the model can read',
      'Pull documentation, changelogs and articles into a turn',
    ],
    supersedes:
      '@modelcontextprotocol/server-fetch@0.1.7 — the package does not exist on npm (E404); the capability is offered through three runnable variants instead',
    variants: [
      {
        id: 'npx',
        label: 'npx (Node ≥18)',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@tokenizin/mcp-npx-fetch@1.0.0'],
        requires: [
          { kind: 'command', name: 'npx', hint: 'Install Node.js ≥18 — npx ships with it' },
          { kind: 'node', name: 'node', minVersion: '18.0.0', hint: 'Install Node.js ≥18' },
        ],
        rank: 1,
        trust: 'community',
        vettedBy: 'community-listed',
        note: 'Third-party npm package (last published 2024-12) — pinned exactly; prefer the uvx variant if you already have uv.',
      },
      {
        id: 'uvx',
        label: 'uvx (Python ≥3.10, uv)',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-fetch==2026.10.10'],
        requires: [
          {
            kind: 'command',
            name: 'uvx',
            hint: 'Install uv (which provides uvx): brew install uv, or see docs.astral.sh/uv',
          },
        ],
        rank: 2,
        trust: 'official',
        vettedBy: 'nous-catalog',
        note: 'The maintained upstream fetch server; Python ≥3.10 is provided by uv, not your system Python.',
      },
      {
        id: 'docker',
        label: 'docker (mcp/fetch image)',
        transport: 'stdio',
        command: 'docker',
        args: ['run', '-i', '--rm', 'mcp/fetch'],
        requires: [
          { kind: 'command', name: 'docker', hint: 'Install Docker Desktop, or the docker engine' },
          {
            kind: 'service',
            name: 'docker',
            check: { args: ['info'] },
            hint: 'START the Docker daemon (open Docker Desktop, or `colima start`) — `docker run` needs it, and the CLI being on PATH is not enough',
          },
        ],
        rank: 3,
        trust: 'official',
        vettedBy: 'nous-catalog',
        note: 'The publisher tags this image `latest` only, so the image itself cannot be pinned to a version — the one variant where that is true (it is a caveat about version drift, NOT about Docker being missing).',
      },
    ],
  },
  {
    name: 'memory',
    description: 'Knowledge-graph based persistent memory (entities, relations, observations)',
    offers: [
      'A knowledge graph the model can read and write across sessions',
      'Entities, relations and observations as first-class tools',
    ],
    variants: [
      {
        id: 'npx',
        label: 'npx (Node ≥18.18)',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory@1.0.0'],
        requires: [
          { kind: 'command', name: 'npx', hint: 'Install Node.js ≥18.18 — npx ships with it' },
          { kind: 'node', name: 'node', minVersion: '18.18.0', hint: 'Install Node.js ≥18.18' },
        ],
        rank: 1,
        trust: 'official',
        vettedBy: 'nous-catalog',
        note: 'A second memory system beside Nuvira’s own memory tools — enable it only if you want the graph form.',
      },
    ],
  },
  {
    name: 'sequential-thinking',
    description: 'Structured, explicit reasoning over a problem space',
    offers: [
      'A step-by-step reasoning scratchpad the model can revise',
      'Branch, backtrack and revise a line of thought explicitly',
    ],
    variants: [
      {
        id: 'npx',
        label: 'npx (Node ≥18.18)',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking@1.0.0'],
        requires: [
          { kind: 'command', name: 'npx', hint: 'Install Node.js ≥18.18 — npx ships with it' },
          { kind: 'node', name: 'node', minVersion: '18.18.0', hint: 'Install Node.js ≥18.18' },
        ],
        rank: 1,
        trust: 'official',
        vettedBy: 'nous-catalog',
      },
    ],
  },
  {
    name: 'context7',
    description: 'Up-to-date library/framework documentation retrieval',
    offers: [
      'Current (not training-cutoff) docs and code examples for a library you name',
      'Version-specific usage snippets while implementing',
    ],
    supersedes: '@upstash/context7-mcp@1.5.2 — that version never existed on npm (line jumps 1.0.34 → 2.0.0)',
    variants: [
      {
        id: 'npx',
        label: 'npx 4.3.0 (needs Node ≥20.18.1)',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@4.3.0'],
        envOptional: { CONTEXT7_API_KEY: 'prompt-secret' },
        requires: [
          { kind: 'command', name: 'npx', hint: 'Install Node.js ≥20.18.1 — npx ships with it' },
          {
            kind: 'node',
            name: 'node',
            minVersion: '20.18.1',
            hint:
              'context7 4.x declares engines.node ≥20.18.1 while Nuvira runs on ≥18.18 — install Node 20+ and pass ' +
              '`--runtime /path/to/node20` (or set mcp.servers.context7.runtime.command), or install the npx-node18 variant',
          },
        ],
        rank: 1,
        trust: 'official',
        vettedBy: 'nous-catalog',
        note: 'CONTEXT7_API_KEY is optional (higher rate limits with a key), so install never blocks on it.',
      },
      {
        id: 'npx-node18',
        label: 'npx 2.0.0 (no engines floor — Node 18 ok)',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@2.0.0'],
        envOptional: { CONTEXT7_API_KEY: 'prompt-secret' },
        requires: [
          { kind: 'command', name: 'npx', hint: 'Install Node.js ≥18.18 — npx ships with it' },
          { kind: 'node', name: 'node', minVersion: '18.18.0', hint: 'Install Node.js ≥18.18' },
        ],
        rank: 2,
        trust: 'official',
        vettedBy: 'nous-catalog',
        note: 'Kept for reach on Node 18: 2.0.0 declares no engines floor, but it is an older release — its docs coverage may lag 4.x.',
      },
    ],
  },

  // ─── Google Workspace (official remote MCP servers, OAuth 2.0) ────────────
  //
  // These are the first entries whose credential is a TOKEN rather than a static
  // API key, which is why the `oauth` block exists on a variant: install writes
  // HOW to get a token (endpoints, client, scopes) and the 0600 config file holds
  // the client secret; the token itself is obtained once with
  // `nuvira mcp authorize <name>` and refreshed silently from then on.
  //
  // Every claim below is from Google's own configuration guide
  // (developers.google.com/workspace/guides/configure-mcp-servers): one remote
  // server per product, OAuth 2.0, and — stated plainly rather than discovered
  // later — Developer Preview membership plus a Cloud project with the product
  // API and its MCP API enabled.
  {
    name: 'gmail',
    description: 'Official Google Workspace Gmail MCP server (remote, OAuth 2.0)',
    offers: [
      'Search and read mail, and create drafts, with your own Gmail permissions',
      'Inbox context inside a turn without handing the mailbox to a third party',
    ],
    variants: [
      {
        id: 'remote',
        label: 'Google Workspace MCP — Gmail (remote, OAuth 2.0)',
        transport: 'sse',
        url: 'https://gmailmcp.googleapis.com/mcp/v1',
        oauth: {
          authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenEndpoint: 'https://oauth2.googleapis.com/token',
          clientId: '${GOOGLE_MCP_CLIENT_ID}',
          clientSecret: '${GOOGLE_MCP_CLIENT_SECRET}',
          scopes: [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.compose',
          ],
          usePKCE: true,
          grant: 'authorization_code',
        },
        env: { GOOGLE_MCP_CLIENT_ID: 'prompt-secret', GOOGLE_MCP_CLIENT_SECRET: 'prompt-secret' },
        requires: [
          {
            kind: 'env',
            name: 'GOOGLE_MCP_CLIENT_ID',
            hint: 'OAuth client ID from your Google Cloud project (see developers.google.com/workspace/guides/configure-mcp-servers)',
          },
          {
            kind: 'env',
            name: 'GOOGLE_MCP_CLIENT_SECRET',
            hint: 'The matching OAuth client secret — a Desktop-app client, since the flow uses a loopback redirect and PKCE',
          },
        ],
        rank: 1,
        trust: 'official',
        vettedBy: 'google-workspace-docs',
        note:
          'Google’s own remote Gmail MCP server — nothing is installed locally. Needs Google Workspace Developer Preview membership and the Gmail API + Gmail MCP API enabled in the Cloud project. Install, then run `nuvira mcp authorize gmail` once.',
      },
    ],
  },
  {
    name: 'gdrive',
    description: 'Official Google Workspace Drive MCP server (remote, OAuth 2.0)',
    offers: [
      'Search, list and read files you already have access to',
      'Upload and organise files with `drive.file` (only what this app creates or opens)',
    ],
    variants: [
      {
        id: 'remote',
        label: 'Google Workspace MCP — Drive (remote, OAuth 2.0)',
        transport: 'sse',
        url: 'https://drivemcp.googleapis.com/mcp/v1',
        oauth: {
          authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenEndpoint: 'https://oauth2.googleapis.com/token',
          clientId: '${GOOGLE_MCP_CLIENT_ID}',
          clientSecret: '${GOOGLE_MCP_CLIENT_SECRET}',
          scopes: [
            'https://www.googleapis.com/auth/drive.readonly',
            'https://www.googleapis.com/auth/drive.file',
          ],
          usePKCE: true,
          grant: 'authorization_code',
        },
        env: { GOOGLE_MCP_CLIENT_ID: 'prompt-secret', GOOGLE_MCP_CLIENT_SECRET: 'prompt-secret' },
        requires: [
          {
            kind: 'env',
            name: 'GOOGLE_MCP_CLIENT_ID',
            hint: 'OAuth client ID from your Google Cloud project (the SAME client can serve all three Workspace servers)',
          },
          {
            kind: 'env',
            name: 'GOOGLE_MCP_CLIENT_SECRET',
            hint: 'The matching OAuth client secret — a Desktop-app client, since the flow uses a loopback redirect and PKCE',
          },
        ],
        rank: 1,
        trust: 'official',
        vettedBy: 'google-workspace-docs',
        note:
          'Google’s own remote Drive MCP server. Needs the Drive API + Drive MCP API enabled, and Developer Preview membership. `drive.file` deliberately does NOT grant blanket access to your Drive — only to files this app creates or that you open with it.',
      },
    ],
  },
  {
    name: 'gcalendar',
    description: 'Official Google Workspace Calendar MCP server (remote, OAuth 2.0)',
    offers: [
      'List calendars and read events, and check free/busy before proposing a time',
      'Give the agent a real schedule view instead of guessing availability',
    ],
    variants: [
      {
        id: 'remote',
        label: 'Google Workspace MCP — Calendar (remote, OAuth 2.0)',
        transport: 'sse',
        url: 'https://calendarmcp.googleapis.com/mcp/v1',
        oauth: {
          authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenEndpoint: 'https://oauth2.googleapis.com/token',
          clientId: '${GOOGLE_MCP_CLIENT_ID}',
          clientSecret: '${GOOGLE_MCP_CLIENT_SECRET}',
          scopes: [
            'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
            'https://www.googleapis.com/auth/calendar.events.freebusy',
            'https://www.googleapis.com/auth/calendar.events.readonly',
          ],
          usePKCE: true,
          grant: 'authorization_code',
        },
        env: { GOOGLE_MCP_CLIENT_ID: 'prompt-secret', GOOGLE_MCP_CLIENT_SECRET: 'prompt-secret' },
        requires: [
          {
            kind: 'env',
            name: 'GOOGLE_MCP_CLIENT_ID',
            hint: 'OAuth client ID from your Google Cloud project (the SAME client can serve all three Workspace servers)',
          },
          {
            kind: 'env',
            name: 'GOOGLE_MCP_CLIENT_SECRET',
            hint: 'The matching OAuth client secret — a Desktop-app client, since the flow uses a loopback redirect and PKCE',
          },
        ],
        rank: 1,
        trust: 'official',
        vettedBy: 'google-workspace-docs',
        note:
          'Google’s own remote Calendar MCP server. Needs the Google Calendar API + Calendar MCP API enabled, and Developer Preview membership. The scopes here are READ + free/busy only, so the agent can propose a time but cannot silently book one.',
      },
    ],
  },
];

// ─── Lookup ─────────────────────────────────────────────────────────────────

/** Find a catalog entry by name. */
export function getCatalogEntry(name: string): MCPCatalogEntry | null {
  return MCP_CATALOG.find((e) => e.name === name) ?? null;
}

/** Search the catalog by name/description keyword. */
export function searchCatalog(query: string): MCPCatalogEntry[] {
  const q = query.toLowerCase();
  return MCP_CATALOG.filter((e) => `${e.name} ${e.description}`.toLowerCase().includes(q));
}

// ─── Variant selection ──────────────────────────────────────────────────────

/**
 * The environment a variant is probed against: the process env, then anything
 * the caller injected (tests describe a machine this way), then the secrets being
 * supplied right now.
 *
 * WHY the secrets belong here: `nuvira mcp install github --env
 * GITHUB_PERSONAL_ACCESS_TOKEN=…` must satisfy the variant's env prerequisite
 * even when the shell variable is not exported — otherwise the documented
 * one-command install refuses on the flag designed to make it work. Both the
 * probe and the config write use this one function, so a value can never be
 * checked in one environment and written from another.
 */
export function effectiveProbeEnv(
  injected?: NodeJS.ProcessEnv,
  secrets?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(injected ?? {}) };
  for (const [key, value] of Object.entries(secrets ?? {})) env[key] = value;
  return env;
}

/** A variant's runtime override, if it declares one (or the entry's explicit one). */
function variantProbeOptions(
  variant: MCPCatalogVariant,
  runtime: { command: string; args?: string[] } | undefined,
  probe: MCPProbeOptions | undefined,
): MCPProbeOptions {
  const runtimeCommand = runtime?.command ?? variant.runtime?.command;
  return { ...(probe ?? {}), ...(runtimeCommand ? { runtimeCommand } : {}) };
}

/**
 * Every variant with its probed status, in preference order — what `nuvira mcp
 * catalog` prints, and the basis for choosing one.
 */
export function evaluateVariants(
  entry: MCPCatalogEntry,
  options: { probe?: MCPProbeOptions; runtime?: { command: string; args?: string[] } } = {},
): MCPVariantChoice[] {
  return [...entry.variants]
    .sort((a, b) => a.rank - b.rank)
    .map((variant) => ({
      variant,
      status: probePrereqs(variant.requires, variantProbeOptions(variant, options.runtime, options.probe)),
    }));
}

/**
 * Pick the variant to install: an explicitly named one, else the highest-ranked
 * variant that is not `optIn` and whose prerequisites are satisfied.
 *
 * Returns `{ ok: false }` with the full candidate list when nothing can run, so
 * the caller can name every way the capability could be reached AND what each
 * one is missing. That is the difference between "install failed" and "here is
 * the dependency you need".
 */
export function chooseVariant(
  entry: MCPCatalogEntry,
  options: { variantId?: string; probe?: MCPProbeOptions; runtime?: { command: string; args?: string[] } } = {},
): { ok: true; choice: MCPVariantChoice } | { ok: false; reason: string; choices: MCPVariantChoice[] } {
  const choices = evaluateVariants(entry, options);

  if (options.variantId) {
    const named = choices.find((c) => c.variant.id === options.variantId);
    if (!named) {
      return {
        ok: false,
        reason: `'${options.variantId}' is not a variant of '${entry.name}'. Available: ${choices
          .map((c) => c.variant.id)
          .join(', ')}`,
        choices,
      };
    }
    return { ok: true, choice: named };
  }

  const auto = choices.filter((c) => !c.variant.optIn);
  const runnable = auto.find((c) => c.status.ok);
  if (runnable) return { ok: true, choice: runnable };

  const lines = (auto.length > 0 ? auto : choices).flatMap((c) => {
    const problems = describePrereqProblems(c.status);
    return [`  • ${c.variant.id}: ${problems.length > 0 ? problems.join('; ') : '(available)'}`];
  });
  const optIn = choices.filter((c) => c.variant.optIn);
  if (optIn.length > 0) {
    lines.push(`  • opt-in variants (name them with --variant): ${optIn.map((c) => c.variant.id).join(', ')}`);
  }
  return {
    ok: false,
    reason: `no variant of '${entry.name}' can run on this machine yet:\n${lines.join('\n')}`,
    choices,
  };
}

// ─── Install path ───────────────────────────────────────────────────────────

/** The per-server config file for an installed catalog server. */
export function catalogConfigPath(name: string, configDir?: string): string {
  return join(resolveMcpConfigDir(configDir), `${name}.json`);
}

/** Is a catalog server already installed? */
export function isCatalogServerInstalled(name: string, configDir?: string): boolean {
  return existsSync(catalogConfigPath(name, configDir));
}

/**
 * Resolve a `prompt-secret` env value: from the live environment first; else
 * `provided` (the CLI's prompted value); else null (caller reports missing).
 */
export function resolveSecret(key: string, provided?: Record<string, string>): string | null {
  const fromEnv = process.env[key];
  if (fromEnv) return fromEnv;
  const explicit = provided?.[key];
  return explicit ?? null;
}

/** Expand `${VAR}` references in a string from a resolved value map. */
export function expandRefs(text: string, values: Record<string, string>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    values[name] !== undefined ? values[name] : whole,
  );
}

export interface InstallOptions {
  /** Force a specific variant id (else the best runnable one is chosen). */
  variantId?: string;
  /**
   * Replace the stdio command with an explicit path — the reach fix for a
   * binary that IS installed but is not on PATH. Verified to exist and be
   * executable here, and it satisfies the variant's `command` prerequisite.
   */
  command?: string;
  /** Explicit per-server runtime override (`--runtime <cmd>`), wins over the variant's. */
  runtime?: { command: string; args?: string[] };
  /** Probe inputs (tests inject `env` / `nodeVersion`). */
  probe?: MCPProbeOptions;
  /** Result of the async npm resolvability check, performed by the caller. */
  pinVerdict?: PinVerdict;
  /** Install even when prerequisites are missing / a pin does not resolve. */
  force?: boolean;
}

export interface InstallResult {
  ok: boolean;
  reason?: string;
  path?: string;
  variantId?: string;
  /** Missing prerequisites, as human lines (populated on a prereq refusal). */
  missing?: string[];
  /** True when a pinned npm spec was written WITHOUT a resolvability check. */
  unverifiedPins?: boolean;
  /** True when the install proceeded despite a failed/un-run check (`--force`). */
  forced?: boolean;
}

/**
 * Install a catalog server: choose a runnable variant, resolve secrets, write
 * the standard MCP config (never the buffconfig), return what was written.
 *
 * Refuses — loudly, before writing anything — when no variant can run on this
 * machine (unless `force`), or when the caller's npm resolvability check
 * reported that a pinned spec does not exist. Secrets come from the environment
 * or `providedSecrets`; a missing REQUIRED secret names the key and never logs a
 * value. The file is written `0600` whenever it carries a secret.
 */
export function installCatalogServer(
  entry: MCPCatalogEntry,
  providedSecrets?: Record<string, string>,
  configDir?: string,
  options: InstallOptions = {},
): InstallResult {
  const target = catalogConfigPath(entry.name, configDir);
  if (existsSync(target)) {
    return { ok: false, reason: `already installed at ${target}` };
  }

  // The probe sees the SAME environment the install will use (see
  // `effectiveProbeEnv`), so what is verified and what is written cannot
  // disagree.
  const probeEnv = effectiveProbeEnv(options.probe?.env, providedSecrets);
  const probe = { ...(options.probe ?? {}), env: probeEnv };

  // An explicit --command names an executable that may deliberately sit outside
  // PATH. It is verified HERE (exists + executable); when it checks out it
  // satisfies the variant's command prerequisite, so a local binary is reachable
  // without installing it into PATH.
  const explicitCommand = options.command?.trim();
  const explicitCommandOk = explicitCommand ? commandExists(explicitCommand, probeEnv) : false;

  const chosen = chooseVariant(entry, {
    ...(options.variantId ? { variantId: options.variantId } : {}),
    probe,
    ...(options.runtime ? { runtime: options.runtime } : {}),
  });
  // Resolve which variant to write. A named variant that exists but cannot run
  // is still selected — the caller may be about to fix it — and the prerequisite
  // gate below decides; an unknown name, or nothing runnable with no --force, is
  // a refusal that names every way the capability could work and what is missing.
  let choice: MCPVariantChoice;
  if (chosen.ok) {
    choice = chosen.choice;
  } else if (options.variantId) {
    const named = chosen.choices.find((c) => c.variant.id === options.variantId);
    if (!named) return { ok: false, reason: chosen.reason };
    choice = named;
  } else if (options.force) {
    // Nothing probed clean; the user asked to override the probe, so write the
    // preferred variant (lowest rank, never an opt-in one) anyway.
    choice = chosen.choices.find((c) => !c.variant.optIn) ?? chosen.choices[0];
  } else {
    return {
      ok: false,
      reason: chosen.reason,
      missing: chosen.choices
        .filter((c) => !c.variant.optIn)
        .flatMap((c) => describePrereqProblems(c.status)),
    };
  }
  const variant = choice.variant;

  // Prerequisite gate — the "call out the dependency before enabling" rule.
  const missingAfterCommand = explicitCommandOk
    ? choice.status.missing.filter((p) => p.kind !== 'command')
    : choice.status.missing;
  // NOTE: `--command` satisfies a MISSING binary only. A `service` that is
  // present but down stays blocked — pointing at a path does not start a daemon.
  if ((missingAfterCommand.length > 0 || choice.status.blocked.length > 0) && !options.force) {
    const missing = describePrereqProblems({ ...choice.status, missing: missingAfterCommand });
    return {
      ok: false,
      reason: `'${entry.name}' (variant '${variant.id}') cannot run on this machine yet:\n${missing
        .map((m) => `  • ${m}`)
        .join('\n')}\nInstall the dependency above, pass a runtime override, or re-run with --force.`,
      missing,
      variantId: variant.id,
    };
  }

  // Resolvability gate — a pin that does not exist must fail HERE, not at
  // connect time in a chat turn. An UNCHECKED verdict (offline) is not a
  // refusal: it installs and reports `unverifiedPins` instead.
  if (options.pinVerdict?.checked && !options.pinVerdict.ok && !options.force) {
    return {
      ok: false,
      reason: `pinned package does not resolve: ${options.pinVerdict.reason ?? 'not found in the registry'}`,
      variantId: variant.id,
    };
  }

  // Resolve env (required + optional) against the EFFECTIVE environment — the
  // same one the probe saw — so what was verified and what is written cannot
  // disagree (`--env KEY=VALUE` counts for both).
  const resolveFrom = (key: string): string | null => {
    const fromEnv = probeEnv[key];
    if (fromEnv && fromEnv.trim()) return fromEnv;
    const explicit = providedSecrets?.[key];
    return explicit ?? null;
  };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(variant.env ?? {})) {
    const resolved = value === 'prompt-secret' ? resolveFrom(key) : value;
    if (resolved === null) {
      return {
        ok: false,
        reason: `missing required env var ${key} — set it or pass a value`,
        variantId: variant.id,
      };
    }
    env[key] = resolved;
  }
  for (const [key, value] of Object.entries(variant.envOptional ?? {})) {
    const resolved = value === 'prompt-secret' ? resolveFrom(key) : value;
    if (resolved !== null) env[key] = resolved;
  }

  const headers = variant.headers
    ? Object.fromEntries(Object.entries(variant.headers).map(([k, v]) => [k, expandRefs(v, env)]))
    : undefined;

  // OAuth endpoints are literal; the CLIENT CREDENTIALS may be `${VAR}`
  // references, expanded from the same resolved env as the headers so the
  // secret is never duplicated into a second place.
  const oauth = variant.oauth
    ? {
        ...variant.oauth,
        ...(variant.oauth.clientId ? { clientId: expandRefs(variant.oauth.clientId, env) } : {}),
        ...(variant.oauth.clientSecret ? { clientSecret: expandRefs(variant.oauth.clientSecret, env) } : {}),
      }
    : undefined;

  const runtime = options.runtime ?? variant.runtime;

  const config: MCPServerConfig = {
    name: entry.name,
    transport: variant.transport,
    enabled: true,
    variant: variant.id,      ...((explicitCommand ?? variant.command) ? { command: explicitCommand ?? variant.command } : {}),
    ...(variant.args ? { args: variant.args } : {}),
    ...(variant.url ? { url: variant.url } : {}),
    ...(headers ? { headers } : {}),
    ...(oauth ? { oauth } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(runtime ? { runtime } : {}),
  };

  try {
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, JSON.stringify(config, null, 2), 'utf-8');
    // §7.8 hygiene: a config that carries a credential is not world-readable.
    if (Object.keys(env).length > 0) {
      try {
        chmodSync(target, 0o600);
      } catch {
        // Windows / exotic filesystems: best-effort, never fail an install.
      }
    }
    // The CALLER reports success (one fact, one owner) — the CLI prints the
    // variant, what it offers and the next step; a second success line here
    // would just say the same thing twice.
    logger.debug(`MCP install: wrote '${entry.name}' (variant ${variant.id}) → ${target}`);
    return {
      ok: true,
      path: target,
      variantId: variant.id,
      ...(options.pinVerdict && !options.pinVerdict.checked ? { unverifiedPins: true } : {}),
      ...(options.force && options.pinVerdict && !options.pinVerdict.ok ? { forced: true } : {}),
    };
  } catch (err) {
    return { ok: false, reason: `write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Uninstall a catalog server (remove its config file). */
export function uninstallCatalogServer(name: string, configDir?: string): { ok: boolean; reason?: string } {
  const target = catalogConfigPath(name, configDir);
  if (!existsSync(target)) {
    return { ok: false, reason: `'${name}' is not installed (no config at ${target})` };
  }
  try {
    unlinkSync(target);
    logger.debug(`MCP uninstall: removed '${name}' (${target})`);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `unlink failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The exact npm specs ONE variant pins (`@scope/pkg@1.2.3`) — what the
 * registry-existence check should verify before this variant is written. Empty
 * for remote/native variants. Shared by the CLI and the dashboard.
 */
export function npmSpecsForVariant(variant: Pick<MCPCatalogVariant, 'command' | 'args'>): string[] {
  if (variant.command !== 'npx') return [];
  return (variant.args ?? []).filter((arg) => /^(@[^/]+\/)?[^@]+@\d/.test(arg));
}

/**
 * Every exact npm spec in the catalog (`@scope/pkg@1.2.3`), for the
 * registry-existence check. Kept here so the catalog stays the single source of
 * truth for what is pinned.
 */
export function catalogNpmSpecs(entries: MCPCatalogEntry[] = MCP_CATALOG): string[] {
  const specs = new Set<string>();
  for (const entry of entries) {
    for (const variant of entry.variants) {
      if (variant.command !== 'npx') continue;
      for (const arg of variant.args ?? []) {
        if (arg.startsWith('@') || /^[a-z0-9][a-z0-9-]*@\d/.test(arg)) specs.add(arg);
      }
    }
  }
  return [...specs];
}
