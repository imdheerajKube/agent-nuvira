/**
 * File Operations — Advanced file handling capabilities.
 *
 * Hermes equivalent: file_operations.py + file_state.py + read_extract.py + read_preview_tool.py
 *
 * Provides:
 * - File state tracking (modified, created, deleted)
 * - Content extraction from various formats
 * - Preview generation for files
 * - Safe file operations with rollback
 */
export interface FileState {
    /** Absolute path */
    path: string;
    /** Content hash (SHA-256) */
    hash: string;
    /** File size in bytes */
    size: number;
    /** Last modified time */
    mtime: number;
    /** When state was captured */
    capturedAt: number;
    /** Previous state (if tracked) */
    previousHash?: string;
}
export interface FileDiff {
    /** File path */
    path: string;
    /** Whether file was added */
    added: boolean;
    /** Whether file was modified */
    modified: boolean;
    /** Whether file was deleted */
    deleted: boolean;
    /** Previous hash */
    previousHash?: string;
    /** Current hash */
    currentHash?: string;
    /** Content before change */
    before?: string;
    /** Content after change */
    after?: string;
}
export declare class FileStateManager {
    private states;
    /**
     * Capture the state of a file.
     */
    captureState(filePath: string): Promise<FileState>;
    /**
     * Capture state of all files in a directory.
     */
    captureDirectoryState(dirPath: string, extensions?: string[]): Promise<FileState[]>;
    /**
     * Detect changes since last capture.
     */
    detectChanges(dirPath: string): Promise<FileDiff[]>;
    /**
     * Get current state map.
     */
    getStates(): Map<string, FileState>;
}
export interface ExtractionResult {
    /** Extracted content */
    content: string;
    /** Content type */
    type: string;
    /** Metadata */
    metadata: Record<string, unknown>;
}
export declare class ContentExtractor {
    /**
     * Extract content from a file based on its type.
     */
    extract(filePath: string): Promise<ExtractionResult>;
    private extractJson;
    private extractYaml;
    private extractXml;
    private extractCsv;
    private extractMarkdown;
    private extractHtml;
    private extractLog;
}
export interface PreviewResult {
    /** Preview content */
    preview: string;
    /** Total lines */
    totalLines: number;
    /** Preview lines shown */
    previewLines: number;
    /** File type */
    type: string;
}
export declare class FilePreviewer {
    /**
     * Generate a preview of a file.
     */
    preview(filePath: string, options?: {
        maxLines?: number;
        maxChars?: number;
    }): Promise<PreviewResult>;
    private getFileType;
}
export interface BackupEntry {
    path: string;
    content: string;
    backedUpAt: number;
}
export declare class SafeFileOperations {
    private backups;
    /**
     * Safely write a file with backup.
     */
    safeWrite(filePath: string, content: string): Promise<void>;
    /**
     * Safely delete a file with backup.
     */
    safeDelete(filePath: string): Promise<void>;
    /**
     * Rollback a file to its backup.
     */
    rollback(filePath: string): Promise<boolean>;
    /**
     * Rollback all backed up files.
     */
    rollbackAll(): Promise<number>;
    /**
     * Get backup list.
     */
    getBackups(): BackupEntry[];
}
export declare function getFileStateManager(): FileStateManager;
export declare function getContentExtractor(): ContentExtractor;
export declare function getFilePreviewer(): FilePreviewer;
export declare function getSafeFileOps(): SafeFileOperations;
//# sourceMappingURL=file-operations.d.ts.map