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
import { resolveNuviraHome } from '../config/paths.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
// ─── Blueprint Manager ────────────────────────────────────────────────────
const BLUEPRINT_DIR = join(resolveNuviraHome(), 'memory', 'blueprints');
export class BlueprintManager {
    blueprints = new Map();
    constructor() {
        this.load();
        this.seedDefaultBlueprints();
    }
    /**
     * Create a new blueprint.
     */
    create(options) {
        const blueprint = {
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
    get(blueprintId) {
        return this.blueprints.get(blueprintId) || null;
    }
    /**
     * Get all blueprints.
     */
    getAll() {
        return [...this.blueprints.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    /**
     * Get blueprints by category.
     */
    getByCategory(category) {
        return this.getAll().filter((b) => b.category === category);
    }
    /**
     * Search blueprints.
     */
    search(query) {
        const lowerQuery = query.toLowerCase();
        return this.getAll().filter((b) => b.name.toLowerCase().includes(lowerQuery) ||
            b.description.toLowerCase().includes(lowerQuery) ||
            b.category.toLowerCase().includes(lowerQuery));
    }
    /**
     * Scaffold a project from a blueprint.
     */
    scaffold(blueprintId, targetDir, variables = {}) {
        const blueprint = this.blueprints.get(blueprintId);
        if (!blueprint)
            return { files: [], errors: ['Blueprint not found'] };
        const files = [];
        const errors = [];
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
                if (!existsSync(dir))
                    mkdirSync(dir, { recursive: true });
                if (file.type === 'directory') {
                    if (!existsSync(filePath))
                        mkdirSync(filePath, { recursive: true });
                }
                else {
                    writeFileSync(filePath, content, 'utf-8');
                }
                files.push(file.path);
            }
            catch (err) {
                errors.push(`Failed to create ${file.path}: ${err}`);
            }
        }
        return { files, errors };
    }
    /**
     * Delete a blueprint.
     */
    delete(blueprintId) {
        const existed = this.blueprints.delete(blueprintId);
        if (existed)
            this.save();
        return existed;
    }
    seedDefaultBlueprints() {
        if (this.blueprints.size > 0)
            return;
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
    load() {
        try {
            if (!existsSync(BLUEPRINT_DIR))
                return;
            const files = require('node:fs').readdirSync(BLUEPRINT_DIR).filter((f) => f.endsWith('.json'));
            for (const file of files) {
                const data = readFileSync(join(BLUEPRINT_DIR, file), 'utf-8');
                const blueprint = JSON.parse(data);
                this.blueprints.set(blueprint.id, blueprint);
            }
        }
        catch { /* ignore */ }
    }
    save() {
        try {
            if (!existsSync(BLUEPRINT_DIR))
                mkdirSync(BLUEPRINT_DIR, { recursive: true });
            for (const [id, blueprint] of this.blueprints) {
                writeFileSync(join(BLUEPRINT_DIR, `${id}.json`), JSON.stringify(blueprint, null, 2));
            }
        }
        catch (err) {
            logger.warn(`BlueprintManager: Failed to save: ${err}`);
        }
    }
}
// ─── Working Diff Tracker ─────────────────────────────────────────────────
const DIFF_DIR = join(resolveNuviraHome(), 'memory', 'diffs');
export class WorkingDiffTracker {
    diffs = new Map();
    constructor() {
        this.load();
    }
    /**
     * Record a working diff.
     */
    record(filePath, diff) {
        const workingDiff = {
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
    markApplied(diffId) {
        const diff = this.diffs.get(diffId);
        if (!diff)
            return false;
        diff.applied = true;
        this.save();
        return true;
    }
    /**
     * Get all diffs for a file.
     */
    getFileDiffs(filePath) {
        return [...this.diffs.values()]
            .filter((d) => d.filePath === filePath)
            .sort((a, b) => b.createdAt - a.createdAt);
    }
    /**
     * Get unapplied diffs.
     */
    getUnappliedDiffs() {
        return [...this.diffs.values()]
            .filter((d) => !d.applied)
            .sort((a, b) => a.createdAt - b.createdAt);
    }
    /**
     * Get all diffs.
     */
    getAllDiffs() {
        return [...this.diffs.values()].sort((a, b) => b.createdAt - a.createdAt);
    }
    /**
     * Clear applied diffs.
     */
    clearApplied() {
        let count = 0;
        for (const [id, diff] of this.diffs) {
            if (diff.applied) {
                this.diffs.delete(id);
                count++;
            }
        }
        if (count > 0)
            this.save();
        return count;
    }
    load() {
        try {
            if (!existsSync(DIFF_DIR))
                return;
            const files = require('node:fs').readdirSync(DIFF_DIR).filter((f) => f.endsWith('.json'));
            for (const file of files) {
                const data = readFileSync(join(DIFF_DIR, file), 'utf-8');
                const diff = JSON.parse(data);
                this.diffs.set(diff.id, diff);
            }
        }
        catch { /* ignore */ }
    }
    save() {
        try {
            if (!existsSync(DIFF_DIR))
                mkdirSync(DIFF_DIR, { recursive: true });
            for (const [id, diff] of this.diffs) {
                writeFileSync(join(DIFF_DIR, `${id}.json`), JSON.stringify(diff, null, 2));
            }
        }
        catch (err) {
            logger.warn(`WorkingDiffTracker: Failed to save: ${err}`);
        }
    }
}
// ─── Singletons ───────────────────────────────────────────────────────────
let _blueprintManager = null;
let _workingDiffTracker = null;
export function getBlueprintManager() {
    if (!_blueprintManager)
        _blueprintManager = new BlueprintManager();
    return _blueprintManager;
}
export function getWorkingDiffTracker() {
    if (!_workingDiffTracker)
        _workingDiffTracker = new WorkingDiffTracker();
    return _workingDiffTracker;
}
//# sourceMappingURL=project-tools.js.map