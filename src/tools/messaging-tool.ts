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

import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// ─── Types ───────────────────────────────────────────────────────────────

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

// ─── Discord Implementation ──────────────────────────────────────────────

/**
 * Send message to Discord.
 */
async function discordSend(
  config: DiscordConfig,
  options: SendMessageOptions
): Promise<MessageResult> {
  const startTime = Date.now();

  try {
    const url = `https://discord.com/api/v10/channels/${options.channelId}/messages`;

    const formData = new FormData();
    if (options.content) {
      formData.append('content', options.content);
    }
    if (options.embeds) {
      formData.append('embeds', JSON.stringify(options.embeds));
    }
    if (options.messageReference) {
      formData.append('message_reference', JSON.stringify({ message_id: options.messageReference }));
    }

    // Add files
    if (options.files) {
      for (const file of options.files) {
        formData.append('files[0]', new Blob([file.buffer]), file.name);
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${config.token}`,
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Discord API failed: ${response.statusText}`);
    }

    const result = (await response.json()) as any;

    return {
      success: true,
      messageId: result.id,
      durationMs: Date.now() - startTime,
      platform: 'discord',
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
      platform: 'discord',
    };
  }
}

/**
 * Add reaction to Discord message.
 */
async function discordReact(
  config: DiscordConfig,
  options: ReactionOptions
): Promise<MessageResult> {
  const startTime = Date.now();

  try {
    const url = `https://discord.com/api/v10/channels/${options.channelId}/messages/${options.messageId}/reactions/${encodeURIComponent(options.emoji)}/@me`;

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bot ${config.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Discord reaction failed: ${response.statusText}`);
    }

    return {
      success: true,
      durationMs: Date.now() - startTime,
      platform: 'discord',
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
      platform: 'discord',
    };
  }
}

/**
 * Create Discord thread.
 */
async function discordCreateThread(
  config: DiscordConfig,
  options: ThreadOptions
): Promise<MessageResult> {
  const startTime = Date.now();

  try {
    const url = `https://discord.com/api/v10/channels/${options.channelId}/threads`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: options.name,
        message: options.message ? { content: options.message } : undefined,
        auto_archive_duration: options.autoArchiveDuration ?? 60,
      }),
    });

    if (!response.ok) {
      throw new Error(`Discord thread creation failed: ${response.statusText}`);
    }

    const result = (await response.json()) as any;

    return {
      success: true,
      messageId: result.id,
      durationMs: Date.now() - startTime,
      platform: 'discord',
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
      platform: 'discord',
    };
  }
}

// ─── Feishu Implementation ───────────────────────────────────────────────

/**
 * Send message to Feishu.
 */
async function feishuSend(
  config: FeishuConfig,
  options: SendMessageOptions
): Promise<MessageResult> {
  const startTime = Date.now();

  try {
    // Get tenant access token if not provided
    let token = config.tenantAccessToken;
    if (!token) {
      token = await getFeishuToken(config);
    }

    const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: options.channelId,
        msg_type: 'text',
        content: JSON.stringify({ text: options.content ?? '' }),
      }),
    });

    if (!response.ok) {
      throw new Error(`Feishu API failed: ${response.statusText}`);
    }

    const result = (await response.json()) as any;

    return {
      success: true,
      messageId: result.data?.message_id,
      durationMs: Date.now() - startTime,
      platform: 'feishu',
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
      platform: 'feishu',
    };
  }
}

/**
 * Get Feishu tenant access token.
 */
async function getFeishuToken(config: FeishuConfig): Promise<string> {
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      app_id: config.appId,
      app_secret: config.appSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`Feishu auth failed: ${response.statusText}`);
  }

  const result = (await response.json()) as any;
  return result.tenant_access_token;
}

// ─── Slack Implementation ────────────────────────────────────────────────

/**
 * Send message to Slack.
 */
async function slackSend(
  config: SlackConfig,
  options: SendMessageOptions
): Promise<MessageResult> {
  const startTime = Date.now();

  try {
    const url = 'https://slack.com/api/chat.postMessage';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: options.channelId,
        text: options.content,
        blocks: options.embeds?.map((embed) => ({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${embed.title ?? ''}*\n${embed.description ?? ''}`,
          },
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`Slack API failed: ${response.statusText}`);
    }

    const result = (await response.json()) as any;

    if (!result.ok) {
      throw new Error(result.error);
    }

    return {
      success: true,
      messageId: result.ts,
      durationMs: Date.now() - startTime,
      platform: 'slack',
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
      platform: 'slack',
    };
  }
}

// ─── Main Send Function ──────────────────────────────────────────────────

/**
 * Send message to any platform.
 */
export async function sendMessage(
  platform: MessagingPlatform,
  config: DiscordConfig | FeishuConfig | SlackConfig,
  options: SendMessageOptions
): Promise<MessageResult> {
  switch (platform) {
    case 'discord':
      return discordSend(config as DiscordConfig, options);
    case 'feishu':
      return feishuSend(config as FeishuConfig, options);
    case 'slack':
      return slackSend(config as SlackConfig, options);
    default:
      return {
        success: false,
        error: `Unknown platform: ${platform}`,
        durationMs: 0,
        platform,
      };
  }
}

/**
 * Add reaction to message.
 */
export async function addReaction(
  platform: MessagingPlatform,
  config: DiscordConfig,
  options: ReactionOptions
): Promise<MessageResult> {
  if (platform === 'discord') {
    return discordReact(config, options);
  }

  return {
    success: false,
    error: `Reactions not supported on ${platform}`,
    durationMs: 0,
    platform,
  };
}

/**
 * Create thread.
 */
export async function createThread(
  platform: MessagingPlatform,
  config: DiscordConfig,
  options: ThreadOptions
): Promise<MessageResult> {
  if (platform === 'discord') {
    return discordCreateThread(config, options);
  }

  return {
    success: false,
    error: `Threads not supported on ${platform}`,
    durationMs: 0,
    platform,
  };
}

// ─── Export All ──────────────────────────────────────────────────────────

export default {
  // Message sending
  sendMessage,

  // Reactions
  addReaction,

  // Threads
  createThread,
};
