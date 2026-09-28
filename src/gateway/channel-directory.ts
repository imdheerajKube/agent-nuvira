/**
 * J1 — Channel directory.
 *
 * Maintains a cached map of REACHABLE channels with human-friendly aliases:
 *   alias        → { platform, channelId }
 *   "support"    → { platform: 'telegram', channelId: 123456 }
 *   "ops"        → { platform: 'slack', channelId: 'C0123' }
 *
 * Aliases are persisted to `~/.nuvira/gateway/aliases.json` (via NUVIRA_CONFIG_DIR)
 * so `nuvira gateway send ops "nightly done"` works across restarts. Platform
 * tokens are read from env — an env-var token map pattern.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveBuffConfigDir } from '../config/paths.js';
import { hasWhatsAppSession } from './whatsapp/session.js';
import { readGatewayContacts, resolveContact } from './contacts.js';

/** Supported platforms (I8 splits WhatsApp, I9 adds webhook connectors). */
export type Platform =
  | 'telegram' | 'discord' | 'slack'
  | 'whatsapp' | 'whatsapp_cloud'
  | 'email' | 'signal'
  | 'dingtalk' | 'feishu' | 'wecom' | 'mattermost' | 'matrix' | 'webhook' | 'bluebubbles'
  // I10 — ntfy / Teams / Google Chat / Weixin (thin send adapters).
  | 'ntfy' | 'teams' | 'google_chat' | 'weixin'
  // I12 — SMS (Twilio REST).
  | 'sms'
  // I13 — IRC (RFC 1459 over node:net/tls).
  | 'irc'
  // I14 — SimpleX (local daemon WebSocket).
  | 'simplex'
  // I15 — Home Assistant (REST API).
  | 'homeassistant'
  | 'mock';

/** A concrete destination: platform + platform-specific channel id. */
export interface ChannelRef {
  platform: Platform;
  channelId: string;
}

/**
 * P1 — per-platform inbound policy (who may trigger the agent pipeline).
 *
 * Keeps "anyone who messages the bot" safe: an allowlist of users/groups,
 * address-only mode for groups, or a hard off-switch. The global
 * BUFF_GATEWAY_ALLOW_IDS (platform:channelId) still applies on top.
 */
export interface ChannelPolicy {
  /**
   * Verified senders allowed to trigger the pipeline. Verified-list rule:
   * present + entries = ONLY those senders; present + empty (blank) = NO ONE;
   * the "Allow-All" wildcard token (case-insensitive) = skip the verifier,
   * anyone may trigger. ABSENT = legacy open default (no per-user gate).
   */
  allowedUsers?: string[];
  /** Group/channel ids allowed to trigger (empty/absent = inherit global). */
  allowedGroups?: string[];
  /**
   * Address-only mode: in groups, only messages that MENTION / address the
   * bot (name-prefix "nuvira …", "agent …", or @-mention) trigger the pipeline.
   */
  requireMention?: boolean;
  /** Hard off-switch for this platform's pipeline triggers. */
  disabled?: boolean;
  /**
   * HARD POLICY: silent by DEFAULT — an unapproved sender/group gets NO reply
   * and NO processing (the refusal is recorded in the inbox only), so unknown
   * numbers never learn a bot exists. Set `silentDrop: false` to explicitly
   * opt a platform back into the polite ⛔ refusal message.
   */
  silentDrop?: boolean;
  /**
   * OUTBOUND send authority — who may command the agent to send to a THIRD
   * PARTY through `gateway_send` (e.g. "send this poem to my brother on
   * WhatsApp"). This is DISTINCT from `allowedUsers`, which only decides who
   * may TRIGGER the agent in the first place.
   *
   * Verified-list rule (identical to `allowedUsers` for consistency):
   * present + entries = ONLY those senders may command an outbound send;
   * present + empty ([]) = NO ONE may; the "Allow-All" wildcard = anyone;
   * ABSENT = inherit `allowedUsers` (legacy behaviour: every sender authorised
   * to trigger the agent can also direct it to send to others).
   *
   * A sender may ALWAYS reply inside their own conversation (that is what the
   * automatic text response already does) — this list governs sending to
   * OTHER targets only.
   */
  outboundSenders?: string[];
  /**
   * Require every `gateway_send` TARGET to resolve to an APPROVED contact in
   * the contacts directory. Off by default so an explicit
   * `platform:<number|id>` target keeps working; turn it on to stop an
   * authorised sender from messaging arbitrary strangers.
   */
  requireApprovedTarget?: boolean;
}

