/**
 * Messaging Tools — Enhanced messaging capabilities.
 *
 * Hermes equivalent: send_message_tool.py + react_to_message_tool.py + feishu_doc_tool.py + feishu_drive_tool.py
 *
 * Provides:
 * - Message history bookkeeping for outbound sends
 * - Feishu document integration
 * - Feishu drive integration
 *
 * DOES NOT PROVIDE: delivery to Discord / Slack / Telegram / WhatsApp / Feishu /
 * webhooks. Every one of those senders used to answer
 * `{ success: true, messageId: '<platform>_<timestamp>' }` without contacting
 * anything, and `reactToMessage` answered `{ success: true }` unconditionally —
 * so an agent could tell the user, honestly from its own point of view, that a
 * message had been delivered to a third party when nothing left the machine.
 * The real, authorization-gated sender is `gateway_send`
 * (`src/tools/gateway-send.ts`); it is the tool whose result the honesty guard in
 * `tool-loop.ts` trusts. These senders now refuse with `not_configured` and name
 * it, so the model is steered to the path that can actually deliver.
 *
 * See TOOL_TRUTHFULNESS_TRACKER.md (findings #3 and #9).
 */

import { logger } from '../utils/logger.js';
import { refusalFields, type ToolRefusalCode } from './tool-refusal.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface MessageTarget {
  /** Platform */
  platform: 'discord' | 'slack' | 'telegram' | 'whatsapp' | 'feishu' | 'webhook';
  /** Channel/chat ID */
  channelId: string;
  /** Optional thread/topic ID */
  threadId?: string;
}

export interface SendMessageOptions {
  /** Message content */
  content: string;
  /** Message format */
  format?: 'text' | 'markdown' | 'html';
  /** Attachments */
  attachments?: Array<{ name: string; url: string; type?: string }>;
  /** Embeds (Discord-specific) */
  embeds?: Array<{ title?: string; description?: string; color?: number; url?: string }>;
}

export interface ReactionOptions {
  /** Emoji or reaction string */
  emoji: string;
  /** Message ID to react to */
  messageId: string;
}

export interface FeishuDocument {
  /** Document ID */
  documentId: string;
  /** Document title */
  title: string;
  /** Document content (blocks) */
  blocks: FeishuBlock[];
  /** Created at */
  createdAt: number;
  /** Updated at */
  updatedAt: number;
}

export interface FeishuBlock {
  /** Block type */
  type: 'text' | 'heading' | 'code' | 'list' | 'image' | 'table';
  /** Block content */
  content: string;
  /** Block metadata */
  metadata?: Record<string, unknown>;
}

export interface FeishuDriveFile {
  /** File ID */
  fileId: string;
  /** File name */
  fileName: string;
  /** File type */
  fileType: string;
  /** Parent folder ID */
  parentFolderId: string;
  /** Size in bytes */
  size: number;
  /** Created at */
  createdAt: number;
  /** Updated at */
  updatedAt: number;
}

// ─── Types (results) ──────────────────────────────────────────────────────

/**
 * The result of an outbound send. `success: false` carries a typed `code` and the
 * alternatives a caller can take instead — never a synthetic `messageId`.
 */
export interface SendResult {
  success: boolean;
  /** Present ONLY when a platform adapter actually delivered the message. */
  messageId?: string;
  code?: ToolRefusalCode;
  alternatives?: string[];
  error?: string;
}

// ─── Messaging Manager ────────────────────────────────────────────────────

export class MessagingManager {
  private messageHistory: Array<{
    platform: string;
    channelId: string;
    content: string;
    timestamp: number;
    messageId?: string;
  }> = [];

  /**
   * The one refusal every platform sender returns: this manager has no adapter.
   * Kept in a single place so a future reader cannot re-introduce a per-platform
   * fake success without deleting the shared reason that explains why.
   */
  private notConfigured(platform: string, channelId: string): SendResult {
    return {
      success: false,
      error:
        `No messaging adapter is configured for ${platform} (channel ${channelId}), so nothing was sent. ` +
        'Use gateway_send — it delivers through the configured gateway and returns an explicit sent/refused result.',
      ...refusalFields('not_configured', [
        'gateway_send — sends via the configured gateway (WhatsApp / Telegram / Slack / Discord by name or number)',
        'nuvira gateway send <platform:channel> <message> — the CLI equivalent',
      ]),
    };
  }

