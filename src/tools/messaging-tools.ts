/**
 * Messaging Tools — Enhanced messaging capabilities.
 *
 * Hermes equivalent: send_message_tool.py + react_to_message_tool.py + feishu_doc_tool.py + feishu_drive_tool.py
 *
 * Provides:
 * - Send messages to various platforms
 * - React to messages
 * - Feishu document integration
 * - Feishu drive integration
 */

import { logger } from '../utils/logger.js';

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
   * Send a message to a platform.
   */
  async sendMessage(
    target: MessageTarget,
    options: SendMessageOptions,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const historyEntry = {
      platform: target.platform,
      channelId: target.channelId,
      content: options.content,
      timestamp: Date.now(),
    };

    try {
      // Route to platform-specific handler
      switch (target.platform) {
        case 'discord':
          return await this.sendDiscord(target, options);
        case 'slack':
          return await this.sendSlack(target, options);
        case 'telegram':
          return await this.sendTelegram(target, options);
        case 'whatsapp':
          return await this.sendWhatsApp(target, options);
        case 'feishu':
          return await this.sendFeishu(target, options);
        case 'webhook':
          return await this.sendWebhook(target, options);
        default:
          return { success: false, error: `Unsupported platform: ${target.platform}` };
      }
    } finally {
      this.messageHistory.push(historyEntry);
    }
  }

  /**
   * React to a message.
   */
  async reactToMessage(
    platform: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ success: boolean; error?: string }> {
    logger.info(`Messaging: Reacting with ${emoji} to message ${messageId} on ${platform}`);

    // In a real implementation, this would call the platform API
    return { success: true };
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

  private async sendDiscord(target: MessageTarget, options: SendMessageOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    logger.info(`Discord: Sending message to channel ${target.channelId}`);
    // In production, this would call Discord API
    return { success: true, messageId: `discord_${Date.now()}` };
  }

  private async sendSlack(target: MessageTarget, options: SendMessageOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    logger.info(`Slack: Sending message to channel ${target.channelId}`);
    return { success: true, messageId: `slack_${Date.now()}` };
  }

  private async sendTelegram(target: MessageTarget, options: SendMessageOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    logger.info(`Telegram: Sending message to chat ${target.channelId}`);
    return { success: true, messageId: `telegram_${Date.now()}` };
  }

  private async sendWhatsApp(target: MessageTarget, options: SendMessageOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    logger.info(`WhatsApp: Sending message to chat ${target.channelId}`);
    return { success: true, messageId: `whatsapp_${Date.now()}` };
  }

  private async sendFeishu(target: MessageTarget, options: SendMessageOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    logger.info(`Feishu: Sending message to chat ${target.channelId}`);
    return { success: true, messageId: `feishu_${Date.now()}` };
  }

  private async sendWebhook(target: MessageTarget, options: SendMessageOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    logger.info(`Webhook: Sending message to ${target.channelId}`);
    return { success: true, messageId: `webhook_${Date.now()}` };
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
