/**
 * WS0 (#22) — the surface registry.
 *
 * WHY THIS FILE EXISTS. Before a capability can be promised on "every surface"
 * (WS1-WS7), the set of surfaces has to be DECLARED. Inferred from whatever
 * happens to import what, it is invisible: nothing fails when a new
 * implementation appears beside the shared one, and nothing fails when a
 * capability lands on one surface and quietly misses three.
 *
 * MEASURED, and the reason this is not paranoia — four ways to run an agent turn
 * already exist over three engine labels:
 *
 *   - `src/cli/chat.ts` runs a turn through its own `answerOnce`
 *     (`cli/chat.ts:502`), which the dashboard drives too
 *     (`web-dashboard/chat-console.ts:391` lazily imports ChatCommand, `:618`
 *     awaits `engine.answerOnce`), and which the gateway chat engine also calls
 *     (`cli/chat.ts:625` — "the chat console and the gateway chat engine both
 *     call answerOnce"). This one IS shared, and it is the model for the rest.
 *   - `src/cli/loop-executor.ts:196` `runLoopExecutor` — the loop engine.
 *   - `src/tools/pipeline-tool.ts:76` `runPipelineTool` — the pipeline engine,
 *     which is the ONLY way the gateway runs a non-chat turn.
 *   - `src/cli/execute.ts` picks between them itself (`:1655` direct, `:1725`
 *     loop, `:2009` pipeline) and reaches the provider factory directly, so its
 *     engine choice and provider construction live in the surface.
 *
 * Also measured: `src/web-dashboard/server.ts` does not import any turn entry —
 * it reaches `answerOnce` indirectly through `chat-console.ts`, which is why
 * `turnEntries` below records what a surface ends up using rather than what it
 * imports literally. `surfacesReaching` (see `parity/graph.ts`) does the
 * transitive check.
 *
 * This module is DATA plus pure lookups on purpose: it is what the parity test
 * and the capability matrix read, so it must be cheap to import from a test and
 * free of side effects.
 */

import type { EngineMode } from '../learning/engine-router.js';

/** The surfaces a person can talk to agent-nuvira through. */
export type SurfaceId =
  | 'cli-chat'
  | 'cli-execute'
  | 'dashboard-chat'
  | 'gateway-chat'
  | 'subagent';

/**
 * The shared turn entries. A surface runs a turn through one of these, or it is
 * a silo — which is exactly what the architecture test in
 * `tests/parity/cross-surface.test.ts` fails on.
 */
export type TurnEntryId =
  | 'chat-once'
  | 'loop-executor'
  | 'pipeline-tool'
  | 'orchestrator'
  | 'child-runtime';

export interface TurnEntry {
  id: TurnEntryId;
  /** Repo-relative module that exports the entry. */
  module: string;
  /** The exported symbol a surface calls. */
  symbol: string;
  /** Engines this entry can serve. */
  engines: readonly EngineMode[];
  note: string;
}

export interface SurfaceDescriptor {
  id: SurfaceId;
  label: string;
  /**
   * Repo-relative modules that OWN the surface (the thing a person addresses).
   * Paths, not globs: the registry is meant to be read.
   */
  modules: readonly string[];
  /** Shared turn entries this surface uses, transitively. */
  turnEntries: readonly TurnEntryId[];
  /**
   * Engine labels observable through this surface. More than one entry means
   * the surface chooses, and a parity test must exercise each.
   */
  engines: readonly EngineMode[];
  /**
   * True when the surface runs in its own process. Such a surface legitimately
   * builds its own provider and loop (that IS the isolation), so the
   * in-process rules below do not apply to it — but its observable behaviour
   * still must match, which is what the normalised observation checks.
   */
  separateProcess?: boolean;
  /** How a parity test drives this surface headlessly. */
  headless: string;
}

/**
 * The shared entries. `engines` is what the entry can serve, not what every
 * caller uses: the gateway only ever asks `pipeline-tool` for pipeline work.
 */
