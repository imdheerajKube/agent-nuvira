/**
 * Credential Files — Secure credential file handling.
 *
 * Hermes equivalent: credential_files.py
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
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
    checkFile(filePath) {
        const exists = existsSync(filePath);
        let permissions;
        let size;
        let permissionsSecure;
        if (exists) {
            try {
                const stat = require('node:fs').statSync(filePath);
                permissions = (stat.mode & 0o777).toString(8);
                size = stat.size;
                // Check if permissions are too open (world-readable)
                permissionsSecure = (stat.mode & 0o077) === 0;
            }
            catch { /* ignore */ }
        }
        return { name: filePath.split('/').pop() || filePath, path: filePath, exists, permissions, size, permissionsSecure };
    }
    /**
     * Secure a credential file (set restrictive permissions).
     */
    secureFile(filePath) {
        try {
            if (existsSync(filePath)) {
                chmodSync(filePath, 0o600); // Owner read/write only
                return true;
            }
        }
        catch (err) {
            logger.warn(`CredentialFileManager: Failed to secure file: ${err}`);
        }
        return false;
    }
    /**
     * Read a credential file (safe read with logging).
     */
    readFile(filePath) {
        try {
            if (!existsSync(filePath))
                return null;
            const content = readFileSync(filePath, 'utf-8');
            logger.debug(`CredentialFileManager: Read credential file '${filePath}'`);
            return content;
        }
        catch (err) {
            logger.warn(`CredentialFileManager: Failed to read file: ${err}`);
            return null;
        }
    }
    /**
     * Write a credential file (secure write).
     */
    writeFile(filePath, content) {
        try {
            const dir = filePath.split('/').slice(0, -1).join('/');
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
            writeFileSync(filePath, content, 'utf-8');
            this.secureFile(filePath);
            return true;
        }
        catch (err) {
            logger.warn(`CredentialFileManager: Failed to write file: ${err}`);
            return false;
        }
    }
    /**
     * Hash a credential file for change detection.
     */
    hashFile(filePath) {
        try {
            if (!existsSync(filePath))
                return null;
            const content = readFileSync(filePath);
            return createHash('sha256').update(content).digest('hex');
        }
        catch {
            return null;
        }
    }
    /**
     * Check if a filename looks like it contains credentials.
     */
    isCredentialFilename(filename) {
        return SENSITIVE_PATTERNS.some((p) => p.test(filename));
    }
}
// ─── Environment Probe ────────────────────────────────────────────────────
export class EnvProbe {
    sensitiveNames = new Set([
        'API_KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'AUTH',
        'AWS_ACCESS_KEY', 'AWS_SECRET_KEY', 'DATABASE_URL',
        'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GITHUB_SECRET',
    ]);
    /**
     * Probe an environment variable.
     */
    probe(name) {
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
    probeMultiple(names) {
        return names.map((n) => this.probe(n));
    }
    /**
     * Probe all environment variables matching a pattern.
     */
    probePattern(pattern) {
        const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
        return Object.entries(process.env)
            .filter(([key]) => regex.test(key))
            .map(([key, value]) => ({
            name: key,
            set: true,
            value: this.isSensitive(key) ? this.maskValue(value || '') : (value || ''),
            isSecret: this.isSensitive(key),
            source: 'env',
        }));
    }
    isSensitive(name) {
        return [...this.sensitiveNames].some((s) => name.toUpperCase().includes(s));
    }
    maskValue(value) {
        if (value.length <= 8)
            return '****';
        return value.slice(0, 4) + '*'.repeat(value.length - 8) + value.slice(-4);
    }
}
// ─── Singletons ───────────────────────────────────────────────────────────
let _credentialFileManager = null;
let _envProbe = null;
export function getCredentialFileManager() {
    if (!_credentialFileManager)
        _credentialFileManager = new CredentialFileManager();
    return _credentialFileManager;
}
export function getEnvProbe() {
    if (!_envProbe)
        _envProbe = new EnvProbe();
    return _envProbe;
}
//# sourceMappingURL=credential-env-tools.js.map