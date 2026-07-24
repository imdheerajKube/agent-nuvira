import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
/**
 * Load environment variables from .env files
 * Checks: project .env, home dir .env, and process.env
 *
 * .env file features:
 * - Lines starting with # are comments
 * - Inline comments are supported (KEY=value # comment)
 * - export prefix is stripped (export KEY=value)
 * - Variable expansion: $VAR, ${VAR}, ${VAR:-default}
 *   - References already-parsed vars in the same file first
 *   - Falls back to process.env
 *   - ${VAR:-default} uses 'default' if VAR is not set
 * - Windows CRLF line endings are handled
 * - Quoted values (single and double) are unquoted
 * - Double-quoted values support variable expansion
 * - Single-quoted values are literal (no expansion)
 */
export function loadEnv() {
    const env = { ...process.env };
    // Try loading from .env in project root
    const projectEnv = findEnvFile(process.cwd());
    if (projectEnv) {
        Object.assign(env, projectEnv);
    }
    // Try loading from ~/.buff/.env
    const homeEnvPath = join(homedir(), '.buff', '.env');
    if (existsSync(homeEnvPath)) {
        const homeEnv = parseEnvFile(readFileSync(homeEnvPath, 'utf-8'));
        Object.assign(env, homeEnv);
    }
    // Write .env values back to process.env so that consumers reading
    // from process.env directly (e.g. dashboard server) pick them up.
    // Do NOT override existing process.env values — system env vars take priority.
    for (const [key, value] of Object.entries(env)) {
        if (!(key in process.env) && value !== undefined) {
            process.env[key] = value;
        }
    }
    return env;
}
function findEnvFile(dir) {
    const envPath = join(dir, '.env');
    if (existsSync(envPath)) {
        return parseEnvFile(readFileSync(envPath, 'utf-8'));
    }
    return null;
}
/**
 * Parse a .env file content into key-value pairs.
 *
 * Supports:
 * - Comments: # full line  and  KEY=val # inline comment
 * - export prefix: export KEY=value
 * - Variable expansion: $VAR, ${VAR}, ${VAR:-default}
 * - Quoted values: KEY="value"  KEY='value'
 * - CRLF line endings
 * - Empty lines
 */
function parseEnvFile(content) {
    const env = {};
    const lines = splitIntoLines(content);
    for (const rawLine of lines) {
        // Skip empty lines and full-line comments
        if (rawLine.length === 0)
            continue;
        // Strip 'export ' prefix if present
        const trimmed = rawLine.startsWith('export ')
            ? rawLine.slice(7).trimStart()
            : rawLine;
        // Check if the line is just a comment after stripping export
        if (trimmed.startsWith('#') || trimmed.length === 0)
            continue;
        // Find the first '=' that separates key from value
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1)
            continue;
        const key = trimmed.slice(0, eqIndex).trim();
        if (!key)
            continue;
        const rawValue = trimmed.slice(eqIndex + 1).trim();
        // Parse the value, handling quotes and inline comments
        const value = parseValue(rawValue, env);
        env[key] = value;
    }
    return env;
}
/**
 * Split content into lines, handling CRLF and trailing newlines.
 */
function splitIntoLines(content) {
    // Normalize CRLF to LF, then split
    const normalized = content.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    // Trim trailing empty line from final newline
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        return lines.slice(0, -1);
    }
    return lines;
}
/**
 * Parse a value string from a .env file line.
 *
 * Handles:
 * - Unquoted values: strip inline comments, expand vars
 * - Double-quoted values: unquote, expand vars, preserve inline comments
 * - Single-quoted values: unquote, literal (no expansion, no comment stripping)
 */
