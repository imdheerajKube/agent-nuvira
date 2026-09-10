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
import { existsSync, readFileSync } from 'fs';
import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';
// ─── Env File Resolution ──────────────────────────────────────────────────
/**
 * Resolve the path to the .env file.
 * Priority: NUVIRA_ENV_FILE > NUVIRA_ENV_FILE > ~/.nuvira/.env > ~/.nuvira/.env
 */
function envFilePath() {
    if (process.env.NUVIRA_ENV_FILE && process.env.NUVIRA_ENV_FILE.trim().length > 0)
        return process.env.NUVIRA_ENV_FILE;
    const override = envBuff('ENV_FILE');
    if (override && override.trim().length > 0)
        return override;
    const nuviraEnv = join(homedir(), '.nuvira', '.env');
    if (existsSync(nuviraEnv))
        return nuviraEnv;
    return join(resolveNuviraHome(), '.env');
}
// ─── Core Functions ───────────────────────────────────────────────────────
/**
 * Parse a single .env line into [key, value] or null.
 */
function parseEnvLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#'))
        return null;
    const bare = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
    const eq = bare.indexOf('=');
    if (eq === -1)
        return null;
    const key = bare.slice(0, eq).trim();
    let value = bare.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
    }
    // Strip inline comment
    const hash = value.indexOf(' #');
    if (hash !== -1)
        value = value.slice(0, hash).trim();
    return [key, value];
}
/**
 * Load all env vars from the .env file.
 */
export function loadEnvFile() {
    const path = envFilePath();
    const vars = {};
    if (!existsSync(path))
        return vars;
    try {
        for (const rawLine of readFileSync(path, 'utf-8').split(/\r?\n/)) {
            const parsed = parseEnvLine(rawLine);
            if (parsed)
                vars[parsed[0]] = parsed[1];
        }
    }
    catch {
        // Ignore read errors — return what we have
    }
    return vars;
}
/**
 * Read a single env var value from the .env file.
 * Returns null if not found.
 */
function readEnvFileValue(varName) {
    const path = envFilePath();
    if (!existsSync(path))
        return null;
    try {
        for (const rawLine of readFileSync(path, 'utf-8').split(/\r?\n/)) {
            const parsed = parseEnvLine(rawLine);
            if (parsed && parsed[0] === varName)
                return parsed[1];
        }
    }
    catch {
        // Ignore
    }
    return null;
}
/**
 * Check if an env var is currently set (file or process.env).
 * Returns true if the var has a non-empty value.
 */
export function isEnvVarPersisted(varName) {
    // Check env file first (source of truth for persisted secrets)
    const fileValue = readEnvFileValue(varName);
    if (fileValue !== null && fileValue !== '')
        return true;
    // Fall back to process.env
    const envValue = process.env[varName];
    return Boolean(envValue && envValue.length > 0);
}
/**
 * Get the current effective value of an env var.
 * Returns the value or empty string if not set.
 */
export function getEnvVarValue(varName) {
    const fileValue = readEnvFileValue(varName);
    if (fileValue !== null && fileValue !== '')
        return fileValue;
    return process.env[varName] ?? '';
}
/**
 * Save or update a value in ~/.nuvira/.env (or ~/.nuvira/.env).
 * Preserves existing lines, adds new ones at the end.
 */
export function saveEnvValue(key, value) {
    const path = envFilePath();
    const cleaned = value.replace(/[\r\n]/g, '');
    // Validate env var name
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        logger.error(`Invalid environment variable name: ${key}`);
        return { success: false, path };
    }
    const ENV_LINE_RE = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
    const pending = new Map();
    pending.set(key, cleaned);
    const lines = [];
    if (existsSync(path)) {
        for (const rawLine of readFileSync(path, 'utf-8').split(/\r?\n/)) {
            const m = rawLine.match(ENV_LINE_RE);
            if (m) {
                const k = m[2];
                if (pending.has(k)) {
                    lines.push(`${k}=${pending.get(k)}`);
                    pending.delete(k);
                    continue;
                }
            }
            lines.push(rawLine);
        }
    }
    // Append remaining new values
    for (const [k, v] of pending) {
        lines.push(`${k}=${v}`);
    }
    // Ensure directory exists
    const { mkdirSync, writeFileSync } = require('fs');
    const { dirname } = require('path');
    try {
        mkdirSync(dirname(path), { recursive: true });
    }
    catch {
        // Ignore
    }
    try {
        writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
        logger.debug(`Saved ${key} to ${path}`);
        return { success: true, path };
    }
    catch (err) {
        logger.error(`Failed to write env file: ${err}`);
        return { success: false, path };
    }
}
// ─── Interactive Capture ──────────────────────────────────────────────────
/**
 * Prompt the user for missing env vars via stdin (CLI mode).
 * Uses dynamic import to avoid bundling inquirer in non-CLI contexts.
 */
