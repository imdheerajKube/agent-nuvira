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

import { readFile } from 'node:fs/promises';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

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

// ─── Error Analyzer ───────────────────────────────────────────────────────

export class ErrorAnalyzer {
  private patterns: Array<{ regex: RegExp; category: string; description: string; fixes: string[] }> = [
    {
      regex: /cannot find module '([^']+)'/i,
      category: 'module-not-found',
      description: 'Node.js module not found',
      fixes: [
        'Run npm install to install dependencies',
        'Check if the module name is correct',
        'Check if the module is in package.json',
      ],
    },
    {
      regex: /EACCES.*permission denied/i,
      category: 'permission-denied',
      description: 'Permission denied error',
      fixes: [
        'Check file permissions with ls -la',
        'Run with sudo if appropriate',
        'Check if the file is owned by the correct user',
      ],
    },
    {
      regex: /ECONNREFUSED.*(\d+\.\d+\.\d+\.\d+:\d+)/,
      category: 'connection-refused',
      description: 'Connection refused to server',
      fixes: [
        'Check if the server is running',
        'Verify the host and port are correct',
        'Check firewall rules',
      ],
    },
    {
      regex: /ETIMEOUT.*(\d+\.\d+\.\d+\.\d+:\d+)/,
      category: 'connection-timeout',
      description: 'Connection timed out',
      fixes: [
        'Check network connectivity',
        'Increase timeout settings',
        'Check if the server is reachable',
      ],
    },
    {
      regex: /SyntaxError.*Unexpected token/i,
      category: 'syntax-error',
      description: 'JavaScript/TypeScript syntax error',
      fixes: [
        'Check the line number in the error',
        'Look for missing brackets, semicolons, or quotes',
        'Use a linter to find syntax issues',
      ],
    },
    {
      regex: /TypeError.*Cannot read propert(y|ies) of (undefined|null)/i,
      category: 'null-reference',
      description: 'Attempting to access property of undefined/null',
      fixes: [
        'Add null/undefined checks before accessing properties',
        'Use optional chaining (?.)',
        'Verify the variable is initialized',
      ],
    },
    {
      regex: /ENOSPC.*no space left on device/i,
      category: 'disk-full',
      description: 'Disk space exhausted',
      fixes: [
        'Free up disk space',
        'Check for large log files',
        'Run docker system prune if Docker is used',
      ],
    },
    {
      regex: /EADDRINUSE.*port (\d+)/i,
      category: 'port-in-use',
      description: 'Port already in use',
      fixes: [
        'Kill the process using the port',
        'Use a different port',
        'Check for zombie processes',
      ],
    },
  ];

  /**
   * Analyze an error and provide debugging insights.
   */
  analyze(context: DebugContext): DebugAnalysis {
    const { errorMessage, stackTrace, command, output } = context;

    // Try to match known patterns
    for (const pattern of this.patterns) {
      const match = errorMessage.match(pattern.regex);
      if (match) {
        return {
          category: pattern.category,
          confidence: 0.8,
          description: pattern.description,
          fixes: pattern.fixes,
          relatedFiles: this.extractFilesFromStack(stackTrace),
          prevention: this.getPreventionTips(pattern.category),
        };
      }
    }

    // Generic analysis
    return {
      category: 'unknown',
      confidence: 0.3,
      description: `Error: ${errorMessage.slice(0, 200)}`,
      fixes: ['Check the error message for clues', 'Search for the error online', 'Review recent changes'],
      relatedFiles: this.extractFilesFromStack(stackTrace),
      prevention: ['Add error handling', 'Write tests', 'Use TypeScript for type safety'],
    };
  }

  /**
   * Parse and beautify a stack trace.
   */
  parseStackTrace(stackTrace: string): Array<{ file: string; line: number; column: number; function: string }> {
    const frames: Array<{ file: string; line: number; column: number; function: string }> = [];
    const lines = stackTrace.split('\n');

    for (const line of lines) {
      // Node.js style: at functionName (filepath:line:column)
      const nodeMatch = line.match(/at\s+(.+?)\s+\((.+):(\d+):(\d+)\)/);
      if (nodeMatch) {
        frames.push({
          function: nodeMatch[1],
          file: nodeMatch[2],
          line: parseInt(nodeMatch[3]),
          column: parseInt(nodeMatch[4]),
        });
        continue;
      }

      // Browser style: at filepath:line:column
      const browserMatch = line.match(/at\s+(.+):(\d+):(\d+)/);
      if (browserMatch) {
        frames.push({
          function: '<anonymous>',
          file: browserMatch[1],
          line: parseInt(browserMatch[2]),
          column: parseInt(browserMatch[3]),
        });
      }
    }

    return frames;
  }

  private extractFilesFromStack(stackTrace?: string): string[] {
    if (!stackTrace) return [];
    const files: string[] = [];
    const matches = stackTrace.matchAll(/(?:at\s+.+\s+\(|at\s+)([^:]+):\d+/g);
    for (const match of matches) {
      const file = match[1];
      if (file && !file.startsWith('node:') && !file.includes('node_modules')) {
        files.push(file);
      }
    }
    return [...new Set(files)];
  }

  private getPreventionTips(category: string): string[] {
    const tips: Record<string, string[]> = {
      'module-not-found': ['Use npm install regularly', 'Pin dependency versions'],
      'permission-denied': ['Use appropriate file permissions', 'Avoid running as root'],
      'connection-refused': ['Add health checks', 'Implement retry logic'],
      'syntax-error': ['Use TypeScript', 'Enable strict mode', 'Run linter in CI'],
      'null-reference': ['Use optional chaining', 'Add null checks', 'Use TypeScript strict mode'],
      'disk-full': ['Monitor disk usage', 'Set up log rotation', 'Clean up Docker resources'],
      'port-in-use': ['Use dynamic port allocation', 'Kill zombie processes'],
    };
    return tips[category] || ['Add error handling', 'Write tests'];
  }
}

