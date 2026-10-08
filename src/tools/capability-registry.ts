/**
 * Capability registry — normalize everything the agent can DO into one index.
 *
 * Phase 1 of the capability layer. It ADAPTS the sources that already exist:
 *
 *   - the TOOL registry (name + description → `kind: 'tool'`),
 *   - the installed SKILL catalog (→ `kind: 'skill'`),
 *   - a small curated set of high-level ACTIONS the user named (install /
 *     uninstall / publish package / publish site / deploy / push / store a
 *     credential) that are expressed TODAY only as scattered prose,
 *   - the tools of any MCP server connected THIS process (→ `kind: 'mcp'`).
 *     Reach borrowed from outside: a foreign server already declares what each
 *     tool does (MCP `ToolAnnotations`) and what it needs (its JSON Schema), so
 *     those become discoverable capabilities with nothing hand-written here.
 *
 * It deliberately does NOT import `./registry.js` — callers pass the tool list
 * in, so `tool_search` can use this without an import cycle. And it does NOT
 * decide anything yet: discovery only. Phase 2 moves the gates onto `effectClass`.
 *
 * The effect-class map below is deliberately CONSERVATIVE: a tool whose effect is
 * unknown defaults to `local-state` (an ask), never `read`. A read-only tool
 * mislabelled is cosmetic; a mutating tool mislabelled read would be dangerous.
 */

import type {
  Capability,
  CapabilityHit,
  CapabilityRequires,
  EffectClass,
  GrantCategory,
} from '../learning/capability-types.js';
import { machineFactsCapability } from '../learning/machine-facts.js';

type ToolLike = { name: string; description?: string; category?: string };

/**
 * A tool discovered on an external MCP server. Deliberately structural, not
 * imported from `src/mcp/types.ts`: this module must stay importable from the
 * tool layer without pulling the MCP client in, and an injected list is what
 * makes the ingestion testable.
 */
