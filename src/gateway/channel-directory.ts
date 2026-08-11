/**
 * J1 — Channel directory (mirrors Hermes `channel_directory.py`).
 *
 * Maintains a cached map of REACHABLE channels with human-friendly aliases:
 *   alias        → { platform, channelId }
 *   "support"    → { platform: 'telegram', channelId: 123456 }
 *   "ops"        → { platform: 'slack', channelId: 'C0123' }
 *
 * Aliases are persisted to `~/.buff/gateway/aliases.json` (via BUFF_CONFIG_DIR)
 * so `buff gateway send ops "nightly done"` works across restarts. Platform
 * tokens are read from env — the Hermes `config.py` env-var token map pattern.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveBuffConfigDir } from '../config/paths.js';

/** Supported inbound platforms (Hermes Platform enum). */
export type Platform = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'mock';

/** A concrete destination: platform + platform-specific channel id. */
export interface ChannelRef {
  platform: Platform;
  channelId: string;
}

/** A channel directory entry — an alias pointing at a channel. */
export interface ChannelAlias {
  alias: string;
  platform: Platform;
  channelId: string;
  /** When the alias was registered (epoch ms). */
  addedAt: number;
}

/** A short, user-facing identity of a channel (for `buff gateway status`). */
export interface ReachableChannel {
  platform: Platform;
  channelId: string;
  aliases: string[];
  /** True when the adapter's transport is configured (env token present). */
  reachable: boolean;
}

// ─── Platform token map (Hermes `config.py` env-var map) ───────────────────

export const PLATFORM_ENV_VARS: Record<Platform, string[]> = {
  telegram: ['BUFF_TELEGRAM_TOKEN'],
  discord: ['BUFF_DISCORD_BOT_TOKEN'],
  slack: ['BUFF_SLACK_BOT_TOKEN'],
  whatsapp: ['BUFF_WHATSAPP_TOKEN'],
  mock: [],
};

/** Human-readable platform names (for CLI + status output). */
export const PLATFORM_LABELS: Record<Platform, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  mock: 'Mock (tests)',
};

/** Whether the platform's transport token is present in the environment. */
export function isPlatformConfigured(platform: Platform): boolean {
  return PLATFORM_ENV_VARS[platform].every((envVar) => Boolean(process.env[envVar]));
}

/** All platforms whose env tokens are present (opt-in adapters). */
export function configuredPlatforms(): Platform[] {
  return (Object.keys(PLATFORM_ENV_VARS) as Platform[]).filter((p) => p !== 'mock' && isPlatformConfigured(p));
}

// ─── Alias persistence ──────────────────────────────────────────────────────

function aliasesFilePath(): string {
  return join(resolveBuffConfigDir(), 'gateway', 'aliases.json');
}

/** Read persisted aliases (empty when the file is absent/corrupt — never throw). */
export function readAliases(): ChannelAlias[] {
  try {
    const raw = readFileSync(aliasesFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as { aliases?: ChannelAlias[] };
    if (!Array.isArray(parsed.aliases)) return [];
    return parsed.aliases.filter(
      (a) => a && typeof a.alias === 'string' && typeof a.channelId === 'string' && a.platform,
    );
  } catch {
    return [];
  }
}

/** Persist aliases (small file — single write). */
export function writeAliases(aliases: ChannelAlias[]): void {
  const file = aliasesFilePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, aliases }, null, 2), 'utf-8');
}

// ─── Channel directory ──────────────────────────────────────────────────────

/** Alias constraints: lowercase alphanumeric + hyphen, 1–40 chars. */
export const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The channel directory. Resolves human-friendly aliases (and raw
 * `platform:channelId` targets) to a ChannelRef.
 */
export class ChannelDirectory {
  private aliases: ChannelAlias[];

  constructor(initial?: ChannelAlias[]) {
    this.aliases = initial ?? readAliases();
  }

  /** All persisted aliases. */
  listAliases(): ChannelAlias[] {
    return [...this.aliases].sort((a, b) => a.alias.localeCompare(b.alias));
  }

  /** Register (or update) an alias. Returns the saved entry. */
  setAlias(alias: string, platform: Platform, channelId: string): ChannelAlias {
    if (!ALIAS_RE.test(alias)) {
      throw new Error(`Invalid alias '${alias}' — use lowercase letters, digits, hyphens (1–40 chars)`);
    }
    if (!isPlatformConfigured(platform) && platform !== 'mock') {
      throw new Error(
        `Platform '${platform}' is not configured — set ${PLATFORM_ENV_VARS[platform].join(', ')}`,
      );
    }
    const entry: ChannelAlias = { alias, platform, channelId, addedAt: Date.now() };
    this.aliases = this.aliases.filter((a) => a.alias !== alias);
    this.aliases.push(entry);
    writeAliases(this.aliases);
    return entry;
  }

  /** Remove an alias. Returns true when it existed. */
  removeAlias(alias: string): boolean {
    const before = this.aliases.length;
    this.aliases = this.aliases.filter((a) => a.alias !== alias);
    if (this.aliases.length !== before) {
      writeAliases(this.aliases);
      return true;
    }
    return false;
  }

  /**
   * Resolve a target string to a ChannelRef.
   *   "ops"            → alias lookup
   *   "telegram:12345" → explicit platform:channelId
   * Returns null when unresolvable.
   */
  resolve(target: string): ChannelRef | null {
    const t = (target || '').trim();
    if (!t) return null;
    const alias = this.aliases.find((a) => a.alias === t);
    if (alias) return { platform: alias.platform, channelId: alias.channelId };
    const explicit = t.match(/^(telegram|discord|slack|whatsapp|mock):(.+)$/);
    if (explicit) return { platform: explicit[1] as Platform, channelId: explicit[2] };
    return null;
  }

  /** Reachable channels (aliases grouped by target) for `buff gateway status`. */
  reachableChannels(): ReachableChannel[] {
    const byKey = new Map<string, ReachableChannel>();
    for (const a of this.aliases) {
      const key = `${a.platform}:${a.channelId}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { platform: a.platform, channelId: a.channelId, aliases: [], reachable: isPlatformConfigured(a.platform) };
        byKey.set(key, entry);
      }
      entry.aliases.push(a.alias);
    }
    return [...byKey.values()].sort((x, y) => x.platform.localeCompare(y.platform));
  }
}