export const TURN_ENTRIES: Record<TurnEntryId, TurnEntry> = {
  'chat-once': {
    id: 'chat-once',
    module: 'src/cli/chat.ts',
    symbol: 'ChatCommand.answerOnce',
    engines: ['loop'],
    note: 'The interactive engine. Shared by the CLI chat, the dashboard console and the gateway chat path — the only entry that is genuinely cross-surface today, and therefore the template for the others.',
  },
  'loop-executor': {
    id: 'loop-executor',
    module: 'src/cli/loop-executor.ts',
    symbol: 'runLoopExecutor',
    engines: ['loop'],
    note: 'The loop engine as a library. Written to give `nuvira execute` the exposure the chat path already had, so it is the intended replacement for the surface-level branch in execute.ts.',
  },
  'pipeline-tool': {
    id: 'pipeline-tool',
    module: 'src/tools/pipeline-tool.ts',
    symbol: 'runPipelineTool',
    engines: ['pipeline'],
    note: 'The pipeline engine, reached through the orchestrator. The gateway runs every non-chat turn through this, which is why the gateway is pipeline-only.',
  },
  orchestrator: {
    id: 'orchestrator',
    module: 'src/agents/orchestrator.ts',
    symbol: 'Orchestrator',
    engines: ['pipeline'],
    note: 'The pipeline engine core, owned by the `pipeline-tool` wrapper. A surface that reaches it DIRECTLY is driving pipeline turns itself — legitimate, but it bypasses the wrapper`s provider resolution, understand-card and checkpoint default, which is what SURFACE_DEBT used to record for `cli/execute.ts`. No surface does today; the entry stays declared because the wrapper itself is one, and the rule needs something to measure against.',
  },
  'child-runtime': {
    id: 'child-runtime',
    module: 'src/tools/child-agent-runtime.ts',
    symbol: 'runSubagent',
    engines: ['loop'],
    note: 'The subagent child process. It builds its own provider and loop on purpose: it is the isolation boundary, and it reports the provider/model/transport it actually used so the parent can attribute the run.',
  },
};

/**
 * Known surface-level debt, keyed by what is wrong and why it is still here.
 *
 * This is a RATCHET, not an allowlist of convenience: the architecture test
 * asserts the observed violations EQUAL this list, so adding a new bypass fails,
 * and removing one without deleting its entry fails too (a stale entry would
 * otherwise hide the next one). Every entry is somebody's workstream.
 *
 * BOTH ARE EMPTY NOW. `src/cli/execute.ts` was the whole list: it built its own
 * provider and drove the pipeline engine through a private `Orchestrator`. It
 * now resolves through the shared `resolveProvider` and runs pipeline turns
 * through `runPipelineTool`. The keys stay declared with empty arrays on
 * purpose — deleting a key would stop the rule from being measured at all, and
 * the next bypass would then be invisible instead of a one-line diff here.
 */
export const SURFACE_DEBT: Record<string, readonly string[]> = {
  /** Surface modules that construct their own provider instead of going through a shared entry. */
  'provider-factory': [],
  /** Surface modules that drive the pipeline engine without the `pipeline-tool` wrapper. */
  'pipeline-wrapper-bypass': [],
};

/**
 * Every surface, with the evidence that it exists. Order is display order only.
 */
