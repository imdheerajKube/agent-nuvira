/**
 * RbacManager — P6 M6.1 role-based access control over the admin/governance
 * surface.
 *
 * Minimal first milestone, deliberately:
 * - A local role file (`~/.nuvira/rbac.json`, or NUVIRA_CONFIG_DIR override) maps
 *   OS user → role. **Legacy single-user mode**: when the file has no users,
 *   everything stays allowed — enabling RBAC can never lock you out.
 * - A permission matrix (admin / operator / viewer) gates the `nuvira admin`
 *   surface: policy *writes* and role management require `admin`; policy
 *   *reads* are open to every role; `operator` may run routing/models.
 * - An **OIDC adapter interface** is the seam for token-backed identity: a
 *   future gateway can implement `OidcAdapter.verify(token)` and swap in
 *   verified identities without touching the enforcement paths.
 *
 * The identity for local mode is the OS username (`process.env.USER`), with
 * `BUFF_ACT_AS` as an override for CI/tests/multi-tenant tooling.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { envBuff } from '../config/paths.js';
import { resolveBuffConfigDir } from '../config/paths.js';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
export const ROLES = ['admin', 'operator', 'viewer'];
const PERMISSION_MATRIX = {
    admin: new Set(['policy.read', 'policy.write', 'role.manage', 'credential.write', 'routing.operate', 'team.manage', 'sbom.write', 'skill.remove', 'cron.manage', 'gateway.manage', 'system.manage']),
    operator: new Set(['policy.read', 'routing.operate', 'team.manage', 'sbom.write', 'cron.manage', 'gateway.manage']),
    viewer: new Set(['policy.read']),
};
const REQUIRED_ROLE_HINT = {
    'policy.read': 'any role',
    'policy.write': 'admin',
    'role.manage': 'admin',
    'credential.write': 'admin',
    'routing.operate': 'admin or operator',
    'team.manage': 'admin or operator',
    'sbom.write': 'admin or operator',
    'skill.remove': 'admin',
    'cron.manage': 'admin or operator',
    'gateway.manage': 'admin or operator',
    'system.manage': 'admin',
};
/**
 * Pure role→permission check — the dashboard server uses this to gate its
 * write surface by the SAME matrix the CLI enforces (a logged-in dashboard
 * user's role resolves via roleForUser, then roleCan decides the action).
 * Unknown roles have no permissions (deny by default).
 */
export function roleCan(role, action) {
    if (!role)
        return false;
    return PERMISSION_MATRIX[role]?.has(action) ?? false;
}
/** Thrown when the current identity lacks permission for an action. */
export class RbacError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RbacError';
    }
}
/** Default adapter: no token mode — identity is always the local OS user. */
export class NoOidcAdapter {
    async verify() {
        return null;
    }
}
/**
 * Parse a raw rbac.json file into validated users. Pure — shared by
 * RbacManager.load() and the dashboard server's readRbacData() so both always
 * agree on the shape. Invalid roles are dropped. THROWS on malformed JSON
 * (callers own the try/catch: RbacManager.load logs a warning and falls back
 * to legacy; readRbacData falls back to the legacy payload).
 */
export function parseRbacUsers(raw) {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.users)
        return {};
    const users = {};
    for (const [user, u] of Object.entries(data.users)) {
        if (u && typeof u === 'object' && ROLES.includes(u.role))
            users[user] = u;
    }
    return users;
}
// ─── Manager ────────────────────────────────────────────────────────────────
function rbacPath() {
    // Same NUVIRA_CONFIG_DIR-aware resolution as every other ~/.nuvira reader — one
    // source of truth for the precedence (explicit > NUVIRA_CONFIG_DIR > ~/.nuvira).
    return join(resolveBuffConfigDir(), 'rbac.json');
}
export class RbacManager {
    users;
    path;
    constructor(path) {
        this.path = path || rbacPath();
        this.users = this.load();
    }
    /** The acting identity — OS user, overridable via BUFF_ACT_AS (CI/tests). */
    static currentIdentity() {
        return envBuff('ACT_AS') || process.env.USER || 'local';
    }
    /** Single-user legacy mode: no role file / no users → fully permissive. */
    isLegacyMode() {
        return Object.keys(this.users).length === 0;
    }
    /** Role assigned to a user, or undefined when unassigned. */
    getRole(user) {
        return this.users[user]?.role;
    }
    /** May `user` perform `action`? Unassigned users have no permissions. */
    can(user, action) {
        const role = this.getRole(user);
        if (!role)
            return false;
        return PERMISSION_MATRIX[role].has(action);
    }
    /** Permissions granted to a role (for `whoami` / diagnostics). */
    permissionsFor(role) {
        return [...PERMISSION_MATRIX[role]];
    }
    /**
     * Enforce `action` for the current identity. Throws RbacError when denied.
     * Callers SHOULD check `isLegacyMode()` first (legacy = permissive), unless
     * they intend to be strict even before RBAC is configured.
     */
    requireCan(action, user = RbacManager.currentIdentity()) {
        if (this.can(user, action))
            return;
        const role = this.getRole(user) || 'unassigned';
        throw new RbacError(`Access denied — role '${role}' cannot '${action}' (requires ${REQUIRED_ROLE_HINT[action]}). User: ${user}`);
    }
    /** Assign (or re-assign) a role. Persists. */
    assignRole(user, role, via = 'local') {
        if (!ROLES.includes(role)) {
            throw new RbacError(`Invalid role "${role}". Valid: ${ROLES.join(', ')}`);
        }
        if (!user || !user.trim()) {
            throw new RbacError('A non-empty username is required.');
        }
        const record = { role, addedAt: Date.now(), via };
        this.users[user] = record;
        this.persist();
        return record;
    }
    /** Remove a user's role assignment. Returns true when one existed. */
    removeUser(user) {
        if (!(user in this.users))
            return false;
        delete this.users[user];
        this.persist();
        return true;
    }
    /** All assigned users, sorted by name. */
    listUsers() {
        return Object.entries(this.users)
            .map(([user, u]) => ({ user, ...u }))
            .sort((a, b) => a.user.localeCompare(b.user));
    }
    /** Reset to legacy mode (tests / recovery). */
    reset() {
        this.users = {};
        try {
            writeFileSync(this.path, JSON.stringify({ version: 1, users: {} }, null, 2), 'utf-8');
        }
        catch { /* best-effort */ }
    }
    // ─── Persistence ──────────────────────────────────────────────────────────
    load() {
        try {
            if (!existsSync(this.path))
                return {};
            return parseRbacUsers(readFileSync(this.path, 'utf-8'));
        }
        catch (err) {
            // A misconfigured role file must not silently downgrade to permissive —
            // surface it so an operator notices, then fall back safely (legacy mode).
            logger.warn(`rbac.json unreadable (${err instanceof Error ? err.message : String(err)}) — falling back to legacy permissive mode`);
            return {};
        }
    }
    persist() {
        try {
            const dir = resolveBuffConfigDir();
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
            writeFileSync(this.path, JSON.stringify({ version: 1, users: this.users }, null, 2), 'utf-8');
        }
        catch {
            // Best-effort — a failed RBAC write must never break the command.
        }
    }
}
//# sourceMappingURL=rbac.js.map