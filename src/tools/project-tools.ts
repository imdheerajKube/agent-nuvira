/**
 * Project Tools — Blueprint templates and working diff tracking.
 *
 * Hermes equivalent: blueprints.py + working_diff.py
 *
 * Provides:
 * - Blueprint templates for project scaffolding
 * - Working diff tracking for changes
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface Blueprint {
  /** Blueprint ID */
  id: string;
  /** Blueprint name */
  name: string;
  /** Description */
  description: string;
  /** Category */
  category: string;
  /** Files to create */
  files: BlueprintFile[];
  /** Variables to substitute */
  variables: BlueprintVariable[];
  /** Created at */
  createdAt: number;
}

export interface BlueprintFile {
  /** File path (relative) */
  path: string;
  /** File content (with {{variable}} placeholders) */
  content: string;
  /** File type */
  type: 'file' | 'directory' | 'template';
}

export interface BlueprintVariable {
  /** Variable name */
  name: string;
  /** Description */
  description: string;
  /** Default value */
  defaultValue?: string;
  /** Whether required */
  required: boolean;
}

export interface WorkingDiff {
  /** Diff ID */
  id: string;
  /** File path */
  filePath: string;
  /** Diff content */
  diff: string;
  /** Whether applied */
  applied: boolean;
  /** Created at */
  createdAt: number;
}

// ─── Blueprint Manager ────────────────────────────────────────────────────

const BLUEPRINT_DIR = join(homedir(), '.buff', 'memory', 'blueprints');

export class BlueprintManager {
  private blueprints: Map<string, Blueprint> = new Map();

  constructor() {
    this.load();
    this.seedDefaultBlueprints();
  }

  /**
   * Create a new blueprint.
   */
  create(options: {
    name: string;
    description: string;
    category: string;
    files: BlueprintFile[];
    variables?: BlueprintVariable[];
  }): Blueprint {
    const blueprint: Blueprint = {
      id: randomUUID(),
      ...options,
      variables: options.variables || [],
      createdAt: Date.now(),
    };
    this.blueprints.set(blueprint.id, blueprint);
    this.save();
    return blueprint;
  }

  /**
   * Get a blueprint by ID.
   */
  get(blueprintId: string): Blueprint | null {
    return this.blueprints.get(blueprintId) || null;
  }

