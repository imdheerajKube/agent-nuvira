/**
 * Credential Files — Secure credential file handling.
 *
 * Hermes equivalent: credential_files.py
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolveNuviraHome } from '../config/paths';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface CredentialFile {
  /** Credential name */
  name: string;
  /** File path */
  path: string;
  /** Whether file exists */
  exists: boolean;
  /** File permissions */
  permissions?: string;
  /** File size */
  size?: number;
  /** Whether permissions are secure */
  permissionsSecure?: boolean;
}

export interface EnvProbeResult {
  /** Environment variable name */
  name: string;
  /** Whether it's set */
  set: boolean;
  /** Value (masked if sensitive) */
  value: string;
  /** Whether it's a secret */
  isSecret: boolean;
  /** Source */
  source: 'env' | 'file' | 'default';
}

// ─── Credential File Manager ──────────────────────────────────────────────

const CREDENTIAL_DIR = join(resolveNuviraHome(), 'credentials');

const SENSITIVE_PATTERNS = [
  /key/i, /secret/i, /token/i, /password/i, /passwd/i,
  /credential/i, /auth/i, /api_key/i, /apikey/i,
];

export class CredentialFileManager {
  /**
   * Check the status of a credential file.
   */
  checkFile(filePath: string): CredentialFile {
    const exists = existsSync(filePath);
    let permissions: string | undefined;
    let size: number | undefined;
    let permissionsSecure: boolean | undefined;

    if (exists) {
      try {
        const stat = require('node:fs').statSync(filePath);
        permissions = (stat.mode & 0o777).toString(8);
        size = stat.size;
        // Check if permissions are too open (world-readable)
        permissionsSecure = (stat.mode & 0o077) === 0;
      } catch { /* ignore */ }
    }

    return { name: filePath.split('/').pop() || filePath, path: filePath, exists, permissions, size, permissionsSecure };
  }

  /**
   * Secure a credential file (set restrictive permissions).
   */
  secureFile(filePath: string): boolean {
    try {
      if (existsSync(filePath)) {
        chmodSync(filePath, 0o600); // Owner read/write only
        return true;
      }
    } catch (err) {
      logger.warn(`CredentialFileManager: Failed to secure file: ${err}`);
    }
    return false;
  }

  /**
   * Read a credential file (safe read with logging).
   */
  readFile(filePath: string): string | null {
    try {
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath, 'utf-8');
      logger.debug(`CredentialFileManager: Read credential file '${filePath}'`);
      return content;
    } catch (err) {
      logger.warn(`CredentialFileManager: Failed to read file: ${err}`);
      return null;
    }
  }

  /**
   * Write a credential file (secure write).
   */
  writeFile(filePath: string, content: string): boolean {
    try {
      const dir = filePath.split('/').slice(0, -1).join('/');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, content, 'utf-8');
      this.secureFile(filePath);
      return true;
    } catch (err) {
      logger.warn(`CredentialFileManager: Failed to write file: ${err}`);
      return false;
    }
  }

  /**
   * Hash a credential file for change detection.
   */
  hashFile(filePath: string): string | null {
    try {
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath);
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Check if a filename looks like it contains credentials.
   */
  isCredentialFilename(filename: string): boolean {
    return SENSITIVE_PATTERNS.some((p) => p.test(filename));
  }
}

// ─── Environment Probe ────────────────────────────────────────────────────

export class EnvProbe {
  private sensitiveNames = new Set([
    'API_KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'AUTH',
    'AWS_ACCESS_KEY', 'AWS_SECRET_KEY', 'DATABASE_URL',
    'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GITHUB_SECRET',
  ]);

  /**
   * Probe an environment variable.
   */
  probe(name: string): EnvProbeResult {
    const value = process.env[name];
    const isSecret = this.isSensitive(name);

    return {
      name,
      set: value !== undefined,
      value: isSecret ? this.maskValue(value || '') : (value || ''),
      isSecret,
      source: 'env',
    };
  }

  /**
   * Probe multiple environment variables.
   */
  probeMultiple(names: string[]): EnvProbeResult[] {
    return names.map((n) => this.probe(n));
  }

  /**
   * Probe all environment variables matching a pattern.
   */
  probePattern(pattern: string | RegExp): EnvProbeResult[] {
    const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
    return Object.entries(process.env)
      .filter(([key]) => regex.test(key))
      .map(([key, value]) => ({
        name: key,
        set: true,
        value: this.isSensitive(key) ? this.maskValue(value || '') : (value || ''),
        isSecret: this.isSensitive(key),
        source: 'env' as const,
      }));
  }

  private isSensitive(name: string): boolean {
    return [...this.sensitiveNames].some((s) => name.toUpperCase().includes(s));
  }

  private maskValue(value: string): string {
    if (value.length <= 8) return '****';
    return value.slice(0, 4) + '*'.repeat(value.length - 8) + value.slice(-4);
  }
}

// ─── Singletons ───────────────────────────────────────────────────────────

let _credentialFileManager: CredentialFileManager | null = null;
let _envProbe: EnvProbe | null = null;

export function getCredentialFileManager(): CredentialFileManager {
  if (!_credentialFileManager) _credentialFileManager = new CredentialFileManager();
  return _credentialFileManager;
}

export function getEnvProbe(): EnvProbe {
  if (!_envProbe) _envProbe = new EnvProbe();
  return _envProbe;
}
