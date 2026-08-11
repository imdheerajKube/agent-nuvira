/**
 * C3 — Declarative intent→action map.
 *
 * ONE source of truth for "which pipeline runs" for a resolved intent. Every
 * action command (chat, execute, plan, edit) derives its dispatch from this
 * map through the shared `resolveDispatch()` choke point — never a per-command
 * branch — so the STANDING cross-command parity rule is enforced structurally,
 * not by convention.
 *
 * Mirrors the Freebuff/Hermes methodology (mirrored in C1/C2): the action is a
 * tool descriptor `{ name, description, inputSchema, run }` in the same shape
 * Freebuff's tool definitions and Hermes' `tools/registry.py` entries use, so
 * the orchestrator pipeline is invocable both from the chat loop (Phase E3
 * pipeline-as-tool) and from native tool-calling providers (H1) with zero
 * re-implementation. "Mode" is an internal pipeline pick, never a user menu:
 * `shouldAutoDispatch` is the menu-unreachable gate — when rule/LLM confidence
 * is at or above `RULE_TRUST_THRESHOLD`, no user-facing mode/menu is reached.
 */

import { z, type ZodType } from 'zod';
import type { TaskIntent } from '../learning/auto-router.js';
import { RULE_TRUST_THRESHOLD, type ModeHint, type NluIntent } from './intent.js';
import { timeRangeSchema } from './schema.js';

// ─── Action descriptor ──────────────────────────────────────────────────────

/**
 * A tool descriptor — byte-identical shape to the tool schemas handed to
 * native tool-calling providers (H1) and to the chat loop's tool dispatcher
 * (E3): name, description, input schema, and what runs.
 */
export interface ActionDescriptor {
  /** Tool name — the vocabulary shared with native tool-calling providers. */
  name: string;
  /** Human description (the tool schema description field). */
  description: string;
  /** What executes: the full agent pipeline, a direct chat answer, or a config flow. */
  run: 'pipeline' | 'chat' | 'config';
  /** The pipeline hint (C1 vocabulary) — derived from the intent, never stale. */
  mode: ModeHint;
  /** The router task-intent this action feeds (auto-router TaskIntent vocabulary). */
  taskIntent: TaskIntent;
  /** zod input schema — the same schema handed to tool-calling providers. */
  inputSchema: ZodType;
}

const buildAction: ActionDescriptor = {
  name: 'build',
  description: 'Generate new code, files, projects, plugins or addons through the full agent pipeline',
  run: 'pipeline',
  mode: 'dev',
  taskIntent: 'coding',
  inputSchema: z.object({ goal: z.string() }),
};

const resumeAction: ActionDescriptor = {
  name: 'resume',
  description: 'Resume prior work for this project (recall + pipeline), with an optional temporal anchor',
  run: 'pipeline',
  mode: 'recall',
  taskIntent: 'coding',
  inputSchema: z.object({ query: z.string(), timeRange: timeRangeSchema.optional() }),
};

const repairAction: ActionDescriptor = {
  name: 'repair',
  description: 'Fix a bug, debug a failure, or resolve an error through the agent pipeline',
  run: 'pipeline',
  mode: 'execute',
  taskIntent: 'debugging',
  inputSchema: z.object({ goal: z.string() }),
};

const assessAction: ActionDescriptor = {
  name: 'assess',
  description: 'Answer a question or analyze/explain something — a direct chat response, no file writes',
  run: 'chat',
  mode: 'chat',
  taskIntent: 'unknown',
  inputSchema: z.object({ question: z.string() }),
};

const configureAction: ActionDescriptor = {
  name: 'configure',
  description: 'Set up API keys, switch providers/models, or change configuration',
  run: 'config',
  mode: 'config',
  taskIntent: 'unknown',
  inputSchema: z.object({ request: z.string() }),
};

const askAction: ActionDescriptor = {
  name: 'ask',
  description: 'Ambiguous request — fall back to a chat answer; no pipeline runs on a guess',
  run: 'chat',
  mode: 'chat',
  taskIntent: 'unknown',
  inputSchema: z.object({ question: z.string() }),
};

/** Every intent resolves to exactly one action (the map is total). */
export const ACTION_BY_INTENT: Record<NluIntent, ActionDescriptor> = {
  create: buildAction,
  continue: resumeAction,
  fix: repairAction,
  explain: assessAction,
  configure: configureAction,
  unknown: askAction,
};

// ─── Lookups ────────────────────────────────────────────────────────────────

/** Resolve the action descriptor for an intent. */
export function resolveAction(intent: NluIntent): ActionDescriptor {
  return ACTION_BY_INTENT[intent];
}

/** Map an NLU intent to the router's task-type vocabulary (single choke point). */
export function taskTypeForIntent(intent: NluIntent): TaskIntent {
  return ACTION_BY_INTENT[intent].taskIntent;
}

/**
 * The menu-unreachable gate (C3 acceptance a/c). A request auto-dispatches —
 * with NO user-facing mode/menu — unless it is an ambiguous CREATE below the
 * trust threshold. Non-create intents never show a menu; create keeps the
 * legacy menu ONLY as an ambiguity fallback (the plan's "menu only as
 * LLM-unavailable fallback").
 */
export function shouldAutoDispatch(intent: NluIntent, confidence: number): boolean {
  if (intent !== 'create') return true;
  return confidence >= RULE_TRUST_THRESHOLD;
}

// ─── The shared dispatch choke point ────────────────────────────────────────

/** The dispatch descriptor every action command derives from a parsed request. */
export interface DispatchDescriptor {
  /** The action tool name (e.g. 'build'). */
  action: string;
  /** The pipeline that runs (never null — 'ask' fills unknown). */
  mode: ModeHint;
  /** Router task-intent seed, present only when confidence ≥ threshold. */
  taskIntentHint?: TaskIntent;
  /** Whether dispatch happens without asking the user (menu-unreachable gate). */
  autoDispatch: boolean;
}

/**
 * THE single function every action command (chat, execute, plan, edit) uses to
 * turn a parsed request into its dispatch — intent resolution, the action map,
 * and the router task-type share one vocabulary by construction. The parity
 * tests assert the five canonical prompts resolve identically through here for
 * every command, which is only possible because they all consume this
 * choke point instead of command-local branching.
 */
export function resolveDispatch(parsed: { intent: NluIntent; confidence: number }): DispatchDescriptor {
  const action = resolveAction(parsed.intent);
  // Only informative intents seed the router: create/fix/continue carry a real
  // task-type bias; explain/configure/unknown map to 'unknown', which would
  // OVERRIDE the router's own text analysis with a meaningless label — omit.
  const informative = action.taskIntent !== 'unknown';
  return {
    action: action.name,
    mode: action.mode,
    taskIntentHint:
      informative && parsed.confidence >= RULE_TRUST_THRESHOLD ? action.taskIntent : undefined,
    autoDispatch: shouldAutoDispatch(parsed.intent, parsed.confidence),
  };
}
