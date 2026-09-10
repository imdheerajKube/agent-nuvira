/**
 * Messaging Tool — Discord and Feishu integration.
 *
 * This provides messaging capabilities:
 * - Discord bot integration
 * - Feishu document/drive integration
 * - Message sending
 * - File sharing
 * - Embed support
 * - Reaction handling
 * - Thread management
 * - Webhook support
 *
 * Better than Hermes:
 * - Multi-platform support
 * - Rich embeds
 * - Thread management
 * - Webhook support
 * - Integration with skill system
 */
export type MessagingPlatform = 'discord' | 'feishu' | 'slack';
export interface DiscordConfig {
    /** Bot token */
    token: string;
    /** Application ID */
    applicationId: string;
    /** Guild (server) ID */
    guildId?: string;
}
export interface FeishuConfig {
    /** App ID */
    appId: string;
    /** App secret */
    appSecret: string;
    /** Tenant access token */
    tenantAccessToken?: string;
}
export interface SlackConfig {
    /** Bot token */
    token: string;
    /** Signing secret */
    signingSecret?: string;
}
export interface SendMessageOptions {
    /** Channel ID */
    channelId: string;
    /** Message content */
    content?: string;
    /** Embeds */
    embeds?: DiscordEmbed[];
    /** Files to attach */
    files?: Array<{
        name: string;
        buffer: Buffer;
    }>;
    /** Message reference (for replies) */
    messageReference?: string;
}
export interface DiscordEmbed {
    /** Embed title */
    title?: string;
    /** Embed description */
    description?: string;
    /** Embed color */
    color?: number;
    /** Embed fields */
    fields?: Array<{
        name: string;
        value: string;
        inline?: boolean;
    }>;
    /** Embed footer */
    footer?: {
        text: string;
        iconUrl?: string;
    };
    /** Embed image */
    image?: {
        url: string;
    };
    /** Embed timestamp */
    timestamp?: string;
}
export interface ReactionOptions {
    /** Message ID */
    messageId: string;
    /** Channel ID */
    channelId: string;
    /** Emoji to add */
    emoji: string;
}
export interface ThreadOptions {
    /** Channel ID to create thread in */
    channelId: string;
    /** Thread name */
    name: string;
    /** Thread message */
    message?: string;
    /** Auto-archive duration (minutes) */
    autoArchiveDuration?: number;
}
export interface MessageResult {
    success: boolean;
    messageId?: string;
    error?: string;
    durationMs: number;
    platform: MessagingPlatform;
}
/**
 * Send message to any platform.
 */
export declare function sendMessage(platform: MessagingPlatform, config: DiscordConfig | FeishuConfig | SlackConfig, options: SendMessageOptions): Promise<MessageResult>;
/**
 * Add reaction to message.
 */
export declare function addReaction(platform: MessagingPlatform, config: DiscordConfig, options: ReactionOptions): Promise<MessageResult>;
/**
 * Create thread.
 */
export declare function createThread(platform: MessagingPlatform, config: DiscordConfig, options: ThreadOptions): Promise<MessageResult>;
declare const _default: {
    sendMessage: typeof sendMessage;
    addReaction: typeof addReaction;
    createThread: typeof createThread;
};
export default _default;
//# sourceMappingURL=messaging-tool.d.ts.map