async function promptCli(entries) {
    const answers = new Map();
    try {
        const inquirer = await import('inquirer');
        const questions = entries.map((entry) => ({
            type: entry.optional ? 'input' : 'password',
            name: entry.name,
            message: entry.prompt + (entry.help ? ` (${entry.help})` : ''),
            // For optional vars, allow empty to skip
            validate: entry.optional ? () => true : (input) => {
                if (!input || input.trim().length === 0) {
                    return `${entry.name} is required. Enter a value or press Ctrl+C to skip.`;
                }
                return true;
            },
        }));
        const result = await inquirer.default.prompt(questions);
        for (const entry of entries) {
            const value = result[entry.name];
            if (typeof value === 'string' && value.trim().length > 0) {
                answers.set(entry.name, value.trim());
            }
        }
    }
    catch (err) {
        // User pressed Ctrl+C or inquirer not available
        logger.debug(`CLI prompt failed: ${err}`);
    }
    return answers;
}
/**
 * Capture missing env vars interactively.
 *
 * @param skillName - Name of the skill requiring env vars
 * @param missingEntries - List of missing env var entries
 * @param surface - 'cli' for terminal, 'dashboard' for web UI
 * @returns CaptureResult with missing vars and stored vars
 */
export async function captureSecrets(skillName, missingEntries, surface = 'cli') {
    if (missingEntries.length === 0) {
        return { missingNames: [], setupSkipped: false, storedVars: [] };
    }
    const storedVars = [];
    const missingNames = [];
    let setupSkipped = false;
    // Filter out optional vars that aren't set — we'll prompt but allow skip
    const requiredMissing = missingEntries.filter(e => !e.optional);
    const optionalMissing = missingEntries.filter(e => e.optional);
    // Show info about what's needed
    if (surface === 'cli') {
        console.log('');
        logger.info(`🔐 Skill "${skillName}" requires environment variables:`);
        for (const entry of missingEntries) {
            const tag = entry.optional ? '(optional)' : '(required)';
            console.log(`   • ${entry.name} ${tag}`);
            if (entry.help)
                console.log(`     → ${entry.help}`);
        }
        console.log('');
    }
    // Prompt for values
    if (surface === 'cli') {
        const answers = await promptCli(missingEntries);
        for (const entry of missingEntries) {
            const value = answers.get(entry.name);
            if (value && value.length > 0) {
                saveEnvValue(entry.name, value);
                process.env[entry.name] = value; // Also set in current process
                storedVars.push(entry.name);
                logger.success(`Saved ${entry.name}`);
            }
            else if (entry.optional) {
                // Optional var skipped — not an error
                logger.info(`Skipped optional var ${entry.name}`);
            }
            else {
                missingNames.push(entry.name);
            }
        }
    }
    else {
        // Dashboard surface — return missing vars for SSE event handling
        // The dashboard will handle prompting via UI components
        for (const entry of missingEntries) {
            missingNames.push(entry.name);
        }
    }
    // If required vars are still missing, mark as setup skipped
    const stillMissingRequired = missingNames.filter(name => requiredMissing.some(e => e.name === name));
    if (stillMissingRequired.length > 0) {
        setupSkipped = true;
        if (surface === 'cli') {
            console.log('');
            logger.warn(`⚠️  Setup incomplete — set these vars to use "${skillName}":`);
            for (const name of stillMissingRequired) {
                console.log(`   export ${name}="<value>"`);
            }
            console.log('');
        }
    }
    return { missingNames, setupSkipped, storedVars };
}
/**
 * Check which required env vars are missing for a skill.
 * Returns the list of entries that need prompting.
 */
export function findMissingEnvVars(requiredEnvVars) {
    const missing = [];
    for (const entry of requiredEnvVars) {
        let name;
        let prompt;
        let help;
        let optional;
        if (typeof entry === 'string') {
            name = entry;
            prompt = `Enter value for ${name}:`;
            help = undefined;
            optional = false;
        }
        else {
            name = entry.name;
            prompt = entry.prompt ?? `Enter value for ${name}:`;
            help = entry.help;
            optional = entry.optional ?? false;
        }
        if (!isEnvVarPersisted(name)) {
            missing.push({ name, prompt, help, optional });
        }
    }
    return missing;
}
/**
 * Get a summary of env var status for a skill.
 */
export function getEnvVarStatus(requiredEnvVars) {
    return requiredEnvVars.map(name => {
        const set = isEnvVarPersisted(name);
        let maskedValue;
        if (set) {
            const value = getEnvVarValue(name);
            if (value.length > 8) {
                maskedValue = value.slice(0, 4) + '...' + value.slice(-4);
            }
            else {
                maskedValue = '***';
            }
        }
        return { name, set, maskedValue };
    });
}
//# sourceMappingURL=secret-capture.js.map