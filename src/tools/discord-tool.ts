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

import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

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
  author: { id: string; username: string; bot?: boolean };
  channel_id: string;
  timestamp: string;
  edited_timestamp?: string;
  attachments?: Array<{ id: string; filename: string; url: string }>;
  embeds?: Array<{ title?: string; description?: string }>;
}

export interface DiscordMember {
  user: { id: string; username: string; discriminator?: string; avatar?: string };
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

// ─── Discord Client ───────────────────────────────────────────────────────

export class DiscordClient {
  private config: DiscordConfig;
  private apiBase: string;

  constructor(config: DiscordConfig) {
    this.config = config;
    this.apiBase = config.apiBase || 'https://discord.com/api/v10';
  }

  /**
   * Make a Discord API request.
   */
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const url = `${this.apiBase}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bot ${this.config.botToken}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Discord API ${response.status}: ${errorText}`);
    }

    // Handle 204 No Content
    if (response.status === 204) return null;

    return response.json();
  }

  // ─── Guild Operations ─────────────────────────────────────────────

  /**
   * List all guilds (servers) the bot is in.
   */
  async listGuilds(): Promise<DiscordGuild[]> {
    return this.request('GET', '/users/@me/guilds');
  }

  /**
   * Get guild info.
   */
  async getGuild(guildId: string): Promise<DiscordGuild> {
    return this.request('GET', `/guilds/${guildId}?with_counts=true`);
  }

  // ─── Channel Operations ───────────────────────────────────────────

  /**
   * List channels in a guild.
   */
  async listChannels(guildId: string): Promise<DiscordChannel[]> {
    return this.request('GET', `/guilds/${guildId}/channels`);
  }

  /**
   * Get channel info.
   */
  async getChannel(channelId: string): Promise<DiscordChannel> {
    return this.request('GET', `/channels/${channelId}`);
  }

  // ─── Message Operations ───────────────────────────────────────────

  /**
   * Fetch messages from a channel.
   */
  async fetchMessages(channelId: string, limit: number = 50, before?: string): Promise<DiscordMessage[]> {
    let path = `/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`;
    if (before) path += `&before=${before}`;
    return this.request('GET', path);
  }

  /**
   * Send a message to a channel.
   */
  async sendMessage(channelId: string, content: string, options: { embed?: unknown; files?: unknown[] } = {}): Promise<DiscordMessage> {
    const body: Record<string, unknown> = { content };
    if (options.embed) body.embeds = [options.embed];
    return this.request('POST', `/channels/${channelId}/messages`, body);
  }

  /**
   * Edit a message.
   */
  async editMessage(channelId: string, messageId: string, content: string): Promise<DiscordMessage> {
    return this.request('PATCH', `/channels/${channelId}/messages/${messageId}`, { content });
  }

  /**
   * Delete a message.
   */
  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request('DELETE', `/channels/${channelId}/messages/${messageId}`);
  }

  /**
   * Add a reaction to a message.
   */
  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.request('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  // ─── Member Operations ────────────────────────────────────────────

  /**
   * List members in a guild.
   */
  async listMembers(guildId: string, limit: number = 100, after?: string): Promise<DiscordMember[]> {
    let path = `/guilds/${guildId}/members?limit=${Math.min(limit, 1000)}`;
    if (after) path += `&after=${after}`;
    return this.request('GET', path);
  }

  /**
   * Get member info.
   */
  async getMember(guildId: string, userId: string): Promise<DiscordMember> {
    return this.request('GET', `/guilds/${guildId}/members/${userId}`);
  }

  /**
   * Search members by username.
   */
  async searchMembers(guildId: string, query: string, limit: number = 100): Promise<DiscordMember[]> {
    return this.request('GET', `/guilds/${guildId}/members/search?query=${encodeURIComponent(query)}&limit=${limit}`);
  }

  // ─── Role Operations ──────────────────────────────────────────────

  /**
   * List roles in a guild.
   */
  async listRoles(guildId: string): Promise<DiscordRole[]> {
    return this.request('GET', `/guilds/${guildId}/roles`);
  }

  /**
   * Create a role.
   */
  async createRole(guildId: string, name: string, options: { color?: number; permissions?: string } = {}): Promise<DiscordRole> {
    return this.request('POST', `/guilds/${guildId}/roles`, { name, ...options });
  }

  /**
   * Delete a role.
   */
  async deleteRole(guildId: string, roleId: string): Promise<void> {
    await this.request('DELETE', `/guilds/${guildId}/roles/${roleId}`);
  }

  // ─── Webhook Operations ───────────────────────────────────────────

  /**
   * List webhooks in a guild.
   */
  async listWebhooks(guildId: string): Promise<Array<{ id: string; name: string; channel_id: string; url: string }>> {
    return this.request('GET', `/guilds/${guildId}/webhooks`);
  }

  /**
   * Create a webhook.
   */
  async createWebhook(channelId: string, name: string): Promise<{ id: string; url: string }> {
    return this.request('POST', `/channels/${channelId}/webhooks`, { name });
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _discordClient: DiscordClient | null = null;

export function getDiscordClient(token?: string): DiscordClient {
  if (!_discordClient || token) {
    const botToken = token || process.env.DISCORD_BOT_TOKEN || '';
    _discordClient = new DiscordClient({ botToken });
  }
  return _discordClient;
}

export function resetDiscordClient(): void {
  _discordClient = null;
}
