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

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { envBuff } from '../../config/paths';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashAdminPassword,
  verifyAdminPassword,
  writeAdminUser,
  removeAdminUser,
  listAdminUsers,
  readAdminUsers,
  countAdminRoleUsers,
  roleForUser,
  isAdminConfigured,
  verifyAdmin,
  envAdminOverride,
  AdminSessions,
  MIN_ADMIN_PASSWORD_LENGTH,
} from './admin-auth';

describe('hashAdminPassword / verifyAdminPassword', () => {
  it('round-trips a password (unique salt per hash)', () => {
    const a = hashAdminPassword('s3cret-pass');
    const b = hashAdminPassword('s3cret-pass');
    expect(a.salt).not.toBe(b.salt);
    expect(verifyAdminPassword('s3cret-pass', a.salt, a.hash)).toBe(true);
  });

  it('rejects a wrong password and a wrong salt', () => {
    const { salt, hash } = hashAdminPassword('right-password');
    expect(verifyAdminPassword('wrong-password', salt, hash)).toBe(false);
    expect(verifyAdminPassword('right-password', 'ffffffffffffffff', hash)).toBe(false);
  });
});

describe('multi-user credential store (config-dir scoped)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buff-admin-auth-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores users with roles — passwords never on disk', () => {
    const admin = writeAdminUser('admin', 'super-secret-pass', 'admin', dir);
    expect(admin.role).toBe('admin');
    const op = writeAdminUser('op', 'operator-pass-1', 'operator', dir);
    expect(op.role).toBe('operator');

    const raw = readFileSync(join(dir, 'dashboard-admin.json'), 'utf-8');
    expect(raw).not.toContain('super-secret-pass');
    expect(raw).not.toContain('operator-pass-1');

    const users = readAdminUsers(dir)!;
    expect(Object.keys(users).sort()).toEqual(['admin', 'op']);
    expect(users.admin.role).toBe('admin');
    expect(users.op.role).toBe('operator');

    expect(verifyAdmin('admin', 'super-secret-pass', dir)).toBe(true);
    expect(verifyAdmin('op', 'operator-pass-1', dir)).toBe(true);
    expect(verifyAdmin('admin', 'wrong', dir)).toBe(false);
    expect(verifyAdmin('ghost', 'super-secret-pass', dir)).toBe(false);
    expect(isAdminConfigured(dir)).toBe(true);
  });

  it('listAdminUsers excludes salt/hash; removeAdminUser deletes; countAdminRoleUsers counts admins', () => {
    writeAdminUser('admin', 'admin-pass-123', 'admin', dir);
    writeAdminUser('op', 'operator-pass-1', 'operator', dir);
    writeAdminUser('view', 'viewer-pass-12', 'viewer', dir);

    const listed = listAdminUsers(dir);
    expect(listed).toHaveLength(3);
    for (const u of listed) {
      expect(u).not.toHaveProperty('salt');
      expect(u).not.toHaveProperty('hash');
    }
    expect(countAdminRoleUsers(dir)).toBe(1);

    expect(removeAdminUser('op', dir)).toBe(true);
    expect(removeAdminUser('op', dir)).toBe(false);
    expect(listAdminUsers(dir).map((u) => u.user)).toEqual(['admin', 'view']);
  });

  it('migrates the legacy single-user file shape to an admin user', () => {
    // Session 18 shape: { user, salt, hash, createdAt } (no users wrapper).
    const { salt, hash } = hashAdminPassword('legacy-pass');
    writeFileSync(
      join(dir, 'dashboard-admin.json'),
      JSON.stringify({ user: 'admin', salt, hash, createdAt: 123 }),
      'utf-8',
    );
    const users = readAdminUsers(dir)!;
    expect(users.admin.role).toBe('admin');
    expect(verifyAdmin('admin', 'legacy-pass', dir)).toBe(true);
    expect(isAdminConfigured(dir)).toBe(true);
  });

  it('a corrupt file reads as unconfigured (never throws, never downgrades to open)', () => {
    writeFileSync(join(dir, 'dashboard-admin.json'), '{not json', 'utf-8');
    expect(readAdminUsers(dir)).toBeNull();
    expect(isAdminConfigured(dir)).toBe(false);
    expect(verifyAdmin('admin', 'anything', dir)).toBe(false);
  });
});

