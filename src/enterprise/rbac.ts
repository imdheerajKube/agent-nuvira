/**
 * RbacManager — P6 M6.1 role-based access control over the admin/governance
 * surface.
 *
 * Minimal first milestone, deliberately:
 * - A local role file (`~/.buff/rbac.json`, or BUFF_CONFIG_DIR override) maps
 *   OS user → role. **Legacy single-user mode**: when the file has no users,
 *   everything stays allowed — enabling RBAC can never lock you out.
 * - A permission matrix (admin / operator / viewer) gates the `buff admin`
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
import { resolveBuffConfigDir } from '../config/paths.js';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Built-in roles — least privilege by default (viewer is read-only). */
export type Role = 'admin' | 'operator' | 'viewer';
export const ROLES: readonly Role[] = ['admin', 'operator', 'viewer'];

/** One user's role assignment in the local role file. */
export interface RbacUser {
  role: Role;
  /** Epoch ms the assignment was written. */
  addedAt: number;
  /** How the identity was established: 'local' (OS user) or 'oidc'. */
  via?: 'local' | 'oidc';
}

/** Actions on the admin/enterprise surface that roles gate. */
export type AdminAction =
  | 'policy.read'        // view the governance policy (any role)
  | 'policy.write'       // allow/deny/max-cost/pii-min/unblock/clear (admin)
  | 'role.manage'        // assign/remove roles (admin)
  | 'credential.write'   // rotate provider credentials (admin; reserved for the gateway milestone)
  | 'routing.operate';   // run routing/model commands (admin + operator)

const PERMISSION_MATRIX: Record<Role, ReadonlySet<AdminAction>> = {
  admin: new Set(['policy.read', 'policy.write', 'role.manage', 'credential.write', 'routing.operate']),
  operator: new Set(['policy.read', 'routing.operate']),
  viewer: new Set(['policy.read']),
};

const REQUIRED_ROLE_HINT: Record<AdminAction, string> = {
  'policy.read': 'any role',
  'policy.write': 'admin',
  'role.manage': 'admin',
  'credential.write': 'admin',
  'routing.operate': 'admin or operator',
};

/** Thrown when the current identity lacks permission for an action. */
export class RbacError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RbacError';
  }
}

/**
 * OIDC adapter interface — the seam for token-backed identity. Implement this
 * to verify a bearer token into a verified identity; the gateway milestone
 * (M6.4) will wire it in. `groups` may map to roles downstream.
 */
export interface OidcAdapter {
  /** Verify a bearer token → identity, or null when invalid/expired. */
  verify(token: string): Promise<{ sub: string; email?: string; groups?: string[] } | null>;
}

/** Default adapter: no token mode — identity is always the local OS user. */
export class NoOidcAdapter implements OidcAdapter {
  async verify(): Promise<null> {
    return null;
  }
}

interface RbacConfig {
  version: number;
  users: Record<string, RbacUser>;
}

/**
 * Parse a raw rbac.json file into validated users. Pure — shared by
 * RbacManager.load() and the dashboard server's readRbacData() so both always
 * agree on the shape. Invalid roles are dropped. THROWS on malformed JSON
 * (callers own the try/catch: RbacManager.load logs a warning and falls back
 * to legacy; readRbacData falls back to the legacy payload).
 */
export function parseRbacUsers(raw: string): Record<string, RbacUser> {
  const data = JSON.parse(raw) as RbacConfig;
  if (!data || typeof data !== 'object' || !data.users) return {};
  const users: Record<string, RbacUser> = {};
  for (const [user, u] of Object.entries(data.users)) {
    if (u && typeof u === 'object' && ROLES.includes(u.role)) users[user] = u;
  }
  return users;
}

// ─── Manager ────────────────────────────────────────────────────────────────

