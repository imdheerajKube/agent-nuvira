/**
 * Send Message Tool — Cross-channel messaging via platform APIs.
 *
 * Hermes equivalent: send_message_tool.py (2,116 lines)
 *
 * Features:
 * - Send messages to Telegram, Discord, Slack, WhatsApp
 * - List available targets
 * - Resolve human-friendly names to IDs
 * - Media attachments (images, videos, audio)
 * - Thread support
 * - Rate limiting
 */
export type Platform = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'email';
export interface SendMessageConfig {
    /** Platform */
    platform: Platform;
    /** Target (channel ID, username, email) */
    target: string;
    /** Message text */
    text: string;
    /** Media attachments */
    media?: string[];
    /** Thread ID (for threaded conversations) */
    threadId?: string;
    /** Parse mode (markdown, html) */
    parseMode?: string;
}
export interface SendMessageResult {
    success: boolean;
    messageId?: string;
    platform: Platform;
    target: string;
    error?: string;
}
export interface PlatformTarget {
    id: string;
    name: string;
    platform: Platform;
    type: 'channel' | 'user' | 'group';
}
export declare class SendMessageManager {
    private rateLimits;
    /**
     * Send a message to a platform.
     */
    send(config: SendMessageConfig): Promise<SendMessageResult>;
    /**
     * Send via Telegram.
     */
    private sendTelegram;
    /**
     * Send via Discord.
     */
    private sendDiscord;
    /**
     * Send via Slack.
     */
    private sendSlack;
    /**
     * Send via WhatsApp through the Baileys bridge (the same adapter the gateway
     * uses). Builds a one-shot GatewayRegistry, registers configured adapters,
     * resolves the target, and sends. If media paths are provided in config.media,
     * the first media file is sent as a media message (image/video/audio/document).
     */
    private sendWhatsApp;
    /**
     * Send via Email (placeholder — requires SMTP).
     */
    private sendEmail;
    /**
     * List available targets for a platform.
     */
    listTargets(platform: Platform): Promise<PlatformTarget[]>;
    private listTelegramTargets;
    private listDiscordTargets;
    private listSlackTargets;
}
export declare function getSendMessageManager(): SendMessageManager;
export declare function resetSendMessageManager(): void;
//# sourceMappingURL=send-message-tool.d.ts.map