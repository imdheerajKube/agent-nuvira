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
  DEFAULT_ADMIN_USER,
  DEFAULT_ADMIN_PASSWORD,
  ensureDefaultAdmin,
  mustChangePasswordFor,
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

/**
 * The env override.
 *
 * `envBuff()` is a READER — `process.env['NUVIRA_<name>'] ?? process.env['BUFF_<name>']`
 * — so it can never be assigned to. This block used to contain eight such
 * assignments (`envBuff('DASHBOARD_ADMIN_PASSWORD') = 'env-pass'`), which is a
 * syntax error: the file failed to TRANSFORM, so every test in it was silently
 * skipped rather than failing. It went unnoticed because the dashboard suite is
 * not part of the main `vitest run` glob.
 *
 * The tests now write the env vars `envBuff` actually reads, and pass an explicit
 * empty config dir so the "no credential file" claim is literally true instead of
 * depending on whatever is in the developer's real profile.
 */
describe('env override (with role)', () => {
  let dir: string;

  const ENV_SUFFIXES = ['USER', 'PASSWORD', 'ROLE'] as const;
  type EnvSuffix = (typeof ENV_SUFFIXES)[number];

  /** envBuff reads NUVIRA_ first, then the legacy BUFF_ alias — set both. */
  const envNames = (suffix: EnvSuffix): [string, string] => [
    `NUVIRA_DASHBOARD_ADMIN_${suffix}`,
    `BUFF_DASHBOARD_ADMIN_${suffix}`,
  ];

  const OLD = new Map<string, string | undefined>();
  for (const suffix of ENV_SUFFIXES) {
    for (const name of envNames(suffix)) OLD.set(name, process.env[name]);
  }

  const setAdminEnv = (suffix: EnvSuffix, value: string | undefined): void => {
    for (const name of envNames(suffix)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buff-admin-auth-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    // Restore the real environment exactly as it was — tests must not leak
    // credentials into whichever test file runs next.
    for (const [name, value] of OLD) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('password-only defaults to the admin user + admin role; env wins over the file', () => {
    // A real credential file exists in this dir and must LOSE to the env vars.
    writeAdminUser('admin', 'file-pass-123', 'viewer', dir);
    setAdminEnv('USER', undefined);
    setAdminEnv('ROLE', undefined);
    setAdminEnv('PASSWORD', 'env-pass');

    expect(envAdminOverride()).toEqual({ user: 'admin', password: 'env-pass', role: 'admin' });
    expect(isAdminConfigured(dir)).toBe(true);
    expect(verifyAdmin('admin', 'env-pass', dir)).toBe(true);
    expect(verifyAdmin('admin', 'file-pass-123', dir)).toBe(false);
  });

  it('honors the ROLE env var and rejects an invalid one (falls back to admin)', () => {
    setAdminEnv('USER', undefined);
    setAdminEnv('PASSWORD', 'env-pass');

    setAdminEnv('ROLE', 'operator');
    expect(envAdminOverride()?.role).toBe('operator');

    setAdminEnv('ROLE', 'superuser');
    expect(envAdminOverride()?.role).toBe('admin');
  });

  it('roleForUser honors the env role even with NO credential file (regression — env admins are not viewers)', () => {
    setAdminEnv('USER', undefined);
    setAdminEnv('ROLE', 'admin');
    setAdminEnv('PASSWORD', 'env-pass');

    // `dir` is an empty temp dir: no dashboard-admin.json exists, yet the env
    // role must still apply (this used to fall through to viewer).
    expect(roleForUser('admin', dir)).toBe('admin');
    expect(roleForUser('someone-else', dir)).toBe('viewer');
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

/**
 * Zero-setup first run: admin/admin is created so a GUI-first user is never
 * blocked by a setup form — and the account it creates is CRIPPLED until the
 * password is changed, which is what makes a published default safe.
 */
describe('first-run default admin (ensureDefaultAdmin)', () => {
  let dir: string;

  const savedDefault = process.env.NUVIRA_DASHBOARD_DEFAULT_ADMIN;
  const savedPw = process.env.NUVIRA_DASHBOARD_ADMIN_PASSWORD;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buff-default-admin-'));
    delete process.env.NUVIRA_DASHBOARD_DEFAULT_ADMIN;
    delete process.env.NUVIRA_DASHBOARD_ADMIN_PASSWORD;
    delete process.env.BUFF_DASHBOARD_ADMIN_PASSWORD;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedDefault === undefined) delete process.env.NUVIRA_DASHBOARD_DEFAULT_ADMIN;
    else process.env.NUVIRA_DASHBOARD_DEFAULT_ADMIN = savedDefault;
    if (savedPw === undefined) delete process.env.NUVIRA_DASHBOARD_ADMIN_PASSWORD;
    else process.env.NUVIRA_DASHBOARD_ADMIN_PASSWORD = savedPw;
  });

  it('creates admin/admin on a fresh install, flagged must-change', () => {
    const created = ensureDefaultAdmin(dir);
    expect(created).toBe(DEFAULT_ADMIN_USER);
    expect(isAdminConfigured(dir)).toBe(true);
    // The published pair actually works…
    expect(verifyAdmin(DEFAULT_ADMIN_USER, DEFAULT_ADMIN_PASSWORD, dir)).toBe(true);
    // …and the account knows it is on a default.
    expect(mustChangePasswordFor(DEFAULT_ADMIN_USER, dir)).toBe(true);
  });

  it('never overwrites an existing admin', () => {
    writeAdminUser('dheeraj', 'a-real-password-1', 'admin', dir);
    expect(ensureDefaultAdmin(dir)).toBeNull();
    expect(readAdminUsers(dir)?.admin).toBeUndefined();
    expect(mustChangePasswordFor('dheeraj', dir)).toBe(false);
  });

  it('a normal password write clears the forced-change flag', () => {
    ensureDefaultAdmin(dir);
    expect(mustChangePasswordFor(DEFAULT_ADMIN_USER, dir)).toBe(true);
    writeAdminUser(DEFAULT_ADMIN_USER, 'a-real-password-1', 'admin', dir);
    expect(mustChangePasswordFor(DEFAULT_ADMIN_USER, dir)).toBe(false);
  });

  it('opts out entirely with NUVIRA_DASHBOARD_DEFAULT_ADMIN=0', () => {
    process.env.NUVIRA_DASHBOARD_DEFAULT_ADMIN = '0';
    expect(ensureDefaultAdmin(dir)).toBeNull();
    expect(isAdminConfigured(dir)).toBe(false);
  });

  it('never creates a default while the env override supplies the credential', () => {
    process.env.NUVIRA_DASHBOARD_ADMIN_PASSWORD = 'operator-chosen-secret';
    expect(ensureDefaultAdmin(dir)).toBeNull();
    // The env path is never locked into a forced change — automation must not
    // be able to brick its own dashboard.
    expect(mustChangePasswordFor('admin', dir)).toBe(false);
  });

  it('stores only a hash — the default password is never written as a value', () => {
    ensureDefaultAdmin(dir);
    const raw = readFileSync(join(dir, 'dashboard-admin.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      users: Record<string, { salt: string; hash: string; mustChangePassword?: boolean }>;
    };
    const record = parsed.users[DEFAULT_ADMIN_USER];

    // A real scrypt digest, not the plaintext ('admin' is also the user key, so
    // asserting on the raw text would be an assertion about the USERNAME).
    expect(record.hash).toMatch(/^[0-9a-f]{128}$/);
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(verifyAdminPassword(DEFAULT_ADMIN_PASSWORD, record.salt, record.hash)).toBe(true);
    expect(raw).not.toContain('"password"');
    expect(record.mustChangePassword).toBe(true);
  });
});
