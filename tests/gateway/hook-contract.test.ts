/**
 * Hook contract — the declarative, allow-listed lifecycle rules.
 *
 * These tests pin the two things that make the feature safe to expose:
 *   1. the CONTRACT rejects a declaration that would be a silent no-op (deny on
 *      a seam that cannot stop a call; scan-args on session end), and
 *   2. the RUNTIME only ever does one of three native things — deny, notify,
 *      scan — so loading a hook can never execute code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateHookDeclaration,
  validateHookDeclarations,
  globMatches,
  matchesHookDeclaration,
  applyHookDeclaration,
  evaluateDeclarations,
  setHookDeclarations,
  getHookDeclarations,
  resetHookDeclarationsCache,
  installDeclaredHooks,
  resetDeclaredHooksInstall,
  hookDeclarationsFile,
  type HookDeclaration,
  type HookRegistrar,
} from '../../src/gateway/hook-contract.js';

const FAKE_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

let configDir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'hook-contract-'));
  prevConfigDir = process.env.NUVIRA_CONFIG_DIR;
  process.env.NUVIRA_CONFIG_DIR = configDir;
  resetHookDeclarationsCache();
  resetDeclaredHooksInstall();
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = prevConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

describe('validateHookDeclaration', () => {
  it('accepts a well-formed declaration', () => {
    const res = validateHookDeclaration({
      id: 'block-rm-rf',
      label: 'Block rm -rf',
      event: 'before_tool_call',
      enabled: true,
      when: { tool: 'run_terminal', argsMatch: { command: 'rm -rf*' } },
      action: { kind: 'deny', reason: 'destructive command' },
    });
    expect(res.ok).toBe(true);
  });

  it('rejects a deny on a seam that cannot stop a call', () => {
    const res = validateHookDeclaration({
      id: 'x', label: 'x', event: 'after_tool_call', enabled: true, action: { kind: 'deny' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/deny is only available on before_tool_call/);
  });

  it('rejects scan-args on on_session_end (no tool call there)', () => {
    const res = validateHookDeclaration({
      id: 'x', label: 'x', event: 'on_session_end', enabled: true, action: { kind: 'scan-args' },
    });
    expect(res.ok).toBe(false);
  });

  it('rejects a bad id and a duplicate id', () => {
    expect(validateHookDeclaration({ id: 'Bad Id', label: 'x', event: 'before_tool_call', enabled: true, action: { kind: 'notify', message: 'hi' } }).ok).toBe(false);
    const dup = validateHookDeclarations([
      { id: 'same', label: 'a', event: 'before_tool_call', enabled: true, action: { kind: 'notify', message: 'a' } },
      { id: 'same', label: 'b', event: 'after_tool_call', enabled: true, action: { kind: 'notify', message: 'b' } },
    ]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toMatch(/duplicate hook id/);
  });
});

describe('matching', () => {
  it('globMatches supports * and is case-insensitive', () => {
    expect(globMatches('*', 'anything')).toBe(true);
    expect(globMatches('edit_*', 'edit_file')).toBe(true);
    expect(globMatches('edit_*', 'write_file')).toBe(false);
    expect(globMatches('run_terminal', 'RUN_TERMINAL')).toBe(true);
    expect(globMatches('*', undefined)).toBe(true);
    expect(globMatches('run_terminal', undefined)).toBe(false);
  });

  it('matchesHookDeclaration reads only the fields it names', () => {
    const hook: HookDeclaration = {
      id: 'h', label: 'h', event: 'before_tool_call', enabled: true,
      when: { tool: 'run_*', cwdPrefix: '/work/proj', argsMatch: { command: 'rm *' } },
      action: { kind: 'notify', message: 'x' },
    };
    expect(matchesHookDeclaration(hook, { tool: 'run_terminal', cwd: '/work/proj/app', args: { command: 'rm -rf /' } })).toBe(true);
    expect(matchesHookDeclaration(hook, { tool: 'run_terminal', cwd: '/other', args: { command: 'rm -rf /' } })).toBe(false);
    expect(matchesHookDeclaration(hook, { tool: 'read_file', cwd: '/work/proj', args: { command: 'rm -rf /' } })).toBe(false);
    expect(matchesHookDeclaration(hook, { tool: 'run_terminal', cwd: '/work/proj', args: { command: 'ls' } })).toBe(false);
  });
});

describe('actions — the allow-list in force', () => {
  const base = (action: HookDeclaration['action'], event: HookDeclaration['event'] = 'before_tool_call'): HookDeclaration => ({
    id: 'h', label: 'h', event, enabled: true, action,
  });

  it('deny returns a decision the registry can honour', () => {
    const d = applyHookDeclaration(base({ kind: 'deny', reason: 'no' }), { tool: 'run_terminal', surface: 'cli-chat' });
    expect(d).toMatchObject({ deny: true, reason: 'no', by: 'hook:h' });
  });

  it('notify logs and never vetoes', () => {
    const reports: string[] = [];
    const d = applyHookDeclaration(base({ kind: 'notify', message: 'ran {tool} on {surface}' }), {
      tool: 'read_file', surface: 'cli-chat', report: (m: string) => reports.push(m),
    });
    expect(d).toBeNull();
    expect(reports.some((r) => r.includes('ran read_file on cli-chat'))).toBe(true);
  });

  it('scan-args detects a secret shape in the arguments', () => {
    const reports: string[] = [];
    const d = applyHookDeclaration(base({ kind: 'scan-args' }), {
      tool: 'write_file', args: { content: `token=${FAKE_TOKEN}` }, report: (m: string) => reports.push(m),
    });
    expect(d).toBeNull();
    expect(reports.some((r) => /secret-shaped/.test(r))).toBe(true);
    // The report must never contain the raw value.
    expect(reports.join(' ')).not.toContain(FAKE_TOKEN);
  });

  it('scan-args with denyOnHit vetoes before the call runs', () => {
    const d = applyHookDeclaration(base({ kind: 'scan-args', denyOnHit: true }), {
      tool: 'write_file', args: { content: `token=${FAKE_TOKEN}` },
    });
    expect(d).toMatchObject({ deny: true, by: 'hook:h' });
  });

  it('a disabled hook is inert', () => {
    const hook = { ...base({ kind: 'deny' }), enabled: false };
    expect(applyHookDeclaration(hook, { tool: 'run_terminal' })).toBeNull();
  });

  it('evaluateDeclarations returns the FIRST denial and skips other events', () => {
    const first: HookDeclaration = { id: 'a', label: 'a', event: 'before_tool_call', enabled: true, action: { kind: 'deny', reason: 'first' } };
    const second: HookDeclaration = { id: 'b', label: 'b', event: 'before_tool_call', enabled: true, action: { kind: 'deny', reason: 'second' } };
    const other: HookDeclaration = { id: 'c', label: 'c', event: 'after_tool_call', enabled: true, action: { kind: 'deny' } };
    const d = evaluateDeclarations([first, second, other], 'before_tool_call', { tool: 'x' });
    expect(d?.reason).toBe('first');
    expect(evaluateDeclarations([other], 'before_tool_call', { tool: 'x' })).toBeNull();
  });
});

describe('persistence', () => {
  it('writes declarations to <config-dir>/hooks.json and reloads them', () => {
    const r = setHookDeclarations([
      { id: 'notify-all', label: 'Notify all', event: 'before_tool_call', enabled: true, action: { kind: 'notify', message: 'hi' } },
    ]);
    expect(r.ok).toBe(true);
    expect(existsSync(hookDeclarationsFile())).toBe(true);
    expect(hookDeclarationsFile().startsWith(configDir)).toBe(true);

    resetHookDeclarationsCache();
    expect(getHookDeclarations().map((h) => h.id)).toEqual(['notify-all']);
  });

  it('rejects an invalid list WITHOUT clobbering the in-force set', () => {
    setHookDeclarations([{ id: 'keep', label: 'keep', event: 'before_tool_call', enabled: true, action: { kind: 'notify', message: 'x' } }]);
    const bad = setHookDeclarations([{ id: 'no', label: 'no', event: 'after_tool_call', enabled: true, action: { kind: 'deny' } }]);
    expect(bad.ok).toBe(false);
    expect(getHookDeclarations().map((h) => h.id)).toEqual(['keep']);
  });
});

describe('runtime installation', () => {
  it('registers one handler per seam and a deny actually fires, idempotently', () => {
    setHookDeclarations([
      { id: 'block', label: 'Block', event: 'before_tool_call', enabled: true, when: { tool: 'run_terminal' }, action: { kind: 'deny', reason: 'blocked' } },
    ]);
    const registered: Array<{ event: string; handler: (ctx: any) => unknown }> = [];
    const fake: HookRegistrar = { register: (event, handler) => { registered.push({ event, handler }); } };
    installDeclaredHooks(fake);
    installDeclaredHooks(fake); // idempotent — must not double-register
    expect(registered.map((r) => r.event)).toEqual(['before_tool_call', 'after_tool_call', 'failed_tool_call', 'on_session_end']);

    const before = registered.find((r) => r.event === 'before_tool_call')!;
    const decision = before.handler({ tool: 'run_terminal', surface: 'cli-chat' }) as { deny?: boolean; reason?: string } | undefined;
    expect(decision?.deny).toBe(true);
    expect(decision?.reason).toBe('blocked');
    // A tool the matcher does not name is untouched.
    expect(before.handler({ tool: 'read_file' })).toBeUndefined();
  });

  it('reads declarations LIVE, so a save takes effect without reinstalling', () => {
    const registered: Array<{ event: string; handler: (ctx: any) => unknown }> = [];
    const fake: HookRegistrar = { register: (event, handler) => { registered.push({ event, handler }); } };
    installDeclaredHooks(fake);
    const before = registered.find((r) => r.event === 'before_tool_call')!;
    expect(before.handler({ tool: 'run_terminal' })).toBeUndefined();

    setHookDeclarations([{ id: 'late', label: 'Late', event: 'before_tool_call', enabled: true, action: { kind: 'deny', reason: 'now' } }]);
    const decision = before.handler({ tool: 'run_terminal' }) as { deny?: boolean } | undefined;
    expect(decision?.deny).toBe(true);
  });
});
