/**
 * Represents a parsed file context chunk
 */
export interface ContextChunk {
    filePath: string;
    content: string;
    priority: number;
    tokenCount: number;
}
/**
 * Options for context parsing
 */
export interface ContextParserOptions {
    /** Maximum total tokens (approximate) to include */
    maxTokens?: number;
    /** File patterns to prioritize (e.g., ['index.ts', 'main.go']) */
    priorityPatterns?: string[];
    /** File extensions to include */
    includeExtensions?: string[];
    /** Files/directories to ignore */
    ignorePatterns?: string[];
    /** Whether to include .gitignore'd files */
    includeGitIgnored?: boolean;
}
/**
 * Multi-file context parser
 * Reads files, chunks content, and prioritizes important files
 */
export declare class ContextParser {
    private options;
    constructor(options?: ContextParserOptions);
    /**
     * Parse context from a list of file paths
     */
    parseFromFiles(filePaths: string[]): ContextChunk[];
    /**
     * Parse context from a directory, recursively finding relevant files
     */
    parseFromDirectory(dirPath: string): Promise<ContextChunk[]>;
    /**
     * Recursively walk a directory
     */
    private walkDirectory;
    /**
     * Parse a single string of context text
     */
    parseFromString(text: string, label?: string): ContextChunk[];
    /**
     * Split text into chunks that fit within token limits
     */
    private chunkText;
    /**
     * Prune chunks to fit within token limits, prioritizing by priority
     */
    private pruneToTokenLimit;
    /**
     * Format chunks into a single prompt-ready string
     */
    static formatContext(chunks: ContextChunk[]): string;
}
//# sourceMappingURL=parser.d.ts.map