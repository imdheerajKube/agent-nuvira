/**
 * Debug Helpers — Debugging utilities for code analysis and troubleshooting.
 *
 * Hermes equivalent: debug_helpers.py + terminal_hints.py + hook_output_spill.py
 *
 * Provides:
 * - Error analysis and root cause detection
 * - Stack trace parsing and beautification
 * - Terminal command hints and suggestions
 * - Hook output capture and analysis
 * - Performance bottleneck detection
 */
export interface DebugContext {
    /** Error message */
    errorMessage: string;
    /** Stack trace */
    stackTrace?: string;
    /** Source file path */
    sourceFile?: string;
    /** Line number */
    lineNumber?: number;
    /** Command that failed */
    command?: string;
    /** Command output */
    output?: string;
}
export interface DebugAnalysis {
    /** Root cause category */
    category: string;
    /** Confidence score (0-1) */
    confidence: number;
    /** Description of the issue */
    description: string;
    /** Suggested fixes */
    fixes: string[];
    /** Related files */
    relatedFiles: string[];
    /** Prevention tips */
    prevention: string[];
}
export interface TerminalHint {
    /** The command the user tried */
    command: string;
    /** Suggested correction */
    suggestion: string;
    /** Explanation */
    explanation: string;
    /** Confidence */
    confidence: number;
}
export declare class ErrorAnalyzer {
    private patterns;
    /**
     * Analyze an error and provide debugging insights.
     */
    analyze(context: DebugContext): DebugAnalysis;
    /**
     * Parse and beautify a stack trace.
     */
    parseStackTrace(stackTrace: string): Array<{
        file: string;
        line: number;
        column: number;
        function: string;
    }>;
    private extractFilesFromStack;
    private getPreventionTips;
}
export declare class TerminalHints {
    private hints;
    /**
     * Get hints for a command.
     */
    getHint(command: string): TerminalHint | null;
    /**
     * Suggest corrections for a failed command.
     */
    suggestCorrection(command: string, errorOutput: string): TerminalHint[];
}
export interface HookOutput {
    /** Hook name */
    name: string;
    /** Hook output */
    output: string;
    /** Exit code */
    exitCode: number;
    /** Duration in ms */
    durationMs: number;
    /** Timestamp */
    timestamp: number;
}
export declare class HookOutputHandler {
    private outputs;
    /**
     * Capture hook output.
     */
    capture(name: string, output: string, exitCode: number, durationMs: number): HookOutput;
    /**
     * Get all captured outputs.
     */
    getOutputs(): HookOutput[];
    /**
     * Get outputs for a specific hook.
     */
    getOutputsForHook(name: string): HookOutput[];
    /**
     * Get failed outputs.
     */
    getFailedOutputs(): HookOutput[];
    /**
     * Clear outputs.
     */
    clear(): void;
}
export declare function getErrorAnalyzer(): ErrorAnalyzer;
export declare function getTerminalHints(): TerminalHints;
export declare function getHookOutputHandler(): HookOutputHandler;
//# sourceMappingURL=debug-helpers.d.ts.map