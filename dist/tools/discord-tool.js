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
// ─── Discord Client ───────────────────────────────────────────────────────
export class DiscordClient {
    config;
    apiBase;
    constructor(config) {
        this.config = config;
        this.apiBase = config.apiBase || 'https://discord.com/api/v10';
    }
    /**
     * Make a Discord API request.
     */
    async request(method, path, body) {
        const url = `${this.apiBase}${path}`;
        const headers = {
            'Authorization': `Bot ${this.config.botToken}`,
            'Content-Type': 'application/json',
        };
        const options = { method, headers };
        if (body)
            options.body = JSON.stringify(body);
        const response = await fetch(url, options);
        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`Discord API ${response.status}: ${errorText}`);
        }
        // Handle 204 No Content
        if (response.status === 204)
            return null;
        return response.json();
    }
    // ─── Guild Operations ─────────────────────────────────────────────
    /**
     * List all guilds (servers) the bot is in.
     */
    async listGuilds() {
        return this.request('GET', '/users/@me/guilds');
    }
    /**
     * Get guild info.
     */
    async getGuild(guildId) {
        return this.request('GET', `/guilds/${guildId}?with_counts=true`);
    }
    // ─── Channel Operations ───────────────────────────────────────────
    /**
     * List channels in a guild.
     */
    async listChannels(guildId) {
        return this.request('GET', `/guilds/${guildId}/channels`);
    }
    /**
     * Get channel info.
     */
    async getChannel(channelId) {
        return this.request('GET', `/channels/${channelId}`);
    }
    // ─── Message Operations ───────────────────────────────────────────
    /**
     * Fetch messages from a channel.
     */
    async fetchMessages(channelId, limit = 50, before) {
        let path = `/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`;
        if (before)
            path += `&before=${before}`;
        return this.request('GET', path);
    }
    /**
     * Send a message to a channel.
     */
    async sendMessage(channelId, content, options = {}) {
        const body = { content };
        if (options.embed)
            body.embeds = [options.embed];
        return this.request('POST', `/channels/${channelId}/messages`, body);
    }
    /**
     * Edit a message.
     */
    async editMessage(channelId, messageId, content) {
        return this.request('PATCH', `/channels/${channelId}/messages/${messageId}`, { content });
    }
    /**
     * Delete a message.
     */
    async deleteMessage(channelId, messageId) {
        await this.request('DELETE', `/channels/${channelId}/messages/${messageId}`);
    }
    /**
     * Add a reaction to a message.
     */
    async addReaction(channelId, messageId, emoji) {
        await this.request('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
    }
    // ─── Member Operations ────────────────────────────────────────────
    /**
     * List members in a guild.
     */
    async listMembers(guildId, limit = 100, after) {
        let path = `/guilds/${guildId}/members?limit=${Math.min(limit, 1000)}`;
        if (after)
            path += `&after=${after}`;
        return this.request('GET', path);
    }
    /**
     * Get member info.
     */
    async getMember(guildId, userId) {
        return this.request('GET', `/guilds/${guildId}/members/${userId}`);
    }
    /**
     * Search members by username.
     */
    async searchMembers(guildId, query, limit = 100) {
        return this.request('GET', `/guilds/${guildId}/members/search?query=${encodeURIComponent(query)}&limit=${limit}`);
    }
    // ─── Role Operations ──────────────────────────────────────────────
    /**
     * List roles in a guild.
     */
    async listRoles(guildId) {
        return this.request('GET', `/guilds/${guildId}/roles`);
    }
    /**
     * Create a role.
     */
    async createRole(guildId, name, options = {}) {
        return this.request('POST', `/guilds/${guildId}/roles`, { name, ...options });
    }
    /**
     * Delete a role.
     */
    async deleteRole(guildId, roleId) {
        await this.request('DELETE', `/guilds/${guildId}/roles/${roleId}`);
    }
    // ─── Webhook Operations ───────────────────────────────────────────
    /**
     * List webhooks in a guild.
     */
    async listWebhooks(guildId) {
        return this.request('GET', `/guilds/${guildId}/webhooks`);
    }
    /**
     * Create a webhook.
     */
    async createWebhook(channelId, name) {
        return this.request('POST', `/channels/${channelId}/webhooks`, { name });
    }
}
// ─── Singleton ─────────────────────────────────────────────────────────────
let _discordClient = null;
export function getDiscordClient(token) {
    if (!_discordClient || token) {
        const botToken = token || process.env.DISCORD_BOT_TOKEN || '';
        _discordClient = new DiscordClient({ botToken });
    }
    return _discordClient;
}
export function resetDiscordClient() {
    _discordClient = null;
}
//# sourceMappingURL=discord-tool.js.map