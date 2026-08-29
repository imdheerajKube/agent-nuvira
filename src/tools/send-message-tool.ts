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

import { readFileSync } from 'fs';
import { extname } from 'path';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

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

// ─── Send Message Manager ─────────────────────────────────────────────────

export class SendMessageManager {
  private rateLimits: Map<string, { count: number; resetAt: number }> = new Map();

  /**
   * Send a message to a platform.
   */
  async send(config: SendMessageConfig): Promise<SendMessageResult> {
    // Rate limiting
    const rateKey = `${config.platform}:${config.target}`;
    const rateLimit = this.rateLimits.get(rateKey);
    if (rateLimit && rateLimit.count >= 30 && Date.now() < rateLimit.resetAt) {
      return {
        success: false,
        platform: config.platform,
        target: config.target,
        error: 'Rate limit exceeded',
      };
    }

    try {
      let result: SendMessageResult;

      switch (config.platform) {
        case 'telegram':
          result = await this.sendTelegram(config);
          break;
        case 'discord':
          result = await this.sendDiscord(config);
          break;
        case 'slack':
          result = await this.sendSlack(config);
          break;
        case 'whatsapp':
          result = await this.sendWhatsApp(config);
          break;
        case 'email':
          result = await this.sendEmail(config);
          break;
        default:
          result = {
            success: false,
            platform: config.platform,
            target: config.target,
            error: `Unsupported platform: ${config.platform}`,
          };
      }

      // Update rate limit
      if (result.success) {
        const current = this.rateLimits.get(rateKey) || { count: 0, resetAt: Date.now() + 60000 };
        current.count++;
        this.rateLimits.set(rateKey, current);
      }

      return result;
    } catch (err) {
      return {
        success: false,
        platform: config.platform,
        target: config.target,
        error: String(err),
      };
    }
  }

  /**
   * Send via Telegram.
   */
  private async sendTelegram(config: SendMessageConfig): Promise<SendMessageResult> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      return { success: false, platform: 'telegram', target: config.target, error: 'TELEGRAM_BOT_TOKEN not set' };
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body: Record<string, unknown> = {
      chat_id: config.target,
      text: config.text,
      parse_mode: config.parseMode || 'Markdown',
    };

    if (config.threadId) body.message_thread_id = config.threadId;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data: any = await response.json();
    if (!data.ok) {
      return { success: false, platform: 'telegram', target: config.target, error: data.description };
    }

