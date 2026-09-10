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
// ─── Platform token map (env-var map) ──────────────────────────────────────
export const PLATFORM_ENV_VARS = {
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
/** Human-readable platform names (for CLI + status output). */
export const PLATFORM_LABELS = {
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
export function isPlatformConfigured(platform) {
    if (platform === 'whatsapp')
        return hasWhatsAppSession();
    return PLATFORM_ENV_VARS[platform].every((envVar) => {
        // Check NUVIRA_* first, then legacy BUFF_* fallback
        if (process.env[envVar])
            return true;
        const legacyName = envVar.replace(/^NUVIRA_/, 'BUFF_');
        return Boolean(process.env[legacyName]);
    });
}
/** All platforms whose env tokens are present (opt-in adapters). */
export function configuredPlatforms() {
    return Object.keys(PLATFORM_ENV_VARS).filter((p) => p !== 'mock' && isPlatformConfigured(p));
}
// ─── Alias persistence ──────────────────────────────────────────────────────
function aliasesFilePath() {
    return join(resolveBuffConfigDir(), 'gateway', 'aliases.json');
}
/** Read persisted aliases (empty when the file is absent/corrupt — never throw). */
export function readAliases() {
    try {
        const raw = readFileSync(aliasesFilePath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.aliases))
            return [];
        return parsed.aliases.filter((a) => a && typeof a.alias === 'string' && typeof a.channelId === 'string' && a.platform);
    }
    catch {
        return [];
    }
}
/** Persist aliases (small file — single write). */
export function writeAliases(aliases) {
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
    aliases;
    constructor(initial) {
        this.aliases = initial ?? readAliases();
    }
    /** All persisted aliases. */
    listAliases() {
        return [...this.aliases].sort((a, b) => a.alias.localeCompare(b.alias));
    }
    /** Register (or update) an alias. Returns the saved entry. */
    setAlias(alias, platform, channelId) {
        if (!ALIAS_RE.test(alias)) {
            throw new Error(`Invalid alias '${alias}' — use lowercase letters, digits, hyphens (1–40 chars)`);
        }
        if (!isPlatformConfigured(platform) && platform !== 'mock') {
            throw new Error(`Platform '${platform}' is not configured — set ${PLATFORM_ENV_VARS[platform].join(', ')}`);
        }
        const entry = { alias, platform, channelId, addedAt: Date.now() };
        this.aliases = this.aliases.filter((a) => a.alias !== alias);
        this.aliases.push(entry);
        writeAliases(this.aliases);
        return entry;
    }
    /** Remove an alias. Returns true when it existed. */
    removeAlias(alias) {
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
    resolve(target) {
        const t = (target || '').trim();
        if (!t)
            return null;
        // 1. Alias lookup
        const alias = this.aliases.find((a) => a.alias === t);
        if (alias)
            return { platform: alias.platform, channelId: alias.channelId };
        // 2. Explicit platform:channelId
        const explicit = t.match(/^(telegram|discord|slack|whatsapp|whatsapp_cloud|email|signal|dingtalk|feishu|wecom|mattermost|matrix|webhook|bluebubbles|ntfy|teams|google_chat|weixin|sms|irc|simplex|homeassistant|mock):(.+)$/);
        if (explicit)
            return { platform: explicit[1], channelId: explicit[2] };
        // 3. Contacts lookup by name or phone (flexible resolution)
        try {
            const contacts = readGatewayContacts();
            // Search across all platforms
            for (const platform of ['telegram', 'whatsapp', 'whatsapp_cloud', 'email', 'slack', 'discord']) {
                const hit = resolveContact(contacts, platform, t);
                if (hit && hit.status === 'approved')
                    return { platform, channelId: hit.id };
            }
        }
        catch {
            /* contacts module unavailable — skip */
        }
        return null;
    }
    /** Reachable channels (aliases grouped by target) for `nuvira gateway status`. */
    reachableChannels() {
        const byKey = new Map();
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
//# sourceMappingURL=channel-directory.js.map