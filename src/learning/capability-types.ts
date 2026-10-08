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

/** What has to exist before the capability can run. */
export interface CapabilityRequires {
  /** Credential names the action needs (e.g. `NPM_TOKEN`, a GitHub token). */
  credentials?: string[];
  /** Executables the action needs on PATH (e.g. `npm`, `winget`, `gh`). */
  binaries?: string[];
  /** Free-form required inputs the model must supply (a bump type, a target). */
  inputs?: string[];
}

/** One thing the agent can do, normalized from a tool, a skill, or the catalog. */
export interface Capability {
  /** Stable id (`tool:write_file`, `action:publish-site`, `skill:deploy-vercel`). */
  id: string;
  /** Which registry this came from. */
  kind: 'tool' | 'skill' | 'action';
  /** The thing to invoke: a tool name, a skill id, or a curated action key. */
  ref: string;
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
}

/** A ranked discovery result. */
export interface CapabilityHit {
  capability: Capability;
  score: number;
  /** The tokens that matched — so a reader can see WHY it ranked. */
  matched: string[];
}
