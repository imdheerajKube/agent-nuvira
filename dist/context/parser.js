import { readFileSync, existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
const DEFAULT_OPTIONS = {
    maxTokens: 4096,
    priorityPatterns: [],
    includeExtensions: ['.ts', '.js', '.tsx', '.jsx', '.go', '.py', '.rs', '.md'],
    ignorePatterns: ['node_modules', '.git', 'dist', 'build', '.next'],
    includeGitIgnored: false,
};
// Rough estimate: ~4 chars per token for code
const CHARS_PER_TOKEN = 4;
/**
 * Estimate token count from string length
 */
function estimateTokens(text) {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}
/**
 * Multi-file context parser
 * Reads files, chunks content, and prioritizes important files
 */
export class ContextParser {
    options;
    constructor(options) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }
    /**
     * Parse context from a list of file paths
     */
    parseFromFiles(filePaths) {
        const chunks = [];
        // Check which files exist
        const validFiles = filePaths.filter((f) => existsSync(f) && statSync(f).isFile());
        for (const filePath of validFiles) {
            try {
                const content = readFileSync(filePath, 'utf-8');
                const ext = filePath.slice(filePath.lastIndexOf('.'));
                const isPriority = this.options.priorityPatterns.some((pattern) => filePath.endsWith(pattern) || filePath.includes(pattern));
                chunks.push({
                    filePath,
                    content,
                    priority: isPriority ? 2 : 1,
                    tokenCount: estimateTokens(content),
                });
            }
            catch {
                // Skip files we can't read
            }
        }
        return this.pruneToTokenLimit(chunks);
    }
    /**
     * Parse context from a directory, recursively finding relevant files
     */
    async parseFromDirectory(dirPath) {
        const chunks = [];
        await this.walkDirectory(dirPath, chunks, dirPath);
        return this.pruneToTokenLimit(chunks);
    }
    /**
     * Recursively walk a directory
     */
    async walkDirectory(dir, chunks, rootDir) {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (this.options.ignorePatterns.includes(entry.name))
                    continue;
                await this.walkDirectory(fullPath, chunks, rootDir);
            }
            else if (entry.isFile()) {
                const ext = fullPath.slice(fullPath.lastIndexOf('.'));
                if (!this.options.includeExtensions.includes(ext))
                    continue;
                try {
                    const content = readFileSync(fullPath, 'utf-8');
                    const relativePath = relative(rootDir, fullPath);
                    const isPriority = this.options.priorityPatterns.some((pattern) => fullPath.endsWith(pattern) || fullPath.includes(pattern));
                    chunks.push({
                        filePath: relativePath.replace(/\\/g, '/'),
                        content,
                        priority: isPriority ? 2 : 1,
                        tokenCount: estimateTokens(content),
                    });
                }
                catch {
                    // Skip files we can't read
                }
            }
        }
    }
    /**
     * Parse a single string of context text
     */
    parseFromString(text, label = 'input') {
        const tokenCount = estimateTokens(text);
        if (tokenCount <= this.options.maxTokens) {
            return [
                {
                    filePath: label,
                    content: text,
                    priority: 1,
                    tokenCount,
                },
            ];
        }
        // Chunk if too large
        return this.chunkText(text, label);
    }
    /**
     * Split text into chunks that fit within token limits
     */
    chunkText(text, label) {
        const chunks = [];
        const maxChars = this.options.maxTokens * CHARS_PER_TOKEN;
        // Split by paragraphs first
        const paragraphs = text.split(/\n\n+/);
        let currentChunk = '';
        let chunkIndex = 0;
        for (const para of paragraphs) {
            if ((currentChunk + para).length > maxChars && currentChunk) {
                chunks.push({
                    filePath: `${label}[part ${chunkIndex + 1}]`,
                    content: currentChunk.trim(),
                    priority: 1,
                    tokenCount: estimateTokens(currentChunk),
                });
                currentChunk = para;
                chunkIndex++;
            }
            else {
                currentChunk += (currentChunk ? '\n\n' : '') + para;
            }
        }
        if (currentChunk) {
            chunks.push({
                filePath: `${label}[part ${chunkIndex + 1}]`,
                content: currentChunk.trim(),
                priority: 1,
                tokenCount: estimateTokens(currentChunk),
            });
        }
        return chunks;
    }
    /**
     * Prune chunks to fit within token limits, prioritizing by priority
     */
    pruneToTokenLimit(chunks) {
        // Sort by priority (descending), then by token count (smaller first)
        const sorted = [...chunks].sort((a, b) => {
            if (a.priority !== b.priority)
                return b.priority - a.priority;
            return a.tokenCount - b.tokenCount;
        });
        const result = [];
        let totalTokens = 0;
        for (const chunk of sorted) {
            if (totalTokens + chunk.tokenCount > this.options.maxTokens) {
                // Try to fit a truncated version
                if (result.length === 0) {
                    // Must include at least the highest priority content
                    const maxChars = this.options.maxTokens * CHARS_PER_TOKEN;
                    result.push({
                        ...chunk,
                        content: chunk.content.slice(0, maxChars) + '\n\n[...truncated...]',
                        tokenCount: this.options.maxTokens,
                    });
                }
                break;
            }
            result.push(chunk);
            totalTokens += chunk.tokenCount;
        }
        return result;
    }
    /**
     * Format chunks into a single prompt-ready string
     */
    static formatContext(chunks) {
        if (chunks.length === 0)
            return '';
        const parts = chunks.map((chunk) => `--- ${chunk.filePath} ---\n${chunk.content}`);
        return parts.join('\n\n');
    }
}
//# sourceMappingURL=parser.js.map