export interface McpToolLike {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** The server's OWN declaration (MCP `ToolAnnotations`). Absent = unknown. */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** The required property names an MCP tool's JSON Schema declares. */
function requiredInputs(inputSchema?: Record<string, unknown>): string[] {
  const required = inputSchema?.required;
  return Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : [];
}

/** Per-tool effect metadata. Anything absent falls back to the conservative default. */
interface EffectInfo {
  effect: EffectClass;
  reversible: boolean;
  how?: string;
  grant?: GrantCategory;
  requires?: CapabilityRequires;
}

const T = (effect: EffectClass, reversible: boolean, extra: Partial<EffectInfo> = {}): EffectInfo => ({
  effect,
  reversible,
  ...extra,
});

/**
 * Curated effect map for the tools whose effect is specific. Reads are marked
 * read; workspace mutations and machine changes carry their grant category;
 * off-machine actions carry their credential needs.
 *
 * Anything NOT listed here falls to `DEFAULT_EFFECT`, which is deliberately
 * cautious in BOTH directions: an unlisted tool is treated as a local-state
 * change (an ask, never a silent read) and NO grant is assumed to cover it (the
 * agent has not declared a category, so a user's grant cannot unlock it).
 *
 * A network READ (`web_search`, `read_page`, `osv_check`) is still `read`: the
 * class describes what the action DOES to the world, not where it runs.
 */
const EFFECT_BY_TOOL: Record<string, EffectInfo> = {
  // ── read-only: inspects, changes nothing ──
  read_file: T('read', true),
  list_dir: T('read', true),
  glob: T('read', true),
  code_search: T('read', true),
  web_search: T('read', true),
  read_page: T('read', true),
  read_extract: T('read', true),
  verify_requirement: T('read', true),
  ask_user: T('read', true),
  suggest_followups: T('read', true),
  tool_search: T('read', true),
  fuzzy_match: T('read', true),
  analyze: T('read', true),
  osv_check: T('read', true),
  path_security: T('read', true),
  threat_patterns: T('read', true),
  url_safety: T('read', true),
  secret_scan: T('read', true),
  security_score: T('read', true),
  list_memories: T('read', true),
  search_memory: T('read', true),
  memory_stats: T('read', true),
  process_registry: T('read', true),
  // ── file writes (grant: 'write') ──
  write_file: T('local-write', true, { how: 'a create is undone by deleting the file; an overwrite is a git revert', grant: 'write' }),
  edit_file: T('local-write', true, { how: 'a git revert', grant: 'write' }),
  file_ops: T('local-write', true, { how: 'a git revert', grant: 'write' }),
  blueprint: T('local-write', true, { how: 'a git revert', grant: 'write' }),
  kanban: T('local-write', true, { how: 'a git revert', grant: 'write' }),
  document: T('local-write', true, { how: 'a git revert', grant: 'write' }),
  website: T('local-write', true, { how: 'a git revert', grant: 'write' }),
  // ── local state / machine changes ──
  run_terminal: T('local-state', true, { grant: 'terminal' }),
  terminal: T('local-state', true, { grant: 'terminal' }),
  run_cli: T('local-state', true, { grant: 'terminal' }),
  code_execution: T('local-state', true, { grant: 'terminal' }),
  docker: T('local-state', true, { grant: 'terminal' }),
  // ── off-machine / metered (a grant is possible, but NEVER assumed) ──
  publish: T('external', false, {
    grant: 'external',
    requires: { credentials: [{ anyOf: ['NPM_TOKEN', 'GITHUB_TOKEN'], note: 'an npm automation token, or a GitHub token for a GitHub release' }] },
  }),
  git: T('external', false, { grant: 'external', how: 'a local commit is reversible; a push is only as reversible as the remote' }),
  clone_repo: T('external', true, { how: 'delete the cloned directory', grant: 'external' }),
  gateway_send: T('external', false, { grant: 'external' }),
  send_message: T('external', false, { grant: 'external' }),
  messaging: T('external', false, { grant: 'external' }),
  discord: T('external', false, { grant: 'external' }),
  feishu_doc: T('external', false, { grant: 'external' }),
  feishu_drive: T('external', false, { grant: 'external' }),
  microsoft_graph: T('external', false, { grant: 'external' }),
  homeassistant: T('external', false, { grant: 'external' }),
  generate_image: T('external', false, { grant: 'external' }),
  describe_image: T('external', false, { grant: 'external' }),
  video_generate: T('external', false, { grant: 'external' }),
  vision: T('external', false, { grant: 'external' }),
  image_source: T('external', false, { grant: 'external' }),
  speak: T('external', false, { grant: 'external' }),
  transcribe: T('external', false, { grant: 'external' }),
  tts_streaming: T('external', false, { grant: 'external' }),
  neutts_synth: T('external', false, { grant: 'external' }),
  browser: T('external', false, { grant: 'external' }),
  camofox: T('external', false, { grant: 'external' }),
  browser_dialog: T('external', false, { grant: 'external' }),
  browser_supervisor: T('external', false, { grant: 'external' }),
  computer_use: T('external', false, { grant: 'external' }),
  mcp_tool: T('external', false, { grant: 'external' }),
  openrouter_client: T('external', true, { grant: 'external' }),
};

/** Unknown tools: treat as a local-state change that NO grant may cover. */
const DEFAULT_EFFECT: EffectInfo = T('local-state', true);

/**
 * The effect class of a registry tool by NAME only — the cheap path.
 *
 * WHY THIS EXISTS SEPARATELY. The tool loop asks this on every call in a step to
 * decide whether siblings may run concurrently, so it must not build a full
 * descriptor (description parsing, tags, requirement objects) per call. It is the
 * same lookup `capabilityFromTool` performs, minus the parts the caller does not
 * need — one map, one conservative default, no second opinion.
 */
export function effectClassOfTool(name: string): EffectClass {
  return (EFFECT_BY_TOOL[name] ?? DEFAULT_EFFECT).effect;
}

/** Short, human summary of a requirement set — rendered FROM the checked form. */
export function describeRequires(requires: CapabilityRequires): string {
  const anyOf = (needs: Array<{ anyOf: string[] }>): string =>
    needs.map((n) => n.anyOf.join(' or ')).join(', ');
  const parts: string[] = [];
  if (requires.credentials?.length) parts.push(`needs ${anyOf(requires.credentials)}`);
  if (requires.binaries?.length) parts.push(`runs ${anyOf(requires.binaries)}`);
  if (requires.inputs?.length) parts.push(`ask for ${requires.inputs.join(', ')}`);
  return parts.join('; ');
}

/** Turn one registry tool into a capability. */
export function capabilityFromTool(tool: ToolLike): Capability {
  const info = EFFECT_BY_TOOL[tool.name] ?? DEFAULT_EFFECT;
  const firstSentence = String(tool.description ?? '').split(/(?<=\.)\s/)[0]?.trim() ?? '';
  return {
    id: `tool:${tool.name}`,
    kind: 'tool',
    ref: tool.name,
    name: tool.name,
    oneLiner: firstSentence || `The ${tool.name} tool.`,
    effectClass: info.effect,
    reversible: info.reversible,
    ...(info.how ? { reversibleHow: info.how } : {}),
    ...(info.grant ? { grantCategory: info.grant } : {}),
    requires: info.requires ?? {},
    tags: [tool.name.replace(/_/g, ' '), ...(tool.category ? [tool.category] : [])],
  };
}

/** Turn a skill (hub catalog or compiled) into a capability. */
export function capabilityFromSkill(skill: { id?: string; name: string; description?: string; tags?: string[] }): Capability {
  const id = skill.id || skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    id: `skill:${id}`,
    kind: 'skill',
    ref: id,
    name: skill.name,
    oneLiner: String(skill.description ?? '').split(/(?<=\.)\s/)[0]?.trim() || `The ${skill.name} skill.`,
    // A skill is METHODOLOGY: loading it changes nothing until its steps run, and
    // those steps carry their own effect classes. So the envelope is local-state,
    // and NO grant category is claimed — loading a skill is not gated, so there is
    // nothing a grant could cover (the steps it leads to declare their own).
    effectClass: 'local-state',
    reversible: true,
    requires: {},
    tags: [skill.name, ...(skill.tags ?? [])],
  };
}