function rbacPath(): string {
  // Same BUFF_CONFIG_DIR-aware resolution as every other ~/.buff reader — one
  // source of truth for the precedence (explicit > BUFF_CONFIG_DIR > ~/.buff).
  return join(resolveBuffConfigDir(), 'rbac.json');
}

export class RbacManager {
  private users: Record<string, RbacUser>;
  private path: string;

  constructor(path?: string) {
    this.path = path || rbacPath();
    this.users = this.load();
  }

  /** The acting identity — OS user, overridable via BUFF_ACT_AS (CI/tests). */
  static currentIdentity(): string {
    return process.env.BUFF_ACT_AS || process.env.USER || 'local';
  }

  /** Single-user legacy mode: no role file / no users → fully permissive. */
  isLegacyMode(): boolean {
    return Object.keys(this.users).length === 0;
  }

  /** Role assigned to a user, or undefined when unassigned. */
  getRole(user: string): Role | undefined {
    return this.users[user]?.role;
  }

  /** May `user` perform `action`? Unassigned users have no permissions. */
  can(user: string, action: AdminAction): boolean {
    const role = this.getRole(user);
    if (!role) return false;
    return PERMISSION_MATRIX[role].has(action);
  }

  /** Permissions granted to a role (for `whoami` / diagnostics). */
  permissionsFor(role: Role): AdminAction[] {
    return [...PERMISSION_MATRIX[role]];
  }

  /**
   * Enforce `action` for the current identity. Throws RbacError when denied.
   * Callers SHOULD check `isLegacyMode()` first (legacy = permissive), unless
   * they intend to be strict even before RBAC is configured.
   */
  requireCan(action: AdminAction, user: string = RbacManager.currentIdentity()): void {
    if (this.can(user, action)) return;
    const role = this.getRole(user) || 'unassigned';
    throw new RbacError(
      `Access denied — role '${role}' cannot '${action}' (requires ${REQUIRED_ROLE_HINT[action]}). User: ${user}`,
    );
  }

  /** Assign (or re-assign) a role. Persists. */
  assignRole(user: string, role: Role, via: 'local' | 'oidc' = 'local'): RbacUser {
    if (!ROLES.includes(role)) {
      throw new RbacError(`Invalid role "${role}". Valid: ${ROLES.join(', ')}`);
    }
    if (!user || !user.trim()) {
      throw new RbacError('A non-empty username is required.');
    }
    const record: RbacUser = { role, addedAt: Date.now(), via };
    this.users[user] = record;
    this.persist();
    return record;
  }

  /** Remove a user's role assignment. Returns true when one existed. */
  removeUser(user: string): boolean {
    if (!(user in this.users)) return false;
    delete this.users[user];
    this.persist();
    return true;
  }

  /** All assigned users, sorted by name. */
  listUsers(): Array<{ user: string } & RbacUser> {
    return Object.entries(this.users)
      .map(([user, u]) => ({ user, ...u }))
      .sort((a, b) => a.user.localeCompare(b.user));
  }

  /** Reset to legacy mode (tests / recovery). */
  reset(): void {
    this.users = {};
    try { writeFileSync(this.path, JSON.stringify({ version: 1, users: {} }, null, 2), 'utf-8'); } catch { /* best-effort */ }
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private load(): Record<string, RbacUser> {
    try {
      if (!existsSync(this.path)) return {};
      return parseRbacUsers(readFileSync(this.path, 'utf-8'));
    } catch (err) {
      // A misconfigured role file must not silently downgrade to permissive —
      // surface it so an operator notices, then fall back safely (legacy mode).
      logger.warn(`rbac.json unreadable (${err instanceof Error ? err.message : String(err)}) — falling back to legacy permissive mode`);
      return {};
    }
  }

  private persist(): void {
    try {
      const dir = resolveBuffConfigDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.path, JSON.stringify({ version: 1, users: this.users }, null, 2), 'utf-8');
    } catch {
      // Best-effort — a failed RBAC write must never break the command.
    }
  }
}
