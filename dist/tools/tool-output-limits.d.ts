/**
 * tool_output_limits — Manages output size limits for tool calls.
 * Truncates, summarizes, or paginates large outputs to stay within LLM context windows.
 */
interface OutputLimitConfig {
    maxChars: number;
    maxLines: number;
    truncateStrategy: 'tail' | 'head' | 'middle' | 'summarize';
    addTruncationNotice: boolean;
}
interface TruncationResult {
    content: string;
    truncated: boolean;
    originalSize: number;
    finalSize: number;
    linesRemoved: number;
}
declare class ToolOutputLimiter {
    private globalConfig;
    private perToolConfigs;
    /**
     * Set global output limit config.
     */
    setGlobalConfig(config: Partial<OutputLimitConfig>): void;
    /**
     * Set output limit for a specific tool.
     */
    setToolConfig(toolName: string, config: Partial<OutputLimitConfig>): void;
    /**
     * Get the effective config for a tool.
     */
    getConfig(toolName?: string): OutputLimitConfig;
    /**
     * Truncate output according to limits.
     */
    truncate(output: string, toolName?: string): TruncationResult;
    /**
     * Get stats for all tool configs.
     */
    getStats(): {
        globalMaxChars: number;
        globalMaxLines: number;
        perToolConfigs: number;
        tools: string[];
    };
}
export declare function getToolOutputLimiter(): ToolOutputLimiter;
export { ToolOutputLimiter };
//# sourceMappingURL=tool-output-limits.d.ts.map