export const SURFACES: readonly SurfaceDescriptor[] = [
  {
    id: 'cli-chat',
    label: 'CLI chat',
    modules: ['src/cli/chat.ts', 'src/cli/cli-program.ts'],
    // Two entries, not one: measured, `chat.ts:87` imports `runPipelineTool` and
    // calls it at `:702`, so the chat surface can also run a pipeline turn. The
    // engine is chosen by the user's explicit command (`:298` checks
    // `action.run === 'pipeline'`), NOT by the router — which is why this
    // surface declares both engines and the parity matrix exercises both.
    turnEntries: ['chat-once', 'pipeline-tool'],
    engines: ['loop', 'pipeline'],
    headless: 'Drive ChatCommand.answerOnce with a stub provider and an in-memory askUser responder (the shape chat-console.ts already uses); drive the pipeline path through the same runPipelineTool wrapper.',
  },
  {
    id: 'cli-execute',
    label: 'CLI execute / one-shot',
    modules: ['src/cli/execute.ts', 'src/cli/run.ts'],
    // `pipeline-tool` IS here now: measured, `execute.ts` drives its pipeline
    // runs through the wrapper. It used to import the Orchestrator directly and
    // never reach the wrapper — exactly the drift this registry exists to
    // surface, and the reason it was the sole entry on
    // `SURFACE_DEBT['pipeline-wrapper-bypass']`.
    // `chat-once` is here for the same measured reason as ever: execute.ts
    // reaches the chat engine through `import('./chat.js')`, which is also how
    // its interactive mode works.
    turnEntries: ['chat-once', 'loop-executor', 'pipeline-tool'],
    engines: ['loop', 'pipeline'],
    headless: 'Drive the command`s own single-goal path (`runSingleGoal`) with the provider stubbed at the shared factory and the engine pinned to loop, and read the turn AND its attribution (provider/model/transport) and its per-call tool outcomes off what the command returns. Both of the command`s arms report now — the loop engine through `runLoopExecutor` and the direct chat answer through the engine`s `onToolCall`.',
  },
  {
    id: 'dashboard-chat',
    label: 'Dashboard chat',
    modules: ['src/web-dashboard/server.ts', 'src/web-dashboard/chat-console.ts'],
    turnEntries: ['chat-once'],
    engines: ['loop'],
    headless: 'Call the turn through chat-console with a stub provider and no HTTP transport; the console is the seam, not the server.',
  },
  {
    id: 'gateway-chat',
    label: 'Gateway (Slack / Discord / Telegram / …)',
    modules: [
      'src/gateway/registry.ts',
      'src/gateway/adapters.ts',
      'src/gateway/realtime.ts',
    ],
    turnEntries: ['chat-once', 'pipeline-tool'],
    engines: ['loop', 'pipeline'],
    headless: 'Invoke the registry handler with a synthetic inbound message and a stub adapter; no live transport, no credentials.',
  },
  {
    id: 'subagent',
    label: 'Subagent child process',
    modules: ['src/tools/child-agent-runtime.ts', 'src/tools/child-agent-entry.ts'],
    turnEntries: ['child-runtime'],
    engines: ['loop'],
    separateProcess: true,
    headless: 'Spawn the child entry with a stub provider over its IPC frames, as tests/tools/subagent-end-to-end.test.ts does.',
  },
];

/** A surface by id, or undefined. */
export function surfaceById(id: SurfaceId): SurfaceDescriptor | undefined {
  return SURFACES.find((s) => s.id === id);
}

/** Every surface that runs a turn through `entry`, directly or transitively. */
export function surfacesReaching(entry: TurnEntryId): SurfaceDescriptor[] {
  return SURFACES.filter((s) => s.turnEntries.includes(entry));
}

/**
 * Every (surface, engine) pair a parity test must exercise. A surface that can
 * select between engines contributes one pair per engine, so a capability that
 * works under `loop` and fails under `pipeline` cannot pass unnoticed.
 */
export function parityMatrix(): Array<{ surface: SurfaceId; engine: EngineMode }> {
  const pairs: Array<{ surface: SurfaceId; engine: EngineMode }> = [];
  for (const surface of SURFACES) {
    for (const engine of surface.engines) pairs.push({ surface: surface.id, engine });
  }
  return pairs;
}

/** Repo-relative paths of the surface-owned modules. */
export function surfaceModulePaths(): string[] {
  return [...new Set(SURFACES.flatMap((s) => s.modules))].sort();
}

/** Repo-relative paths of the shared turn entries. */
export function turnEntryModulePaths(): string[] {
  return Object.values(TURN_ENTRIES).map((e) => e.module).sort();
}