/**
 * Turn an EXTERNAL MCP tool into a capability.
 *
 * This is the "borrow capability from outside" path: the agent's reach grows by
 * ingesting what a foreign server already declares, with nothing hand-written
 * here. The effect class comes from the MCP spec's own `ToolAnnotations` —
 * `readOnlyHint` and `destructiveHint` — NOT from matching words in a
 * description. The required inputs come from the tool's JSON Schema.
 *
 * When a server declares NOTHING, the capability is `external` and not
 * reversible: a foreign tool is off-machine by construction, so the honest
 * reading of silence is "off-machine, effect unknown" — it asks, and only an
 * explicit off-machine session grant can unlock it. Erring the other way would
 * let an undeclared foreign tool run silently, which is the one outcome the whole
 * layer exists to prevent.
 *
 * HONEST LIMIT: `readOnlyHint` is the spec's description of itself as "a hint,
 * not a guarantee". These tests prove we READ the declaration, not that the
 * declaration is true.
 */
export function capabilityFromMcpTool(t: McpToolLike): Capability {
  const ann = t.annotations ?? {};
  const inputs = requiredInputs(t.inputSchema);

  let effectClass: EffectClass;
  let reversible: boolean;
  let grantCategory: GrantCategory | undefined;
  if (ann.readOnlyHint === true) {
    // The server declares it changes nothing — nothing to gate.
    effectClass = 'read';
    reversible = true;
  } else if (ann.destructiveHint === true) {
    // Destructive is never grantable, exactly like the DENY floor.
    effectClass = 'destructive';
    reversible = false;
  } else {
    effectClass = 'external';
    reversible = false;
    grantCategory = 'external';
  }

  const name = t.annotations?.title || t.name;
  return {
    id: `mcp:${t.server}:${t.name}`,
    kind: 'mcp',
    ref: `${t.server}/${t.name}`,
    name,
    oneLiner: String(t.description ?? '').split(/(?<=\.)\s/)[0]?.trim() || `The ${t.name} tool on the ${t.server} MCP server.`,
    effectClass,
    reversible,
    ...(grantCategory ? { grantCategory } : {}),
    // Reached through the dispatcher — `ref` is not itself a callable tool name,
    // so a hit must say how to reach it instead of handing over a name it cannot
    // call. These arguments mirror `mcp_tool`'s real schema.
    invoke: { tool: 'mcp_tool', args: { action: 'call', server: t.server, tool: t.name } },
    requires: inputs.length > 0 ? { inputs } : {},
    tags: [t.name.replace(/_/g, ' '), t.server, 'mcp'],
  };
}