/** Per-platform policies (keyed by Platform id). */
export type PolicyMap = Partial<Record<Platform, ChannelPolicy>>;

/** A channel directory entry — an alias pointing at a channel. */
export interface ChannelAlias {
  alias: string;
  platform: Platform;
  channelId: string;
  /** When the alias was registered (epoch ms). */
  addedAt: number;
}

/** A short, user-facing identity of a channel (for `nuvira gateway status`). */
export interface ReachableChannel {
  platform: Platform;
  channelId: string;
  aliases: string[];
  /** True when the adapter's transport is configured (env token present). */
  reachable: boolean;
}

// ─── Platform token map (env-var map) ──────────────────────────────────────

export const PLATFORM_ENV_VARS: Record<Platform, string[]> = {
  telegram: ['NUVIRA_TELEGRAM_TOKEN'],
  discord: ['NUVIRA_DISCORD_BOT_TOKEN'],
  slack: ['NUVIRA_SLACK_BOT_TOKEN'],
  // I8: `whatsapp` = personal Baileys bridge (paired session dir override),
  // `whatsapp_cloud` = paid Meta Business API (token + phone id).
  whatsapp: ['NUVIRA_WHATSAPP_SESSION_DIR'],
  whatsapp_cloud: ['NUVIRA_WHATSAPP_TOKEN'],
  // I9 — webhook/REST connectors (send-only bot webhooks).
  dingtalk: ['NUVIRA_DINGTALK_WEBHOOK_URL'],
  feishu: ['NUVIRA_FEISHU_WEBHOOK_URL'],
  wecom: ['NUVIRA_WECOM_WEBHOOK_URL'],
  mattermost: ['NUVIRA_MATTERMOST_WEBHOOK_URL'],
  matrix: ['NUVIRA_MATRIX_HOMESERVER', 'NUVIRA_MATRIX_ACCESS_TOKEN'],
  webhook: ['NUVIRA_WEBHOOK_URL'],
  bluebubbles: ['NUVIRA_BLUEBUBBLES_URL', 'NUVIRA_BLUEBUBBLES_PASSWORD'],
  // I10 — thin send connectors. ntfy needs only the topic (NUVIRA_NTFY_URL
  // defaults to ntfy.sh); weixin needs only the iLink bot token (base URL
  // defaults to the official iLink endpoint).
  ntfy: ['NUVIRA_NTFY_TOPIC'],
  teams: ['NUVIRA_TEAMS_WEBHOOK_URL'],
  google_chat: ['NUVIRA_GOOGLE_CHAT_WEBHOOK_URL'],
  weixin: ['NUVIRA_WEIXIN_TOKEN'],
  // I12 — SMS uses the standard Twilio env vars (`plugins/platforms/sms`),
  // so the same creds work in both agents.
  sms: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'],
  // I13 — IRC uses the standard env vars (`plugins/platforms/irc`):
  // IRC_SERVER is the transport gate; nickname/port/channel have defaults.
  irc: ['IRC_SERVER'],
  // I14 — SimpleX uses the standard env var (`plugins/platforms/simplex`):
  // the daemon's WebSocket URL is the transport gate.
  simplex: ['SIMPLEX_WS_URL'],
  // I15 — Home Assistant uses the standard env vars
  // (`plugins/platforms/homeassistant`): HASS_TOKEN is the gate (HASS_URL
  // defaults to http://homeassistant.local:8123).
  homeassistant: ['HASS_TOKEN'],
  // Email transport = an SMTP relay the gateway can reach (host + auth user;
  // NUVIRA_SMTP_PASS may be absent for local/trusted relays).
  email: ['NUVIRA_SMTP_HOST', 'NUVIRA_SMTP_USER'],
  // Signal = the registered account number (the REST endpoint defaults to a
  // local signal-cli-rest-api and is not itself an opt-in signal).
  signal: ['NUVIRA_SIGNAL_ACCOUNT'],
  mock: [],
};

