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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

import {
  type WorkflowTemplate,
  type WorkflowDependency,
  getWorkflowTemplate,
  isValidWorkflowTemplate,
} from './templates.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

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

/** The master index file format */
interface RegistryIndex {
  /** Schema version */
  version: number;
  /** When the index was last updated */
  updatedAt: string;
  /** All available templates */
  templates: RegistryEntry[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** GitHub raw content base URL for the workflow registry */
const REGISTRY_RAW_BASE = 'https://raw.githubusercontent.com/imdheerajKube/agent-nuvira/main';

/** GitHub API URL for the registry */
const REGISTRY_API_BASE = 'https://api.github.com/repos/imdheerajKube/agent-nuvira';

/** Local storage for installed registry templates */
const BUFF_DIR = join(homedir(), '.buff');
const INSTALLED_REGISTRY_DIR = join(BUFF_DIR, 'workflows', 'registry');

/** Cache file for the registry index */
const REGISTRY_CACHE_PATH = join(BUFF_DIR, 'workflows', 'registry-cache.json');

/** How long to cache the registry index (1 hour in ms) */
const REGISTRY_CACHE_TTL = 60 * 60 * 1000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDirs(): void {
  for (const dir of [INSTALLED_REGISTRY_DIR, join(BUFF_DIR, 'workflows')]) {
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    }
  }
}

// ─── Registry Index ─────────────────────────────────────────────────────────

/**
 * Fetch the registry index from GitHub (with TTL caching).
 */
export async function fetchRegistryIndex(): Promise<RegistryEntry[]> {
  // Check cache first
  const cached = readRegistryCache();
  if (cached) return cached;

  try {
    const response = await fetch(`${REGISTRY_RAW_BASE}/index.json`, {
      headers: {
        'User-Agent': 'agent-nuvira/2.0',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!response.ok) {
      logger.debug(`Registry index fetch failed (${response.status}), using cache`);
      return cached || [];
    }

    const index = await response.json() as RegistryIndex;

    if (!index.templates || !Array.isArray(index.templates)) {
      logger.debug('Invalid registry index format');
      return cached || [];
    }

    // Update cache
    writeRegistryCache(index.templates);

    return index.templates;
  } catch (err) {
    logger.debug(`Failed to fetch registry index: ${err}`);
    return cached || [];
  }
}

/**
 * Search the registry for templates matching a query.
 */
export async function searchRegistry(query: string): Promise<RegistryEntry[]> {
  const templates = await fetchRegistryIndex();
  const q = query.toLowerCase();

  return templates.filter((t) => {
    const searchable = `${t.id} ${t.name} ${t.description} ${t.tags.join(' ')}`.toLowerCase();
    return searchable.includes(q);
  });
}

/**
 * Get a specific template entry from the registry by ID.
 */
export async function getRegistryEntry(id: string): Promise<RegistryEntry | null> {
  const templates = await fetchRegistryIndex();
  return templates.find((t) => t.id === id) || null;
}

// ─── Install ────────────────────────────────────────────────────────────────

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
export async function installTemplate(templateId: string): Promise<WorkflowTemplate | null> {
  // First check if it exists in the registry index
  const entry = await getRegistryEntry(templateId);
  if (!entry) {
    logger.error(`Template '${templateId}' not found in the registry.`);
    logger.info('Search available templates: buff workflow search <query>');
    return null;
  }

  // Check if already installed
  const localPath = join(INSTALLED_REGISTRY_DIR, `${templateId}.json`);
  if (existsSync(localPath)) {
    logger.info(`Template '${templateId}' is already installed.`);
    logger.info('To reinstall, first remove it: rm ~/.buff/workflows/registry/<id>.json');
    // Still return the existing one so it can be used
    return readLocalTemplate(templateId);
  }

  // Download the template file
  try {
    const url = `${REGISTRY_RAW_BASE}/templates/${templateId}.json`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'agent-nuvira/2.0',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      logger.error(`Failed to download template '${templateId}' (${response.status})`);
      return null;
    }

    const template = await response.json() as WorkflowTemplate;

    // Validate the template
    if (!isValidWorkflowTemplate(template)) {
      logger.error(`Downloaded template '${templateId}' is not a valid workflow template.`);
      return null;
    }

    // Save locally
    ensureDirs();
    const enriched = {
      ...template,
      _registryVersion: entry.version,
      _registryAuthor: entry.author,
      _installedAt: new Date().toISOString(),
    };
    writeFileSync(localPath, JSON.stringify(enriched, null, 2), 'utf-8');

    logger.success(`Installed workflow template: ${template.name} v${entry.version}`);
    return template;
  } catch (err) {
    logger.error(`Failed to install template '${templateId}': ${err instanceof Error ? err.message : String(err)}`);
    logger.info('Check your internet connection or try again later.');
    return null;
  }
}

/**
 * Read an installed template from local storage.
 */
function readLocalTemplate(templateId: string): WorkflowTemplate | null {
  const localPath = join(INSTALLED_REGISTRY_DIR, `${templateId}.json`);
  try {
    if (!existsSync(localPath)) return null;
    const content = readFileSync(localPath, 'utf-8');
    const template = JSON.parse(content) as WorkflowTemplate;
    // Strip internal metadata before returning
    delete (template as any)._registryVersion;
    delete (template as any)._registryAuthor;
    delete (template as any)._installedAt;
    return template;
  } catch {
    return null;
  }
}

/**
 * Get all locally installed registry templates.
 */
export function getInstalledTemplates(): WorkflowTemplate[] {
  ensureDirs();
  const templates: WorkflowTemplate[] = [];

  try {
    const files = readdirSync(INSTALLED_REGISTRY_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const template = readLocalTemplate(file.replace('.json', ''));
      if (template) {
        templates.push(template);
      }
    }
  } catch {
    // Directory might not exist yet
  }

  return templates;
}

// ─── Publish ────────────────────────────────────────────────────────────────

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
export function validateForPublish(templateId: string): PublishValidation {
  // Find the template in local workflows
  const localPath = join(BUFF_DIR, 'workflows', `${templateId}.json`);

  if (!existsSync(localPath)) {
    // Also check .buff/workflows/registry/
    const registryPath = join(INSTALLED_REGISTRY_DIR, `${templateId}.json`);
    if (!existsSync(registryPath)) {
      return {
        valid: false,
        errors: [`Template '${templateId}' not found in ~/.buff/workflows/ or ~/.buff/workflows/registry/`],
        warnings: [],
      };
    }
  }

  try {
    const filePath = existsSync(join(BUFF_DIR, 'workflows', `${templateId}.json`))
      ? join(BUFF_DIR, 'workflows', `${templateId}.json`)
      : join(INSTALLED_REGISTRY_DIR, `${templateId}.json`);

    const content = readFileSync(filePath, 'utf-8');
    const template = JSON.parse(content) as Record<string, unknown>;

    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields
    if (!template.id || typeof template.id !== 'string') errors.push('Missing or invalid: id (string)');
    if (!template.name || typeof template.name !== 'string') errors.push('Missing or invalid: name (string)');
    if (!template.description || typeof template.description !== 'string') errors.push('Missing or invalid: description (string)');
    if (!Array.isArray(template.steps) || template.steps.length === 0) errors.push('Missing or invalid: steps (non-empty array)');

    // Validate steps
    if (Array.isArray(template.steps)) {
      for (let i = 0; i < template.steps.length; i++) {
        const step = template.steps[i] as Record<string, unknown>;
        if (!step.agentType || typeof step.agentType !== 'string') {
          errors.push(`steps[${i}]: missing or invalid agentType`);
        }
        if (!step.description || typeof step.description !== 'string') {
          errors.push(`steps[${i}]: missing or invalid description`);
        }
      }
    }

    // ID format
    if (template.id && typeof template.id === 'string' && !/^[a-z0-9-]+$/.test(template.id)) {
      errors.push('Template ID must be lowercase alphanumeric with hyphens only');
    }

    // Warnings
    if (!template.recommendedModels) warnings.push('No recommendedModels defined — agents will use default provider');
    if (!template.useMemory && template.useMemory !== false) warnings.push('useMemory not set — defaulting to false');
    if (template.description && typeof template.description === 'string' && template.description.length > 200) {
      warnings.push('Description is longer than 200 characters — consider shortening');
    }

    return { valid: errors.length === 0, errors, warnings };
  } catch (err) {
    return {
      valid: false,
      errors: [`Failed to read template: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
    };
  }
}

/**
 * Prepare a local template for publishing.
 * Returns a JSON string that can be submitted as a PR to the registry.
 */
export function prepareForPublish(templateId: string): string | null {
  const validation = validateForPublish(templateId);
  if (!validation.valid) {
    logger.error('Validation failed. Fix these issues:');
    for (const err of validation.errors) {
      logger.error(`  ${err}`);
    }
    return null;
  }

  // Find and read the template
  const localPath = join(BUFF_DIR, 'workflows', `${templateId}.json`);
  const filePath = existsSync(localPath)
    ? localPath
    : join(INSTALLED_REGISTRY_DIR, `${templateId}.json`);

  try {
    const content = readFileSync(filePath, 'utf-8');
    const template = JSON.parse(content) as Record<string, unknown>;

    // Add/update metadata for publishing
    const publishData = {
      id: template.id,
      name: template.name,
      description: template.description,
      version: template.version || '1.0.0',
      author: template.author || 'anonymous',
      steps: template.steps,
      recommendedModels: template.recommendedModels || {},
      useMemory: template.useMemory || false,
      tags: template.tags || [],
    };

    return JSON.stringify(publishData, null, 2);
  } catch (err) {
    logger.error(`Failed to prepare template for publish: ${err}`);
    return null;
  }
}

/**
 * Get the URL for submitting a new template to the registry.
 */
export function getPublishUrl(): string {
  return 'https://github.com/imdheerajKube/agent-nuvira/issues/new?template=template-submission.md';
}

// ─── Version & Dependency Resolution ────────────────────────────────────────

/**
 * Compare two semantic version strings.
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] || 0;
    const bVal = bParts[i] || 0;
    if (aVal > bVal) return 1;
    if (aVal < bVal) return -1;
  }
  return 0;
}

/**
 * Check if a version satisfies a semver constraint (e.g., ">=1.0.0", "^2.0.0").
 */
export function versionSatisfies(version: string, constraint: string): boolean {
  // Simple prefix-based constraint check
  if (constraint.startsWith('>=')) {
    return compareVersions(version, constraint.slice(2)) >= 0;
  }
  if (constraint.startsWith('<=')) {
    return compareVersions(version, constraint.slice(2)) <= 0;
  }
  if (constraint.startsWith('^')) {
    // ^1.2.3 means >=1.2.3 and <2.0.0
    const target = constraint.slice(1).split('.').map(Number);
    const current = version.split('.').map(Number);
    if (compareVersions(version, constraint.slice(1)) < 0) return false;
    if (target[0] !== undefined && (current[0] || 0) > target[0]) return false;
    return true;
  }
  if (constraint.startsWith('~')) {
    // ~1.2.3 means >=1.2.3 and <1.3.0
    const target = constraint.slice(1).split('.').map(Number);
    const current = version.split('.').map(Number);
    if (compareVersions(version, constraint.slice(1)) < 0) return false;
    if (target[0] !== undefined && (current[0] || 0) !== target[0]) return false;
    if (target[1] !== undefined && (current[1] || 0) > target[1]) return false;
    return true;
  }
  // Exact match or bare number
  return compareVersions(version, constraint) === 0;
}

/**
 * Check if an installed template has a newer version available in the registry.
 */
export async function checkForUpgrades(): Promise<Array<{
  id: string;
  currentVersion: string;
  latestVersion: string;
}>> {
  const installed = getInstalledTemplates();
  if (installed.length === 0) return [];

  const registry = await fetchRegistryIndex();
  const upgrades: Array<{ id: string; currentVersion: string; latestVersion: string }> = [];

  for (const t of installed) {
    if (!t.version || !t.id) continue;
    const entry = registry.find((e) => e.id === t.id);
    if (entry && compareVersions(entry.version, t.version) > 0) {
      upgrades.push({ id: t.id, currentVersion: t.version, latestVersion: entry.version });
    }
  }

  return upgrades;
}

/**
 * Resolve dependencies for a template.
 * Returns any missing dependencies that need to be installed.
 */
export async function resolveDependencies(
  template: WorkflowTemplate,
): Promise<{ met: WorkflowDependency[]; missing: WorkflowDependency[] }> {
  const deps = template.dependencies || [];
  const met: WorkflowDependency[] = [];
  const missing: WorkflowDependency[] = [];

  for (const dep of deps) {
    switch (dep.type) {
      case 'template': {
        // Check if the dependency template exists (built-in or installed)
        const builtin = getWorkflowTemplate(dep.name);
        if (builtin) {
          met.push(dep);
          continue;
        }
        const localPath = join(INSTALLED_REGISTRY_DIR, `${dep.name}.json`);
        if (existsSync(localPath)) {
          met.push(dep);
          continue;
        }
        // Check registry
        const entry = await getRegistryEntry(dep.name);
        if (entry) {
          missing.push(dep);
        } else {
          missing.push({ ...dep, description: `${dep.description || dep.name} (not found in registry)` });
        }
        break;
      }
      case 'npm':
      case 'cli':
        // For npm/cli dependencies, we can't easily verify during a template install
        // Just record them as met-with-caveats
        met.push(dep);
        break;
    }
  }

  return { met, missing };
}

/**
 * Validate that all dependencies of a template are satisfied.
 * Returns true if all dependencies are met or optional.
 */
export function dependenciesMet(deps: WorkflowDependency[]): boolean {
  return deps.every((d) => d.optional);
}

// ─── Registry Cache ─────────────────────────────────────────────────────────

function readRegistryCache(): RegistryEntry[] | null {
  try {
    if (!existsSync(REGISTRY_CACHE_PATH)) return null;

    const raw = readFileSync(REGISTRY_CACHE_PATH, 'utf-8');
    const cached = JSON.parse(raw) as { timestamp: number; templates: RegistryEntry[] };

    // Check TTL
    if (Date.now() - cached.timestamp > REGISTRY_CACHE_TTL) return null;

    return cached.templates;
  } catch {
    return null;
  }
}

function writeRegistryCache(templates: RegistryEntry[]): void {
  try {
    ensureDirs();
    const data = { timestamp: Date.now(), templates };
    writeFileSync(REGISTRY_CACHE_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Non-critical
  }
}

/**
 * Clear the registry index cache.
 */
export function clearRegistryCache(): void {
  try {
    if (existsSync(REGISTRY_CACHE_PATH)) {
      writeFileSync(REGISTRY_CACHE_PATH, JSON.stringify({ timestamp: 0, templates: [] }), 'utf-8');
    }
  } catch {
    // Non-critical
  }
}
