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
import { readFile, writeFile, stat, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
export class FileStateManager {
    states = new Map();
    /**
     * Capture the state of a file.
     */
    async captureState(filePath) {
        const content = await readFile(filePath, 'utf-8').catch(() => '');
        const fileStat = await stat(filePath).catch(() => null);
        const hash = createHash('sha256').update(content).digest('hex');
        const previous = this.states.get(filePath);
        const state = {
            path: filePath,
            hash,
            size: fileStat?.size || 0,
            mtime: fileStat?.mtimeMs || Date.now(),
            capturedAt: Date.now(),
            previousHash: previous?.hash,
        };
        this.states.set(filePath, state);
        return state;
    }
    /**
     * Capture state of all files in a directory.
     */
    async captureDirectoryState(dirPath, extensions) {
        const states = [];
        const entries = await readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile()) {
                const filePath = join(dirPath, entry.name);
                if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) {
                    states.push(await this.captureState(filePath));
                }
            }
        }
        return states;
    }
    /**
     * Detect changes since last capture.
     */
    async detectChanges(dirPath) {
        const diffs = [];
        const entries = await readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile())
                continue;
            const filePath = join(dirPath, entry.name);
            const previous = this.states.get(filePath);
            try {
                const content = await readFile(filePath, 'utf-8');
                const hash = createHash('sha256').update(content).digest('hex');
                const fileStat = await stat(filePath);
                if (!previous) {
                    diffs.push({ path: filePath, added: true, modified: false, deleted: false, currentHash: hash });
                }
                else if (previous.hash !== hash) {
                    diffs.push({ path: filePath, added: false, modified: true, deleted: false, previousHash: previous.hash, currentHash: hash });
                }
            }
            catch {
                if (previous) {
                    diffs.push({ path: filePath, added: false, modified: false, deleted: true, previousHash: previous.hash });
                }
            }
        }
        return diffs;
    }
    /**
     * Get current state map.
     */
    getStates() {
        return new Map(this.states);
    }
}
export class ContentExtractor {
    /**
     * Extract content from a file based on its type.
     */
    async extract(filePath) {
        const ext = extname(filePath).toLowerCase();
        const content = await readFile(filePath, 'utf-8');
        switch (ext) {
            case '.json':
                return this.extractJson(content);
            case '.yaml':
            case '.yml':
                return this.extractYaml(content);
            case '.xml':
                return this.extractXml(content);
            case '.csv':
                return this.extractCsv(content);
            case '.md':
            case '.markdown':
                return this.extractMarkdown(content);
            case '.html':
                return this.extractHtml(content);
            case '.log':
                return this.extractLog(content);
            default:
                return { content, type: 'text', metadata: { ext } };
        }
    }
    extractJson(content) {
        try {
            const parsed = JSON.parse(content);
            return {
                content: JSON.stringify(parsed, null, 2),
                type: 'json',
                metadata: {
                    keys: typeof parsed === 'object' ? Object.keys(parsed) : [],
                    isArray: Array.isArray(parsed),
                    length: Array.isArray(parsed) ? parsed.length : undefined,
                },
            };
        }
        catch {
            return { content, type: 'json-invalid', metadata: {} };
        }
    }
    extractYaml(content) {
        return { content, type: 'yaml', metadata: { lines: content.split('\n').length } };
    }
    extractXml(content) {
        const tagMatches = content.match(/<(\w+)[^>]*>/g) || [];
        const tags = [...new Set(tagMatches.map((m) => m.replace(/<(\w+).*/, '$1')))];
        return { content, type: 'xml', metadata: { rootTags: tags.slice(0, 10) } };
    }
    extractCsv(content) {
        const lines = content.split('\n').filter(Boolean);
        const headers = lines[0]?.split(',') || [];
        return {
            content,
            type: 'csv',
            metadata: { headers, rowCount: lines.length - 1 },
        };
    }
    extractMarkdown(content) {
        const headings = content.match(/^#{1,6}\s+.+$/gm) || [];
        const links = content.match(/\[([^\]]+)\]\(([^)]+)\)/g) || [];
        const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
        return {
            content,
            type: 'markdown',
            metadata: { headings: headings.length, links: links.length, codeBlocks: codeBlocks.length },
        };
    }
    extractHtml(content) {
        const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
        const links = content.match(/href="([^"]+)"/g) || [];
        const scripts = content.match(/<script[^>]*>/g) || [];
        return {
            content,
            type: 'html',
            metadata: { title: titleMatch?.[1], links: links.length, scripts: scripts.length },
        };
    }
    extractLog(content) {
        const lines = content.split('\n');
        const errors = lines.filter((l) => /\berror\b/i.test(l));
        const warnings = lines.filter((l) => /\bwarn(ing)?\b/i.test(l));
        return {
            content,
            type: 'log',
            metadata: { totalLines: lines.length, errors: errors.length, warnings: warnings.length },
        };
    }
}
export class FilePreviewer {
    /**
     * Generate a preview of a file.
     */
    async preview(filePath, options = {}) {
        const maxLines = options.maxLines || 50;
        const maxChars = options.maxChars || 5000;
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const ext = extname(filePath).toLowerCase();
        let preview = lines.slice(0, maxLines).join('\n');
        if (preview.length > maxChars) {
            preview = preview.slice(0, maxChars) + '\n... (truncated)';
        }
        return {
            preview,
            totalLines: lines.length,
            previewLines: Math.min(maxLines, lines.length),
            type: this.getFileType(ext),
        };
    }
    getFileType(ext) {
        const types = {
            '.ts': 'typescript', '.js': 'javascript', '.py': 'python',
            '.rs': 'rust', '.go': 'go', '.java': 'java',
            '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
            '.md': 'markdown', '.html': 'html', '.css': 'css',
            '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
            '.sql': 'sql', '.graphql': 'graphql',
        };
        return types[ext] || 'text';
    }
}
export class SafeFileOperations {
    backups = new Map();
    /**
     * Safely write a file with backup.
     */
    async safeWrite(filePath, content) {
        // Backup existing file
        if (existsSync(filePath)) {
            const existing = await readFile(filePath, 'utf-8').catch(() => '');
            this.backups.set(filePath, {
                path: filePath,
                content: existing,
                backedUpAt: Date.now(),
            });
        }
        await writeFile(filePath, content, 'utf-8');
    }
    /**
     * Safely delete a file with backup.
     */
    async safeDelete(filePath) {
        if (existsSync(filePath)) {
            const existing = await readFile(filePath, 'utf-8').catch(() => '');
            this.backups.set(filePath, {
                path: filePath,
                content: existing,
                backedUpAt: Date.now(),
            });
            await unlink(filePath);
        }
    }
    /**
     * Rollback a file to its backup.
     */
    async rollback(filePath) {
        const backup = this.backups.get(filePath);
        if (!backup)
            return false;
        await writeFile(backup.path, backup.content, 'utf-8');
        this.backups.delete(filePath);
        return true;
    }
    /**
     * Rollback all backed up files.
     */
    async rollbackAll() {
        let count = 0;
        for (const [path] of this.backups) {
            if (await this.rollback(path))
                count++;
        }
        return count;
    }
    /**
     * Get backup list.
     */
    getBackups() {
        return [...this.backups.values()];
    }
}
// ─── Singletons ───────────────────────────────────────────────────────────
let _fileStateManager = null;
let _contentExtractor = null;
let _filePreviewer = null;
let _safeFileOps = null;
export function getFileStateManager() {
    if (!_fileStateManager)
        _fileStateManager = new FileStateManager();
    return _fileStateManager;
}
export function getContentExtractor() {
    if (!_contentExtractor)
        _contentExtractor = new ContentExtractor();
    return _contentExtractor;
}
export function getFilePreviewer() {
    if (!_filePreviewer)
        _filePreviewer = new FilePreviewer();
    return _filePreviewer;
}
export function getSafeFileOps() {
    if (!_safeFileOps)
        _safeFileOps = new SafeFileOperations();
    return _safeFileOps;
}
//# sourceMappingURL=file-operations.js.map