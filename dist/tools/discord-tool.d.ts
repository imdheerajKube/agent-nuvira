/**
 * Discord Tool — Server introspection and management via REST API.
 *
 * Hermes equivalent: discord_tool.py (1,116 lines)
 *
 * Provides:
 * - Server/guild information
 * - Channel listing and management
 * - Message fetching and sending
 * - Member listing and info
 * - Role management
 * - Webhook management
 */
export interface DiscordConfig {
    botToken: string;
    apiBase?: string;
}
export interface DiscordGuild {
    id: string;
    name: string;
    icon?: string;
    owner?: boolean;
    permissions?: string;
    memberCount?: number;
}
export interface DiscordChannel {
    id: string;
    name: string;
    type: number;
    guild_id?: string;
    topic?: string;
    nsfw?: boolean;
    position?: number;
}
export interface DiscordMessage {
    id: string;
    content: string;
    author: {
        id: string;
        username: string;
        bot?: boolean;
    };
    channel_id: string;
    timestamp: string;
    edited_timestamp?: string;
    attachments?: Array<{
        id: string;
        filename: string;
        url: string;
    }>;
    embeds?: Array<{
        title?: string;
        description?: string;
    }>;
}
export interface DiscordMember {
    user: {
        id: string;
        username: string;
        discriminator?: string;
        avatar?: string;
    };
    nick?: string;
    roles: string[];
    joined_at: string;
    permissions?: string;
}
export interface DiscordRole {
    id: string;
    name: string;
    color: number;
    hoist: boolean;
    position: number;
    permissions: string;
}
export declare class DiscordClient {
    private config;
    private apiBase;
    constructor(config: DiscordConfig);
    /**
     * Make a Discord API request.
     */
    private request;
    /**
     * List all guilds (servers) the bot is in.
     */
    listGuilds(): Promise<DiscordGuild[]>;
    /**
     * Get guild info.
     */
    getGuild(guildId: string): Promise<DiscordGuild>;
    /**
     * List channels in a guild.
     */
    listChannels(guildId: string): Promise<DiscordChannel[]>;
    /**
     * Get channel info.
     */
    getChannel(channelId: string): Promise<DiscordChannel>;
    /**
     * Fetch messages from a channel.
     */
    fetchMessages(channelId: string, limit?: number, before?: string): Promise<DiscordMessage[]>;
    /**
     * Send a message to a channel.
     */
    sendMessage(channelId: string, content: string, options?: {
        embed?: unknown;
        files?: unknown[];
    }): Promise<DiscordMessage>;
    /**
     * Edit a message.
     */
    editMessage(channelId: string, messageId: string, content: string): Promise<DiscordMessage>;
    /**
     * Delete a message.
     */
    deleteMessage(channelId: string, messageId: string): Promise<void>;
    /**
     * Add a reaction to a message.
     */
    addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
    /**
     * List members in a guild.
     */
    listMembers(guildId: string, limit?: number, after?: string): Promise<DiscordMember[]>;
    /**
     * Get member info.
     */
    getMember(guildId: string, userId: string): Promise<DiscordMember>;
    /**
     * Search members by username.
     */
    searchMembers(guildId: string, query: string, limit?: number): Promise<DiscordMember[]>;
    /**
     * List roles in a guild.
     */
    listRoles(guildId: string): Promise<DiscordRole[]>;
    /**
     * Create a role.
     */
    createRole(guildId: string, name: string, options?: {
        color?: number;
        permissions?: string;
    }): Promise<DiscordRole>;
    /**
     * Delete a role.
     */
    deleteRole(guildId: string, roleId: string): Promise<void>;
    /**
     * List webhooks in a guild.
     */
    listWebhooks(guildId: string): Promise<Array<{
        id: string;
        name: string;
        channel_id: string;
        url: string;
    }>>;
    /**
     * Create a webhook.
     */
    createWebhook(channelId: string, name: string): Promise<{
        id: string;
        url: string;
    }>;
}
export declare function getDiscordClient(token?: string): DiscordClient;
export declare function resetDiscordClient(): void;
//# sourceMappingURL=discord-tool.d.ts.map