  /**
   * Get all blueprints.
   */
  getAll(): Blueprint[] {
    return [...this.blueprints.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get blueprints by category.
   */
  getByCategory(category: string): Blueprint[] {
    return this.getAll().filter((b) => b.category === category);
  }

  /**
   * Search blueprints.
   */
  search(query: string): Blueprint[] {
    const lowerQuery = query.toLowerCase();
    return this.getAll().filter(
      (b) =>
        b.name.toLowerCase().includes(lowerQuery) ||
        b.description.toLowerCase().includes(lowerQuery) ||
        b.category.toLowerCase().includes(lowerQuery),
    );
  }

  /**
   * Scaffold a project from a blueprint.
   */
  scaffold(
    blueprintId: string,
    targetDir: string,
    variables: Record<string, string> = {},
  ): { files: string[]; errors: string[] } {
    const blueprint = this.blueprints.get(blueprintId);
    if (!blueprint) return { files: [], errors: ['Blueprint not found'] };

    const files: string[] = [];
    const errors: string[] = [];

    for (const file of blueprint.files) {
      try {
        let content = file.content;

        // Substitute variables
        for (const [key, value] of Object.entries(variables)) {
          content = content.replace(new RegExp(`{{${key}}}`, 'g'), value);
        }

        // Check for unresolved variables
        const unresolvedVars = content.match(/\{\{(\w+)\}\}/g);
        if (unresolvedVars) {
          errors.push(`Unresolved variables in ${file.path}: ${unresolvedVars.join(', ')}`);
        }

        const filePath = join(targetDir, file.path);
        const dir = filePath.split('/').slice(0, -1).join('/');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        if (file.type === 'directory') {
          if (!existsSync(filePath)) mkdirSync(filePath, { recursive: true });
        } else {
          writeFileSync(filePath, content, 'utf-8');
        }

        files.push(file.path);
      } catch (err) {
        errors.push(`Failed to create ${file.path}: ${err}`);
      }
    }

    return { files, errors };
  }

  /**
   * Delete a blueprint.
   */
  delete(blueprintId: string): boolean {
    const existed = this.blueprints.delete(blueprintId);
    if (existed) this.save();
    return existed;
  }

  private seedDefaultBlueprints(): void {
    if (this.blueprints.size > 0) return;

    // TypeScript project blueprint
    this.create({
      name: 'typescript-project',
      description: 'Basic TypeScript project with build and test setup',
      category: 'scaffolding',
      files: [
        {
          path: 'package.json',
          content: `{\n  "name": "{{name}}",\n  "version": "1.0.0",\n  "description": "{{description}}",\n  "main": "dist/index.js",\n  "scripts": {\n    "build": "tsc",\n    "test": "vitest",\n    "dev": "tsx src/index.ts"\n  }\n}`,
          type: 'template',
        },
        {
          path: 'tsconfig.json',
          content: `{\n  "compilerOptions": {\n    "target": "ES2022",\n    "module": "NodeNext",\n    "outDir": "dist",\n    "strict": true\n  },\n  "include": ["src/**/*"]\n}`,
          type: 'template',
        },
        {
          path: 'src/index.ts',
          content: `export function main() {\n  console.log('Hello from {{name}}!');\n}\n`,
          type: 'template',
        },
        {
          path: 'src/index.test.ts',
          content: `import { describe, it, expect } from 'vitest';\nimport { main } from './index.js';\n\ndescribe('main', () => {\n  it('should work', () => {\n    expect(true).toBe(true);\n  });\n});\n`,
          type: 'template',
        },
      ],
      variables: [
        { name: 'name', description: 'Project name', required: true },
        { name: 'description', description: 'Project description', defaultValue: '', required: false },
      ],
    });

    // React project blueprint
    this.create({
      name: 'react-project',
      description: 'React + TypeScript project with Vite',
      category: 'scaffolding',
      files: [
        {
          path: 'package.json',
          content: `{\n  "name": "{{name}}",\n  "type": "module",\n  "scripts": {\n    "dev": "vite",\n    "build": "tsc && vite build",\n    "preview": "vite preview"\n  },\n  "dependencies": {\n    "react": "^18.2.0",\n    "react-dom": "^18.2.0"\n  }\n}`,
          type: 'template',
        },
        {
          path: 'src/App.tsx',
          content: `export function App() {\n  return <div>{{name}}</div>;\n}\n`,
          type: 'template',
        },
      ],
      variables: [
        { name: 'name', description: 'Project name', required: true },
      ],
    });

    this.save();
  }

  private load(): void {
    try {
      if (!existsSync(BLUEPRINT_DIR)) return;
      const files = require('node:fs').readdirSync(BLUEPRINT_DIR).filter((f: string) => f.endsWith('.json'));
      for (const file of files) {
        const data = readFileSync(join(BLUEPRINT_DIR, file), 'utf-8');
        const blueprint = JSON.parse(data) as Blueprint;
        this.blueprints.set(blueprint.id, blueprint);
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    try {
      if (!existsSync(BLUEPRINT_DIR)) mkdirSync(BLUEPRINT_DIR, { recursive: true });
      for (const [id, blueprint] of this.blueprints) {
        writeFileSync(join(BLUEPRINT_DIR, `${id}.json`), JSON.stringify(blueprint, null, 2));
      }
    } catch (err) {
      logger.warn(`BlueprintManager: Failed to save: ${err}`);
    }
  }
}

// ─── Working Diff Tracker ─────────────────────────────────────────────────

const DIFF_DIR = join(homedir(), '.buff', 'memory', 'diffs');

export class WorkingDiffTracker {
  private diffs: Map<string, WorkingDiff> = new Map();

  constructor() {
    this.load();
  }

  /**
   * Record a working diff.
   */
  record(filePath: string, diff: string): WorkingDiff {
    const workingDiff: WorkingDiff = {
      id: randomUUID(),
      filePath,
      diff,
      applied: false,
      createdAt: Date.now(),
    };
    this.diffs.set(workingDiff.id, workingDiff);
    this.save();
    return workingDiff;
  }

  /**
   * Mark a diff as applied.
   */
  markApplied(diffId: string): boolean {
    const diff = this.diffs.get(diffId);
    if (!diff) return false;
    diff.applied = true;
    this.save();
    return true;
  }

  /**
   * Get all diffs for a file.
   */
  getFileDiffs(filePath: string): WorkingDiff[] {
    return [...this.diffs.values()]
      .filter((d) => d.filePath === filePath)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get unapplied diffs.
   */
  getUnappliedDiffs(): WorkingDiff[] {
    return [...this.diffs.values()]
      .filter((d) => !d.applied)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Get all diffs.
   */
  getAllDiffs(): WorkingDiff[] {
    return [...this.diffs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Clear applied diffs.
   */
  clearApplied(): number {
    let count = 0;
    for (const [id, diff] of this.diffs) {
      if (diff.applied) {
        this.diffs.delete(id);
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  private load(): void {
    try {
      if (!existsSync(DIFF_DIR)) return;
      const files = require('node:fs').readdirSync(DIFF_DIR).filter((f: string) => f.endsWith('.json'));
      for (const file of files) {
        const data = readFileSync(join(DIFF_DIR, file), 'utf-8');
        const diff = JSON.parse(data) as WorkingDiff;
        this.diffs.set(diff.id, diff);
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    try {
      if (!existsSync(DIFF_DIR)) mkdirSync(DIFF_DIR, { recursive: true });
      for (const [id, diff] of this.diffs) {
        writeFileSync(join(DIFF_DIR, `${id}.json`), JSON.stringify(diff, null, 2));
      }
    } catch (err) {
      logger.warn(`WorkingDiffTracker: Failed to save: ${err}`);
    }
  }
}

// ─── Singletons ───────────────────────────────────────────────────────────

let _blueprintManager: BlueprintManager | null = null;
let _workingDiffTracker: WorkingDiffTracker | null = null;

export function getBlueprintManager(): BlueprintManager {
  if (!_blueprintManager) _blueprintManager = new BlueprintManager();
  return _blueprintManager;
}

export function getWorkingDiffTracker(): WorkingDiffTracker {
  if (!_workingDiffTracker) _workingDiffTracker = new WorkingDiffTracker();
  return _workingDiffTracker;
}
