/**
 * J1 — Channel directory tests.
 * No network: alias persistence goes to a hermetic BUFF_CONFIG_DIR.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAliases } from '../../src/gateway/channel-directory.js';
import {
  ChannelDirectory,
  ALIAS_RE,
  isPlatformConfigured,
  configuredPlatforms,
  PLATFORM_ENV_VARS,
  readAliases,
} from '../../src/gateway/channel-directory.js';

const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const cfgDir = mkdtempSync(join(tmpdir(), 'buff-gw-dir-'));

beforeAll(() => {
  process.env.NUVIRA_CONFIG_DIR = cfgDir;
});

afterAll(() => {
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  rmSync(cfgDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.NUVIRA_TELEGRAM_TOKEN;
  delete process.env.NUVIRA_SLACK_BOT_TOKEN;
  delete process.env.NUVIRA_DISCORD_BOT_TOKEN;
  delete process.env.NUVIRA_DISCORD_WEBHOOK_URL;
  // Shared cfgDir persists aliases between tests — start each test clean.
  writeAliases([]);
});

describe('alias validation', () => {
  it('accepts lowercase alphanumeric + hyphens', () => {
    expect(ALIAS_RE.test('ops')).toBe(true);
    expect(ALIAS_RE.test('nightly-build')).toBe(true);
    expect(ALIAS_RE.test('a1b2')).toBe(true);
  });

  it('rejects uppercase, spaces, and over-length aliases', () => {
    expect(ALIAS_RE.test('Ops')).toBe(false);
    expect(ALIAS_RE.test('ops room')).toBe(false);
    expect(ALIAS_RE.test('a'.repeat(41))).toBe(false);
  });
});

describe('platform env map', () => {
  it('flags configured platforms only when their tokens are present', () => {
    process.env.NUVIRA_TELEGRAM_TOKEN = '123:abc';
    expect(isPlatformConfigured('telegram')).toBe(true);
    expect(configuredPlatforms()).toContain('telegram');
    delete process.env.NUVIRA_TELEGRAM_TOKEN;
    expect(isPlatformConfigured('telegram')).toBe(false);
    expect(configuredPlatforms()).not.toContain('telegram');
  });

  it('exposes the env vars per platform', () => {
    expect(PLATFORM_ENV_VARS.telegram).toEqual(['NUVIRA_TELEGRAM_TOKEN']);
    // I8: `whatsapp` = personal Baileys bridge (session dir override),
    // `whatsapp_cloud` = the paid Meta Business API.
    expect(PLATFORM_ENV_VARS.whatsapp).toEqual(['NUVIRA_WHATSAPP_SESSION_DIR']);
    expect(PLATFORM_ENV_VARS.whatsapp_cloud).toEqual(['NUVIRA_WHATSAPP_TOKEN']);
  });
});

describe('alias persistence + resolve', () => {
  it('setAlias → resolve round-trips and persists to disk', () => {
    process.env.NUVIRA_TELEGRAM_TOKEN = 'tok';
    process.env.NUVIRA_SLACK_BOT_TOKEN = 'xoxb-tok';
    const dir = new ChannelDirectory();
    dir.setAlias('ops', 'telegram', '12345');
    dir.setAlias('nightly', 'slack', 'C0123');

    expect(dir.resolve('ops')).toEqual({ platform: 'telegram', channelId: '12345' });
    expect(dir.resolve('nightly')).toEqual({ platform: 'slack', channelId: 'C0123' });

    // A fresh directory reads the same aliases from disk.
    const reloaded = new ChannelDirectory();
    expect(reloaded.resolve('ops')).toEqual({ platform: 'telegram', channelId: '12345' });
    expect(readAliases().length).toBe(2);
  });

  it('resolves explicit platform:channelId targets without an alias', () => {
    const dir = new ChannelDirectory();
    expect(dir.resolve('discord:987654')).toEqual({ platform: 'discord', channelId: '987654' });
    expect(dir.resolve('whatsapp:+15551234567')).toEqual({ platform: 'whatsapp', channelId: '+15551234567' });
  });

  it('returns null for unresolvable targets', () => {
    const dir = new ChannelDirectory();
    expect(dir.resolve('nope')).toBeNull();
    expect(dir.resolve('')).toBeNull();
    // 'matrix' is a real I9 platform — a genuinely unknown prefix is null.
    expect(dir.resolve('matrix:foo')).toEqual({ platform: 'matrix', channelId: 'foo' });
    expect(dir.resolve('unknown:foo')).toBeNull();
  });

  it('rejects registering an alias for an unconfigured platform', () => {
    delete process.env.NUVIRA_DISCORD_BOT_TOKEN;
    delete process.env.NUVIRA_DISCORD_WEBHOOK_URL;
    const dir = new ChannelDirectory();
    expect(() => dir.setAlias('chan', 'discord', '123')).toThrow(/not configured/);
  });

  it('removeAlias deletes and persists', () => {
    process.env.NUVIRA_TELEGRAM_TOKEN = 'tok';
    const dir = new ChannelDirectory();
    dir.setAlias('temp', 'telegram', '1');
    expect(dir.removeAlias('temp')).toBe(true);
    expect(dir.removeAlias('temp')).toBe(false);
    expect(dir.resolve('temp')).toBeNull();
  });

  it('reachableChannels groups aliases per target with reachability', () => {
    process.env.NUVIRA_TELEGRAM_TOKEN = 'tok';
    const dir = new ChannelDirectory();
    dir.setAlias('a', 'telegram', '1');
    dir.setAlias('b', 'telegram', '1');
    dir.setAlias('c', 'telegram', '2');
    const channels = dir.reachableChannels();
    const first = channels.find((c) => c.channelId === '1');
    expect(first?.aliases.sort()).toEqual(['a', 'b']);
    expect(first?.reachable).toBe(true);
    expect(channels.length).toBe(2);
  });
});

describe('I6 platforms (email / signal)', () => {
  const envBackup: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of Object.keys(envBackup)) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    Object.keys(envBackup).forEach((k) => delete envBackup[k]);
  });

  it('resolves explicit email: and signal: targets', () => {
    const dir = new ChannelDirectory();
    expect(dir.resolve('email:ops@example.com')).toEqual({ platform: 'email', channelId: 'ops@example.com' });
    expect(dir.resolve('signal:+15559876543')).toEqual({ platform: 'signal', channelId: '+15559876543' });
  });

  it('isPlatformConfigured reflects the SMTP / Signal env vars', () => {
    envBackup.NUVIRA_SMTP_HOST = process.env.NUVIRA_SMTP_HOST;
    envBackup.NUVIRA_SMTP_USER = process.env.NUVIRA_SMTP_USER;
    envBackup.NUVIRA_SIGNAL_ACCOUNT = process.env.NUVIRA_SIGNAL_ACCOUNT;
    delete process.env.NUVIRA_SMTP_HOST;
    delete process.env.NUVIRA_SMTP_USER;
    delete process.env.NUVIRA_SIGNAL_ACCOUNT;

    expect(isPlatformConfigured('email')).toBe(false);
    expect(isPlatformConfigured('signal')).toBe(false);
    expect(configuredPlatforms()).not.toContain('email');
    expect(configuredPlatforms()).not.toContain('signal');

    process.env.NUVIRA_SMTP_HOST = 'smtp.example.com';
    process.env.NUVIRA_SMTP_USER = 'bot';
    process.env.NUVIRA_SIGNAL_ACCOUNT = '+15551234567';
    expect(isPlatformConfigured('email')).toBe(true);
    expect(isPlatformConfigured('signal')).toBe(true);
    expect(PLATFORM_ENV_VARS.email).toEqual(['NUVIRA_SMTP_HOST', 'NUVIRA_SMTP_USER']);
    expect(PLATFORM_ENV_VARS.signal).toEqual(['NUVIRA_SIGNAL_ACCOUNT']);
  });

  it('allows registering an email alias when SMTP is configured', () => {
    envBackup.NUVIRA_SMTP_HOST = process.env.NUVIRA_SMTP_HOST;
    envBackup.NUVIRA_SMTP_USER = process.env.NUVIRA_SMTP_USER;
    process.env.NUVIRA_SMTP_HOST = 'smtp.example.com';
    process.env.NUVIRA_SMTP_USER = 'bot';
    const dir = new ChannelDirectory();
    const entry = dir.setAlias('notify', 'email', 'ops@example.com');
    expect(entry.platform).toBe('email');
    expect(dir.resolve('notify')).toEqual({ platform: 'email', channelId: 'ops@example.com' });
  });
});
