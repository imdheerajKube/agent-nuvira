/**
 * Bundle 37a — the session grant ("allow all <category> for this session").
 *
 * Pins the Copilot-style grant end to end:
 *   - the module: additive, expiring, revocable, keyed to the session;
 *   - `run_terminal`: a granted session runs recoverable workspace commands
 *     without asking, while EXTERNAL commands and DENY patterns still refuse;
 *   - `write_file`: a granted session may overwrite, which the request-derived
 *     envelope deliberately would not allow;
 *   - `ask_user`: the grant is OFFERED as one choice at the confirmation a tool
 *     demanded, and only that choice grants it.
 *
 * Hermetic: a temp workspace, no network, no TTY.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getTool, type ToolContext } from '../../src/tools/registry.js';
import { runTerminalTool } from '../../src/tools/run-terminal.js';
import {
  grantSession,
  getSessionGrant,
  clearSessionGrant,
  sessionGrantCovers,
  sessionGrantNotice,
  SESSION_GRANT_TTL_MS,
} from '../../src/learning/session-grant.js';

let root: string;
/** A stand-in session key — the same object a plan store would be. */
let session: object;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nuvira-session-grant-'));
  session = {};
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A tool context whose `planStore` IS the grant key. */
function ctxWith(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    configManager: {},
    cwd: root,
    planStore: session as unknown as NonNullable<ToolContext['planStore']>,
    ...extra,
  };
}

describe('session-grant — the primitive', () => {
  it('grants a category and covers only what it names', () => {
    grantSession(session, ['terminal']);
    expect(sessionGrantCovers(session, 'terminal')).toBe(true);
    expect(sessionGrantCovers(session, 'write')).toBe(false);
  });

  it('is additive — granting a second category does not revoke the first', () => {
    grantSession(session, ['terminal']);
    grantSession(session, ['write']);
    expect(sessionGrantCovers(session, 'terminal')).toBe(true);
    expect(sessionGrantCovers(session, 'write')).toBe(true);
  });

  it('expires, and drops an expired grant on read', () => {
    grantSession(session, ['write'], 'test', 1_000);
    expect(sessionGrantCovers(session, 'write', 1_000 + SESSION_GRANT_TTL_MS - 1)).toBe(true);
    expect(sessionGrantCovers(session, 'write', 1_000 + SESSION_GRANT_TTL_MS + 1)).toBe(false);
  });

  it('is revocable, and a missing key never covers anything', () => {
    grantSession(session, ['write']);
    clearSessionGrant(session);
    expect(getSessionGrant(session)).toBeNull();
    expect(sessionGrantCovers(undefined, 'write')).toBe(false);
    expect(grantSession(undefined, ['write'])).toBeNull();
  });

  it('discloses what was granted', () => {
    const grant = grantSession(session, ['terminal', 'write'])!;
    const notice = sessionGrantNotice(grant);
    expect(notice).toContain('terminal commands');
    expect(notice).toContain('file writes');
    expect(notice).toContain('still ask');
  });
});

describe('run_terminal — a terminal grant covers recoverable commands only', () => {
  it('runs a recoverable command without asking when the session granted terminal', async () => {
    const ctx = ctxWith();
    // Without the grant it refuses and asks.
    const refused = await runTerminalTool({ command: 'touch marker.txt' }, ctx);
    expect(refused).toContain('needs explicit confirmation');
    expect(existsSync(join(root, 'marker.txt'))).toBe(false);

    grantSession(session, ['terminal']);
    const out = await runTerminalTool({ command: 'touch marker.txt' }, ctx);
    expect(out).toContain('✅ succeeded');
    expect(existsSync(join(root, 'marker.txt'))).toBe(true);
  });

  it('still refuses an EXTERNAL command even with a terminal grant', async () => {
    grantSession(session, ['terminal']);
    const out = await runTerminalTool({ command: 'curl -s https://example.com' }, ctxWith());
    expect(out).toContain('needs explicit confirmation');
  });

  it('still DENIES a destructive command even with a terminal grant', async () => {
    grantSession(session, ['terminal']);
    const out = await runTerminalTool({ command: 'git push origin main' }, ctxWith());
    expect(out).toContain('DENIED');
  });
});

describe('write_file — a write grant may overwrite; nothing else widens', () => {
  it('refuses an overwrite without the grant, and applies it with one', async () => {
    writeFileSync(join(root, 'notes.md'), 'first draft');
    const ctx = ctxWith();
    const refused = await getTool('write_file')!.run({ path: 'notes.md', content: 'overwritten' }, ctx);
    expect(refused).toContain('state-changing — NOT applied');
    expect(readFileSync(join(root, 'notes.md'), 'utf-8')).toBe('first draft');

    grantSession(session, ['write']);
    const out = await getTool('write_file')!.run({ path: 'notes.md', content: 'overwritten' }, ctx);
    expect(out).toContain("overwrote 'notes.md'");
    expect(readFileSync(join(root, 'notes.md'), 'utf-8')).toBe('overwritten');
  });
});

describe('ask_user — the grant is OFFERED at a tool-demanded confirmation', () => {
  it('offers the session choice and grants it when picked', async () => {
    const askUser = vi.fn(async (_q: string, choices: Array<{ label: string }>) => ({
      // The harness appended the grant choice as the third option.
      answer: choices[2]!.label,
      index: 2,
    }));
    const ctx = ctxWith({
      askUser,
      pendingConfirmation: { tool: 'run_terminal', command: 'touch marker.txt' },
    });

    const out = await getTool('ask_user')!.run(
      { question: 'Run `touch marker.txt`?', choices: [{ label: 'Yes' }, { label: 'No' }] },
      ctx,
    );

    // The renderer saw the extra choice …
    const offered = (askUser.mock.calls[0] as unknown as [string, Array<{ label: string }>])[1];
    expect(offered).toHaveLength(3);
    expect(offered[2]!.label).toBe('Allow this for the whole session');
    // … the grant is live for the session …
    expect(sessionGrantCovers(session, 'terminal')).toBe(true);
    // … and the model is told to finish the refused call once, then stop asking.
    expect(out).toContain('allowed all terminal commands for this session');
    expect(out).toContain('Retry the refused run_terminal command ONCE with confirm:true');
  });

  it('does NOT offer the grant on an ordinary clarifying question', async () => {
    const askUser = vi.fn(async () => ({ answer: 'Yes', index: 0 }));
    const ctx = ctxWith({ askUser });
    await getTool('ask_user')!.run(
      { question: 'Which database?', choices: [{ label: 'Postgres' }, { label: 'SQLite' }] },
      ctx,
    );
    const offered = (askUser.mock.calls[0] as unknown as [string, Array<{ label: string }>])[1];
    expect(offered.map((c) => c.label)).toEqual(['Postgres', 'SQLite']);
    expect(sessionGrantCovers(session, 'terminal')).toBe(false);
  });
});