/**
 * The high-level ACTIONS the user named — the verbs that today exist only as
 * scattered prose across tool descriptions and the consent picture. Each declares
 * what it needs and what it touches, so the model can discover it and (Phase 2)
 * the gate can read it instead of parsing the request.
 */
export function actionCapabilities(): Capability[] {
  const A = (
    key: string,
    name: string,
    oneLiner: string,
    effectClass: EffectClass,
    reversible: boolean,
    requires: CapabilityRequires,
    tags: string[],
    how?: string,
    platforms?: Capability['platforms'],
  ): Capability => ({
    id: `action:${key}`,
    kind: 'action',
    ref: key,
    name,
    oneLiner,
    effectClass,
    reversible,
    ...(how ? { reversibleHow: how } : {}),
    ...(effectClass === 'external' ? { grantCategory: 'external' as GrantCategory } : effectClass === 'read' ? {} : { grantCategory: 'terminal' as GrantCategory }),
    requires,
    tags,
    ...(platforms ? { platforms } : {}),
  });

  return [
    A(
      'install-package',
      'Install a project dependency',
      'Install the packages a project already declares (npm/pnpm/yarn/bun install) into the workspace.',
      'local-state',
      true,
      { binaries: [{ anyOf: ['npm', 'pnpm', 'yarn', 'bun'] }] },
      ['install', 'dependency', 'package', 'npm', 'node'],
      'removing node_modules or a git checkout',
    ),
    A(
      'add-dependency',
      'Add a NEW dependency',
      'Declare and install a package the manifest does not yet list — a new choice, so the user owns it.',
      'external',
      true,
      { binaries: [{ anyOf: ['npm', 'pnpm', 'yarn', 'bun'] }], inputs: ['which package'] },
      ['add', 'dependency', 'install', 'package', 'library'],
      'uninstall it and revert the manifest',
    ),
    A(
      'install-system-tool',
      'Install a system tool',
      'Install a binary or toolchain for the machine (winget/brew/apt/choco/scoop, or npm -g).',
      'external',
      false,
      { binaries: [{ anyOf: ['winget', 'brew', 'apt', 'choco', 'scoop', 'npm'] }], inputs: ['which tool'] },
      ['install', 'tool', 'toolchain', 'winget', 'brew', 'apt', 'global'],
      undefined,
      // GENUINELY OS-determined: there is no portable install command. Every
      // `binary` here is one the requirement list above also declares, so the
      // pre-flight that says "winget is present" is the same fact this hint uses.
      {
        win32: { command: 'winget install <tool>', binary: 'winget', note: 'or `choco install <tool>` / `scoop install <tool>` if those are installed instead' },
        darwin: { command: 'brew install <tool>', binary: 'brew' },
        linux: { command: 'apt-get install -y <tool>', binary: 'apt', note: 'needs root — run it through sudo yourself, or the agent will report the privilege failure' },
      },
    ),
    A(
      'uninstall-package',
      'Uninstall a package or tool',
      'Remove an installed package or tool, locally or from the machine.',
      'external',
      false,
      { binaries: [{ anyOf: ['npm', 'pnpm', 'yarn'] }, { anyOf: ['winget', 'brew', 'apt'] }], inputs: ['which package'] },
      ['uninstall', 'remove', 'delete', 'package', 'tool'],
    ),
    A(
      'publish-package',
      'Publish a package to a registry',
      'Publish a release to npm/GitHub — off-machine and irreversible.',
      'external',
      false,
      {
        credentials: [{ anyOf: ['NPM_TOKEN', 'GITHUB_TOKEN'], note: 'an npm automation token, or a GitHub token for a GitHub release' }],
        binaries: [{ anyOf: ['npm', 'gh'] }],
        inputs: ['bump type'],
      },
      ['publish', 'release', 'npm', 'registry', 'package', 'ship'],
    ),
    A(
      'publish-website',
      'Publish / deploy a website',
      'Deploy a built site to a host (Cloudflare Pages, Netlify, Vercel, GitHub Pages) — off-machine and public.',
      'external',
      false,
      {
        credentials: [{ anyOf: ['CLOUDFLARE_API_TOKEN', 'NETLIFY_AUTH_TOKEN', 'VERCEL_TOKEN'], note: 'the token for whichever host you deploy to — may also live in the credential vault' }],
        binaries: [{ anyOf: ['wrangler', 'netlify', 'vercel', 'gh'] }],
        inputs: ['which host', 'the domain or project'],
      },
      ['publish', 'website', 'deploy', 'host', 'cloudflare', 'netlify', 'vercel', 'pages'],
    ),
    A(
      'deploy-app',
      'Deploy an application',
      'Deploy an app/server to a host or platform — off-machine and public.',
      'external',
      false,
      {
        credentials: [{ anyOf: ['VERCEL_TOKEN', 'FLY_API_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_ACCESS_KEY_ID', 'AZURE_CLIENT_ID'], note: 'the token for whichever platform you deploy to — a logged-in CLI may already hold it' }],
        binaries: [{ anyOf: ['vercel', 'flyctl', 'gcloud', 'aws', 'az'] }],
        inputs: ['which platform'],
      },
      ['deploy', 'app', 'server', 'host', 'platform', 'ship'],
    ),
    A(
      'push-git',
      'Push to a git remote',
      'Send commits to a remote (GitHub et al.) — off-machine; the request naming it is the authorization.',
      'external',
      true,
      {
        credentials: [{ anyOf: ['GITHUB_TOKEN', 'GH_TOKEN'], note: 'or an SSH key / credential helper the remote already accepts' }],
        binaries: [{ anyOf: ['git'] }],
      },
      ['push', 'git', 'github', 'remote', 'origin', 'commit'],
      'force-push is denied; otherwise the remote keeps history you can revert',
    ),
    A(
      'store-credential',
      'Store a credential',
      'Persist a token (GitHub/npm/host) so later releases work without an environment export.',
      'local-state',
      true,
      { inputs: ['the token'] },
      ['credential', 'token', 'secret', 'store', 'login', 'auth'],
      'forget it with the credentials tool',
      // Also genuinely OS-determined, and for a different reason: the OS decides
      // WHERE a secret can safely live, not which package manager exists.
      {
        win32: { command: 'nuvira credentials set <name> --value <token>', note: 'Windows has no OS keychain the CLI can reach, so this lands in the vault file' },
        darwin: { command: 'nuvira credentials set <name> --value <token>', note: 'stored in the macOS Keychain when one is available' },
        linux: { command: 'nuvira credentials set <name> --value <token>', note: 'stored via secret-tool when available, otherwise the vault file' },
      },
    ),
  ];
}

