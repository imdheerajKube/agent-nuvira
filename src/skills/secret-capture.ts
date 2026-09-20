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
import { resolveNuviraEnvFile } from '../config/paths.js';
import { isProviderEnvBlocked } from '../config/provider-env.js';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

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
  /**
   * Vars REFUSED because they are provider credentials (see
   * `isProviderEnvBlocked`). Reported separately from `missingNames` so a
   * caller can say *why* nothing was stored instead of silently looping.
   */
  blockedNames?: string[];
}

/** Why a save/delete did not take effect (absent when it succeeded). */
export type SecretWriteReason =
  /** The var is a provider credential — configure it as a provider instead. */
  | 'provider-credential'
  /** The name is not a valid env var identifier. */
  | 'invalid-name'
  /** The write/read failed at the filesystem layer. */
  | 'write-failed';

// ─── Env File Resolution ──────────────────────────────────────────────────

/**
 * Resolve the path to the .env file.
 * Priority: NUVIRA_ENV_FILE / BUFF_ENV_FILE > <active config dir>/.env
 *
 * Delegates to the shared resolver so secret capture agrees with loadEnv() and
 * honours `NUVIRA_CONFIG_DIR` — a hardcoded `~/.nuvira/.env` here meant an
 * isolated process could read AND write the real profile's credentials.
 */
function envFilePath(): string {
  return resolveNuviraEnvFile();
}

// ─── Core Functions ───────────────────────────────────────────────────────

/**
 * Parse a single .env line into [key, value] or null.
 */
function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const bare = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
  const eq = bare.indexOf('=');
  if (eq === -1) return null;
  const key = bare.slice(0, eq).trim();
  let value = bare.slice(eq + 1).trim();
  // Strip surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  // Strip inline comment
  const hash = value.indexOf(' #');
  if (hash !== -1) value = value.slice(0, hash).trim();
  return [key, value];
}

/**
 * Load all env vars from the .env file.
 */
export function loadEnvFile(): Record<string, string> {
  const path = envFilePath();
  const vars: Record<string, string> = {};
  if (!existsSync(path)) return vars;
  try {
    for (const rawLine of readFileSync(path, 'utf-8').split(/\r?\n/)) {
      const parsed = parseEnvLine(rawLine);
      if (parsed) vars[parsed[0]] = parsed[1];
    }
  } catch {
    // Ignore read errors — return what we have
  }
  return vars;
}

/**
 * Read a single env var value from the .env file.
 * Returns null if not found.
 */
function readEnvFileValue(varName: string): string | null {
  const path = envFilePath();
  if (!existsSync(path)) return null;
  try {
    for (const rawLine of readFileSync(path, 'utf-8').split(/\r?\n/)) {
      const parsed = parseEnvLine(rawLine);
      if (parsed && parsed[0] === varName) return parsed[1];
    }
  } catch {
    // Ignore
  }
  return null;
}

/**
 * Check if an env var is currently set (file or process.env).
 * Returns true if the var has a non-empty value.
 */
export function isEnvVarPersisted(varName: string): boolean {
  // Check env file first (source of truth for persisted secrets)
  const fileValue = readEnvFileValue(varName);
  if (fileValue !== null && fileValue !== '') return true;
  // Fall back to process.env
  const envValue = process.env[varName];
  return Boolean(envValue && envValue.length > 0);
}

/**
 * Get the current effective value of an env var.
 * Returns the value or empty string if not set.
 */
export function getEnvVarValue(varName: string): string {
  const fileValue = readEnvFileValue(varName);
  if (fileValue !== null && fileValue !== '') return fileValue;
  return process.env[varName] ?? '';
}

/**
 * Save or update a value in ~/.nuvira/.env (or ~/.nuvira/.env).
 * Preserves existing lines, adds new ones at the end.
 */
export function saveEnvValue(
  key: string,
  value: string,
  opts: {
    /**
     * Permit storing a provider credential here. Defaults to FALSE: this is the
     * SKILL-secret path, and a provider credential stored here would be
     * advertised as available to skills while `skill-executor` deliberately
     * blocks it from ever reaching them. Provider keys belong in provider
     * setup (dashboard AdminPanel / `nuvira models`), where the router also
     * learns the provider is credentialed.
     */
    allowProviderCredential?: boolean;
  } = {},
): { success: boolean; path: string; reason?: SecretWriteReason } {
  const path = envFilePath();
  const cleaned = value.replace(/[\r\n]/g, '');
  
  // Validate env var name
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    logger.error(`Invalid environment variable name: ${key}`);
    return { success: false, path, reason: 'invalid-name' };
  }

  // Provider credentials are refused unless a caller explicitly opts in.
  // Without this the dashboard's 🔒 badge was decorative: the endpoint accepted
  // the key and wrote it, so a "blocked" row could be saved through the API.
  if (!opts.allowProviderCredential && isProviderEnvBlocked(key)) {
    logger.warn(
      `Refusing to store ${key} as a skill secret — it is a provider credential. ` +
      'Configure it through provider setup instead.',
    );
    return { success: false, path, reason: 'provider-credential' };
  }

  const ENV_LINE_RE = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
  const pending = new Map<string, string>();
  pending.set(key, cleaned);
  const lines: string[] = [];

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
  } catch {
    // Ignore
  }

  try {
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
    logger.debug(`Saved ${key} to ${path}`);
    return { success: true, path };
  } catch (err) {
    logger.error(`Failed to write env file: ${err}`);
    return { success: false, path, reason: 'write-failed' };
  }
}

