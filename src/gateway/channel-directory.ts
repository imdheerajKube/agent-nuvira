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
import { hasWhatsAppSession } from './whatsapp/session.js';

/** Supported platforms (Hermes Platform enum — I8 splits WhatsApp, I9 adds webhook connectors). */
export type Platform =
  | 'telegram' | 'discord' | 'slack'
  | 'whatsapp' | 'whatsapp_cloud'
  | 'email' | 'signal'
  | 'dingtalk' | 'feishu' | 'wecom' | 'mattermost' | 'matrix' | 'webhook' | 'bluebubbles'
  // I10 — ntfy / Teams / Google Chat / Weixin (thin send adapters).
  | 'ntfy' | 'teams' | 'google_chat' | 'weixin'
  // I12 — SMS (Twilio REST, Hermes plugins/platforms/sms parity).
  | 'sms'
  // I13 — IRC (RFC 1459 over node:net/tls, Hermes plugins/platforms/irc parity).
  | 'irc'
  // I14 — SimpleX (local daemon WebSocket, Hermes plugins/platforms/simplex parity).
  | 'simplex'
  // I15 — Home Assistant (REST API, Hermes plugins/platforms/homeassistant parity).
  | 'homeassistant'
  | 'mock';

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
  // I8: `whatsapp` = personal Baileys bridge (paired session dir override),
  // `whatsapp_cloud` = paid Meta Business API (token + phone id).
  whatsapp: ['BUFF_WHATSAPP_SESSION_DIR'],
  whatsapp_cloud: ['BUFF_WHATSAPP_TOKEN'],
  // I9 — webhook/REST connectors (send-only bot webhooks).
  dingtalk: ['BUFF_DINGTALK_WEBHOOK_URL'],
  feishu: ['BUFF_FEISHU_WEBHOOK_URL'],
  wecom: ['BUFF_WECOM_WEBHOOK_URL'],
  mattermost: ['BUFF_MATTERMOST_WEBHOOK_URL'],
  matrix: ['BUFF_MATRIX_HOMESERVER', 'BUFF_MATRIX_ACCESS_TOKEN'],
  webhook: ['BUFF_WEBHOOK_URL'],
  bluebubbles: ['BUFF_BLUEBUBBLES_URL', 'BUFF_BLUEBUBBLES_PASSWORD'],
  // I10 — thin send connectors. ntfy needs only the topic (BUFF_NTFY_URL
  // defaults to ntfy.sh); weixin needs only the iLink bot token (base URL
  // defaults to the official iLink endpoint).
  ntfy: ['BUFF_NTFY_TOPIC'],
  teams: ['BUFF_TEAMS_WEBHOOK_URL'],
  google_chat: ['BUFF_GOOGLE_CHAT_WEBHOOK_URL'],
  weixin: ['BUFF_WEIXIN_TOKEN'],
  // I12 — SMS uses the SAME Twilio env vars as Hermes (`plugins/platforms/sms`),
  // so the same creds work in both agents.
  sms: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'],
  // I13 — IRC uses the SAME env vars as Hermes (`plugins/platforms/irc`):
  // IRC_SERVER is the transport gate; nickname/port/channel have defaults.
  irc: ['IRC_SERVER'],
  // I14 — SimpleX uses the SAME env var as Hermes (`plugins/platforms/simplex`):
  // the daemon's WebSocket URL is the transport gate.
  simplex: ['SIMPLEX_WS_URL'],
  // I15 — Home Assistant uses the SAME env vars as Hermes
  // (`plugins/platforms/homeassistant`): HASS_TOKEN is the gate (HASS_URL
  // defaults to http://homeassistant.local:8123).
  homeassistant: ['HASS_TOKEN'],
  // Email transport = an SMTP relay the gateway can reach (host + auth user;
  // BUFF_SMTP_PASS may be absent for local/trusted relays).
  email: ['BUFF_SMTP_HOST', 'BUFF_SMTP_USER'],
  // Signal = the registered account number (the REST endpoint defaults to a
  // local signal-cli-rest-api and is not itself an opt-in signal).
  signal: ['BUFF_SIGNAL_ACCOUNT'],
  mock: [],
};

/** Human-readable platform names (for CLI + status output). */
export const PLATFORM_LABELS: Record<Platform, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp (Baileys bridge)',
  whatsapp_cloud: 'WhatsApp Business (Cloud API)',
  dingtalk: 'DingTalk (robot webhook)',
  feishu: 'Feishu (bot webhook)',
  wecom: 'WeCom (group bot webhook)',
  mattermost: 'Mattermost (webhook)',
  matrix: 'Matrix (homeserver API)',
  webhook: 'Webhook (generic)',
  bluebubbles: 'BlueBubbles (iMessage bridge)',
  ntfy: 'ntfy (push notifications)',
  teams: 'Microsoft Teams (incoming webhook)',
  google_chat: 'Google Chat (space webhook)',
  weixin: 'Weixin (iLink bot API, send)',
  sms: 'SMS (Twilio)',
  irc: 'IRC',
  simplex: 'SimpleX (daemon WS)',
  homeassistant: 'Home Assistant (REST)',
  email: 'Email (SMTP)',
  signal: 'Signal (signal-cli-rest-api)',
  mock: 'Mock (tests)',
};

/**
 * Whether the platform's transport is configured.
 *
 * Env-token based for every platform except I8's `whatsapp` bridge: its
 * transport is a PAIRED SESSION on disk (default `~/.buff/whatsapp/session`),
 * so the env override (`BUFF_WHATSAPP_SESSION_DIR`) alone would lie about a
 * default-path session. hasWhatsAppSession() is the authoritative check
 * (session.ts imports only node builtins — no cycle).
 */
export function isPlatformConfigured(platform: Platform): boolean {
  if (platform === 'whatsapp') return hasWhatsAppSession();
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
    const explicit = t.match(/^(telegram|discord|slack|whatsapp|whatsapp_cloud|email|signal|dingtalk|feishu|wecom|mattermost|matrix|webhook|bluebubbles|ntfy|teams|google_chat|weixin|sms|irc|simplex|homeassistant|mock):(.+)$/);
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
