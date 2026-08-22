/**
 * Feishu Tools — Document and Drive management.
 *
 * Hermes equivalents:
 * - feishu_doc_tool.py (138 lines) — Document management
 * - feishu_drive_tool.py (431 lines) — Drive file management
 *
 * Provides:
 * - Document CRUD (create, read, update, delete)
 * - Document blocks management
 * - Drive file operations
 * - Folder management
 * - Search
 */

import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

export interface FeishuDocument {
  document_id: string;
  title: string;
  revision_id?: number;
  url?: string;
}

export interface FeishuDriveFile {
  token: string;
  name: string;
  type: string;
  url: string;
  created_time: string;
  modified_time: string;
  size?: number;
  parent_token?: string;
}

// ─── Feishu Client ────────────────────────────────────────────────────────

export class FeishuClient {
  private config: FeishuConfig;
  private baseUrl = 'https://open.feishu.cn/open-apis';
  private accessToken?: string;
  private tokenExpiry?: number;

  constructor(config: FeishuConfig) {
    this.config = config;
  }

  /**
   * Get tenant access token.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const response = await fetch(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }),
    });

    if (!response.ok) throw new Error(`Token request failed: ${response.status}`);

    const data = await response.json() as { tenant_access_token: string; expire: number };
    this.accessToken = data.tenant_access_token;
    this.tokenExpiry = Date.now() + (data.expire - 60) * 1000;
    return this.accessToken;
  }

  /**
   * Make a Feishu API request.
   */
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Feishu API ${response.status}: ${errorText}`);
    }

    const result: any = await response.json();
    if (result.code !== 0) {
      throw new Error(`Feishu API error: ${result.msg}`);
    }

    return result.data;
  }

  // ─── Document Operations ──────────────────────────────────────────

  /**
   * Create a document.
   */
  async createDocument(title: string, folderToken?: string): Promise<FeishuDocument> {
    const body: Record<string, unknown> = { title };
    if (folderToken) body.folder_token = folderToken;
    return this.request('POST', '/docx/v1/documents', body);
  }

  /**
   * Get document info.
   */
  async getDocument(documentId: string): Promise<FeishuDocument> {
    return this.request('GET', `/docx/v1/documents/${documentId}`);
  }

  /**
   * Get document content (raw text).
   */
  async getDocumentContent(documentId: string): Promise<string> {
    const blocks = await this.request('GET', `/docx/v1/documents/${documentId}/blocks`);
    return this.extractText(blocks.items || []);
  }

  /**
   * Create a block in document.
   */
  async createBlock(documentId: string, blockId: string, children: unknown[]): Promise<any> {
    return this.request('POST', `/docx/v1/documents/${documentId}/blocks/${blockId}/children`, {
      children,
    });
  }

  /**
   * Delete a block from document.
   */
  async deleteBlock(documentId: string, blockId: string): Promise<void> {
    await this.request('DELETE', `/docx/v1/documents/${documentId}/blocks/${blockId}`);
  }

  /**
   * Update document title.
   */
  async updateDocumentTitle(documentId: string, title: string): Promise<void> {
    await this.request('PATCH', `/docx/v1/documents/${documentId}`, { title });
  }

  /**
   * Delete document.
   */
  async deleteDocument(documentId: string): Promise<void> {
    await this.request('DELETE', `/drive/v1/files/${documentId}?type=docx`);
  }

  // ─── Drive Operations ─────────────────────────────────────────────

  /**
   * List files in folder.
   */
  async listFiles(folderToken?: string, pageSize: number = 20): Promise<FeishuDriveFile[]> {
    const params = folderToken ? `?folder_token=${folderToken}&page_size=${pageSize}` : `?page_size=${pageSize}`;
    const result = await this.request('GET', `/drive/v1/files${params}`);
    return result.files || [];
  }

  /**
   * Get file info.
   */
  async getFileInfo(fileToken: string): Promise<FeishuDriveFile> {
    return this.request('GET', `/drive/v1/files/${fileToken}`);
  }

  /**
   * Create folder.
   */
  async createFolder(name: string, parentToken?: string): Promise<FeishuDriveFile> {
    const body: Record<string, unknown> = { name };
    if (parentToken) body.folder_token = parentToken;
    return this.request('POST', '/drive/v1/files/create_folder', body);
  }

  /**
   * Delete file/folder.
   */
  async deleteFile(fileToken: string): Promise<void> {
    await this.request('DELETE', `/drive/v1/files/${fileToken}`);
  }

  /**
   * Move file to folder.
   */
  async moveFile(fileToken: string, targetFolderToken: string): Promise<void> {
    await this.request('POST', `/drive/v1/files/${fileToken}/move`, {
      type: 'file',
      folder_token: targetFolderToken,
    });
  }

  /**
   * Copy file.
   */
  async copyFile(fileToken: string, targetFolderToken: string): Promise<FeishuDriveFile> {
    return this.request('POST', `/drive/v1/files/${fileToken}/copy`, {
      name: 'Copy',
      type: 'file',
      folder_token: targetFolderToken,
    });
  }

  /**
   * Search files.
   */
  async searchFiles(query: string, count: number = 20): Promise<FeishuDriveFile[]> {
    const result = await this.request('POST', '/suite/docs-api/search/object', {
      search_key: query,
      count,
      docs_types: ['docx', 'sheet', 'bitable', 'mindnote'],
    });
    return result.docs_entities || [];
  }

  // ─── Helper Methods ───────────────────────────────────────────────

  private extractText(blocks: any[]): string {
    const parts: string[] = [];
    for (const block of blocks) {
      if (block.block_type === 2) { // Text block
        const elements = block.text?.elements || [];
        for (const el of elements) {
          if (el.text_run) parts.push(el.text_run.content);
        }
      }
    }
    return parts.join('\n');
  }
}

// ─── Singletons ───────────────────────────────────────────────────────────

let _feishuClient: FeishuClient | null = null;

export function getFeishuClient(config?: FeishuConfig): FeishuClient {
  if (!_feishuClient || config) {
    _feishuClient = new FeishuClient(config || {
      appId: process.env.FEISHU_APP_ID || '',
      appSecret: process.env.FEISHU_APP_SECRET || '',
    });
  }
  return _feishuClient;
}

export function resetFeishuClient(): void {
  _feishuClient = null;
}