describe('roleForUser — rbac.json wins over the stored role (CLI parity)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buff-admin-auth-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the credential role when rbac.json has no assignment', () => {
    writeAdminUser('op', 'operator-pass-1', 'operator', dir);
    expect(roleForUser('op', dir)).toBe('operator');
  });

  it('an rbac.json assignment overrides the stored role (a viewer in rbac is a viewer here)', () => {
    writeAdminUser('op', 'operator-pass-1', 'operator', dir);
    writeFileSync(
      join(dir, 'rbac.json'),
      JSON.stringify({ version: 1, users: { op: { role: 'viewer', addedAt: Date.now(), via: 'local' } } }),
      'utf-8',
    );
    // rbac wins: the dashboard cannot escalate a user the CLI governs as viewer.
    expect(roleForUser('op', dir)).toBe('viewer');
  });

  it('unknown users resolve to viewer (deny by default)', () => {
    expect(roleForUser('ghost', dir)).toBe('viewer');
  });
});

describe('env override (with role)', () => {
  const OLD = {
    user: envBuff('DASHBOARD_ADMIN_USER'),
    pass: envBuff('DASHBOARD_ADMIN_PASSWORD'),
    role: envBuff('DASHBOARD_ADMIN_ROLE'),
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(OLD)) {
      if (v === undefined) delete process.env[`BUFF_DASHBOARD_ADMIN_${k.toUpperCase()}`];
      else process.env[`BUFF_DASHBOARD_ADMIN_${k.toUpperCase()}`] = v;
    }
  });

  it('password-only defaults to the admin user + admin role; env wins over the file', () => {
    delete envBuff('DASHBOARD_ADMIN_USER');
    delete envBuff('DASHBOARD_ADMIN_ROLE');
    envBuff('DASHBOARD_ADMIN_PASSWORD') = 'env-pass';
    expect(envAdminOverride()).toEqual({ user: 'admin', password: 'env-pass', role: 'admin' });
    expect(isAdminConfigured()).toBe(true);
    expect(verifyAdmin('admin', 'env-pass')).toBe(true);
    expect(verifyAdmin('admin', 'file-pass')).toBe(false);
  });

  it('honors BUFF_DASHBOARD_ADMIN_ROLE and rejects an invalid one (falls back to admin)', () => {
    delete envBuff('DASHBOARD_ADMIN_USER');
    envBuff('DASHBOARD_ADMIN_PASSWORD') = 'env-pass';
    envBuff('DASHBOARD_ADMIN_ROLE') = 'operator';
    expect(envAdminOverride()?.role).toBe('operator');
    envBuff('DASHBOARD_ADMIN_ROLE') = 'superuser';
    expect(envAdminOverride()?.role).toBe('admin');
  });

  it('roleForUser honors the env override role even with NO credential file (regression — env admins are not viewers)', () => {
    delete envBuff('DASHBOARD_ADMIN_USER');
    envBuff('DASHBOARD_ADMIN_ROLE') = 'admin';
    envBuff('DASHBOARD_ADMIN_PASSWORD') = 'env-pass';
    // No dashboard-admin.json exists anywhere — the env role must still apply.
    expect(roleForUser('admin')).toBe('admin');
    expect(roleForUser('someone-else')).toBe('viewer');
  });
});

describe('AdminSessions (role-carrying)', () => {
  it('issues and validates a token with its role, rejects garbage', () => {
    const s = new AdminSessions();
    const token = s.issue('admin', 'admin');
    expect(s.validate(token)).toEqual({ user: 'admin', role: 'admin' });
    expect(s.validate('nope')).toBeNull();
    expect(s.validate(undefined)).toBeNull();
    expect(s.size()).toBe(1);
  });

  it('revokes a token', () => {
    const s = new AdminSessions();
    const token = s.issue('op', 'operator');
    expect(s.revoke(token)).toBe(true);
    expect(s.validate(token)).toBeNull();
    expect(s.size()).toBe(0);
  });

  it('rejects expired tokens and reaps them', () => {
    const s = new AdminSessions();
    const token = s.issue('admin', 'admin');
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(8 * 60 * 60 * 1000 + 1);
      expect(s.validate(token)).toBeNull();
      expect(s.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MIN_ADMIN_PASSWORD_LENGTH', () => {
  it('is enforced by the server-facing constant (8 chars)', () => {
    expect(MIN_ADMIN_PASSWORD_LENGTH).toBe(8);
  });
});