function parseValue(rawValue, env) {
    if (rawValue.length === 0)
        return '';
    // Single-quoted: literal value, no expansion, no inline comments
    if (rawValue.startsWith("'")) {
        const closingQuote = rawValue.indexOf("'", 1);
        if (closingQuote !== -1) {
            return rawValue.slice(1, closingQuote);
        }
        // No closing quote — treat rest as literal
        return rawValue.slice(1);
    }
    // Double-quoted or unquoted: handle inline comments and variable expansion
    // First, strip inline comments from unquoted values
    // (Double-quoted values keep everything inside the quotes, including #)
    let value;
    if (rawValue.startsWith('"')) {
        // Find closing double quote
        const closingQuote = findClosingQuote(rawValue, 0);
        if (closingQuote !== -1) {
            value = rawValue.slice(1, closingQuote);
            // Rest after the closing quote is ignored (could be an inline comment)
        }
        else {
            // No closing quote — treat entire rest as value
            value = rawValue.slice(1);
        }
    }
    else {
        // Unquoted: strip inline comments
        value = stripInlineComment(rawValue);
    }
    // Expand variables
    value = expandVariables(value, env);
    return value;
}
/**
 * Find the closing double quote starting from a given position.
 * Handles escaped quotes inside the string.
 */
function findClosingQuote(s, start) {
    let i = start + 1;
    while (i < s.length) {
        if (s[i] === '\\') {
            i += 2; // Skip escaped character
            continue;
        }
        if (s[i] === '"') {
            return i;
        }
        i++;
    }
    return -1;
}
/**
 * Strip inline comments from an unquoted value.
 *
 * A '#' starts a comment UNLESS it's inside:
 * - A quoted string (single or double)
 * - It's escaped (\#)
 */
function stripInlineComment(value) {
    let result = '';
    let i = 0;
    while (i < value.length) {
        // Escaped character — keep literally
        if (value[i] === '\\' && i + 1 < value.length) {
            result += value[i + 1];
            i += 2;
            continue;
        }
        // Start of a quote — find matching closing quote and include the whole thing
        if (value[i] === "'") {
            const close = value.indexOf("'", i + 1);
            if (close !== -1) {
                result += value.slice(i, close + 1);
                i = close + 1;
                continue;
            }
            // No closing quote — include rest
            result += value.slice(i);
            break;
        }
        if (value[i] === '"') {
            const close = findClosingQuote(value, i);
            if (close !== -1) {
                result += value.slice(i, close + 1);
                i = close + 1;
                continue;
            }
            // No closing quote — include rest
            result += value.slice(i);
            break;
        }
        // Comment start — stop here
        if (value[i] === '#') {
            break;
        }
        result += value[i];
        i++;
    }
    return result.trim();
}
/**
 * Expand variable references in a value string.
 *
 * Supports:
 * - $VAR — simple variable reference (ends at non-identifier char)
 * - ${VAR} — explicit variable reference
 * - ${VAR:-default} — with default value if VAR is unset or empty
 *
 * Variables are resolved from:
 * 1. The current file's already-parsed env object
 * 2. process.env as fallback
 */
function expandVariables(value, env) {
    if (!value.includes('$'))
        return value;
    return value.replace(/\$(?:\{([^}]+)\}|([a-zA-Z_][a-zA-Z0-9_]*))/g, (match, bracedVar, simpleVar) => {
        if (bracedVar !== undefined) {
            // ${VAR} or ${VAR:-default}
            const colonDefaultIndex = bracedVar.indexOf(':-');
            if (colonDefaultIndex !== -1) {
                const varName = bracedVar.slice(0, colonDefaultIndex);
                const defaultValue = bracedVar.slice(colonDefaultIndex + 2);
                // Bash semantics: use default if var is unset OR empty
                const resolved = resolveVar(varName, env);
                if (resolved !== null && resolved !== '')
                    return resolved;
                return defaultValue;
            }
            return resolveVar(bracedVar, env) ?? '';
        }
        // $VAR
        return resolveVar(simpleVar, env) ?? '';
    });
}
/**
 * Resolve a single variable name from the env object or process.env.
 */
function resolveVar(varName, env) {
    if (varName in env)
        return env[varName];
    if (varName in process.env)
        return process.env[varName];
    return null;
}
//# sourceMappingURL=env.js.map