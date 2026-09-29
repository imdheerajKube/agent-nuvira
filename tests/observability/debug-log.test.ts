/**
 * WS2 (#24) — the session debug log, unit-tested at its own boundary.
 *
 * The parity suite proves the CAPABILITY (every surface writes one, and every
 * header names the same backend). This file proves the CONTRACT, including the
 * four rules in the module's header that a driven run cannot observe:
 *
 *   1. opt-in — off unless asked, and `NUVIRA_DEBUG_LOG=false` means OFF (a user
 *      writing that into an `.env` is not asking for a log);
 *   2. redacted — a key that reaches an event or a header field must not reach
 *      the file, because we are asking a user to attach this to a bug report;
 *   3. bounded — long details are cut and the oldest events are dropped, with
 *      the file saying so rather than silently losing them;
 *   4. written once at close — the header can only be right if the backend is
 *      learned first, so nothing is written until `write()`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEBUG_LOG_MAX_EVENTS,
  DEBUG_LOG_PREVIEW_CHARS,
  SessionDebugLog,
  debugLogDir,
  debugLogNotice,
  debugLoggingEnabled,
  listDebugLogs,
  parseDebugLogHeader,
  readLatestDebugLog,
  sessionDebugLog,
} from '../../src/observability/debug-log.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'buff-debuglog-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('WS2 debug log — opt-in', () => {
  it('is OFF when the env var is unset', () => {
    expect(debugLoggingEnabled({})).toBe(false);
    expect(sessionDebugLog({ surface: 'cli-chat', env: {} })).toBeNull();
  });

  it('is ON for a truthy value and OFF for the falsey ones a user would write', () => {
    for (const on of ['1', 'true', 'TRUE', 'yes', 'on', 'anything']) {
      expect(debugLoggingEnabled({ NUVIRA_DEBUG_LOG: on }), on).toBe(true);
    }
    // `NUVIRA_DEBUG_LOG=false` in an `.env` means off, not "a non-empty string".
    for (const off of ['0', 'false', 'FALSE', 'off', 'no', '   ']) {
      expect(debugLoggingEnabled({ NUVIRA_DEBUG_LOG: off }), off).toBe(false);
    }
    // The legacy alias still works for old profiles.
    expect(debugLoggingEnabled({ BUFF_DEBUG_LOG: '1' })).toBe(true);
  });

  it('honours the directory override, then the isolated config dir', () => {
    expect(debugLogDir({ NUVIRA_DEBUG_LOG_DIR: '/tmp/one' })).toBe('/tmp/one');
    expect(debugLogDir({ NUVIRA_DEBUG_LOG_DIR: '  ', BUFF_DEBUG_LOG_DIR: '/tmp/two' })).toBe('/tmp/two');
    // No override → `<config dir>/debug-logs`, so an isolated profile never
    // writes into the developer's real ~/.nuvira.
    const previous = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_CONFIG_DIR = '/tmp/isolated-profile';
    try {
      expect(debugLogDir({})).toBe(join('/tmp/isolated-profile', 'debug-logs'));
    } finally {
      if (previous === undefined) delete process.env.NUVIRA_CONFIG_DIR;
      else process.env.NUVIRA_CONFIG_DIR = previous;
    }
  });
});

describe('WS2 debug log — header', () => {
  it('names the surface and the backend, and round-trips through the parser', () => {
    const log = new SessionDebugLog({
      surface: 'Dashboard-Chat',
      goal: 'answer the question',
      backend: { engine: 'loop', provider: 'groq', model: 'llama-3.3-70b', transport: 'native' },
      dir: tempDir(),
      now: () => 1_700_000_000_000,
    });
    const text = log.render();

    // The human-readable first line — what a reader attaching this sees.
    expect(text.split('\n')[0]).toContain('nuvira session debug log');

    const header = parseDebugLogHeader(text);
    expect(header).not.toBeNull();
    // The surface label is normalised to a filename-safe, lower-case form.
    expect(header!.surface).toBe('dashboard-chat');
    expect(header!.engine).toBe('loop');
    expect(header!.provider).toBe('groq');
    expect(header!.model).toBe('llama-3.3-70b');
    expect(header!.transport).toBe('native');
    expect(header!.startedAt).toBe(1_700_000_000_000);
    expect(header!.pid).toBe(process.pid);
    expect(header!.platform).toContain(process.platform);
  });

  it('reports a field it never learned as `unknown` in the file and null when parsed', () => {
    // The distinction that matters: a header with no backend is readable and
    // honest, but it must NOT compare equal to a header that named one — hence
    // the sentinel maps back to null.
    const log = new SessionDebugLog({ surface: 'cli-chat', dir: null });
    log.backendOf({ engine: 'loop' });
    const text = log.render();
    expect(text).toContain('# backend.provider: unknown');
    const header = parseDebugLogHeader(text)!;
    expect(header.provider).toBeNull();
    expect(header.model).toBeNull();
    expect(header.transport).toBeNull();
  });

  it('refuses to parse a header with no surface — that field is the contract', () => {
    expect(parseDebugLogHeader('just some text\nmore')).toBeNull();
    expect(parseDebugLogHeader('# provider: groq\n')).toBeNull();
  });

  it('learns the backend as the turn runs, and the LAST value wins', () => {
    // The whole reason the file is written at close: the provider walk mutates
    // the route mid-turn, so a header captured at turn start is wrong exactly
    // when failover happened.
    const log = new SessionDebugLog({ surface: 'cli-execute', dir: null });
    log.backendOf({ provider: 'auto', model: 'default' });
    log.backendOf({ provider: 'groq', model: 'llama-3.3-70b', transport: 'native' });
    const header = parseDebugLogHeader(log.render())!;
    expect(header.provider).toBe('groq');
    expect(header.model).toBe('llama-3.3-70b');
    expect(header.transport).toBe('native');
  });
});

describe('WS2 debug log — redaction and bounds', () => {
  it('never writes a credential pasted into an event or a header field', () => {
    const dir = tempDir();
    const log = new SessionDebugLog({ surface: 'gateway-chat', dir });
    log.event('send', { target: 'https://api.example.com/v1?api_key=sk-live-abcdefghijklmnop' });
    log.event('call', 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    log.detail('channel', 'token=xoxb-1234567890-abcdefghijkl');
    const text = log.render();
    expect(text).not.toContain('sk-live-abcdefghijklmnop');
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(text).not.toContain('xoxb-1234567890-abcdefghijkl');
    expect(text).toContain('***');
  });

  it('cuts a long detail and says how many lines were cut', () => {
    const log = new SessionDebugLog({ surface: 'cli-chat', dir: null });
    log.event('big', 'x'.repeat(DEBUG_LOG_PREVIEW_CHARS * 3));
    const text = log.render();
    expect(text).toContain('# truncated: 1 event(s)');
    // The line is bounded, not the whole payload.
    const detail = text.split('\n').find((l) => l.includes('big'))!;
    expect(detail.length).toBeLessThan(DEBUG_LOG_PREVIEW_CHARS + 60);
  });

  it('drops the OLDEST events past the cap and records the loss', () => {
    const log = new SessionDebugLog({ surface: 'cli-chat', dir: null });
    for (let i = 0; i < DEBUG_LOG_MAX_EVENTS + 5; i += 1) log.event(`e${i}`);
    const text = log.render();
    expect(text).toContain(`# events: ${DEBUG_LOG_MAX_EVENTS} (+5 older dropped)`);
    expect(text).not.toContain(' e0\n');
    expect(text).toContain(`e${DEBUG_LOG_MAX_EVENTS + 4}`);
  });
});

describe('WS2 debug log — writing and reading back', () => {
  it('writes one file per turn and reads it back by surface', () => {
    const dir = tempDir();
    const log = new SessionDebugLog({
      surface: 'cli-chat',
      goal: 'do the thing',
      backend: { engine: 'loop', provider: 'groq', model: 'm', transport: 'native' },
      dir,
      now: () => 1_700_000_000_000,
    });
    log.event('turn.start');
    expect(log.path()).toBeNull();
    const path = log.write();
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    expect(log.path()).toBe(path);

    const found = readLatestDebugLog('cli-chat', dir);
    expect(found).not.toBeNull();
    expect(found!.header.provider).toBe('groq');
    expect(found!.text).toContain('turn.start');
    // A surface that wrote nothing must NOT be found by another surface's name.
    expect(readLatestDebugLog('subagent', dir)).toBeNull();
  });

  it('returns the NEWEST log for a surface, so a repeat turn is read not the first', () => {
    const dir = tempDir();
    const first = new SessionDebugLog({ surface: 'cli-chat', dir, now: () => 1_000 });
    first.backendOf({ provider: 'groq', model: 'old' });
    first.write();
    const second = new SessionDebugLog({ surface: 'cli-chat', dir, now: () => 2_000 });
    second.backendOf({ provider: 'groq', model: 'new' });
    second.write();

    const found = readLatestDebugLog('cli-chat', dir)!;
    expect(found.header.model).toBe('new');
    expect(listDebugLogs(dir)).toHaveLength(2);
  });

  it('is a silent no-op when there is nowhere to write', () => {
    const log = new SessionDebugLog({ surface: 'cli-chat', dir: null });
    log.event('turn.start');
    expect(() => log.write()).not.toThrow();
    expect(log.write()).toBeNull();
  });

  it('words the console notice identically wherever it is printed', () => {
    expect(debugLogNotice('cli-chat', null)).toBeNull();
    expect(debugLogNotice('cli-chat', '/tmp/x.log')).toContain('cli-chat');
    expect(debugLogNotice('cli-chat', '/tmp/x.log')).toContain('/tmp/x.log');
    expect(debugLogNotice('cli-chat', '/tmp/x.log')).toContain('bug report');
  });

  it('lists nothing for a directory that does not exist', () => {
    expect(listDebugLogs(join(tmpdir(), 'buff-debuglog-missing-dir'))).toEqual([]);
    expect(readdirSync(tmpdir()).length).toBeGreaterThan(0);
  });
});