/**
 * Remove an env var from the .env file.
 *
 * Rewrites the file keeping every other line — comments, blank lines and
 * ordering — byte-for-byte, so deleting one secret never reshuffles the file
 * a user hand-edited. Removes `KEY=...` in both plain and `export KEY=` forms,
 * and drops only the FIRST match (a duplicate later in the file is a different
 * line, and removing it too would be surprising).
 *
 * A missing file, or a key that was never there, is a SUCCESS: the caller's
 * intent ("this var should not be set") already holds, and reporting failure
 * would make the dashboard surface a pointless error.
 */
export function deleteEnvValue(key: string): { success: boolean; path: string; removed: boolean; reason?: SecretWriteReason } {
  const path = envFilePath();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return { success: false, path, removed: false, reason: 'invalid-name' };
  }
  if (!existsSync(path)) {
    return { success: true, path, removed: false };
  }

  const ENV_LINE_RE = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  const kept: string[] = [];
  let removed = false;

  for (const rawLine of lines) {
    const m = rawLine.match(ENV_LINE_RE);
    if (!removed && m && m[2] === key) {
      removed = true;
      continue;
    }
    kept.push(rawLine);
  }

  if (!removed) {
    return { success: true, path, removed: false };
  }

  try {
    const { writeFileSync } = require('fs');
    // Drop the trailing empty element left by the final newline, then re-add
    // exactly one — matching saveEnvValue's file shape.
    const body = kept.filter((l, i) => !(i === kept.length - 1 && l === '')).join('\n');
    writeFileSync(path, body.length > 0 ? `${body}\n` : '', 'utf-8');
    logger.debug(`Removed ${key} from ${path}`);
    return { success: true, path, removed: true };
  } catch (err) {
    logger.error(`Failed to write env file: ${err}`);
    return { success: false, path, removed: false, reason: 'write-failed' };
  }
}

// ─── Interactive Capture ──────────────────────────────────────────────────

/**
 * Prompt the user for missing env vars via stdin (CLI mode).
 * Uses dynamic import to avoid bundling inquirer in non-CLI contexts.
 */
async function promptCli(
  entries: EnvVarEntry[],
): Promise<Map<string, string>> {
  const answers = new Map<string, string>();
  
  try {
    const inquirer = await import('inquirer');
    
    const questions = entries.map((entry) => ({
      type: entry.optional ? 'input' : 'password',
      name: entry.name,
      message: entry.prompt + (entry.help ? ` (${entry.help})` : ''),
      // For optional vars, allow empty to skip
      validate: entry.optional ? () => true : (input: string) => {
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
  } catch (err) {
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
export async function captureSecrets(
  skillName: string,
  missingEntries: EnvVarEntry[],
  surface: 'cli' | 'dashboard' = 'cli',
): Promise<CaptureResult> {
  if (missingEntries.length === 0) {
    return { missingNames: [], setupSkipped: false, storedVars: [], blockedNames: [] };
  }

  const storedVars: string[] = [];
  const missingNames: string[] = [];
  const blockedNames: string[] = [];
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
      if (entry.help) console.log(`     → ${entry.help}`);
    }
    console.log('');
  }

  // Prompt for values
  if (surface === 'cli') {
    const answers = await promptCli(missingEntries);
    
    for (const entry of missingEntries) {
      const value = answers.get(entry.name);
      if (value && value.length > 0) {
        const saved = saveEnvValue(entry.name, value);
        if (!saved.success) {
          // Refused (provider credential / invalid name). Do not claim it was
          // stored, and do not silently set it in-process either — that would
          // make the refusal meaningless for this run.
          blockedNames.push(entry.name);
          missingNames.push(entry.name);
          logger.warn(`${entry.name} was not stored (${saved.reason ?? 'refused'})`);
          continue;
        }
        process.env[entry.name] = value; // Also set in current process
        storedVars.push(entry.name);
        logger.success(`Saved ${entry.name}`);
      } else if (entry.optional) {
        // Optional var skipped — not an error
        logger.info(`Skipped optional var ${entry.name}`);
      } else {
        missingNames.push(entry.name);
      }
    }
  } else {
    // Dashboard surface — return missing vars for SSE event handling
    // The dashboard will handle prompting via UI components
    for (const entry of missingEntries) {
      missingNames.push(entry.name);
    }
  }

  // If required vars are still missing, mark as setup skipped
  const stillMissingRequired = missingNames.filter(
    name => requiredMissing.some(e => e.name === name)
  );
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

  return { missingNames, setupSkipped, storedVars, blockedNames };
}

/**
 * Check which required env vars are missing for a skill.
 * Returns the list of entries that need prompting.
 */
export function findMissingEnvVars(
  requiredEnvVars: string[] | Array<{ name: string; prompt?: string; help?: string; optional?: boolean }>,
): EnvVarEntry[] {
  const missing: EnvVarEntry[] = [];

  for (const entry of requiredEnvVars) {
    let name: string;
    let prompt: string;
    let help: string | undefined;
    let optional: boolean;

    if (typeof entry === 'string') {
      name = entry;
      prompt = `Enter value for ${name}:`;
      help = undefined;
      optional = false;
    } else {
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
export function getEnvVarStatus(
  requiredEnvVars: string[],
): Array<{ name: string; set: boolean; maskedValue?: string }> {
  return requiredEnvVars.map(name => {
    const set = isEnvVarPersisted(name);
    let maskedValue: string | undefined;
    if (set) {
      const value = getEnvVarValue(name);
      if (value.length > 8) {
        maskedValue = value.slice(0, 4) + '...' + value.slice(-4);
      } else {
        maskedValue = '***';
      }
    }
    return { name, set, maskedValue };
  });
}
