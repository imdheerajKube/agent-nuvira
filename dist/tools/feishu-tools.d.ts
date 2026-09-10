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
export declare class FeishuClient {
    private config;
    private baseUrl;
    private accessToken?;
    private tokenExpiry?;
    constructor(config: FeishuConfig);
    /**
     * Get tenant access token.
     */
    getAccessToken(): Promise<string>;
    /**
     * Make a Feishu API request.
     */
    private request;
    /**
     * Create a document.
     */
    createDocument(title: string, folderToken?: string): Promise<FeishuDocument>;
    /**
     * Get document info.
     */
    getDocument(documentId: string): Promise<FeishuDocument>;
    /**
     * Get document content (raw text).
     */
    getDocumentContent(documentId: string): Promise<string>;
    /**
     * Create a block in document.
     */
    createBlock(documentId: string, blockId: string, children: unknown[]): Promise<any>;
    /**
     * Delete a block from document.
     */
    deleteBlock(documentId: string, blockId: string): Promise<void>;
    /**
     * Update document title.
     */
    updateDocumentTitle(documentId: string, title: string): Promise<void>;
    /**
     * Delete document.
     */
    deleteDocument(documentId: string): Promise<void>;
    /**
     * List files in folder.
     */
    listFiles(folderToken?: string, pageSize?: number): Promise<FeishuDriveFile[]>;
    /**
     * Get file info.
     */
    getFileInfo(fileToken: string): Promise<FeishuDriveFile>;
    /**
     * Create folder.
     */
    createFolder(name: string, parentToken?: string): Promise<FeishuDriveFile>;
    /**
     * Delete file/folder.
     */
    deleteFile(fileToken: string): Promise<void>;
    /**
     * Move file to folder.
     */
    moveFile(fileToken: string, targetFolderToken: string): Promise<void>;
    /**
     * Copy file.
     */
    copyFile(fileToken: string, targetFolderToken: string): Promise<FeishuDriveFile>;
    /**
     * Search files.
     */
    searchFiles(query: string, count?: number): Promise<FeishuDriveFile[]>;
    private extractText;
}
export declare function getFeishuClient(config?: FeishuConfig): FeishuClient;
export declare function resetFeishuClient(): void;
//# sourceMappingURL=feishu-tools.d.ts.map