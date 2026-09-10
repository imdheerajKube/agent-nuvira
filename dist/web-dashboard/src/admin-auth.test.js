"use strict";
/**
 * Admin-auth module tests (Sessions 18 + 19).
 *
 * Session 18: the user-id + password gate (scrypt, env override, Bearer
 * sessions). Session 19: multi-user + RBAC roles — the credential file stores
 * a users map with roles, rbac.json assignments override the stored role (CLI
 * governance parity), and sessions carry the acting role. These tests pin the
 * security properties: passwords never on disk, wrong passwords fail, legacy
 * single-user files migrate, rbac wins over the stored role, and the last
 * admin can't be removed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const paths_1 = require("../../config/paths");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const admin_auth_1 = require("./admin-auth");
(0, vitest_1.describe)('hashAdminPassword / verifyAdminPassword', () => {
    (0, vitest_1.it)('round-trips a password (unique salt per hash)', () => {
        const a = (0, admin_auth_1.hashAdminPassword)('s3cret-pass');
        const b = (0, admin_auth_1.hashAdminPassword)('s3cret-pass');
        (0, vitest_1.expect)(a.salt).not.toBe(b.salt);
        (0, vitest_1.expect)((0, admin_auth_1.verifyAdminPassword)('s3cret-pass', a.salt, a.hash)).toBe(true);
    });
    (0, vitest_1.it)('rejects a wrong password and a wrong salt', () => {
        const { salt, hash } = (0, admin_auth_1.hashAdminPassword)('right-password');
        (0, vitest_1.expect)((0, admin_auth_1.verifyAdminPassword)('wrong-password', salt, hash)).toBe(false);
        (0, vitest_1.expect)((0, admin_auth_1.verifyAdminPassword)('right-password', 'ffffffffffffffff', hash)).toBe(false);
    });
});
(0, vitest_1.describe)('multi-user credential store (config-dir scoped)', () => {
    let dir;
    (0, vitest_1.beforeEach)(() => {
        dir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'buff-admin-auth-'));
    });
    (0, vitest_1.afterEach)(() => {
        (0, node_fs_1.rmSync)(dir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('stores users with roles — passwords never on disk', () => {
        const admin = (0, admin_auth_1.writeAdminUser)('admin', 'super-secret-pass', 'admin', dir);
        (0, vitest_1.expect)(admin.role).toBe('admin');
        const op = (0, admin_auth_1.writeAdminUser)('op', 'operator-pass-1', 'operator', dir);
        (0, vitest_1.expect)(op.role).toBe('operator');
        const raw = (0, node_fs_1.readFileSync)((0, node_path_1.join)(dir, 'dashboard-admin.json'), 'utf-8');
        (0, vitest_1.expect)(raw).not.toContain('super-secret-pass');
        (0, vitest_1.expect)(raw).not.toContain('operator-pass-1');
        const users = (0, admin_auth_1.readAdminUsers)(dir);
        (0, vitest_1.expect)(Object.keys(users).sort()).toEqual(['admin', 'op']);
        (0, vitest_1.expect)(users.admin.role).toBe('admin');
        (0, vitest_1.expect)(users.op.role).toBe('operator');
        (0, vitest_1.expect)((0, admin_auth_1.verifyAdmin)('admin', 'super-secret-pass', dir)).toBe(true);
        (0, vitest_1.expect)((0, admin_auth_1.verifyAdmin)('op', 'operator-pass-1', dir)).toBe(true);
        (0, vitest_1.expect)((0, admin_auth_1.verifyAdmin)('admin', 'wrong', dir)).toBe(false);
        (0, vitest_1.expect)((0, admin_auth_1.verifyAdmin)('ghost', 'super-secret-pass', dir)).toBe(false);
        (0, vitest_1.expect)((0, admin_auth_1.isAdminConfigured)(dir)).toBe(true);
    });
    (0, vitest_1.it)('listAdminUsers excludes salt/hash; removeAdminUser deletes; countAdminRoleUsers counts admins', () => {
        (0, admin_auth_1.writeAdminUser)('admin', 'admin-pass-123', 'admin', dir);
        (0, admin_auth_1.writeAdminUser)('op', 'operator-pass-1', 'operator', dir);
        (0, admin_auth_1.writeAdminUser)('view', 'viewer-pass-12', 'viewer', dir);
        const listed = (0, admin_auth_1.listAdminUsers)(dir);
        (0, vitest_1.expect)(listed).toHaveLength(3);
        for (const u of listed) {
            (0, vitest_1.expect)(u).not.toHaveProperty('salt');
            (0, vitest_1.expect)(u).not.toHaveProperty('hash');
        }
        (0, vitest_1.expect)((0, admin_auth_1.countAdminRoleUsers)(dir)).toBe(1);
        (0, vitest_1.expect)((0, admin_auth_1.removeAdminUser)('op', dir)).toBe(true);
        (0, vitest_1.expect)((0, admin_auth_1.removeAdminUser)('op', dir)).toBe(false);
        (0, vitest_1.expect)((0, admin_auth_1.listAdminUsers)(dir).map((u) => u.user)).toEqual(['admin', 'view']);
    });
    (0, vitest_1.it)('migrates the legacy single-user file shape to an admin user', () => {
        // Session 18 shape: { user, salt, hash, createdAt } (no users wrapper).
        const { salt, hash } = (0, admin_auth_1.hashAdminPassword)('legacy-pass');
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, 'dashboard-admin.json'), JSON.stringify({ user: 'admin', salt, hash, createdAt: 123 }), 'utf-8');
        const users = (0, admin_auth_1.readAdminUsers)(dir);
        (0, vitest_1.expect)(users.admin.role).toBe('admin');
        (0, vitest_1.expect)((0, admin_auth_1.verifyAdmin)('admin', 'legacy-pass', dir)).toBe(true);
        (0, vitest_1.expect)((0, admin_auth_1.isAdminConfigured)(dir)).toBe(true);
    });
    (0, vitest_1.it)('a corrupt file reads as unconfigured (never throws, never downgrades to open)', () => {
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, 'dashboard-admin.json'), '{not json', 'utf-8');
        (0, vitest_1.expect)((0, admin_auth_1.readAdminUsers)(dir)).toBeNull();
        (0, vitest_1.expect)((0, admin_auth_1.isAdminConfigured)(dir)).toBe(false);
        (0, vitest_1.expect)((0, admin_auth_1.verifyAdmin)('admin', 'anything', dir)).toBe(false);
    });
});
(0, vitest_1.describe)('roleForUser — rbac.json wins over the stored role (CLI parity)', () => {
    let dir;
    (0, vitest_1.beforeEach)(() => {
        dir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'buff-admin-auth-'));
    });
    (0, vitest_1.afterEach)(() => {
        (0, node_fs_1.rmSync)(dir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('uses the credential role when rbac.json has no assignment', () => {
        (0, admin_auth_1.writeAdminUser)('op', 'operator-pass-1', 'operator', dir);
        (0, vitest_1.expect)((0, admin_auth_1.roleForUser)('op', dir)).toBe('operator');
    });
    (0, vitest_1.it)('an rbac.json assignment overrides the stored role (a viewer in rbac is a viewer here)', () => {
        (0, admin_auth_1.writeAdminUser)('op', 'operator-pass-1', 'operator', dir);
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, 'rbac.json'), JSON.stringify({ version: 1, users: { op: { role: 'viewer', addedAt: Date.now(), via: 'local' } } }), 'utf-8');
        // rbac wins: the dashboard cannot escalate a user the CLI governs as viewer.
        (0, vitest_1.expect)((0, admin_auth_1.roleForUser)('op', dir)).toBe('viewer');
    });
    (0, vitest_1.it)('unknown users resolve to viewer (deny by default)', () => {
        (0, vitest_1.expect)((0, admin_auth_1.roleForUser)('ghost', dir)).toBe('viewer');
    });
});
(0, vitest_1.describe)('env override (with role)', () => {
    const OLD = {
        user: (0, paths_1.envBuff)('DASHBOARD_ADMIN_USER'),
        pass: (0, paths_1.envBuff)('DASHBOARD_ADMIN_PASSWORD'),
        role: (0, paths_1.envBuff)('DASHBOARD_ADMIN_ROLE'),
    };
    (0, vitest_1.afterEach)(() => {
        for (const [k, v] of Object.entries(OLD)) {
            if (v === undefined)
                delete process.env[`BUFF_DASHBOARD_ADMIN_${k.toUpperCase()}`];
            else
                process.env[`BUFF_DASHBOARD_ADMIN_${k.toUpperCase()}`] = v;
        }
    });
    (0, vitest_1.it)('password-only defaults to the admin user + admin role; env wins over the file', () => {
        delete (0, paths_1.envBuff)('DASHBOARD_ADMIN_USER');
        delete (0, paths_1.envBuff)('DASHBOARD_ADMIN_ROLE');
        (0, paths_1.envBuff)('DASHBOARD_ADMIN_PASSWORD') = 'env-pass';
        (0, vitest_1.expect)((0, admin_auth_1.envAdminOverride)()).toEqual({ user: 'admin', password: 'env-pass', role: 'admin' });
        (0, vitest_1.expect)((0, admin_auth_1.isAdminConfigured)()).toBe(true);
        (0, vitest_1.expect)((0, admin_auth_1.verifyAdmin)('admin', 'env-pass')).toBe(true);
        (0, vitest_1.expect)((0, admin_auth_1.verifyAdmin)('admin', 'file-pass')).toBe(false);
    });
    (0, vitest_1.it)('honors BUFF_DASHBOARD_ADMIN_ROLE and rejects an invalid one (falls back to admin)', () => {
        delete (0, paths_1.envBuff)('DASHBOARD_ADMIN_USER');
        (0, paths_1.envBuff)('DASHBOARD_ADMIN_PASSWORD') = 'env-pass';
        (0, paths_1.envBuff)('DASHBOARD_ADMIN_ROLE') = 'operator';
        (0, vitest_1.expect)((0, admin_auth_1.envAdminOverride)()?.role).toBe('operator');
        (0, paths_1.envBuff)('DASHBOARD_ADMIN_ROLE') = 'superuser';
        (0, vitest_1.expect)((0, admin_auth_1.envAdminOverride)()?.role).toBe('admin');
    });
    (0, vitest_1.it)('roleForUser honors the env override role even with NO credential file (regression — env admins are not viewers)', () => {
        delete (0, paths_1.envBuff)('DASHBOARD_ADMIN_USER');
        (0, paths_1.envBuff)('DASHBOARD_ADMIN_ROLE') = 'admin';
        (0, paths_1.envBuff)('DASHBOARD_ADMIN_PASSWORD') = 'env-pass';
        // No dashboard-admin.json exists anywhere — the env role must still apply.
        (0, vitest_1.expect)((0, admin_auth_1.roleForUser)('admin')).toBe('admin');
        (0, vitest_1.expect)((0, admin_auth_1.roleForUser)('someone-else')).toBe('viewer');
    });
});
(0, vitest_1.describe)('AdminSessions (role-carrying)', () => {
    (0, vitest_1.it)('issues and validates a token with its role, rejects garbage', () => {
        const s = new admin_auth_1.AdminSessions();
        const token = s.issue('admin', 'admin');
        (0, vitest_1.expect)(s.validate(token)).toEqual({ user: 'admin', role: 'admin' });
        (0, vitest_1.expect)(s.validate('nope')).toBeNull();
        (0, vitest_1.expect)(s.validate(undefined)).toBeNull();
        (0, vitest_1.expect)(s.size()).toBe(1);
    });
    (0, vitest_1.it)('revokes a token', () => {
        const s = new admin_auth_1.AdminSessions();
        const token = s.issue('op', 'operator');
        (0, vitest_1.expect)(s.revoke(token)).toBe(true);
        (0, vitest_1.expect)(s.validate(token)).toBeNull();
        (0, vitest_1.expect)(s.size()).toBe(0);
    });
    (0, vitest_1.it)('rejects expired tokens and reaps them', () => {
        const s = new admin_auth_1.AdminSessions();
        const token = s.issue('admin', 'admin');
        vitest_1.vi.useFakeTimers();
        try {
            vitest_1.vi.advanceTimersByTime(8 * 60 * 60 * 1000 + 1);
            (0, vitest_1.expect)(s.validate(token)).toBeNull();
            (0, vitest_1.expect)(s.size()).toBe(0);
        }
        finally {
            vitest_1.vi.useRealTimers();
        }
    });
});
(0, vitest_1.describe)('MIN_ADMIN_PASSWORD_LENGTH', () => {
    (0, vitest_1.it)('is enforced by the server-facing constant (8 chars)', () => {
        (0, vitest_1.expect)(admin_auth_1.MIN_ADMIN_PASSWORD_LENGTH).toBe(8);
    });
});
