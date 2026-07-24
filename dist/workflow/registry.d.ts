/**
 * Workflow Registry — GitHub-hosted marketplace for community workflow templates.
 *
 * The registry is a GitHub repo (agent-nuvira/workflows) that contains:
 *   index.json          — Master index of all available templates
 *   templates/          — Directory of individual template files
 *     quick-fix.json
 *     security-audit.json
 *     ...
 *
 * Each template file is a JSON document matching the WorkflowTemplate interface
 * extended with version, author, and source metadata.
 *
 * Commands:
 *   buff workflow search <query>    — Search the GitHub registry
 *   buff workflow install <name>    — Install a template from the registry
 *   buff workflow publish           — Publish a local template to the registry
 *   buff workflow info <name>       — Show template details from the registry
 */
import { type WorkflowTemplate, type WorkflowDependency } from './templates.js';
/** A workflow template entry in the registry index */
export interface RegistryEntry {
    /** Template identifier (unique in registry) */
    id: string;
    /** Human-readable name */
    name: string;
    /** Short description (max 200 chars) */
    description: string;
    /** Semantic version (e.g., "1.0.0") */
    version: string;
    /** Author name or GitHub handle */
    author: string;
    /** Number of agent steps */
    stepCount: number;
    /** Tags for search/filter (e.g., ["test", "release", "security"]) */
    tags: string[];
    /** When this template was last updated (ISO date string) */
    updatedAt: string;
    /** Number of installs (approximate) */
    installCount?: number;
    /** URL to the template file in the registry */
    sourceUrl: string;
}
/**
 * Fetch the registry index from GitHub (with TTL caching).
 */
export declare function fetchRegistryIndex(): Promise<RegistryEntry[]>;
/**
 * Search the registry for templates matching a query.
 */
export declare function searchRegistry(query: string): Promise<RegistryEntry[]>;
/**
 * Get a specific template entry from the registry by ID.
 */
export declare function getRegistryEntry(id: string): Promise<RegistryEntry | null>;
/**
 * Install a workflow template from the registry.
 *
 * Downloads the template JSON file from GitHub and saves it to
 * ~/.buff/workflows/registry/<id>.json where the workflow system
 * can auto-discover it.
 *
 * @param templateId  The template ID to install
 * @returns           The installed WorkflowTemplate, or null if failed
 */
export declare function installTemplate(templateId: string): Promise<WorkflowTemplate | null>;
/**
 * Get all locally installed registry templates.
 */
export declare function getInstalledTemplates(): WorkflowTemplate[];
/**
 * Validation errors found during publish preparation.
 */
export interface PublishValidation {
    valid: boolean;
    errors: string[];
    warnings: string[];
}
/**
 * Validate a local workflow template for publishing.
 * Checks for required fields, valid steps, etc.
 */
export declare function validateForPublish(templateId: string): PublishValidation;
/**
 * Prepare a local template for publishing.
 * Returns a JSON string that can be submitted as a PR to the registry.
 */
export declare function prepareForPublish(templateId: string): string | null;
/**
 * Get the URL for submitting a new template to the registry.
 */
export declare function getPublishUrl(): string;
/**
 * Compare two semantic version strings.
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export declare function compareVersions(a: string, b: string): number;
/**
 * Check if a version satisfies a semver constraint (e.g., ">=1.0.0", "^2.0.0").
 */
export declare function versionSatisfies(version: string, constraint: string): boolean;
/**
 * Check if an installed template has a newer version available in the registry.
 */
export declare function checkForUpgrades(): Promise<Array<{
    id: string;
    currentVersion: string;
    latestVersion: string;
}>>;
/**
 * Resolve dependencies for a template.
 * Returns any missing dependencies that need to be installed.
 */
export declare function resolveDependencies(template: WorkflowTemplate): Promise<{
    met: WorkflowDependency[];
    missing: WorkflowDependency[];
}>;
/**
 * Validate that all dependencies of a template are satisfied.
 * Returns true if all dependencies are met or optional.
 */
export declare function dependenciesMet(deps: WorkflowDependency[]): boolean;
/**
 * Clear the registry index cache.
 */
export declare function clearRegistryCache(): void;
//# sourceMappingURL=registry.d.ts.map