/**
 * K4 — RBAC enforcement tests.
 *
 * Covers:
 *  - guardRbacAction() semantics: legacy permissive mode, deny → exit code 3,
 *    allow for the right role, and operator partial permissions.
 *  - Wiring: every sensitive surface consults the guard with the right action
 *    (team writes → team.manage, skill removal → skill.remove, sbom --out →
 *    sbom.write), and dry-run/read-only paths stay unguarded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

import { guardRbacAction } from '../../src/cli/rbac-guard.js';
import * as rbacGuard from '../../src/cli/rbac-guard.js';
import { TeamCommand } from '../../src/cli/team.js';
import { SkillCommand } from '../../src/cli/skill.js';
import { SbomCommand } from '../../src/cli/sbom.js';

// ─── Hermetic RBAC dir (mirrors tests/cli/admin.test.ts) ────────────────────

let rbacDir: string;
let originalConfigDir: string | undefined;
let originalActAs: string | undefined;

function setupRbacDir(): void {
  rbacDir = mkdtempSync(join(tmpdir(), 'buff-guard-rbac-'));
  originalConfigDir = process.env.NUVIRA_CONFIG_DIR;
  process.env.NUVIRA_CONFIG_DIR = rbacDir;
  originalActAs = process.env.NUVIRA_ACT_AS;
  delete process.env.NUVIRA_ACT_AS; // legacy mode by default
}

function teardownRbacDir(): void {
  if (originalConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = originalConfigDir;
  if (originalActAs === undefined) delete process.env.NUVIRA_ACT_AS;
  else process.env.NUVIRA_ACT_AS = originalActAs;
  rmSync(rbacDir, { recursive: true, force: true });
}

/** Pre-seed a role assignment so the manager exits legacy mode. */
function seedRole(user: string, role: string): void {
  writeFileSync(join(rbacDir, 'rbac.json'), JSON.stringify({
    version: 1,
    users: { [user]: { role, addedAt: Date.now(), via: 'local' } },
  }), 'utf-8');
}

function actAs(user: string): void {
  process.env.NUVIRA_ACT_AS = user;
}

// ─── guardRbacAction semantics ──────────────────────────────────────────────

describe('guardRbacAction — semantics', () => {
  beforeEach(() => {
    setupRbacDir();
    process.exitCode = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    teardownRbacDir();
  });

  it('legacy single-user mode (no role file) is fully permissive', () => {
    expect(guardRbacAction('team.manage')).toBe(true);
    expect(guardRbacAction('skill.remove')).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it('denies a viewer on team.manage with a clear exit code 3', () => {
    seedRole('alice', 'viewer');
    actAs('alice');

    expect(guardRbacAction('team.manage')).toBe(false);
    expect(process.exitCode).toBe(3);
  });

  it('allows an admin on every K4 action', () => {
    seedRole('alice', 'admin');
    actAs('alice');

    expect(guardRbacAction('team.manage')).toBe(true);
    expect(guardRbacAction('sbom.write')).toBe(true);
    expect(guardRbacAction('skill.remove')).toBe(true);
    expect(guardRbacAction('credential.write')).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it('operator can write sbom/team but cannot remove skills', () => {
    seedRole('op', 'operator');
    actAs('op');

    expect(guardRbacAction('team.manage')).toBe(true);
    expect(guardRbacAction('sbom.write')).toBe(true);
    expect(guardRbacAction('skill.remove')).toBe(false);
    expect(process.exitCode).toBe(3);
  });
});

// ─── Wiring: the surfaces actually consult the guard ───────────────────────

describe('K4 enforcement wiring', () => {
  beforeEach(() => {
    setupRbacDir();
    process.exitCode = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    teardownRbacDir();
  });

  it('every mutating team handler consults team.manage; read-only ones do not', async () => {
    // Deny everything so handlers short-circuit: the wiring contract is that
    // the guard is consulted — not that the mutation runs (which for join/sync
    // would attempt real network/git I/O). The spy records the calls either way.
    const spy = vi.spyOn(rbacGuard, 'guardRbacAction').mockReturnValue(false);
    const cmd = new TeamCommand() as unknown as Record<string, (...a: unknown[]) => Promise<void>>;

    await cmd.handleInit('Team X');
    await cmd.handleJoin('https://example.com/team.git');
    await cmd.handleSync();
    await cmd.handleShare();
    await cmd.handleReviewCreate('title', 'goal');
    await cmd.handleReviewApprove('r1');
    await cmd.handleReviewRequestChanges('r1', 'reason');
    await cmd.handleReviewReject('r1');
    await cmd.handleReviewMerge('r1');

    // Every mutation consults the guard exactly once with the same action.
    expect(spy).toHaveBeenCalledTimes(9);
    for (const call of spy.mock.calls) {
      expect(call[0]).toBe('team.manage');
    }
  });

  it('skill gc dry-run is unguarded; real removal and clear consult skill.remove', () => {
    const spy = vi.spyOn(rbacGuard, 'guardRbacAction').mockReturnValue(false);
    const cmd = new SkillCommand() as unknown as Record<string, (opts?: unknown) => void>;

    // Dry-run is read-only — must NOT be gated (a viewer can preview).
    cmd.garbageCollect({ dryRun: true });
    expect(spy).not.toHaveBeenCalled();

    // Real removal — gated, and a false deny short-circuits safely.
    cmd.garbageCollect({ dryRun: false });
    expect(spy).toHaveBeenLastCalledWith('skill.remove');

    cmd.clearSkills({ force: true });
    expect(spy).toHaveBeenLastCalledWith('skill.remove');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('sbom --out write is denied for a viewer and no file is created', () => {
    seedRole('bob', 'viewer');
    actAs('bob');

    const outPath = join(rbacDir, 'denied.sbom.json');
    const cli = new Command();
    cli.addCommand(new SbomCommand().create());
    cli.parse(['node', 'buff', 'sbom', '--out', outPath]);

    expect(existsSync(outPath)).toBe(false);
    expect(process.exitCode).toBe(3);
  });

  it('sbom --out write proceeds for an admin and creates the file', () => {
    seedRole('bob', 'admin');
    actAs('bob');

    const outPath = join(rbacDir, 'allowed.sbom.json');
    const cli = new Command();
    cli.addCommand(new SbomCommand().create());
    cli.parse(['node', 'buff', 'sbom', '--out', outPath]);

    expect(existsSync(outPath)).toBe(true);
  });
});
