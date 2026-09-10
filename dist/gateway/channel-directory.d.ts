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
/** Supported platforms (I8 splits WhatsApp, I9 adds webhook connectors). */
export type Platform = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'whatsapp_cloud' | 'email' | 'signal' | 'dingtalk' | 'feishu' | 'wecom' | 'mattermost' | 'matrix' | 'webhook' | 'bluebubbles' | 'ntfy' | 'teams' | 'google_chat' | 'weixin' | 'sms' | 'irc' | 'simplex' | 'homeassistant' | 'mock';
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
export declare const PLATFORM_ENV_VARS: Record<Platform, string[]>;
/** Human-readable platform names (for CLI + status output). */
export declare const PLATFORM_LABELS: Record<Platform, string>;
/**
 * Whether the platform's transport is configured.
 *
 * Env-token based for every platform except I8's `whatsapp` bridge: its
 * transport is a PAIRED SESSION on disk (default `~/.nuvira/whatsapp/session`),
 * so the env override (`NUVIRA_WHATSAPP_SESSION_DIR`) alone would lie about a
 * default-path session. hasWhatsAppSession() is the authoritative check
 * (session.ts imports only node builtins — no cycle).
 */
export declare function isPlatformConfigured(platform: Platform): boolean;
/** All platforms whose env tokens are present (opt-in adapters). */
export declare function configuredPlatforms(): Platform[];
/** Read persisted aliases (empty when the file is absent/corrupt — never throw). */
export declare function readAliases(): ChannelAlias[];
/** Persist aliases (small file — single write). */
export declare function writeAliases(aliases: ChannelAlias[]): void;
/** Alias constraints: lowercase alphanumeric + hyphen, 1–40 chars. */
export declare const ALIAS_RE: RegExp;
/**
 * The channel directory. Resolves human-friendly aliases (and raw
 * `platform:channelId` targets) to a ChannelRef.
 */
export declare class ChannelDirectory {
    private aliases;
    constructor(initial?: ChannelAlias[]);
    /** All persisted aliases. */
    listAliases(): ChannelAlias[];
    /** Register (or update) an alias. Returns the saved entry. */
    setAlias(alias: string, platform: Platform, channelId: string): ChannelAlias;
    /** Remove an alias. Returns true when it existed. */
    removeAlias(alias: string): boolean;
    /**
     * Resolve a target string to a ChannelRef.
     *   "ops"            → alias lookup
     *   "Anuj"           → contacts lookup by name
     *   "+918800425333"   → contacts lookup by phone (flexible)
     *   "telegram:12345" → explicit platform:channelId
     * Returns null when unresolvable.
     */
    resolve(target: string): ChannelRef | null;
    /** Reachable channels (aliases grouped by target) for `nuvira gateway status`. */
    reachableChannels(): ReachableChannel[];
}
//# sourceMappingURL=channel-directory.d.ts.map