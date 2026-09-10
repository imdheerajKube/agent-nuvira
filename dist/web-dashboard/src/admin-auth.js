/**
 * Dashboard admin auth (Session 18 — the auth'd WRITE phase of the admin surface).
 *
 * The control layer the user described: dashboard admin writes (API-key /
 * provider configuration) are gated by a user-id + password. This module is
 * deliberately self-contained and pure so it is unit-testable without a server:
 *
 * - Credentials live in `~/.nuvira/dashboard-admin.json` (or NUVIRA_CONFIG_DIR
 *   override — the same dir the RBAC role file uses). Only a scrypt hash is
 *   stored, never the password.
 * - `BUFF_DASHBOARD_ADMIN_USER` / `BUFF_DASHBOARD_ADMIN_PASSWORD` env override
 *   is the zero-config path (explicit, documented; useful for automation).
 * - Sessions are in-memory Bearer tokens (Node crypto.randomUUID) with an 8h
 *   expiry — no cookies, no persistence. Restarting the dashboard server
 *   invalidates sessions (acceptable: the surface is local-first).
 *
 * The CLI is NEVER deprecated: this gate only guards the dashboard's GUI write
 * paths; `nuvira config set` keeps working exactly as before (GUI parallel).
 */
import { scryptSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { envBuff } from '../../config/paths.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBuffConfigDir } from '../../config/paths.js';
import { RbacManager, ROLES } from '../../enterprise/rbac.js';
/** Admin credential file (config-dir scoped, same dir as rbac.json). */
const ADMIN_FILE = 'dashboard-admin.json';
/** The stored file format version. */
const ADMIN_FILE_VERSION = 1;
/** Default role for the env override. */
const ENV_DEFAULT_ROLE = 'admin';
/** Session lifetime: 8 hours. */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** Fixed salt for the constant-time env-password comparison (NOT for storage). */
const ENV_HASH_SALT = 'buff-dashboard-env-admin-v1';
/** Minimum password length for the bootstrap setup (reject typos-adjacent weak setups). */
export const MIN_ADMIN_PASSWORD_LENGTH = 8;
/**
 * The role a logged-in dashboard user ACTS with. Precedence: the env override's
 * own role when the user IS the env user (the zero-config automation path must
 * never degrade to viewer), then rbac.json when the username is assigned there
 * (CLI governance parity: one role source), then the credential file's own
 * role. When rbac.json has no users (legacy permissive mode), the credential
 * role applies unchanged. Unknown users resolve to viewer (deny by default).
 */
export function roleForUser(user, configDir) {
    const env = envAdminOverride();
    if (env && env.user === user)
        return env.role;
    const rbac = new RbacManager(configDir ? join(configDir, 'rbac.json') : undefined);
    const rbacRole = rbac.getRole(user);
    if (rbacRole)
        return rbacRole;
    return readAdminUsers(configDir)?.[user]?.role ?? 'viewer';
}
/** scrypt-hash a password with a fresh (or provided) salt. Returns both parts. */
export function hashAdminPassword(password, salt = randomBytes(16).toString('hex')) {
    const derived = scryptSync(password, salt, 64).toString('hex');
    return { salt, hash: derived };
}
/** Constant-time password check against a stored hash. */
export function verifyAdminPassword(password, salt, hash) {
    try {
        const derived = scryptSync(password, salt, 64);
        const expected = Buffer.from(hash, 'hex');
        return expected.length === derived.length && timingSafeEqual(derived, expected);
    }
    catch {
        return false;
    }
}
export function adminConfigPath(configDir) {
    return join(configDir ?? resolveBuffConfigDir(), ADMIN_FILE);
}
/**
 * Read the stored admin users, or null when not configured/corrupt.
 * Backwards-compatible with the Session 18 single-user file shape
 * (`{ user, salt, hash, createdAt }` — promoted to role 'admin').
 */
export function readAdminUsers(configDir) {
    try {
        const p = adminConfigPath(configDir);
        if (!existsSync(p))
            return null;
        const raw = JSON.parse(readFileSync(p, 'utf-8'));
        if (raw && typeof raw === 'object' && 'users' in raw && raw.users && typeof raw.users === 'object') {
            // v1 format: { version, users }
            const users = {};
            for (const [user, u] of Object.entries(raw.users)) {
                if (u && typeof u.user === 'string' && typeof u.salt === 'string' && typeof u.hash === 'string' && ROLES.includes(u.role)) {
                    users[user] = u;
                }
            }
            return users;
        }
        // Legacy Session 18 shape: a single { user, salt, hash, createdAt } record.
        const legacy = raw;
        if (typeof legacy?.user === 'string' && typeof legacy?.salt === 'string' && typeof legacy?.hash === 'string') {
            return { [legacy.user]: { ...legacy, role: 'admin' } };
        }
        return null;
    }
    catch {
        return null;
    }
}
/** Upsert an admin user (scrypt-hashed). Returns the stored record. */
export function writeAdminUser(user, password, role, configDir) {
    if (!ROLES.includes(role))
        throw new Error(`Invalid role "${role}". Valid: ${ROLES.join(', ')}`);
    const dir = configDir ?? resolveBuffConfigDir();
    mkdirSync(dir, { recursive: true });
    const existing = readAdminUsers(configDir) || {};
    const { salt, hash } = hashAdminPassword(password);
    const record = { user, role, salt, hash, createdAt: existing[user]?.createdAt ?? Date.now() };
    existing[user] = record;
    writeFileSync(adminConfigPath(configDir), JSON.stringify({ version: ADMIN_FILE_VERSION, users: existing }, null, 2), 'utf-8');
    return record;
}
/** Remove an admin user. Returns true when one existed. */
export function removeAdminUser(user, configDir) {
    const users = readAdminUsers(configDir);
    if (!users || !users[user])
        return false;
    delete users[user];
    writeFileSync(adminConfigPath(configDir), JSON.stringify({ version: ADMIN_FILE_VERSION, users }, null, 2), 'utf-8');
    return true;
}
/** All admin users (salt/hash excluded) sorted by name. */
export function listAdminUsers(configDir) {
    const users = readAdminUsers(configDir) || {};
    return Object.values(users)
        .map((u) => ({ user: u.user, role: u.role, createdAt: u.createdAt }))
        .sort((a, b) => a.user.localeCompare(b.user));
}
/** The number of stored admin-role users (for the last-admin guard). */
export function countAdminRoleUsers(configDir) {
    const users = readAdminUsers(configDir) || {};
    return Object.values(users).filter((u) => roleForUser(u.user, configDir) === 'admin').length;
}
/**
 * Zero-config env override: `BUFF_DASHBOARD_ADMIN_PASSWORD` (with optional
 * `BUFF_DASHBOARD_ADMIN_USER` defaulting to 'admin' and
 * `BUFF_DASHBOARD_ADMIN_ROLE` defaulting to 'admin'). When set, it wins over
 * the file — explicit automation override. Single-user by design.
 */
export function envAdminOverride() {
    const password = envBuff('DASHBOARD_ADMIN_PASSWORD');
    if (!password)
        return null;
    const role = envBuff('DASHBOARD_ADMIN_ROLE') || ENV_DEFAULT_ROLE;
    return {
        user: envBuff('DASHBOARD_ADMIN_USER')?.trim() || 'admin',
        password,
        role: ROLES.includes(role) ? role : ENV_DEFAULT_ROLE,
    };
}
/** True once an admin credential exists (file or env override). */
export function isAdminConfigured(configDir) {
    return readAdminUsers(configDir) !== null || envAdminOverride() !== null;
}
/**
 * Verify a user-id + password (env override first, then the stored file).
 * Both paths compare in constant time: the env override hashes the two
 * passwords with a fixed salt before timingSafeEqual (string `===` would
 * leak length/prefix timing on a network-exposed dashboard).
 */
export function verifyAdmin(user, password, configDir) {
    const env = envAdminOverride();
    if (env) {
        if (env.user !== user)
            return false;
        const a = scryptSync(password, ENV_HASH_SALT, 64);
        const b = scryptSync(env.password, ENV_HASH_SALT, 64);
        return a.length === b.length && timingSafeEqual(a, b);
    }
    const record = readAdminUsers(configDir)?.[user];
    if (!record)
        return false;
    return verifyAdminPassword(password, record.salt, record.hash);
}
/**
 * In-memory Bearer-token sessions (8h expiry) carrying the user's ROLE.
 * One instance per server process. The role is resolved at issue-time
 * (rbac.json username match wins, else the credential's role).
 */
export class AdminSessions {
    sessions = new Map();
    issue(user, role) {
        const token = randomUUID();
        this.sessions.set(token, { user, role, expiresAt: Date.now() + SESSION_TTL_MS });
        return token;
    }
    /** Resolve a token to its user + role, or null when invalid/expired (expired entries are reaped). */
    validate(token) {
        if (!token)
            return null;
        const s = this.sessions.get(token);
        if (!s)
            return null;
        if (s.expiresAt < Date.now()) {
            this.sessions.delete(token);
            return null;
        }
        return { user: s.user, role: s.role };
    }
    revoke(token) {
        if (!token)
            return false;
        return this.sessions.delete(token);
    }
    /** Test hook: number of live sessions. */
    size() {
        return this.sessions.size;
    }
}
//# sourceMappingURL=admin-auth.js.map