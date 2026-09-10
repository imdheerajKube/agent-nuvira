/**
 * C3 — Declarative intent→action map.
 *
 * ONE source of truth for "which pipeline runs" for a resolved intent. Every
 * action command (chat, execute, plan, edit) derives its dispatch from this
 * map through the shared `resolveDispatch()` choke point — never a per-command
 * branch — so the STANDING cross-command parity rule is enforced structurally,
 * not by convention.
 *
 * The action is a
 * tool descriptor `{ name, description, inputSchema, run }` in the same shape
 * Tool definitions and `tools/registry.py` entries use, so
 * the orchestrator pipeline is invocable both from the chat loop (Phase E3
 * pipeline-as-tool) and from native tool-calling providers (H1) with zero
 * re-implementation. "Mode" is an internal pipeline pick, never a user menu:
 * `shouldAutoDispatch` is the menu-unreachable gate — when rule/LLM confidence
 * is at or above `RULE_TRUST_THRESHOLD`, no user-facing mode/menu is reached.
 */
import { type ZodType } from 'zod';
import type { TaskIntent } from '../learning/auto-router.js';
import { type ModeHint, type NluIntent } from './intent.js';
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
/** Every intent resolves to exactly one action (the map is total). */
export declare const ACTION_BY_INTENT: Record<NluIntent, ActionDescriptor>;
/** Resolve the action descriptor for an intent. */
export declare function resolveAction(intent: NluIntent): ActionDescriptor;
/** Map an NLU intent to the router's task-type vocabulary (single choke point). */
export declare function taskTypeForIntent(intent: NluIntent): TaskIntent;
/**
 * The menu-unreachable gate (C3 acceptance a/c). A request auto-dispatches —
 * with NO user-facing mode/menu — unless it is an ambiguous CREATE below the
 * trust threshold. Non-create intents never show a menu; create keeps the
 * legacy menu ONLY as an ambiguity fallback (the plan's "menu only as
 * LLM-unavailable fallback").
 */
export declare function shouldAutoDispatch(intent: NluIntent, confidence: number): boolean;
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
export declare function resolveDispatch(parsed: {
    intent: NluIntent;
    confidence: number;
}): DispatchDescriptor;
//# sourceMappingURL=actions.d.ts.map