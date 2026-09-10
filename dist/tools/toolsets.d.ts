/**
 * H1b — Toolsets (`src/tools/toolsets.ts`).
 *
 * Capability-gating parity (`toolsets` + `toolset_validation.py`
 * + `web_routers/tools.py:get_toolsets`): the registry's tools are grouped
 * into named toolsets — the "capabilities" a user toggles. Each toolset can
 * be enabled/disabled via config (`tools.toolsets.<name>.enabled` in
 * `~/.nuvira/buffconfig.json`; absent = enabled).
 *
 * Two enforcement points (I1, the capability gate):
 * 1. **Schema gating** — the tool JSON schema handed to native tool-calling
 *    providers is built from ENABLED toolsets only, so the model never sees a
 *    disabled tool (the capability-gating behavior).
 * 2. **Execution gate** — calling a disabled tool returns an explicit error
 *    instead of running it. This is the single runtime-honored enforcement
 *    point: a future dashboard toggle is never cosmetic (same rule as the
 *    skills bridge).
 *
 * The catalog here is the ONLY place tools are assigned to groups; a tool not
 * listed in any toolset is treated as always-enabled (never accidentally
 * filtered) and is surfaced by `validateToolsetCoverage` for the CLI.
 */
import { type Tool, type ToolJsonSchema } from './registry.js';
/** A named group of registry tools — the user-visible "capability". */
export interface ToolsetDef {
    /** Toolset id (config key `tools.toolsets.<name>.enabled`). */
    name: string;
    /** Human label for CLI/dashboard. */
    label: string;
    /** One-line description shown in `nuvira tools toolsets`. */
    description: string;
    /** Registry tool names in this group. */
    tools: string[];
    /** Toolsets with no in-code tools (config-only toolsets). */
    configOnly?: boolean;
    /** True when this toolset gates MCP-server tools (dynamic, no static names). */
    bindsMcpServers?: boolean;
}
/** Per-toolset state read from config (absent entry = enabled). */
export interface ToolsetStateMap {
    [name: string]: {
        enabled?: boolean;
    };
}
/** A ConfigManager-shaped object (real instance or a test stub). */
export interface ConfigManagerLike {
    getAll?(): {
        tools?: {
            toolsets?: ToolsetStateMap;
        };
    };
    save?(config: {
        tools: {
            toolsets: ToolsetStateMap;
        };
    }): void;
}
export declare const TOOLSETS: ToolsetDef[];
/** Find the toolset that owns a tool name (undefined → tool is always-enabled). */
export declare function toolsetForTool(toolName: string): ToolsetDef | undefined;
/**
 * Integrity check over the registry: every registered tool must belong to
 * EXACTLY ONE toolset (no unassigned, no duplicates across groups). Returns
 * the violations so the CLI can surface them instead of silently gating.
 */
export declare function validateToolsetCoverage(registered: string[]): {
    unassigned: string[];
    duplicated: string[];
};
/**
 * Read the toolsets state map. Accepts a real ConfigManager or a stub
 * (`{ getAll() {...} }`); a stub without `getAll` (or any read failure)
 * yields `{}` = all toolsets enabled — the graceful default, so existing
 * callers that pass a bare object never accidentally gate on real config.
 */
export declare function readToolsetsState(cm?: ConfigManagerLike): ToolsetStateMap;
/** Names of toolsets currently disabled (absent entry = enabled). */
export declare function disabledToolsetNames(state?: ToolsetStateMap): string[];
/**
 * Persist a toolset's enabled state. Uses the provided ConfigManager when
 * given (CLI/dashboard pass their own), else constructs a fresh one.
 * Throws for an unknown toolset name (typo-safe for `nuvira tools toolsets`).
 */
export declare function setToolsetEnabled(name: string, enabled: boolean, cm?: ConfigManagerLike): void;
/** Is a registry tool allowed to run? Unknown tools → true (never block). */
export declare function isToolEnabled(toolName: string, cm?: ConfigManagerLike): boolean;
/** Registry tools filtered to ENABLED toolsets. Tools with no toolset pass. */
export declare function effectiveTools(cm?: ConfigManagerLike): Tool[];
/** The JSON schemas handed to native tool-calling providers — gated version. */
export declare function effectiveToolJsonSchemas(cm?: ConfigManagerLike): ToolJsonSchema[];
/**
 * The always-exposed primitive set. Each name MUST exist in the registry
 * (guarded at module load by `validateCoreToolCoverage`). This is the whole
 * loop harness: files, terminal, code execution, web, clarification,
 * plan/todo, skills, delegation, and the discovery tool itself.
 */
export declare const CORE_TOOL_NAMES: readonly string[];
/**
 * Integrity guard: a core name that is not registered (typo / rename) must
 * fail LOUDLY at import time, not silently shrink the loop's toolset.
 * Returns the missing names (empty = healthy).
 */
export declare function validateCoreToolCoverage(): string[];
/** Is a tool in the always-exposed core set? */
export declare function isCoreTool(toolName: string): boolean;
/**
 * Core-only tool list: registered + core + still respecting ENABLED toolsets
 * (a user who disabled the `media` toolset must never get generate_image
 * back just because tiering changed the schema path — the I1 gate stays
 * the single source of enablement truth).
 */
export declare function coreTools(cm?: ConfigManagerLike): Tool[];
/** Core-only JSON schemas (the tiered hand-off for native tool-calling). */
export declare function coreToolJsonSchemas(cm?: ConfigManagerLike): ToolJsonSchema[];
/**
 * Tiered exposure mode — read from config (`tools.loopExposure`):
 * - 'tiered'  — core schemas on the wire; the rest via `tool_search` load.
 * - 'all'     — the pre-tiering behavior (every enabled toolset's schemas).
 * Default 'all' keeps every existing caller byte-identical until evals
 * (Phase 0) justify flipping the default — the feature ships complete but
 * inert, so nothing can regress silently.
 */
export declare function getLoopExposureMode(cm?: ConfigManagerLike): 'tiered' | 'all';
/** Status of every toolset (CLI + future dashboard): enabled, label, tools. */
export declare function getToolsetStatus(cm?: ConfigManagerLike): Array<{
    name: string;
    label: string;
    description: string;
    enabled: boolean;
    tools: string[];
    toolCount: number;
}>;
/** Filter a tool list by an explicit set of disabled toolset names. */
export declare function filterToolsByToolsets(tools: Tool[], disabled: string[]): Tool[];
//# sourceMappingURL=toolsets.d.ts.map