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
    attachments?: Array<{
        name: string;
        url: string;
        type?: string;
    }>;
    /** Embeds (Discord-specific) */
    embeds?: Array<{
        title?: string;
        description?: string;
        color?: number;
        url?: string;
    }>;
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
export declare class MessagingManager {
    private messageHistory;
    /**
     * Send a message to a platform.
     */
    sendMessage(target: MessageTarget, options: SendMessageOptions): Promise<{
        success: boolean;
        messageId?: string;
        error?: string;
    }>;
    /**
     * React to a message.
     */
    reactToMessage(platform: string, channelId: string, messageId: string, emoji: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * Get message history.
     */
    getHistory(platform?: string, channelId?: string, limit?: number): Array<{
        platform: string;
        channelId: string;
        content: string;
        timestamp: number;
        messageId?: string;
    }>;
    private sendDiscord;
    private sendSlack;
    private sendTelegram;
    private sendWhatsApp;
    private sendFeishu;
    private sendWebhook;
}
export declare class FeishuDocumentManager {
    private documents;
    /**
     * Create a new Feishu document.
     */
    createDocument(title: string, blocks?: FeishuBlock[]): FeishuDocument;
    /**
     * Get a document by ID.
     */
    getDocument(documentId: string): FeishuDocument | null;
    /**
     * Update document blocks.
     */
    updateDocument(documentId: string, blocks: FeishuBlock[]): boolean;
    /**
     * Export document as markdown.
     */
    exportAsMarkdown(documentId: string): string | null;
    /**
     * List all documents.
     */
    listDocuments(): FeishuDocument[];
}
export declare class FeishuDriveManager {
    private files;
    /**
     * List files in a folder.
     */
    listFiles(folderId?: string): FeishuDriveFile[];
    /**
     * Get file info.
     */
    getFile(fileId: string): FeishuDriveFile | null;
    /**
     * Search files by name.
     */
    searchFiles(query: string): FeishuDriveFile[];
    /**
     * Upload a file (creates a record).
     */
    uploadFile(fileName: string, fileType: string, parentFolderId: string, size: number): FeishuDriveFile;
    /**
     * Delete a file.
     */
    deleteFile(fileId: string): boolean;
    /**
     * Move a file to a different folder.
     */
    moveFile(fileId: string, newParentFolderId: string): boolean;
}
export declare function getMessagingManager(): MessagingManager;
export declare function getFeishuDocumentManager(): FeishuDocumentManager;
export declare function getFeishuDriveManager(): FeishuDriveManager;
//# sourceMappingURL=messaging-tools.d.ts.map