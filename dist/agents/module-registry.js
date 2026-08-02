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
import { PlannerAgent } from './agents/planner.js';
import { ContextGathererAgent } from './agents/context-gatherer.js';
import { WriterAgent } from './agents/writer.js';
import { ReviewerAgent } from './agents/reviewer.js';
import { RunnerAgent } from './agents/runner.js';
import { TesterAgent } from './agents/tester.js';
import { DebuggerAgent } from './agents/debugger.js';
import { GitAgent } from './agents/git-agent.js';
import { GitLabAgent } from './agents/gitlab-agent.js';
import { PackageAgent } from './agents/package-agent.js';
import { GitHubReleaseAgent } from './agents/github-release-agent.js';
import { SecurityAgent } from './agents/security-agent.js';
import { SkillRunnerAgent } from './agents/skill-runner.js';
import { MCPAgent } from './agents/mcp-agent.js';
import { PRReviewAgent } from './agents/pr-review-agent.js';
import { IssueTriageAgent } from './agents/issue-triage-agent.js';
import { BranchAutomationAgent } from './agents/branch-automation-agent.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
/** Error thrown when a module lookup fails */
export class ModuleNotFoundError extends Error {
    constructor(agentType) {
        super(`No module registered for agent type: '${agentType}'`);
        this.name = 'ModuleNotFoundError';
    }
}
// ─── Registry Class ─────────────────────────────────────────────────────────
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
export class ModuleRegistry {
    /** Agent factory functions, keyed by agentType */
    factories = new Map();
    /** Module metadata, keyed by agentType */
    metadata = new Map();
    /** The event bus for emitting observability events */
    eventBus;
    constructor(eventBus) {
        this.eventBus = eventBus ?? getEventBus();
    }
    // ── Registration ─────────────────────────────────────────────────────
    /**
     * Register an agent module with the registry.
     *
     * @param agentType - The agent type string used in task plans
     * @param factory   - Factory function that returns a new Agent instance
     * @param meta      - Metadata describing the module
     *
     * @throws {Error} If `agentType` is already registered (use `override` to replace)
     */
    register(agentType, factory, meta) {
        if (this.factories.has(agentType)) {
            throw new Error(`Agent type '${agentType}' is already registered. Use unregister() first to replace.`);
        }
        this.factories.set(agentType, factory);
        this.metadata.set(agentType, {
            agentType,
            name: meta.name,
            description: meta.description,
            icon: meta.icon,
            isBuiltin: meta.isBuiltin ?? false,
        });
        this.eventBus.emit(EventNames.REGISTRY_MODULE_REGISTERED, {
            agentType,
            name: meta.name,
            isBuiltin: meta.isBuiltin ?? false,
        }, 'module-registry');
    }
    /**
     * Register an agent module, silently replacing any existing registration.
     * Useful for plugin overrides and hot-reload scenarios.
     */
    registerOrOverride(agentType, factory, meta) {
        this.factories.set(agentType, factory);
        this.metadata.set(agentType, {
            agentType,
            name: meta.name,
            description: meta.description,
            icon: meta.icon,
            isBuiltin: meta.isBuiltin ?? false,
        });
        this.eventBus.emit(EventNames.REGISTRY_MODULE_REGISTERED, {
            agentType,
            name: meta.name,
            isBuiltin: meta.isBuiltin ?? false,
        }, 'module-registry');
    }
    /**
     * Unregister an agent module.
     * Safe to call for non-existent agent types (no-op).
     */
    unregister(agentType) {
        const hadFactory = this.factories.delete(agentType);
        this.metadata.delete(agentType);
        if (hadFactory) {
            this.eventBus.emit(EventNames.REGISTRY_MODULE_UNREGISTERED, {
                agentType,
            }, 'module-registry');
        }
        return hadFactory;
    }
    // ── Lookup ───────────────────────────────────────────────────────────
    /**
     * Get an Agent instance for the given agent type.
     *
     * @param agentType - The agent type string (e.g. 'planner', 'writer')
     * @returns A new Agent instance
     * @throws {ModuleNotFoundError} If no module is registered for `agentType`
     */
    getModule(agentType) {
        const factory = this.factories.get(agentType);
        if (!factory) {
            throw new ModuleNotFoundError(agentType);
        }
        return factory();
    }
    /**
     * Check if an agent type is registered.
     */
    hasModule(agentType) {
        return this.factories.has(agentType);
    }
    /**
     * Get metadata for a registered agent type.
     * Returns undefined if the agent type is not registered.
     */
    getMetadata(agentType) {
        return this.metadata.get(agentType);
    }
    /**
     * List all registered modules, optionally filtered by a predicate.
     */
    listModules(filter) {
        const all = Array.from(this.metadata.values());
        return filter ? all.filter(filter) : all;
    }
    /**
     * Get the icon for an agent type, or a default icon if not found.
     */
    getIcon(agentType) {
        return this.metadata.get(agentType)?.icon ?? '⚙️';
    }
    /**
     * Get the number of registered modules.
     */
    get size() {
        return this.factories.size;
    }
    // ── Factory methods ──────────────────────────────────────────────────
    /**
     * Create a ModuleRegistry pre-populated with all built-in agents.
     */
    static createWithBuiltins(eventBus) {
        const registry = new ModuleRegistry(eventBus);
        // Each registration includes: agentType, factory, and metadata
        registry.register('planner', () => new PlannerAgent(), {
            name: 'Planner',
            description: 'Analyzes user goals and creates detailed execution plans',
            icon: '📋',
            isBuiltin: true,
        });
        registry.register('context-gatherer', () => new ContextGathererAgent(), {
            name: 'Context Gatherer',
            description: 'Scans the codebase and identifies relevant files',
            icon: '📂',
            isBuiltin: true,
        });
        registry.register('writer', () => new WriterAgent(), {
            name: 'Writer',
            description: 'Generates code changes based on the plan and context',
            icon: '✏️',
            isBuiltin: true,
        });
        registry.register('reviewer', () => new ReviewerAgent(), {
            name: 'Reviewer',
            description: 'Validates code changes for correctness, security, and quality',
            icon: '👁️',
            isBuiltin: true,
        });
        registry.register('runner', () => new RunnerAgent(), {
            name: 'Runner',
            description: 'Executes shell commands and captures output',
            icon: '▶️',
            isBuiltin: true,
        });
        registry.register('tester', () => new TesterAgent(), {
            name: 'Tester',
            description: 'Runs tests in a sandboxed environment',
            icon: '🧪',
            isBuiltin: true,
        });
        registry.register('debugger', () => new DebuggerAgent(), {
            name: 'Debugger',
            description: 'Diagnoses test failures and iteratively applies fixes',
            icon: '🐛',
            isBuiltin: true,
        });
        registry.register('git', () => new GitAgent(), {
            name: 'Git',
            description: 'Manages git operations (branch, commit, PR)',
            icon: '🔀',
            isBuiltin: true,
        });
        registry.register('gitlab', () => new GitLabAgent(), {
            name: 'GitLab',
            description: 'Manages GitLab operations (MR, issues, comments, pipelines)',
            icon: '🦊',
            isBuiltin: true,
        });
        registry.register('package', () => new PackageAgent(), {
            name: 'Package',
            description: 'Manages package version, build, and npm publish',
            icon: '📦',
            isBuiltin: true,
        });
        registry.register('github-release', () => new GitHubReleaseAgent(), {
            name: 'GitHub Release',
            description: 'Creates GitHub releases with auto-generated changelogs',
            icon: '🏷️',
            isBuiltin: true,
        });
        registry.register('security', () => new SecurityAgent(), {
            name: 'Security',
            description: 'Scans for PII, prompt injection, and dangerous code patterns',
            icon: '🔒',
            isBuiltin: true,
        });
        registry.register('skill-runner', () => new SkillRunnerAgent(), {
            name: 'SkillRunner',
            description: 'Executes a compiled skill as a pre-filled task plan',
            icon: '🧠',
            isBuiltin: true,
        });
        registry.register('mcp', () => new MCPAgent(), {
            name: 'MCP',
            description: 'Invokes MCP (Model Context Protocol) tools from connected servers',
            icon: '🔌',
            isBuiltin: true,
        });
        registry.register('pr-review', () => new PRReviewAgent(), {
            name: 'PR Review',
            description: 'Reviews open GitHub PRs for security, quality, and correctness',
            icon: '👁️',
            isBuiltin: true,
        });
        registry.register('issue-triage', () => new IssueTriageAgent(), {
            name: 'Issue Triage',
            description: 'Classifies, prioritizes, and labels open issues from GitHub and GitLab',
            icon: '🏷️',
            isBuiltin: true,
        });
        registry.register('branch-automation', () => new BranchAutomationAgent(), {
            name: 'Branch Automation',
            description: 'Automates branch workflows: issue-driven branches, PR updates, file-watch commits, CI fix detection',
            icon: '🔀',
            isBuiltin: true,
        });
        return registry;
    }
}
// ─── Global Singleton ───────────────────────────────────────────────────────
let _globalRegistry = null;
/**
 * Get or create the global ModuleRegistry singleton.
 *
 * First call creates a registry with all built-in agents pre-registered.
 * Subsequent calls return the same instance.
 * Use `resetModuleRegistry()` to clear and re-initialize (useful in tests).
 */
export function getModuleRegistry() {
    if (!_globalRegistry) {
        _globalRegistry = ModuleRegistry.createWithBuiltins();
    }
    return _globalRegistry;
}
/**
 * Reset the global module registry.
 * Primarily useful in tests to get a clean slate.
 */
export function resetModuleRegistry() {
    _globalRegistry = null;
}
/**
 * Set the global module registry (for dependency injection in tests).
 * Returns the previous registry instance (or null).
 */
export function setModuleRegistry(registry) {
    const previous = _globalRegistry;
    _globalRegistry = registry;
    return previous;
}
//# sourceMappingURL=module-registry.js.map