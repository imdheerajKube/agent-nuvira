/**
 * Init command — Scaffold new projects from templates.
 *
 * Usage:
 *   buff init                    — Interactive prompt for project name and template
 *   buff init my-app             — Create project 'my-app' with interactive template picker
 *   buff init my-app --template node-cli  — Create from a specific template
 *   buff init my-app --list      — List available templates
 *   buff init my-app --template custom --template-dir ~/my-templates
 *
 * Templates are stored in ~/.buff/templates/ and can be custom.
 * Built-in templates ship with the CLI.
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export interface InitTemplate {
    /** Template identifier */
    id: string;
    /** Human-readable name */
    name: string;
    /** Short description */
    description: string;
    /** Files to create (key = path, value = content or generator function) */
    files: Record<string, string | ((projectName: string) => string)>;
    /** Dependencies to add (npm packages, etc.) */
    dependencies?: string[];
    /** Dev dependencies */
    devDependencies?: string[];
    /** Post-creation instructions */
    postInstall?: string[];
}
export declare class InitCommand extends BaseCommand {
    create(): Command;
    private execute;
    private listTemplates;
    /**
     * Get all available templates (built-in + custom from ~/.buff/templates/).
     */
    private getAllTemplates;
    /**
     * Find a template by ID (searches built-in first, then custom).
     */
    private findTemplate;
    /**
     * Print the project structure recursively.
     */
    private printStructure;
}
//# sourceMappingURL=init.d.ts.map