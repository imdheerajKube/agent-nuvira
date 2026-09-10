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
/** Built-in roles — least privilege by default (viewer is read-only). */
export type Role = 'admin' | 'operator' | 'viewer';
export declare const ROLES: readonly Role[];
/** One user's role assignment in the local role file. */
export interface RbacUser {
    role: Role;
    /** Epoch ms the assignment was written. */
    addedAt: number;
    /** How the identity was established: 'local' (OS user) or 'oidc'. */
    via?: 'local' | 'oidc';
}
/** Actions on the admin/enterprise surface that roles gate. */
export type AdminAction = 'policy.read' | 'policy.write' | 'role.manage' | 'credential.write' | 'routing.operate' | 'team.manage' | 'sbom.write' | 'skill.remove' | 'cron.manage' | 'gateway.manage' | 'system.manage';
/**
 * Pure role→permission check — the dashboard server uses this to gate its
 * write surface by the SAME matrix the CLI enforces (a logged-in dashboard
 * user's role resolves via roleForUser, then roleCan decides the action).
 * Unknown roles have no permissions (deny by default).
 */
export declare function roleCan(role: Role | undefined | null, action: AdminAction): boolean;
/** Thrown when the current identity lacks permission for an action. */
export declare class RbacError extends Error {
    constructor(message: string);
}
/**
 * OIDC adapter interface — the seam for token-backed identity. Implement this
 * to verify a bearer token into a verified identity; the gateway milestone
 * (M6.4) will wire it in. `groups` may map to roles downstream.
 */
export interface OidcAdapter {
    /** Verify a bearer token → identity, or null when invalid/expired. */
    verify(token: string): Promise<{
        sub: string;
        email?: string;
        groups?: string[];
    } | null>;
}
/** Default adapter: no token mode — identity is always the local OS user. */
export declare class NoOidcAdapter implements OidcAdapter {
    verify(): Promise<null>;
}
/**
 * Parse a raw rbac.json file into validated users. Pure — shared by
 * RbacManager.load() and the dashboard server's readRbacData() so both always
 * agree on the shape. Invalid roles are dropped. THROWS on malformed JSON
 * (callers own the try/catch: RbacManager.load logs a warning and falls back
 * to legacy; readRbacData falls back to the legacy payload).
 */
export declare function parseRbacUsers(raw: string): Record<string, RbacUser>;
export declare class RbacManager {
    private users;
    private path;
    constructor(path?: string);
    /** The acting identity — OS user, overridable via BUFF_ACT_AS (CI/tests). */
    static currentIdentity(): string;
    /** Single-user legacy mode: no role file / no users → fully permissive. */
    isLegacyMode(): boolean;
    /** Role assigned to a user, or undefined when unassigned. */
    getRole(user: string): Role | undefined;
    /** May `user` perform `action`? Unassigned users have no permissions. */
    can(user: string, action: AdminAction): boolean;
    /** Permissions granted to a role (for `whoami` / diagnostics). */
    permissionsFor(role: Role): AdminAction[];
    /**
     * Enforce `action` for the current identity. Throws RbacError when denied.
     * Callers SHOULD check `isLegacyMode()` first (legacy = permissive), unless
     * they intend to be strict even before RBAC is configured.
     */
    requireCan(action: AdminAction, user?: string): void;
    /** Assign (or re-assign) a role. Persists. */
    assignRole(user: string, role: Role, via?: 'local' | 'oidc'): RbacUser;
    /** Remove a user's role assignment. Returns true when one existed. */
    removeUser(user: string): boolean;
    /** All assigned users, sorted by name. */
    listUsers(): Array<{
        user: string;
    } & RbacUser>;
    /** Reset to legacy mode (tests / recovery). */
    reset(): void;
    private load;
    private persist;
}
//# sourceMappingURL=rbac.d.ts.map