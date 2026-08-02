/**
 * ModuleRegistry — Plugin-based module loading system for the agent execution engine.
 *
 * Replaces the hardcoded `createAgent()` switch statement with a registry that
 * allows modules (agents) to be registered, discovered, and loaded at runtime.
 * Built-in agents are pre-registered; custom agents can be added by plugins
 * or via the SDK's `registerAgent()` function.
 *
 * @see ARCHITECTURE.md §4.1 — Extensibility System
 */
import { Agent } from './agent.js';
import type { EventBus } from '../observability/event-bus.js';
/** Factory function that creates a new Agent instance */
export type AgentFactory = () => Agent;
/** Metadata about a registered module */
export interface ModuleMetadata {
    /** The agent type string used in task plans (e.g. 'planner', 'writer') */
    agentType: string;
    /** Human-readable name of the agent (e.g. 'Planner', 'Writer') */
    name: string;
    /** Short description of what this agent does */
    description: string;
    /** Emoji icon for the spinner / UI display */
    icon: string;
    /** Whether this module is built-in (true) or added by a plugin (false) */
    isBuiltin: boolean;
}
/** Error thrown when a module lookup fails */
export declare class ModuleNotFoundError extends Error {
    constructor(agentType: string);
}
/**
 * ModuleRegistry — Central registry for agent modules.
 *
 * Manages a collection of agent factories with metadata. Supports lookup,
 * listing, and dynamic registration at runtime.
 *
 * @example
 * ```typescript
 * const registry = ModuleRegistry.createWithBuiltins();
 * const planner = registry.getModule('planner'); // → PlannerAgent instance
 * ```
 */
export declare class ModuleRegistry {
    /** Agent factory functions, keyed by agentType */
    private factories;
    /** Module metadata, keyed by agentType */
    private metadata;
    /** The event bus for emitting observability events */
    private eventBus;
    constructor(eventBus?: EventBus);
    /**
     * Register an agent module with the registry.
     *
     * @param agentType - The agent type string used in task plans
     * @param factory   - Factory function that returns a new Agent instance
     * @param meta      - Metadata describing the module
     *
     * @throws {Error} If `agentType` is already registered (use `override` to replace)
     */
    register(agentType: string, factory: AgentFactory, meta: Omit<ModuleMetadata, 'agentType' | 'isBuiltin'> & {
        isBuiltin?: boolean;
    }): void;
    /**
     * Register an agent module, silently replacing any existing registration.
     * Useful for plugin overrides and hot-reload scenarios.
     */
    registerOrOverride(agentType: string, factory: AgentFactory, meta: Omit<ModuleMetadata, 'agentType' | 'isBuiltin'> & {
        isBuiltin?: boolean;
    }): void;
    /**
     * Unregister an agent module.
     * Safe to call for non-existent agent types (no-op).
     */
    unregister(agentType: string): boolean;
    /**
     * Get an Agent instance for the given agent type.
     *
     * @param agentType - The agent type string (e.g. 'planner', 'writer')
     * @returns A new Agent instance
     * @throws {ModuleNotFoundError} If no module is registered for `agentType`
     */
    getModule(agentType: string): Agent;
    /**
     * Check if an agent type is registered.
     */
    hasModule(agentType: string): boolean;
    /**
     * Get metadata for a registered agent type.
     * Returns undefined if the agent type is not registered.
     */
    getMetadata(agentType: string): ModuleMetadata | undefined;
    /**
     * List all registered modules, optionally filtered by a predicate.
     */
    listModules(filter?: (meta: ModuleMetadata) => boolean): ModuleMetadata[];
    /**
     * Get the icon for an agent type, or a default icon if not found.
     */
    getIcon(agentType: string): string;
    /**
     * Get the number of registered modules.
     */
    get size(): number;
    /**
     * Create a ModuleRegistry pre-populated with all built-in agents.
     */
    static createWithBuiltins(eventBus?: EventBus): ModuleRegistry;
}
/**
 * Get or create the global ModuleRegistry singleton.
 *
 * First call creates a registry with all built-in agents pre-registered.
 * Subsequent calls return the same instance.
 * Use `resetModuleRegistry()` to clear and re-initialize (useful in tests).
 */
export declare function getModuleRegistry(): ModuleRegistry;
/**
 * Reset the global module registry.
 * Primarily useful in tests to get a clean slate.
 */
export declare function resetModuleRegistry(): void;
/**
 * Set the global module registry (for dependency injection in tests).
 * Returns the previous registry instance (or null).
 */
export declare function setModuleRegistry(registry: ModuleRegistry): ModuleRegistry | null;
//# sourceMappingURL=module-registry.d.ts.map