// ─── Terminal Hints ───────────────────────────────────────────────────────

export class TerminalHints {
  private hints: Array<{ pattern: RegExp; suggestion: string; explanation: string }> = [
    { pattern: /^git staus$/, suggestion: 'git status', explanation: 'Typo: "staus" → "status"' },
    { pattern: /^git comit$/, suggestion: 'git commit', explanation: 'Typo: "comit" → "commit"' },
    { pattern: /^git push -u origin (\w+)$/, suggestion: 'git push -u origin $1', explanation: 'Normal push with upstream' },
    { pattern: /^npm isntall$/, suggestion: 'npm install', explanation: 'Typo: "isntall" → "install"' },
    { pattern: /^npm run dev$/, suggestion: 'npm run dev', explanation: 'Start development server' },
    { pattern: /^docker buid$/, suggestion: 'docker build', explanation: 'Typo: "buid" → "build"' },
    { pattern: /^docker ps -a$/, suggestion: 'docker ps -a', explanation: 'List all containers including stopped' },
    { pattern: /^ls -la$/, suggestion: 'ls -la', explanation: 'List all files with details' },
    { pattern: /^cat (.+)$/, suggestion: 'cat $1 | head -50', explanation: 'Preview first 50 lines to avoid flooding terminal' },
    { pattern: /^grep (.+) \*$/, suggestion: 'grep -r $1 .', explanation: 'Use -r for recursive search in current directory' },
    { pattern: /^find . -name$/, suggestion: 'find . -name "pattern"', explanation: 'Provide a pattern for find command' },
    { pattern: /^chmod 777$/, suggestion: 'chmod 755', explanation: '777 is too permissive; 755 is safer for executables' },
    { pattern: /^rm -rf$/, suggestion: 'rm -rf (be careful!)', explanation: 'Destructive command - double check the target' },
  ];

  /**
   * Get hints for a command.
   */
  getHint(command: string): TerminalHint | null {
    const trimmed = command.trim();

    for (const hint of this.hints) {
      if (hint.pattern.test(trimmed)) {
        return {
          command: trimmed,
          suggestion: trimmed.replace(hint.pattern, hint.suggestion),
          explanation: hint.explanation,
          confidence: 0.9,
        };
      }
    }

    return null;
  }

  /**
   * Suggest corrections for a failed command.
   */
  suggestCorrection(command: string, errorOutput: string): TerminalHint[] {
    const hints: TerminalHint[] = [];

    // Command not found
    if (errorOutput.includes('command not found') || errorOutput.includes('not found')) {
      hints.push({
        command,
        suggestion: `Check if '${command.split(' ')[0]}' is installed`,
        explanation: 'The command was not found in PATH',
        confidence: 0.7,
      });
    }

    // Permission denied
    if (errorOutput.includes('Permission denied')) {
      hints.push({
        command,
        suggestion: `sudo ${command}`,
        explanation: 'Try running with elevated privileges',
        confidence: 0.6,
      });
    }

    // No such file
    if (errorOutput.includes('No such file or directory')) {
      const fileMatch = command.match(/(?:cat|less|more|vim|nano|code)\s+(.+)/);
      if (fileMatch) {
        hints.push({
          command,
          suggestion: `ls -la ${fileMatch[1]}`,
          explanation: 'Check if the file exists',
          confidence: 0.8,
        });
      }
    }

    return hints;
  }
}

// ─── Hook Output Handler ──────────────────────────────────────────────────

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

export class HookOutputHandler {
  private outputs: HookOutput[] = [];

  /**
   * Capture hook output.
   */
  capture(name: string, output: string, exitCode: number, durationMs: number): HookOutput {
    const hookOutput: HookOutput = {
      name,
      output,
      exitCode,
      durationMs,
      timestamp: Date.now(),
    };
    this.outputs.push(hookOutput);
    return hookOutput;
  }

  /**
   * Get all captured outputs.
   */
  getOutputs(): HookOutput[] {
    return [...this.outputs];
  }

  /**
   * Get outputs for a specific hook.
   */
  getOutputsForHook(name: string): HookOutput[] {
    return this.outputs.filter((o) => o.name === name);
  }

  /**
   * Get failed outputs.
   */
  getFailedOutputs(): HookOutput[] {
    return this.outputs.filter((o) => o.exitCode !== 0);
  }

  /**
   * Clear outputs.
   */
  clear(): void {
    this.outputs = [];
  }
}

// ─── Singletons ───────────────────────────────────────────────────────────

let _errorAnalyzer: ErrorAnalyzer | null = null;
let _terminalHints: TerminalHints | null = null;
let _hookOutputHandler: HookOutputHandler | null = null;

export function getErrorAnalyzer(): ErrorAnalyzer {
  if (!_errorAnalyzer) _errorAnalyzer = new ErrorAnalyzer();
  return _errorAnalyzer;
}

export function getTerminalHints(): TerminalHints {
  if (!_terminalHints) _terminalHints = new TerminalHints();
  return _terminalHints;
}

export function getHookOutputHandler(): HookOutputHandler {
  if (!_hookOutputHandler) _hookOutputHandler = new HookOutputHandler();
  return _hookOutputHandler;
}
