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

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── Built-in Templates ─────────────────────────────────────────────────────

const BUILTIN_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'quick-fix',
    name: 'Quick Fix',
    description: 'Fast context gather \u2192 edit \u2192 run test \u2192 review for small changes (bug fixes, typos, simple edits)',
    steps: [
      {
        agentType: 'context-gatherer',
        description: 'Scan codebase to find relevant files for the fix',
        dependsOn: [],
      },
      {
        agentType: 'writer',
        description: 'Apply the fix based on gathered context',
        dependsOn: ['step-0'],
      },
      {
        agentType: 'runner',
        description: 'Run: npm test (or equivalent verification command) to verify the fix',
        dependsOn: ['step-1'],
      },
      {
        agentType: 'reviewer',
        description: 'Review the fix for correctness and quality',
        dependsOn: ['step-2'],
      },
      {
        agentType: 'security',
        description: 'Run all security scans on changes',
        dependsOn: ['step-3'],
      },
    ],
    recommendedModels: {
      'context-gatherer': 'groq/llama-3.1-8b-instant',
      writer: 'groq/llama-3.1-8b-instant',
      reviewer: 'groq/llama-3.1-8b-instant',
    },
  },
  {
    id: 'create-and-run',
    name: 'Create & Run',
    description: 'Create a new program/script from scratch, execute it, and show output — perfect for prototyping and scaffolding',
    steps: [
      {
        agentType: 'writer',
        description: 'Create the program files from scratch based on the goal',
        dependsOn: [],
      },
      {
        agentType: 'runner',
        description: 'Run the newly created program and capture output',
        dependsOn: ['step-0'],
      },
      {
        agentType: 'reviewer',
        description: 'Review the code quality and correctness of output',
        dependsOn: ['step-1'],
      },
    ],
    recommendedModels: {
      writer: 'groq/llama-3.1-8b-instant',
    },
  },
  {
    id: 'feature-implement',
    name: 'Feature Implementation',
    description: 'Full feature workflow: plan \u2192 gather \u2192 write \u2192 test \u2192 run \u2192 review',
    steps: [
      {
        agentType: 'planner',
        description: 'Analyze the goal and create an implementation plan',
        dependsOn: [],
      },
      {
        agentType: 'context-gatherer',
        description: 'Gather relevant files and context for the feature',
        dependsOn: ['step-0'],
      },
      {
        agentType: 'writer',
        description: 'Implement the feature code changes',
        dependsOn: ['step-1'],
      },
      {
        agentType: 'tester',
        description: 'Run tests to verify the implementation',
        dependsOn: ['step-2'],
      },
      {
        agentType: 'runner',
        description: 'Run the application to verify it starts correctly',
        dependsOn: ['step-2'],
      },
      {
        agentType: 'reviewer',
        description: 'Review the implementation for quality and completeness',
        dependsOn: ['step-2'],
      },
      {
        agentType: 'security',
        description: 'Run all security scans on changes',
        dependsOn: ['step-5'],
      },
    ],
    recommendedModels: {
      planner: 'groq/llama-3.1-8b-instant',
      'context-gatherer': 'groq/llama-3.1-8b-instant',
      writer: 'groq/llama-3.1-8b-instant',
      tester: 'groq/llama-3.1-8b-instant',
      reviewer: 'groq/llama-3.1-8b-instant',
    },
    useMemory: true,
  },
  {
    id: 'publish-release',
    name: 'Publish Release',
    description: 'Full release pipeline: test \u2192 version bump \u2192 review \u2192 commit \u2192 build&publish \u2192 github release',
    steps: [
      {
        agentType: 'tester',
        description: 'Run the full test suite to verify the codebase is healthy',
        dependsOn: [],
      },
      {
        agentType: 'writer',
        description: 'Bump version number in package.json and update changelog',
        dependsOn: ['step-0'],
      },
      {
        agentType: 'reviewer',
        description: 'Review version bump and changelog for correctness',
        dependsOn: ['step-1'],
      },
      {
        agentType: 'security',
        description: 'Run all security scans on changes before committing',
        dependsOn: ['step-2'],
      },
      {
        agentType: 'git',
        description: 'Commit the version bump and changelog changes to git',
        dependsOn: ['step-3'],
      },
      {
        agentType: 'package',
        description: 'Build project and publish to npm',
        dependsOn: ['step-4'],
      },
      {
        agentType: 'github-release',
        description: 'Create git tag and GitHub release with auto-generated notes',
        dependsOn: ['step-5'],
      },
    ],
    recommendedModels: {
      writer: 'groq/llama-3.1-8b-instant',
      reviewer: 'groq/llama-3.1-8b-instant',
    },
    useMemory: false,
    tags: ['release', 'publish', 'devops'],
  },
  {
    id: 'api-scaffold',
    name: 'API Scaffold',
    description: 'Scaffold a REST API project: create routes, controllers, models, and middleware from a specification',
    steps: [
      {
        agentType: 'planner',
        description: 'Analyze the API specification and design the architecture',
        dependsOn: [],
      },
      {
        agentType: 'context-gatherer',
        description: 'Scan existing project structure to understand conventions',
        dependsOn: ['step-0'],
      },
      {
        agentType: 'writer',
        description: 'Create routes, controllers, models, and middleware files',
        dependsOn: ['step-1'],
      },
      {
        agentType: 'runner',
        description: 'Run: npm run lint (or equivalent) to verify code quality',
        dependsOn: ['step-2'],
      },
      {
        agentType: 'tester',
        description: 'Generate and run basic endpoint tests',
        dependsOn: ['step-3'],
      },
      {
        agentType: 'reviewer',
        description: 'Review the API implementation for correctness and consistency',
        dependsOn: ['step-4'],
      },
    ],
    recommendedModels: {
      planner: 'groq/llama-3.1-8b-instant',
      'context-gatherer': 'groq/llama-3.1-8b-instant',
      writer: 'groq/llama-3.1-8b-instant',
      reviewer: 'groq/llama-3.1-8b-instant',
    },
    useMemory: true,
    tags: ['api', 'scaffold', 'rest', 'backend'],
  },
  // ── New Templates (Phase 2.2) ────────────────────────────────────────────
  {
    id: 'security-audit',
    name: 'Security Audit',
    description: 'Run security scans, review dependencies for vulnerabilities, and generate a security report',
    steps: [
      {
        agentType: 'context-gatherer',
        description: 'Scan codebase and identify all dependencies and entry points',
        dependsOn: [],
      },
      {
        agentType: 'security',
        description: 'Run all security scans (injection, PII, dangerous code)',
        dependsOn: ['step-0'],
      },
      {
        agentType: 'writer',
        description: 'Generate a comprehensive security report',
        dependsOn: ['step-1'],
      },
      {
        agentType: 'reviewer',
        description: 'Review security findings and prioritize fixes',
        dependsOn: ['step-2'],
      },
    ],
    recommendedModels: {
      'context-gatherer': 'groq/llama-3.1-8b-instant',
      writer: 'groq/llama-3.1-8b-instant',
      reviewer: 'openrouter/meta-llama/llama-3.1-8b-instruct',
    },
    useMemory: false,
    tags: ['security', 'audit', 'scan'],
  },
  {
    id: 'refactor-module',
    name: 'Refactor Module',
    description: 'Plan and execute a module-level refactor with testing and verification',
    steps: [
      {
        agentType: 'planner',
        description: 'Analyze the module and create refactoring plan',
        dependsOn: [],
      },
      {
        agentType: 'context-gatherer',
        description: 'Find all files that import or depend on the module',
        dependsOn: ['step-0'],
      },
      {
        agentType: 'writer',
        description: 'Execute the refactoring changes across all files',
        dependsOn: ['step-1'],
      },
      {
        agentType: 'runner',
        description: 'Run: npm test (or equivalent) to verify nothing is broken',
        dependsOn: ['step-2'],
      },
      {
        agentType: 'tester',
        description: 'Run full test suite to ensure refactor is safe',
        dependsOn: ['step-3'],
      },
      {
        agentType: 'reviewer',
        description: 'Review refactoring for correctness and style',
        dependsOn: ['step-4'],
      },
    ],
    recommendedModels: {
      planner: 'gemini-2.0-flash-exp',
      writer: 'groq/llama-3.1-8b-instant',
      reviewer: 'groq/llama-3.1-8b-instant',
    },
    useMemory: true,
    tags: ['refactor', 'cleanup', 'optimize'],
  },
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Review staged changes in git, run security scans, and generate a thorough review report',
    steps: [
      {
        agentType: 'context-gatherer',
        description: 'Get git diff of staged changes and scan the codebase',
        dependsOn: [],
      },
      {
        agentType: 'reviewer',
        description: 'Review all changes for bugs, style, and correctness',
        dependsOn: ['step-0'],
      },
      {
        agentType: 'security',
        description: 'Run security scans on the changes',
        dependsOn: ['step-1'],
      },
      {
        agentType: 'writer',
        description: 'Generate a review report with findings and recommendations',
        dependsOn: ['step-2'],
      },
    ],
    recommendedModels: {
      'context-gatherer': 'groq/llama-3.1-8b-instant',
      reviewer: 'openrouter/meta-llama/llama-3.1-8b-instruct',
      writer: 'groq/llama-3.1-8b-instant',
    },
    useMemory: false,
    tags: ['review', 'code-quality', 'git'],
  },
  {
    id: 'bug-hunt',
    name: 'Bug Hunt',
    description: 'Systematically find and fix bugs: reproduce \u2192 diagnose \u2192 fix \u2192 verify',
    steps: [
      {
        agentType: 'context-gatherer',
        description: 'Analyze the codebase around the bug report',
        dependsOn: [],
      },
      {
        agentType: 'planner',
        description: 'Create a diagnosis and fix plan',
        dependsOn: ['step-0'],
      },
      {
        agentType: 'writer',
        description: 'Implement the bug fix',
        dependsOn: ['step-1'],
      },
      {
        agentType: 'tester',
        description: 'Run tests to verify the fix and check for regressions',
        dependsOn: ['step-2'],
      },
      {
        agentType: 'debugger',
        description: 'If tests fail, iterate on the fix',
        dependsOn: ['step-3'],
      },
      {
        agentType: 'runner',
        description: 'Run the application to verify the fix works end-to-end',
        dependsOn: ['step-4'],
      },
    ],
    recommendedModels: {
      planner: 'groq/llama-3.1-8b-instant',
      writer: 'groq/llama-3.1-8b-instant',
      debugger: 'groq/llama-3.1-8b-instant',
    },
    useMemory: true,
    tags: ['debug', 'fix', 'bug'],
  },
  {
    id: 'test-generation',
    name: 'Test Generation',
    description: 'Automatically generate unit/integration tests for files in the codebase',
    steps: [
      {
        agentType: 'context-gatherer',
        description: 'Find files without tests and analyze their exports',
        dependsOn: [],
      },
      {
        agentType: 'writer',
        description: 'Generate test files for discovered code',
        dependsOn: ['step-0'],
      },
      {
        agentType: 'runner',
        description: 'Run: npm test (or equivalent) to verify generated tests pass',
        dependsOn: ['step-1'],
      },
      {
        agentType: 'debugger',
        description: 'Fix any failing generated tests',
        dependsOn: ['step-2'],
      },
      {
        agentType: 'reviewer',
        description: 'Review the generated tests for quality and coverage',
        dependsOn: ['step-3'],
      },
    ],
    recommendedModels: {
      'context-gatherer': 'groq/llama-3.1-8b-instant',
      writer: 'groq/llama-3.1-8b-instant',
      reviewer: 'groq/llama-3.1-8b-instant',
    },
    useMemory: false,
    tags: ['test', 'coverage', 'qa'],
  },
];

