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
import { type Role } from '../../enterprise/rbac.js';
/** Minimum password length for the bootstrap setup (reject typos-adjacent weak setups). */
export declare const MIN_ADMIN_PASSWORD_LENGTH = 8;
/** One dashboard admin user: scrypt-hashed password + a governance role. */
export interface AdminUser {
    user: string;
    role: Role;
    salt: string;
    hash: string;
    createdAt: number;
}
/**
 * The role a logged-in dashboard user ACTS with. Precedence: the env override's
 * own role when the user IS the env user (the zero-config automation path must
 * never degrade to viewer), then rbac.json when the username is assigned there
 * (CLI governance parity: one role source), then the credential file's own
 * role. When rbac.json has no users (legacy permissive mode), the credential
 * role applies unchanged. Unknown users resolve to viewer (deny by default).
 */
export declare function roleForUser(user: string, configDir?: string): Role;
/** scrypt-hash a password with a fresh (or provided) salt. Returns both parts. */
export declare function hashAdminPassword(password: string, salt?: string): {
    salt: string;
    hash: string;
};
/** Constant-time password check against a stored hash. */
export declare function verifyAdminPassword(password: string, salt: string, hash: string): boolean;
export declare function adminConfigPath(configDir?: string): string;
/**
 * Read the stored admin users, or null when not configured/corrupt.
 * Backwards-compatible with the Session 18 single-user file shape
 * (`{ user, salt, hash, createdAt }` — promoted to role 'admin').
 */
export declare function readAdminUsers(configDir?: string): Record<string, AdminUser> | null;
/** Upsert an admin user (scrypt-hashed). Returns the stored record. */
export declare function writeAdminUser(user: string, password: string, role: Role, configDir?: string): AdminUser;
/** Remove an admin user. Returns true when one existed. */
export declare function removeAdminUser(user: string, configDir?: string): boolean;
/** All admin users (salt/hash excluded) sorted by name. */
export declare function listAdminUsers(configDir?: string): Array<Pick<AdminUser, 'user' | 'role' | 'createdAt'>>;
/** The number of stored admin-role users (for the last-admin guard). */
export declare function countAdminRoleUsers(configDir?: string): number;
/**
 * Zero-config env override: `BUFF_DASHBOARD_ADMIN_PASSWORD` (with optional
 * `BUFF_DASHBOARD_ADMIN_USER` defaulting to 'admin' and
 * `BUFF_DASHBOARD_ADMIN_ROLE` defaulting to 'admin'). When set, it wins over
 * the file — explicit automation override. Single-user by design.
 */
export declare function envAdminOverride(): {
    user: string;
    password: string;
    role: Role;
} | null;
/** True once an admin credential exists (file or env override). */
export declare function isAdminConfigured(configDir?: string): boolean;
/**
 * Verify a user-id + password (env override first, then the stored file).
 * Both paths compare in constant time: the env override hashes the two
 * passwords with a fixed salt before timingSafeEqual (string `===` would
 * leak length/prefix timing on a network-exposed dashboard).
 */
export declare function verifyAdmin(user: string, password: string, configDir?: string): boolean;
export interface AdminSession {
    user: string;
    role: Role;
}
/**
 * In-memory Bearer-token sessions (8h expiry) carrying the user's ROLE.
 * One instance per server process. The role is resolved at issue-time
 * (rbac.json username match wins, else the credential's role).
 */
export declare class AdminSessions {
    private sessions;
    issue(user: string, role: Role): string;
    /** Resolve a token to its user + role, or null when invalid/expired (expired entries are reaped). */
    validate(token: string | undefined | null): AdminSession | null;
    revoke(token: string | undefined | null): boolean;
    /** Test hook: number of live sessions. */
    size(): number;
}
//# sourceMappingURL=admin-auth.d.ts.map