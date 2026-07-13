import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Load environment variables from .env files
 * Checks: project .env, home dir .env, and process.env
 */
export function loadEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };

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

  return env;
}

function findEnvFile(dir: string): Record<string, string> | null {
  const envPath = join(dir, '.env');
  if (existsSync(envPath)) {
    return parseEnvFile(readFileSync(envPath, 'utf-8'));
  }
  return null;
}

function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}
