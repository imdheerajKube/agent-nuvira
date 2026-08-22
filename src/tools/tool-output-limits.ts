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

class ToolOutputLimiter {
  private globalConfig: OutputLimitConfig = {
    maxChars: 50_000,
    maxLines: 2000,
    truncateStrategy: 'tail',
    addTruncationNotice: true,
  };

  private perToolConfigs = new Map<string, OutputLimitConfig>();

  /**
   * Set global output limit config.
   */
  setGlobalConfig(config: Partial<OutputLimitConfig>): void {
    this.globalConfig = { ...this.globalConfig, ...config };
  }

  /**
   * Set output limit for a specific tool.
   */
  setToolConfig(toolName: string, config: Partial<OutputLimitConfig>): void {
    this.perToolConfigs.set(toolName, {
      ...this.globalConfig,
      ...config,
    });
  }

  /**
   * Get the effective config for a tool.
   */
  getConfig(toolName?: string): OutputLimitConfig {
    if (toolName && this.perToolConfigs.has(toolName)) {
      return this.perToolConfigs.get(toolName)!;
    }
    return this.globalConfig;
  }

  /**
   * Truncate output according to limits.
   */
  truncate(output: string, toolName?: string): TruncationResult {
    const config = this.getConfig(toolName);
    const originalSize = output.length;
    const originalLines = output.split('\n').length;

    // Check if truncation is needed
    if (output.length <= config.maxChars && originalLines <= config.maxLines) {
      return {
        content: output,
        truncated: false,
        originalSize,
        finalSize: originalSize,
        linesRemoved: 0,
      };
    }

    let result: string;
    const lines = output.split('\n');

    switch (config.truncateStrategy) {
      case 'tail': {
        // Keep last N lines/chars
        if (lines.length > config.maxLines) {
          const removed = lines.length - config.maxLines;
          result = lines.slice(-config.maxLines).join('\n');
          if (config.addTruncationNotice) {
            result = `\n[... ${removed} lines truncated — showing last ${config.maxLines}]\n\n${result}`;
          }
        } else {
          result = output.slice(-config.maxChars);
          if (config.addTruncationNotice) {
            const removed = originalSize - config.maxChars;
            result = `\n[... ${removed} chars truncated — showing last ${config.maxChars}]\n\n${result}`;
          }
        }
        break;
      }

      case 'head': {
        if (lines.length > config.maxLines) {
          const removed = lines.length - config.maxLines;
          result = lines.slice(0, config.maxLines).join('\n');
          if (config.addTruncationNotice) {
            result += `\n\n[... ${removed} lines truncated — showing first ${config.maxLines}]`;
          }
        } else {
          result = output.slice(0, config.maxChars);
          if (config.addTruncationNotice) {
            const removed = originalSize - config.maxChars;
            result += `\n\n[... ${removed} chars truncated — showing first ${config.maxChars}]`;
          }
        }
        break;
      }

      case 'middle': {
        if (lines.length > config.maxLines) {
          const half = Math.floor(config.maxLines / 2);
          const top = lines.slice(0, half);
          const bottom = lines.slice(-half);
          const removed = lines.length - config.maxLines;
          result = top.join('\n');
          if (config.addTruncationNotice) {
            result += `\n\n[... ${removed} lines truncated ...]\n\n`;
          }
          result += bottom.join('\n');
        } else {
          const half = Math.floor(config.maxChars / 2);
          const top = output.slice(0, half);
          const bottom = output.slice(-half);
          const removed = originalSize - config.maxChars;
          result = top;
          if (config.addTruncationNotice) {
            result += `\n\n[... ${removed} chars truncated ...]\n\n`;
          }
          result += bottom;
        }
        break;
      }

      case 'summarize':
      default: {
        // Default to tail
        if (lines.length > config.maxLines) {
          const removed = lines.length - config.maxLines;
          result = lines.slice(-config.maxLines).join('\n');
          if (config.addTruncationNotice) {
            result = `\n[... ${removed} lines truncated — showing last ${config.maxLines}]\n\n${result}`;
          }
        } else {
          result = output.slice(-config.maxChars);
        }
        break;
      }
    }

    const finalLines = result.split('\n').length;
    return {
      content: result,
      truncated: true,
      originalSize,
      finalSize: result.length,
      linesRemoved: originalLines - finalLines,
    };
  }

  /**
   * Get stats for all tool configs.
   */
  getStats(): { globalMaxChars: number; globalMaxLines: number; perToolConfigs: number; tools: string[] } {
    return {
      globalMaxChars: this.globalConfig.maxChars,
      globalMaxLines: this.globalConfig.maxLines,
      perToolConfigs: this.perToolConfigs.size,
      tools: Array.from(this.perToolConfigs.keys()),
    };
  }
}

let _instance: ToolOutputLimiter | null = null;

export function getToolOutputLimiter(): ToolOutputLimiter {
  if (!_instance) _instance = new ToolOutputLimiter();
  return _instance;
}

export { ToolOutputLimiter };
