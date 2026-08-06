/**
 * RbacManager — P6 M6.1 role-based access control tests.
 *
 * Covers: legacy single-user mode (no role file → permissive), role
 * assignment/persistence, the admin/operator/viewer permission matrix,
 * requireCan enforcement + RbacError, removeUser/listUsers, and the
 * BUFF_ACT_AS identity override. Hermetic via BUFF_CONFIG_DIR temp dirs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RbacManager, RbacError, ROLES } from '../../src/enterprise/rbac.js';

let tempDir: string;
let originalConfigDir: string | undefined;
let originalActAs: string | undefined;

function rbacPath(): string {
  return join(tempDir, 'rbac.json');
}

describe('RbacManager — legacy mode', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-rbac-'));
    originalConfigDir = process.env.BUFF_CONFIG_DIR;
    process.env.BUFF_CONFIG_DIR = tempDir;
    originalActAs = process.env.BUFF_ACT_AS;
    delete process.env.BUFF_ACT_AS;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.BUFF_CONFIG_DIR;
    else process.env.BUFF_CONFIG_DIR = originalConfigDir;
    if (originalActAs === undefined) delete process.env.BUFF_ACT_AS;
    else process.env.BUFF_ACT_AS = originalActAs;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('starts in legacy single-user mode (no role file → fully permissive)', () => {
    const rbac = new RbacManager();
    expect(rbac.isLegacyMode()).toBe(true);
    expect(rbac.listUsers()).toEqual([]);
    expect(rbac.getRole('alice')).toBeUndefined();
  });

  it('resolves the current identity from BUFF_ACT_AS', () => {
    process.env.BUFF_ACT_AS = 'ci-bot';
    expect(RbacManager.currentIdentity()).toBe('ci-bot');
  });
});

describe('RbacManager — role matrix + enforcement', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-rbac-'));
    originalConfigDir = process.env.BUFF_CONFIG_DIR;
    process.env.BUFF_CONFIG_DIR = tempDir;
    originalActAs = process.env.BUFF_ACT_AS;
    delete process.env.BUFF_ACT_AS;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.BUFF_CONFIG_DIR;
    else process.env.BUFF_CONFIG_DIR = originalConfigDir;
    if (originalActAs === undefined) delete process.env.BUFF_ACT_AS;
    else process.env.BUFF_ACT_AS = originalActAs;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('assignRole persists to the role file and exits legacy mode', () => {
    const rbac = new RbacManager();
    rbac.assignRole('alice', 'admin');
    expect(rbac.isLegacyMode()).toBe(false);
    expect(rbac.getRole('alice')).toBe('admin');
    expect(existsSync(rbacPath())).toBe(true);
    const raw = JSON.parse(readFileSync(rbacPath(), 'utf-8')) as { users: Record<string, { role: string }> };
    expect(raw.users.alice.role).toBe('admin');
  });

  it('enforces the permission matrix (admin writes / operator operates / viewer reads)', () => {
    const rbac = new RbacManager();
    rbac.assignRole('admin-user', 'admin');
    rbac.assignRole('op-user', 'operator');
    rbac.assignRole('viewer-user', 'viewer');

    expect(rbac.can('admin-user', 'policy.write')).toBe(true);
    expect(rbac.can('admin-user', 'role.manage')).toBe(true);
    expect(rbac.can('admin-user', 'routing.operate')).toBe(true);

    expect(rbac.can('op-user', 'policy.write')).toBe(false);
    expect(rbac.can('op-user', 'routing.operate')).toBe(true);
    expect(rbac.can('op-user', 'policy.read')).toBe(true);

    expect(rbac.can('viewer-user', 'policy.read')).toBe(true);
    expect(rbac.can('viewer-user', 'routing.operate')).toBe(false);
    expect(rbac.can('viewer-user', 'policy.write')).toBe(false);

    // Unassigned users have NO permissions.
    expect(rbac.can('mystery', 'policy.read')).toBe(false);
  });

  it('requireCan throws RbacError with a helpful message when denied', () => {
    const rbac = new RbacManager();
    rbac.assignRole('viewer-user', 'viewer');
    expect(() => rbac.requireCan('policy.write', 'viewer-user')).toThrow(RbacError);
    expect(() => rbac.requireCan('policy.write', 'viewer-user')).toThrow(/Access denied/);
    expect(() => rbac.requireCan('policy.write', 'viewer-user')).toThrow(/requires admin/);
    // Reads are fine for every role.
    expect(() => rbac.requireCan('policy.read', 'viewer-user')).not.toThrow();
  });

  it('removeUser clears an assignment; removing all users returns to legacy mode', () => {
    const rbac = new RbacManager();
    rbac.assignRole('alice', 'admin');
    expect(rbac.removeUser('nobody')).toBe(false);
    expect(rbac.removeUser('alice')).toBe(true);
    expect(rbac.getRole('alice')).toBeUndefined();
    expect(rbac.isLegacyMode()).toBe(true);
  });

  it('listUsers is sorted by name and carries metadata', () => {
    const rbac = new RbacManager();
    rbac.assignRole('zoe', 'viewer');
    rbac.assignRole('amy', 'admin', 'oidc');
    const users = rbac.listUsers();
    expect(users.map((u) => u.user)).toEqual(['amy', 'zoe']);
    expect(users[0].via).toBe('oidc');
    expect(typeof users[0].addedAt).toBe('number');
  });

  it('a fresh manager reloads assignments from disk', () => {
    const rbac = new RbacManager();
    rbac.assignRole('alice', 'admin');
    const reloaded = new RbacManager();
    expect(reloaded.getRole('alice')).toBe('admin');
    expect(reloaded.can('alice', 'policy.write')).toBe(true);
  });

  it('rejects invalid roles and empty usernames', () => {
    const rbac = new RbacManager();
    expect(() => rbac.assignRole('alice', 'superuser' as never)).toThrow(RbacError);
    expect(() => rbac.assignRole('   ', 'admin')).toThrow(RbacError);
  });

  it('exposes the built-in role list and per-role permissions for diagnostics', () => {
    expect(ROLES).toEqual(['admin', 'operator', 'viewer']);
    const rbac = new RbacManager();
    expect(rbac.permissionsFor('admin')).toContain('policy.write');
    expect(rbac.permissionsFor('viewer')).toEqual(['policy.read']);
  });
});