// ─── Workflow Engine ────────────────────────────────────────────────────────

/**
 * Get all available workflow templates.
 */
export function getWorkflowTemplates(): WorkflowTemplate[] {
  return [...BUILTIN_TEMPLATES];
}

/**
 * Get a specific workflow template by ID.
 */
export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}

/**
 * Build a task plan from a workflow template, filling in the user's goal.
 * Each step gets a stable ID (step-0, step-1, etc.) and the dependsOn
 * references are translated from index-based to ID-based.
 */
export function buildTaskPlanFromTemplate(
  template: WorkflowTemplate,
  goal: string,
): TaskStep[] {
  return template.steps.map((step, index) => ({
    id: `step-${index}`,
    description: `${step.description} for: ${goal}`,
    agentType: step.agentType,
    dependsOn: step.dependsOn,
    status: 'pending' as const,
  }));
}

/**
 * Build OrchestratorOptions from a workflow template.
 * Merges the template's recommended models with user overrides.
 */
/**
 * Validate that an object is a valid WorkflowTemplate.
 * Used by the workflow registry when installing templates.
 */
export function isValidWorkflowTemplate(obj: unknown): obj is WorkflowTemplate {
  if (typeof obj !== 'object' || obj === null) return false;
  const t = obj as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    typeof t.name === 'string' &&
    Array.isArray(t.steps) &&
    t.steps.length > 0 &&
    t.steps.every(
      (s: unknown) =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as Record<string, unknown>).agentType === 'string' &&
        typeof (s as Record<string, unknown>).description === 'string',
    )
  );
}

/**
 * Build OrchestratorOptions from a workflow template.
 * Merges the template's recommended models with user overrides.
 */
export function buildWorkflowOptions(
  template: WorkflowTemplate,
  userOptions: Partial<OrchestratorOptions> = {},
): OrchestratorOptions {
  return {
    agentModels: template.recommendedModels,
    useMemory: template.useMemory,
    autoRouteModels: !template.recommendedModels,
    verbose: userOptions.verbose,
    dryRun: userOptions.dryRun,
    provider: userOptions.provider,
    model: userOptions.model,
  };
}
