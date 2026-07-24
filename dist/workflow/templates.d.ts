/**
 * Workflow Templates — Pre-built agent pipeline templates.
 *
 * Each template defines a sequence of agent steps for common tasks.
 * The WorkflowEngine uses these to pre-fill the orchestrator's task plan,
 * bypassing the PlannerAgent when a fixed workflow is desired.
 *
 * Built-in templates:
 * - quick-fix: gather context → edit → run → review (small, fast changes)
 * - feature-implement: plan → gather → write → test → review (new features)
 * - create-and-run: write → run → review (create from scratch + execute)
 * - publish-release: test → build → version → publish (release pipeline)
 */
import type { TaskStep } from '../agents/agent.js';
import type { OrchestratorOptions } from '../agents/orchestrator.js';
export interface WorkflowTemplate {
    /** Template identifier (used in CLI: `buff workflow run quick-fix`) */
    id: string;
    /** Human-readable name */
    name: string;
    /** Short description */
    description: string;
    /** Ordered agent steps that form the pipeline */
    steps: WorkflowStep[];
    /** Recommended model routing for this workflow */
    recommendedModels?: Partial<Record<string, string>>;
    /** Whether to use memory for this workflow type */
    useMemory?: boolean;
    /** Semantic version (for registry-published templates) */
    version?: string;
    /** Author name or GitHub handle (for registry-published templates) */
    author?: string;
    /** Tags for categorization (e.g., ['test', 'release', 'security']) */
    tags?: string[];
    /**
     * Template and package dependencies required by this template.
     * Used for version resolution and dependency checking during install.
     */
    dependencies?: WorkflowDependency[];
}
/**
 * A dependency declaration for a workflow template.
 * Can reference other templates, npm packages, or CLI tools.
 */
export interface WorkflowDependency {
    /** Type of dependency: 'template' | 'npm' | 'cli' */
    type: 'template' | 'npm' | 'cli';
    /** Name/identifier of the dependency */
    name: string;
    /** Semantic version constraint (e.g., ">=1.0.0", "^2.0.0") */
    version?: string;
    /** Whether this dependency is optional */
    optional?: boolean;
    /** Description of why this dependency is needed */
    description?: string;
}
export interface WorkflowStep {
    /** Agent type (must be registered in Orchestrator's createAgent) */
    agentType: string;
    /** Description of what this step does (becomes the task description) */
    description: string;
    /** IDs of steps this step depends on (index-based: ['step-0', 'step-1']) */
    dependsOn: string[];
}
/**
 * Get all available workflow templates.
 */
export declare function getWorkflowTemplates(): WorkflowTemplate[];
/**
 * Get a specific workflow template by ID.
 */
export declare function getWorkflowTemplate(id: string): WorkflowTemplate | undefined;
/**
 * Build a task plan from a workflow template, filling in the user's goal.
 * Each step gets a stable ID (step-0, step-1, etc.) and the dependsOn
 * references are translated from index-based to ID-based.
 */
export declare function buildTaskPlanFromTemplate(template: WorkflowTemplate, goal: string): TaskStep[];
/**
 * Build OrchestratorOptions from a workflow template.
 * Merges the template's recommended models with user overrides.
 */
/**
 * Validate that an object is a valid WorkflowTemplate.
 * Used by the workflow registry when installing templates.
 */
export declare function isValidWorkflowTemplate(obj: unknown): obj is WorkflowTemplate;
/**
 * Build OrchestratorOptions from a workflow template.
 * Merges the template's recommended models with user overrides.
 */
export declare function buildWorkflowOptions(template: WorkflowTemplate, userOptions?: Partial<OrchestratorOptions>): OrchestratorOptions;
//# sourceMappingURL=templates.d.ts.map