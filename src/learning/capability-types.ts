/**
 * Capability types — ONE descriptor for everything the agent can DO.
 *
 * WHY THIS EXISTS. "What an action needs, what it costs, and what it touches"
 * was scattered: tools carried it in prose descriptions, each gate hardcoded its
 * own effect class, skills carried only methodology, and the CLI manifest carried
 * a single boolean. Adding a verb (install / uninstall / publish / deploy / push)
 * meant editing all of them. The capability descriptor is the ONE shape those
 * sources are normalized into, so discovery, gating, the consent picture and the
 * refusal wording all read from one place and cannot drift.
 *
 * A capability is the ENVELOPE (`kind`, `ref`, `requires`, `effectClass`,
 * `reversible`); a SKILL is one implementation of it (`kind: 'skill'`) alongside
 * a TOOL (`kind: 'tool'`) and a curated high-level ACTION (`kind: 'action'`).
 *
 * These are pure types — no imports, no side effects — so both the tool side and
 * the learning side can depend on them without a cycle.
 */

/** What an action does to the world. The gate's source of truth (Phase 2). */
export type EffectClass = 'read' | 'local-write' | 'local-state' | 'external' | 'destructive';

/** Which session grant may cover the action (see `session-grant.ts`). */
export type GrantCategory = 'write' | 'terminal' | 'external';

/**
 * ONE requirement, in a shape that can be both SHOWN and CHECKED.
 *
 * The alternative — a human phrase like `'NPM_TOKEN or a GitHub token'` — can be
 * displayed but never probed, so the agent could only discover it was missing by
 * failing halfway through. `anyOf` is machine-checkable (an env var NAMES list
 * for a credential, an executable list for a binary) and `join(' or ')` renders
 * the same sentence a reader used to see. One source, so the displayed and the
 * checked forms cannot drift.
 */
export interface CapabilityNeed {
  /** Satisfied when ANY of these is present. */
  anyOf: string[];
  /** How to satisfy it — shown when it is missing. */
  note?: string;
}

/** What has to exist before the capability can run. */
export interface CapabilityRequires {
  /** Env var names; satisfied when any one is set and non-empty. */
  credentials?: CapabilityNeed[];
  /** Executables; satisfied when any one resolves on PATH. */
  binaries?: CapabilityNeed[];
  /**
   * Things only the MODEL can supply (a bump type, a target host) — a decision,
   * not an environment fact, so never probed.
   */
  inputs?: string[];
}

/**
 * How to satisfy a capability on ONE operating system.
 *
 * WHY THIS IS NOT ON EVERY CAPABILITY. The OS determines the command for some
 * verbs and not others, and saying otherwise would be inventing a mapping that
 * does not exist:
 *
 *   - `install-system-tool` IS OS-determined — winget on Windows, brew on macOS,
 *     apt-get on Linux. There is no portable form.
 *   - `store-credential` IS OS-determined — the OS keychain on macOS/Linux versus
 *     a credentials file on Windows.
 *   - `add-dependency` is NOT — `npm install` is the same command everywhere, and
 *     npm-vs-pnpm is a USER PREFERENCE, not an OS affordance.
 *   - `deploy-app` is NOT — the choice between vercel and flyctl is a platform
 *     choice, not an OS one. (Windows and macOS both deploy to Vercel.)
 *
 * So `platforms` is present exactly where the OS genuinely decides, and ABSENT
 * means "there is one command, or the model/user picks" — which is a different and
 * equally truthful statement.
 */
export interface PlatformCommand {
  /** The command to run on this OS, with the variable part in angle brackets. */
  command: string;
  /**
   * The binary it runs, WHEN an external one does. MUST be a binary this
   * capability also declares it needs — a test asserts it, so a platform hint can
   * never name a tool the requirement pre-flight did not check for.
   *
   * ABSENT means the command runs through nuvira itself, not through a binary on
   * PATH. `store-credential` is the case that forced this: the OS decides WHERE a
   * secret can safely live (Keychain / secret-tool / a vault file), but the command
   * is identical on all three, so claiming a PATH binary would be a false fact.
   */
  binary?: string;
  /** A caveat worth showing (a privilege requirement, or a fallback). */
  note?: string;
}

/** The OSes a `platforms` map may key on. */
export type PlatformKey = 'win32' | 'darwin' | 'linux';

/**
 * How to actually invoke a capability whose `ref` is NOT a callable tool name.
 * An ingested MCP tool, for instance, is invoked through the `mcp_tool`
 * dispatcher with the server and tool it names, so a discovery hit must say so
 * rather than hand the model a name it cannot call.
 */
export interface CapabilityInvoke {
  /** The real tool to call. */
  tool: string;
  /** Fixed arguments that identify the capability (e.g. server + tool). */
  args: Record<string, string>;
}

/** One thing the agent can do, normalized from a tool, a skill, an MCP server, or the catalog. */
export interface Capability {
  /** Stable id (`tool:write_file`, `action:publish-site`, `skill:deploy-vercel`). */
  id: string;
  /**
   * Which registry this came from. `mcp` is a FOREIGN tool, discovered from an
   * external MCP server at runtime — it has no place in this repo's registry, so
   * it carries `invoke` to say how it is reached.
   */
  kind: 'tool' | 'skill' | 'action' | 'mcp';
  /** The thing to invoke: a tool name, a skill id, a curated action key, or `<server>/<tool>`. */
  ref: string;
  /** How to reach it, when `ref` is not itself a callable tool name. */
  invoke?: CapabilityInvoke;
  /** Short human name. */
  name: string;
  /** ONE sentence: what it does. Used for display and refusal wording. */
  oneLiner: string;
  effectClass: EffectClass;
  reversible: boolean;
  /** How to undo it, when it is reversible. */
  reversibleHow?: string;
  /** The session grant that can cover it (absent = no grant covers it). */
  grantCategory?: GrantCategory;
  requires: CapabilityRequires;
  /** Discovery keywords — a hint for search, NEVER a decision rule. */
  tags: string[];
  /**
   * How to do it on each OS — present ONLY where the OS genuinely determines the
   * command (see {@link PlatformCommand}). Absent everywhere else, deliberately.
   */
  platforms?: Partial<Record<PlatformKey, PlatformCommand>>;
}

/**
 * A TOOL's own capability declaration — the fact the descriptor used to hold in
 * one hand-maintained name-keyed map (`EFFECT_BY_TOOL`).
 *
 * WHY IT LIVES ON THE TOOL. The map meant a tool could be born unclassified and
 * its gate could hardcode a different answer than its descriptor; the map was the
 * last place the layer did not let the TOOL own its own facts. The tool declares
 * these at `registerTool`, `registry.ts` records them, and every consumer
 * (fan-out, the write/terminal/external grants, the capability descriptor) reads
 * the same declaration.
 *
 * `reversible` defaults to `true` (matching the old map's every read/write
 * entry), and every field except `effectClass` is optional so a silent tool still
 * declares the one fact that matters.
 */
export interface ToolCapabilityDeclaration {
  /** What the action does to the world — the one REQUIRED fact. */
  effectClass: EffectClass;
  /** Can re-running undo it? Defaults to true; set false for off-machine effects. */
  reversible?: boolean;
  /** How to undo it, when it is reversible. */
  reversibleHow?: string;
  /** The session grant that may cover it (absent = no grant covers it). */
  grantCategory?: GrantCategory;
  /** What has to exist before it can run. */
  requires?: CapabilityRequires;
}

/** A ranked discovery result. */
export interface CapabilityHit {
  capability: Capability;
  score: number;
  /** The tokens that matched — so a reader can see WHY it ranked. */
  matched: string[];
}
