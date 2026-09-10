/**
 * Secret Capture Module — Interactive env var prompting + persistence
 *
 * Phase A1 of the Skill System Parity Plan.
 *
 * Provides:
 * - isEnvVarPersisted(): check if an env var is currently set
 * - loadEnvFile(): read all vars from ~/.nuvira/.env
 * - saveEnvValue(): write a single var to ~/.nuvira/.env
 * - captureSecrets(): interactively prompt for missing vars
 *
 * Hermes reference: tools/skills_tool.py:_capture_required_environment_variables()
 */
export interface EnvVarEntry {
    /** The env var name (e.g. OPENAI_API_KEY). */
    name: string;
    /** The prompt shown to the user (e.g. "Enter your OpenAI API key:"). */
    prompt: string;
    /** Optional help text (e.g. URL to get the key). */
    help?: string;
    /** If true, user can skip this var. */
    optional?: boolean;
}
export interface CaptureResult {
    /** Vars the user did NOT provide (still missing). */
    missingNames: string[];
    /** True if the user explicitly skipped setup. */
    setupSkipped: boolean;
    /** Vars that were successfully stored. */
    storedVars: string[];
}
/**
 * Load all env vars from the .env file.
 */
export declare function loadEnvFile(): Record<string, string>;
/**
 * Check if an env var is currently set (file or process.env).
 * Returns true if the var has a non-empty value.
 */
export declare function isEnvVarPersisted(varName: string): boolean;
/**
 * Get the current effective value of an env var.
 * Returns the value or empty string if not set.
 */
export declare function getEnvVarValue(varName: string): string;
/**
 * Save or update a value in ~/.nuvira/.env (or ~/.nuvira/.env).
 * Preserves existing lines, adds new ones at the end.
 */
export declare function saveEnvValue(key: string, value: string): {
    success: boolean;
    path: string;
};
/**
 * Capture missing env vars interactively.
 *
 * @param skillName - Name of the skill requiring env vars
 * @param missingEntries - List of missing env var entries
 * @param surface - 'cli' for terminal, 'dashboard' for web UI
 * @returns CaptureResult with missing vars and stored vars
 */
export declare function captureSecrets(skillName: string, missingEntries: EnvVarEntry[], surface?: 'cli' | 'dashboard'): Promise<CaptureResult>;
/**
 * Check which required env vars are missing for a skill.
 * Returns the list of entries that need prompting.
 */
export declare function findMissingEnvVars(requiredEnvVars: string[] | Array<{
    name: string;
    prompt?: string;
    help?: string;
    optional?: boolean;
}>): EnvVarEntry[];
/**
 * Get a summary of env var status for a skill.
 */
export declare function getEnvVarStatus(requiredEnvVars: string[]): Array<{
    name: string;
    set: boolean;
    maskedValue?: string;
}>;
//# sourceMappingURL=secret-capture.d.ts.map