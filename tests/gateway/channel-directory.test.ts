/**
 * J1 — Channel directory tests (Hermes `channel_directory.py` parity).
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

const ORIG_CONFIG_DIR = process.env.BUFF_CONFIG_DIR;
const cfgDir = mkdtempSync(join(tmpdir(), 'buff-gw-dir-'));

beforeAll(() => {
  process.env.BUFF_CONFIG_DIR = cfgDir;
});

afterAll(() => {
  if (ORIG_CONFIG_DIR === undefined) delete process.env.BUFF_CONFIG_DIR;
  else process.env.BUFF_CONFIG_DIR = ORIG_CONFIG_DIR;
  rmSync(cfgDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.BUFF_TELEGRAM_TOKEN;
  delete process.env.BUFF_SLACK_BOT_TOKEN;
  delete process.env.BUFF_DISCORD_BOT_TOKEN;
  delete process.env.BUFF_DISCORD_WEBHOOK_URL;
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
    process.env.BUFF_TELEGRAM_TOKEN = '123:abc';
    expect(isPlatformConfigured('telegram')).toBe(true);
    expect(configuredPlatforms()).toContain('telegram');
    delete process.env.BUFF_TELEGRAM_TOKEN;
    expect(isPlatformConfigured('telegram')).toBe(false);
    expect(configuredPlatforms()).not.toContain('telegram');
  });

  it('exposes the env vars per platform (Hermes config.py token map)', () => {
    expect(PLATFORM_ENV_VARS.telegram).toEqual(['BUFF_TELEGRAM_TOKEN']);
    expect(PLATFORM_ENV_VARS.whatsapp).toEqual(['BUFF_WHATSAPP_TOKEN']);
  });
});

describe('alias persistence + resolve', () => {
  it('setAlias → resolve round-trips and persists to disk', () => {
    process.env.BUFF_TELEGRAM_TOKEN = 'tok';
    process.env.BUFF_SLACK_BOT_TOKEN = 'xoxb-tok';
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
    expect(dir.resolve('matrix:foo')).toBeNull();
  });

  it('rejects registering an alias for an unconfigured platform', () => {
    delete process.env.BUFF_DISCORD_BOT_TOKEN;
    delete process.env.BUFF_DISCORD_WEBHOOK_URL;
    const dir = new ChannelDirectory();
    expect(() => dir.setAlias('chan', 'discord', '123')).toThrow(/not configured/);
  });

  it('removeAlias deletes and persists', () => {
    process.env.BUFF_TELEGRAM_TOKEN = 'tok';
    const dir = new ChannelDirectory();
    dir.setAlias('temp', 'telegram', '1');
    expect(dir.removeAlias('temp')).toBe(true);
    expect(dir.removeAlias('temp')).toBe(false);
    expect(dir.resolve('temp')).toBeNull();
  });

  it('reachableChannels groups aliases per target with reachability', () => {
    process.env.BUFF_TELEGRAM_TOKEN = 'tok';
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