/**
 * Extra transport vars the CONFIG SURFACE offers on top of
 * {@link PLATFORM_ENV_VARS} — each one turns on an ADDITIONAL way to talk to the
 * platform, not a prerequisite for using it at all.
 *
 * WHY THIS IS SEPARATE, and why it is not just merged into PLATFORM_ENV_VARS:
 * that map answers "is this platform configured?" with `every(var is set)`, and
 * it also gates alias registration. Slack with ONLY a bot token genuinely works —
 * it replies and downloads files — it simply cannot RECEIVE. Folding the inbound
 * token into the required list would have flipped a working transport to "not
 * configured" and blocked registering an alias to a channel it can already post
 * to. So the required list stays the required list, and this map is what the
 * wizard, `config gateway list` and the dashboard form ALSO display.
 *
 * MEASURED, and the reason it exists: `config gateway set slack` used to offer
 * only the bot token, so the app-level token Slack's Socket Mode REQUIRES could
 * not be set from the product's own config surface at all — the gateway then
 * logged "Slack: real-time Socket Mode inbound skipped — no app-level token" and
 * the operator had no CLI that mentioned the key. GATEWAY.md already documented
 * `config gateway set slack` as needing both; the surface is what was missing.
 */
export const PLATFORM_TRANSPORT_ENV_VARS: Partial<Record<Platform, string[]>> = {
  // inbound over the Discord Gateway WebSocket (bot token) OR inbound through
  // the shared webhook receiver — either one, so both are offered.
  discord: ['NUVIRA_DISCORD_WEBHOOK_URL'],
  // Socket Mode inbound (xapp-…), outgoing webhook, and Events-API signature
  // verification respectively.
  slack: ['NUVIRA_SLACK_APP_TOKEN', 'NUVIRA_SLACK_WEBHOOK_URL', 'NUVIRA_SLACK_SIGNING_SECRET'],
};

/**
 * Every env var the config surface manages for a platform: the required
 * transport vars first (what {@link isPlatformConfigured} checks), then the
 * additional transport modes. This is the list the wizard prompts for, that
 * `config gateway list` and the dashboard form display, and that the dashboard's
 * write/remove endpoints validate against — so a key can never be offered
 * without being writable.
 */
export function platformConfigVars(platform: Platform): string[] {
  return [...PLATFORM_ENV_VARS[platform], ...(PLATFORM_TRANSPORT_ENV_VARS[platform] ?? [])];
}

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
 * transport is a PAIRED SESSION on disk (default `~/.nuvira/whatsapp/session`),
 * so the env override (`NUVIRA_WHATSAPP_SESSION_DIR`) alone would lie about a
 * default-path session. hasWhatsAppSession() is the authoritative check
 * (session.ts imports only node builtins — no cycle).
 */
export function isPlatformConfigured(platform: Platform): boolean {
  if (platform === 'whatsapp') return hasWhatsAppSession();
  return PLATFORM_ENV_VARS[platform].every((envVar) => {
    // Check NUVIRA_* first, then legacy BUFF_* fallback
    if (process.env[envVar]) return true;
    const legacyName = envVar.replace(/^NUVIRA_/, 'BUFF_');
    return Boolean(process.env[legacyName]);
  });
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
   *   "Anuj"           → contacts lookup by name
   *   "+918800425333"   → contacts lookup by phone (flexible)
   *   "telegram:12345" → explicit platform:channelId
   * Returns null when unresolvable.
   */
  resolve(target: string): ChannelRef | null {
    const t = (target || '').trim();
    if (!t) return null;
    // 1. Alias lookup
    const alias = this.aliases.find((a) => a.alias === t);
    if (alias) return { platform: alias.platform, channelId: alias.channelId };
    // 2. Explicit platform:channelId
    const explicit = t.match(/^(telegram|discord|slack|whatsapp|whatsapp_cloud|email|signal|dingtalk|feishu|wecom|mattermost|matrix|webhook|bluebubbles|ntfy|teams|google_chat|weixin|sms|irc|simplex|homeassistant|mock):(.+)$/);
    if (explicit) return { platform: explicit[1] as Platform, channelId: explicit[2] };
    // 3. Contacts lookup by name or phone (flexible resolution)
    try {
      const contacts = readGatewayContacts();
      // Search across all platforms
      for (const platform of ['telegram', 'whatsapp', 'whatsapp_cloud', 'email', 'slack', 'discord'] as Platform[]) {
        const hit = resolveContact(contacts, platform, t);
        if (hit && hit.status === 'approved') return { platform, channelId: hit.id };
      }
    } catch {
      /* contacts module unavailable — skip */
    }
    return null;
  }

  /** Reachable channels (aliases grouped by target) for `nuvira gateway status`. */
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