  /**
   * Send a message to a platform.
   *
   * Records the attempt in history ONLY when a platform adapter reported success,
   * so `getHistory()` can never list a message that was never delivered.
   */
  async sendMessage(
    target: MessageTarget,
    options: SendMessageOptions,
  ): Promise<SendResult> {
    let result: SendResult;
    switch (target.platform) {
      case 'discord':
        result = await this.sendDiscord(target, options);
        break;
      case 'slack':
        result = await this.sendSlack(target, options);
        break;
      case 'telegram':
        result = await this.sendTelegram(target, options);
        break;
      case 'whatsapp':
        result = await this.sendWhatsApp(target, options);
        break;
      case 'feishu':
        result = await this.sendFeishu(target, options);
        break;
      case 'webhook':
        result = await this.sendWebhook(target, options);
        break;
      default:
        result = {
          success: false,
          error: `Unsupported platform: ${target.platform}`,
          ...refusalFields('unsupported_format'),
        };
    }

    if (result.success) {
      this.messageHistory.push({
        platform: target.platform,
        channelId: target.channelId,
        content: options.content,
        timestamp: Date.now(),
        messageId: result.messageId,
      });
    } else {
      logger.warn(`Messaging: refused ${target.platform} send to ${target.channelId} — ${result.error}`);
    }
    return result;
  }

  /**
   * React to a message.
   *
   * No adapter exists for reactions, so this refuses. It used to return
   * `{ success: true }` and the registry turned that into the string 'Reacted'.
   */
  async reactToMessage(
    platform: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<SendResult> {
    logger.warn(`Messaging: reaction not sent (no adapter) — ${emoji} on ${messageId} in ${platform}/${channelId}`);
    return {
      success: false,
      error: `No messaging adapter is configured for ${platform}, so the reaction was NOT applied to ${messageId}.`,
      ...refusalFields('not_configured', [
        'Report the reaction as not sent, or send the message text instead via gateway_send',
      ]),
    };
  }

  /**
   * Get message history.
   */
  getHistory(platform?: string, channelId?: string, limit: number = 50): Array<{
    platform: string;
    channelId: string;
    content: string;
    timestamp: number;
    messageId?: string;
  }> {
    let history = [...this.messageHistory];
    if (platform) history = history.filter((h) => h.platform === platform);
    if (channelId) history = history.filter((h) => h.channelId === channelId);
    return history.slice(-limit);
  }

  // ─── Platform Handlers ─────────────────────────────────────────────
  //
  // Each returns `notConfigured(...)`. The per-platform shape is kept so a real
  // adapter can be dropped in per platform without touching the dispatcher; until
  // one exists, the honest answer is the same for all six.

  private async sendDiscord(target: MessageTarget, _options: SendMessageOptions): Promise<SendResult> {
    return this.notConfigured('discord', target.channelId);
  }

  private async sendSlack(target: MessageTarget, _options: SendMessageOptions): Promise<SendResult> {
    return this.notConfigured('slack', target.channelId);
  }

  private async sendTelegram(target: MessageTarget, _options: SendMessageOptions): Promise<SendResult> {
    return this.notConfigured('telegram', target.channelId);
  }

  private async sendWhatsApp(target: MessageTarget, _options: SendMessageOptions): Promise<SendResult> {
    return this.notConfigured('whatsapp', target.channelId);
  }

  private async sendFeishu(target: MessageTarget, _options: SendMessageOptions): Promise<SendResult> {
    return this.notConfigured('feishu', target.channelId);
  }

  private async sendWebhook(target: MessageTarget, _options: SendMessageOptions): Promise<SendResult> {
    return this.notConfigured('webhook', target.channelId);
  }
}

// ─── Feishu Document Manager ──────────────────────────────────────────────

export class FeishuDocumentManager {
  private documents: Map<string, FeishuDocument> = new Map();

