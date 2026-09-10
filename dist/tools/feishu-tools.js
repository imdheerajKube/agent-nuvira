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
// ─── Feishu Client ────────────────────────────────────────────────────────
export class FeishuClient {
    config;
    baseUrl = 'https://open.feishu.cn/open-apis';
    accessToken;
    tokenExpiry;
    constructor(config) {
        this.config = config;
    }
    /**
     * Get tenant access token.
     */
    async getAccessToken() {
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
        if (!response.ok)
            throw new Error(`Token request failed: ${response.status}`);
        const data = await response.json();
        this.accessToken = data.tenant_access_token;
        this.tokenExpiry = Date.now() + (data.expire - 60) * 1000;
        return this.accessToken;
    }
    /**
     * Make a Feishu API request.
     */
    async request(method, path, body) {
        const token = await this.getAccessToken();
        const url = `${this.baseUrl}${path}`;
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        };
        const options = { method, headers };
        if (body)
            options.body = JSON.stringify(body);
        const response = await fetch(url, options);
        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`Feishu API ${response.status}: ${errorText}`);
        }
        const result = await response.json();
        if (result.code !== 0) {
            throw new Error(`Feishu API error: ${result.msg}`);
        }
        return result.data;
    }
    // ─── Document Operations ──────────────────────────────────────────
    /**
     * Create a document.
     */
    async createDocument(title, folderToken) {
        const body = { title };
        if (folderToken)
            body.folder_token = folderToken;
        return this.request('POST', '/docx/v1/documents', body);
    }
    /**
     * Get document info.
     */
    async getDocument(documentId) {
        return this.request('GET', `/docx/v1/documents/${documentId}`);
    }
    /**
     * Get document content (raw text).
     */
    async getDocumentContent(documentId) {
        const blocks = await this.request('GET', `/docx/v1/documents/${documentId}/blocks`);
        return this.extractText(blocks.items || []);
    }
    /**
     * Create a block in document.
     */
    async createBlock(documentId, blockId, children) {
        return this.request('POST', `/docx/v1/documents/${documentId}/blocks/${blockId}/children`, {
            children,
        });
    }
    /**
     * Delete a block from document.
     */
    async deleteBlock(documentId, blockId) {
        await this.request('DELETE', `/docx/v1/documents/${documentId}/blocks/${blockId}`);
    }
    /**
     * Update document title.
     */
    async updateDocumentTitle(documentId, title) {
        await this.request('PATCH', `/docx/v1/documents/${documentId}`, { title });
    }
    /**
     * Delete document.
     */
    async deleteDocument(documentId) {
        await this.request('DELETE', `/drive/v1/files/${documentId}?type=docx`);
    }
    // ─── Drive Operations ─────────────────────────────────────────────
    /**
     * List files in folder.
     */
    async listFiles(folderToken, pageSize = 20) {
        const params = folderToken ? `?folder_token=${folderToken}&page_size=${pageSize}` : `?page_size=${pageSize}`;
        const result = await this.request('GET', `/drive/v1/files${params}`);
        return result.files || [];
    }
    /**
     * Get file info.
     */
    async getFileInfo(fileToken) {
        return this.request('GET', `/drive/v1/files/${fileToken}`);
    }
    /**
     * Create folder.
     */
    async createFolder(name, parentToken) {
        const body = { name };
        if (parentToken)
            body.folder_token = parentToken;
        return this.request('POST', '/drive/v1/files/create_folder', body);
    }
    /**
     * Delete file/folder.
     */
    async deleteFile(fileToken) {
        await this.request('DELETE', `/drive/v1/files/${fileToken}`);
    }
    /**
     * Move file to folder.
     */
    async moveFile(fileToken, targetFolderToken) {
        await this.request('POST', `/drive/v1/files/${fileToken}/move`, {
            type: 'file',
            folder_token: targetFolderToken,
        });
    }
    /**
     * Copy file.
     */
    async copyFile(fileToken, targetFolderToken) {
        return this.request('POST', `/drive/v1/files/${fileToken}/copy`, {
            name: 'Copy',
            type: 'file',
            folder_token: targetFolderToken,
        });
    }
    /**
     * Search files.
     */
    async searchFiles(query, count = 20) {
        const result = await this.request('POST', '/suite/docs-api/search/object', {
            search_key: query,
            count,
            docs_types: ['docx', 'sheet', 'bitable', 'mindnote'],
        });
        return result.docs_entities || [];
    }
    // ─── Helper Methods ───────────────────────────────────────────────
    extractText(blocks) {
        const parts = [];
        for (const block of blocks) {
            if (block.block_type === 2) { // Text block
                const elements = block.text?.elements || [];
                for (const el of elements) {
                    if (el.text_run)
                        parts.push(el.text_run.content);
                }
            }
        }
        return parts.join('\n');
    }
}
// ─── Singletons ───────────────────────────────────────────────────────────
let _feishuClient = null;
export function getFeishuClient(config) {
    if (!_feishuClient || config) {
        _feishuClient = new FeishuClient(config || {
            appId: process.env.FEISHU_APP_ID || '',
            appSecret: process.env.FEISHU_APP_SECRET || '',
        });
    }
    return _feishuClient;
}
export function resetFeishuClient() {
    _feishuClient = null;
}
//# sourceMappingURL=feishu-tools.js.map