    return { success: true, messageId: String(data.result.message_id), platform: 'telegram', target: config.target };
  }

  /**
   * Send via Discord.
   */
  private async sendDiscord(config: SendMessageConfig): Promise<SendMessageResult> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      return { success: false, platform: 'discord', target: config.target, error: 'DISCORD_BOT_TOKEN not set' };
    }

    const url = `https://discord.com/api/v10/channels/${config.target}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: config.text }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, platform: 'discord', target: config.target, error: errorText };
    }

    const data: any = await response.json();
    return { success: true, messageId: data.id, platform: 'discord', target: config.target };
  }

  /**
   * Send via Slack.
   */
  private async sendSlack(config: SendMessageConfig): Promise<SendMessageResult> {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      return { success: false, platform: 'slack', target: config.target, error: 'SLACK_BOT_TOKEN not set' };
    }

    const url = 'https://slack.com/api/chat.postMessage';
    const body: Record<string, unknown> = {
      channel: config.target,
      text: config.text,
    };

    if (config.threadId) body.thread_ts = config.threadId;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data: any = await response.json();
    if (!data.ok) {
      return { success: false, platform: 'slack', target: config.target, error: data.error };
    }

    return { success: true, messageId: data.ts, platform: 'slack', target: config.target };
  }

  /**
   * Send via WhatsApp through the Baileys bridge (the same adapter the gateway
   * uses). Builds a one-shot GatewayRegistry, registers configured adapters,
   * resolves the target, and sends. If media paths are provided in config.media,
   * the first media file is sent as a media message (image/video/audio/document).
   */
  private async sendWhatsApp(config: SendMessageConfig): Promise<SendMessageResult> {
    try {
      const { GatewayRegistry } = await import('../gateway/registry.js');
      const { createConfiguredAdapters } = await import('../gateway/adapters.js');

      const registry = new GatewayRegistry({ streamEvents: false });
      const adapters = createConfiguredAdapters();
      for (const adapter of adapters) registry.register(adapter);

      const ref = registry.directory.resolve(config.target);
      if (!ref) {
        return { success: false, platform: 'whatsapp', target: config.target, error: `Unknown WhatsApp target '${config.target}' — use a contact name or phone number (e.g. 'Alex', '+9188006663237')` };
      }

      // Media path: send the first media file if provided.
      if (config.media && config.media.length > 0) {
        const filePath = config.media[0];
        let data: Uint8Array;
        try {
          data = readFileSync(filePath) as unknown as Uint8Array;
        } catch (err) {
          return { success: false, platform: 'whatsapp', target: config.target, error: `Cannot read media file '${filePath}': ${err instanceof Error ? err.message : String(err)}` };
        }
        if (data.length === 0) {
          return { success: false, platform: 'whatsapp', target: config.target, error: `Media file '${filePath}' is empty.` };
        }
        const ext = extname(filePath).toLowerCase();
        const type: 'image' | 'video' | 'audio' | 'document' =
          ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext) ? 'image'
          : ['.mp4', '.mov', '.mkv', '.webm'].includes(ext) ? 'video'
          : ['.mp3', '.m4a', '.ogg', '.wav'].includes(ext) ? 'audio'
          : 'document';
        const ok = await registry.sendMediaToRef(ref, {
          type,
          data,
          caption: config.text || undefined,
          filename: filePath.split('/').pop() ?? filePath,
        });
        // Disconnect adapters so the process can exit cleanly (one-shot path).
        for (const adapter of adapters) { try { await adapter.stop(); } catch { /* best-effort */ } }
        if (ok) {
          return { success: true, platform: 'whatsapp', target: config.target };
        }
        return { success: false, platform: 'whatsapp', target: config.target, error: 'Media send failed — WhatsApp adapter may not be paired or configured.' };
      }

      // Text-only send.
      const ok = await registry.sendToRef(ref, config.text, config.target);
      // Disconnect adapters so the process can exit cleanly (one-shot path).
      for (const adapter of adapters) { try { await adapter.stop(); } catch { /* best-effort */ } }
      if (ok) {
        return { success: true, platform: 'whatsapp', target: config.target };
      }
      return { success: false, platform: 'whatsapp', target: config.target, error: 'Send failed — WhatsApp adapter may not be paired or configured. Run nuvira whatsapp status to check.' };
    } catch (err) {
      return { success: false, platform: 'whatsapp', target: config.target, error: `WhatsApp send error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Send via Email (placeholder — requires SMTP).
   */
  private async sendEmail(config: SendMessageConfig): Promise<SendMessageResult> {
    // SMTP email integration would go here
    return { success: false, platform: 'email', target: config.target, error: 'Email integration not implemented' };
  }

  /**
   * List available targets for a platform.
   */
  async listTargets(platform: Platform): Promise<PlatformTarget[]> {
    switch (platform) {
      case 'telegram':
        return this.listTelegramTargets();
      case 'discord':
        return this.listDiscordTargets();
      case 'slack':
        return this.listSlackTargets();
      default:
        return [];
    }
  }

  private async listTelegramTargets(): Promise<PlatformTarget[]> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return [];

    const url = `https://api.telegram.org/bot${token}/getUpdates`;
    const response = await fetch(url);
    const data: any = await response.json();

    if (!data.ok) return [];

    const targets = new Map<string, PlatformTarget>();
    for (const update of data.result || []) {
      const chat = update.message?.chat || update.my_chat_member?.chat;
      if (chat) {
        targets.set(String(chat.id), {
          id: String(chat.id),
          name: chat.title || chat.username || chat.first_name || 'Unknown',
          platform: 'telegram',
          type: chat.type === 'private' ? 'user' : 'group',
        });
      }
    }

    return Array.from(targets.values());
  }

  private async listDiscordTargets(): Promise<PlatformTarget[]> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) return [];

    const url = 'https://discord.com/api/v10/users/@me/guilds';
    const response = await fetch(url, {
      headers: { 'Authorization': `Bot ${token}` },
    });

    const data: any = await response.json();
    if (!Array.isArray(data)) return [];

    return data.map((guild: any) => ({
      id: guild.id,
      name: guild.name,
      platform: 'discord' as Platform,
      type: 'channel' as const,
    }));
  }

  private async listSlackTargets(): Promise<PlatformTarget[]> {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return [];

    const url = 'https://slack.com/api/conversations.list';
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    const data: any = await response.json();
    if (!data.ok) return [];

    return (data.channels || []).map((ch: any) => ({
      id: ch.id,
      name: ch.name,
      platform: 'slack' as Platform,
      type: ch.is_channel ? 'channel' : 'group',
    }));
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _sendMessageManager: SendMessageManager | null = null;

export function getSendMessageManager(): SendMessageManager {
  if (!_sendMessageManager) _sendMessageManager = new SendMessageManager();
  return _sendMessageManager;
}

export function resetSendMessageManager(): void {
  _sendMessageManager = null;
}
