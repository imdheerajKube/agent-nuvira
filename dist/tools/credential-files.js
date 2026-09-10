/**
 * credential_files — Credential file management for remote terminal backends.
 *
 * Manages credential files for Docker, SSH, Modal sandbox execution:
 * - Tracks which credential files exist
 * - Provides secure access to credentials
 * - Redacts credentials in logs
 * - Supports multiple credential types
 */
import * as fs from 'fs';
import { join } from 'node:path';
import { resolveNuviraHome } from '../config/paths.js';
import * as path from 'path';
// ─── Credential Files Manager ───────────────────────────────────────────────
class CredentialFilesManager {
    credentials = new Map();
    manifestPath;
    manifest;
    constructor(configDir) {
        const dir = configDir || join(resolveNuviraHome(), 'credentials');
        this.manifestPath = path.join(dir, 'manifest.json');
        this.manifest = this.loadManifest();
    }
    /**
     * Register a credential file.
     */
    register(params) {
        const id = `cred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const exists = fs.existsSync(params.path);
        const credential = {
            id,
            name: params.name,
            type: params.type,
            path: params.path,
            exists,
            createdAt: Date.now(),
            metadata: params.metadata,
        };
        this.credentials.set(id, credential);
        this.manifest.credentials.push(credential);
        this.saveManifest();
        return id;
    }
    /**
     * Get a credential file.
     */
    get(id) {
        const cred = this.credentials.get(id);
        if (cred) {
            cred.lastAccessed = Date.now();
            cred.exists = fs.existsSync(cred.path);
        }
        return cred || null;
    }
    /**
     * Read credential content.
     */
    read(id) {
        const cred = this.credentials.get(id);
        if (!cred || !cred.exists) {
            return null;
        }
        try {
            return fs.readFileSync(cred.path, 'utf-8');
        }
        catch {
            return null;
        }
    }
    /**
     * List all credentials.
     */
    list(type) {
        const all = Array.from(this.credentials.values());
        if (type) {
            return all.filter((c) => c.type === type);
        }
        return all;
    }
    /**
     * Remove a credential.
     */
    remove(id) {
        const cred = this.credentials.get(id);
        if (!cred) {
            return false;
        }
        this.credentials.delete(id);
        this.manifest.credentials = this.manifest.credentials.filter((c) => c.id !== id);
        this.saveManifest();
        return true;
    }
    /**
     * Redact credentials in text.
     */
    redact(text) {
        let result = text;
        for (const cred of this.credentials.values()) {
            if (cred.exists) {
                try {
                    const content = fs.readFileSync(cred.path, 'utf-8').trim();
                    if (content) {
                        // Redact the actual content
                        result = result.replace(new RegExp(content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), `[REDACTED:${cred.name}]`);
                    }
                }
                catch {
                    // Ignore read errors
                }
            }
        }
        // Also redact common patterns
        result = result
            .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
            .replace(/ghp_[A-Za-z0-9]+/g, 'ghp_[REDACTED]')
            .replace(/sk-[A-Za-z0-9]+/g, 'sk_[REDACTED]')
            .replace(/password\s*[:=]\s*[^\s,}]+/gi, 'password=[REDACTED]')
            .replace(/token\s*[:=]\s*[^\s,}]+/gi, 'token=[REDACTED]');
        return result;
    }
    /**
     * Get credential paths for mounting in containers.
     */
    getMountPaths() {
        return Array.from(this.credentials.values())
            .filter((c) => c.exists)
            .map((c) => c.path);
    }
    /**
     * Validate all credentials exist.
     */
    validate() {
        const missing = [];
        let valid = 0;
        for (const cred of this.credentials.values()) {
            if (fs.existsSync(cred.path)) {
                valid++;
            }
            else {
                missing.push(cred.name);
            }
        }
        return {
            valid,
            invalid: missing.length,
            missing,
        };
    }
    /**
     * Load manifest from disk.
     */
    loadManifest() {
        try {
            if (fs.existsSync(this.manifestPath)) {
                const data = JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
                // Restore credentials map
                for (const cred of data.credentials) {
                    this.credentials.set(cred.id, cred);
                }
                return data;
            }
        }
        catch {
            // Ignore errors
        }
        return {
            credentials: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
    }
    /**
     * Save manifest to disk.
     */
    saveManifest() {
        try {
            const dir = path.dirname(this.manifestPath);
            fs.mkdirSync(dir, { recursive: true });
            this.manifest.updatedAt = Date.now();
            fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf-8');
        }
        catch {
            // Ignore errors
        }
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let _instance = null;
export function getCredentialFilesManager() {
    if (!_instance)
        _instance = new CredentialFilesManager();
    return _instance;
}
export { CredentialFilesManager };
//# sourceMappingURL=credential-files.js.map