  /**
   * Create a new Feishu document.
   */
  createDocument(title: string, blocks: FeishuBlock[] = []): FeishuDocument {
    const doc: FeishuDocument = {
      documentId: `doc_${Date.now()}`,
      title,
      blocks,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.documents.set(doc.documentId, doc);
    return doc;
  }

  /**
   * Get a document by ID.
   */
  getDocument(documentId: string): FeishuDocument | null {
    return this.documents.get(documentId) || null;
  }

  /**
   * Update document blocks.
   */
  updateDocument(documentId: string, blocks: FeishuBlock[]): boolean {
    const doc = this.documents.get(documentId);
    if (!doc) return false;
    doc.blocks = blocks;
    doc.updatedAt = Date.now();
    return true;
  }

  /**
   * Export document as markdown.
   */
  exportAsMarkdown(documentId: string): string | null {
    const doc = this.documents.get(documentId);
    if (!doc) return null;

    let md = `# ${doc.title}\n\n`;
    for (const block of doc.blocks) {
      switch (block.type) {
        case 'heading':
          md += `## ${block.content}\n\n`;
          break;
        case 'text':
          md += `${block.content}\n\n`;
          break;
        case 'code':
          md += `\`\`\`\n${block.content}\n\`\`\`\n\n`;
          break;
        case 'list':
          md += block.content.split('\n').map((item) => `- ${item}`).join('\n') + '\n\n';
          break;
        default:
          md += `${block.content}\n\n`;
      }
    }
    return md;
  }

  /**
   * List all documents.
   */
  listDocuments(): FeishuDocument[] {
    return [...this.documents.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

// ─── Feishu Drive Manager ─────────────────────────────────────────────────

export class FeishuDriveManager {
  private files: Map<string, FeishuDriveFile> = new Map();

  /**
   * List files in a folder.
   */
  listFiles(folderId: string = 'root'): FeishuDriveFile[] {
    return [...this.files.values()]
      .filter((f) => f.parentFolderId === folderId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Get file info.
   */
  getFile(fileId: string): FeishuDriveFile | null {
    return this.files.get(fileId) || null;
  }

  /**
   * Search files by name.
   */
  searchFiles(query: string): FeishuDriveFile[] {
    const lowerQuery = query.toLowerCase();
    return [...this.files.values()]
      .filter((f) => f.fileName.toLowerCase().includes(lowerQuery));
  }

  /**
   * Upload a file (creates a record).
   */
  uploadFile(fileName: string, fileType: string, parentFolderId: string, size: number): FeishuDriveFile {
    const file: FeishuDriveFile = {
      fileId: `file_${Date.now()}`,
      fileName,
      fileType,
      parentFolderId,
      size,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.files.set(file.fileId, file);
    return file;
  }

  /**
   * Delete a file.
   */
  deleteFile(fileId: string): boolean {
    return this.files.delete(fileId);
  }

  /**
   * Move a file to a different folder.
   */
  moveFile(fileId: string, newParentFolderId: string): boolean {
    const file = this.files.get(fileId);
    if (!file) return false;
    file.parentFolderId = newParentFolderId;
    file.updatedAt = Date.now();
    return true;
  }
}

// ─── Singletons ───────────────────────────────────────────────────────────

let _messagingManager: MessagingManager | null = null;
let _feishuDocManager: FeishuDocumentManager | null = null;
let _feishuDriveManager: FeishuDriveManager | null = null;

export function getMessagingManager(): MessagingManager {
  if (!_messagingManager) _messagingManager = new MessagingManager();
  return _messagingManager;
}

export function getFeishuDocumentManager(): FeishuDocumentManager {
  if (!_feishuDocManager) _feishuDocManager = new FeishuDocumentManager();
  return _feishuDocManager;
}

export function getFeishuDriveManager(): FeishuDriveManager {
  if (!_feishuDriveManager) _feishuDriveManager = new FeishuDriveManager();
  return _feishuDriveManager;
}