/**
 * The MCP tools the agent can reach — from servers connected this process, plus
 * cached schemas from previous ones. Never connects, so a capability search
 * cannot spawn a server as a side effect; a failure to read them never breaks
 * discovery.
 */
async function readDiscoverableMcpTools(): Promise<McpToolLike[]> {
  try {
    const { readDiscoverableMcpTools: read } = await import('../mcp/mcp-discovery.js');
    return (await read()) as McpToolLike[];
  } catch {
    return [];
  }
}

/**
 * The capability index, best-effort. Skills come from the installed hub catalog;
 * a catalog read failure simply omits them, it never breaks discovery. MCP tools
 * come from servers already connected this process, and may be injected instead
 * (which is what makes the ingestion testable without a live server).
 */
export async function capabilityIndex(
  tools: ToolLike[],
  opts: { includeSkills?: boolean; includeMcp?: boolean; mcpTools?: McpToolLike[] } = {},
): Promise<Capability[]> {
  const index: Capability[] = [
    ...tools.map(capabilityFromTool),
    ...actionCapabilities(),
    // The host itself is a discoverable capability: OS / arch / shell / which
    // package managers are installed. Detected once per run (memoized), so this
    // costs nothing after the first index build and cannot disagree with the
    // facts the system prompt carries.
    machineFactsCapability(),
  ];
  if (opts.includeMcp !== false) {
    const mcp = opts.mcpTools ?? (await readDiscoverableMcpTools());
    for (const t of mcp) {
      if (t && t.server && t.name) index.push(capabilityFromMcpTool(t));
    }
  }
  if (opts.includeSkills !== false) {
    try {
      const { readHubCatalog } = await import('../learning/hub-skill-catalog.js');
      const skills = readHubCatalog() as Array<{ id?: string; name?: string; description?: string; tags?: string[] }>;
      for (const s of skills) {
        if (s && s.name) index.push(capabilityFromSkill({ id: s.id, name: s.name, description: s.description, tags: s.tags }));
      }
    } catch {
      // Best-effort — no skill catalog means tool + action capabilities only.
    }
  }
  return index;
}

/** Tokenize a query/text into lowercased significant tokens (length ≥ 3). */
function tokens(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Rank capabilities against a free-text query. Lexical + weighted by field, with
 * a substring fallback so "publish" matches "publishing" in a description. This
 * is DISCOVERY — it surfaces candidates for the model to choose from; it never
 * decides what runs.
 */
export function searchCapabilities(index: Capability[], query: string, limit = 10): CapabilityHit[] {
  const q = tokens(query);
  const qLower = String(query ?? '').toLowerCase().trim();
  const hits: CapabilityHit[] = [];

  for (const cap of index) {
    const nameTokens = tokens(cap.name.replace(/_/g, ' '));
    const tagTokens = cap.tags.flatMap(tokens);
    const refTokens = tokens(cap.ref.replace(/[_:]/g, ' '));
    const oneTokens = tokens(cap.oneLiner);
    const matched = new Set<string>();
    let score = 0;

    for (const t of q) {
      if (nameTokens.includes(t)) { score += 4; matched.add(t); }
      if (refTokens.includes(t)) { score += 3; matched.add(t); }
      if (tagTokens.includes(t)) { score += 2; matched.add(t); }
      if (oneTokens.includes(t)) { score += 1; matched.add(t); }
    }
    // Substring fallback (a single query term inside a longer word).
    if (score === 0 && qLower.length >= 3) {
      const hay = `${cap.name} ${cap.oneLiner} ${cap.tags.join(' ')} ${cap.ref}`.toLowerCase();
      if (hay.includes(qLower)) { score += 1; matched.add(qLower); }
    }
    if (score > 0) hits.push({ capability: cap, score, matched: [...matched].sort() });
  }

  return hits.sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id)).slice(0, Math.max(1, limit));
}
