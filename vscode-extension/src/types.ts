/**
 * Shared types for the Agent-Baba-D VS Code extension.
 */

// ─── CLI Communication ──────────────────────────────────────────────────────

/** A single line of output from the CLI process */
export interface CLILine {
  /** Type of output */
  type: 'stdout' | 'stderr' | 'error';
  /** The text content */
  text: string;
  /** Timestamp */
  timestamp: number;
}

/** Result from a CLI command execution */
export interface CLIResult {
  /** Full stdout content */
  stdout: string;
  /** Full stderr content */
  stderr: string;
  /** Exit code */
  exitCode: number | null;
  /** Whether the command was successful (exit code 0) */
  success: boolean;
  /** Duration in milliseconds */
  durationMs: number;
}

// ─── Agent Task Messages ────────────────────────────────────────────────────

/** Message sent from the extension to the webview panel */
export interface ExtensionMessage {
  type: 'init' | 'progress' | 'result' | 'error' | 'diff' | 'clear' | 'status' | 'config';
  payload?: unknown;
}

/** Message sent from the webview panel to the extension */
export interface WebviewMessage {
  type: 'acceptChanges' | 'rejectChanges' | 'cancelTask' | 'toggleDiff' | 'requestConfig';
  payload?: unknown;
}

/** Progress update for the agent panel */
export interface AgentProgress {
  /** Current phase description (e.g., "Planning", "Writing code...") */
  phase: string;
  /** Progress percentage (0-100), or -1 for indeterminate */
  progress: number;
  /** Optional detail message */
  detail?: string;
  /** Whether this phase is complete */
  completed: boolean;
  /** Log entries for this phase */
  log: string[];
}

/** Final result of an agent task */
export interface AgentResult {
  /** Whether the task was successful */
  success: boolean;
  /** Summary of what was done */
  summary: string;
  /** File changes proposed */
  changes: FileChange[];
  /** Error message if failed */
  error?: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Full output text */
  output: string;
}

/** A proposed file change from an agent */
export interface FileChange {
  /** File path relative to workspace root */
  path: string;
  /** Type of change */
  type: 'created' | 'modified' | 'deleted';
  /** Original content (for modified/deleted files) */
  originalContent?: string;
  /** New content (for created/modified files) */
  newContent?: string;
  /** Whether this change has been applied */
  applied: boolean;
}

// ─── Configuration ──────────────────────────────────────────────────────────

/** Extension configuration from VS Code settings */
export interface ExtensionConfig {
  /** Path to the 'buff' CLI executable */
  cliPath: string;
  /** Default AI provider */
  defaultProvider: string;
  /** Default model */
  defaultModel: string;
  /** Whether to auto-apply changes */
  autoApplyChanges: boolean;
  /** Max tokens for responses */
  maxTokens: number;
  /** Whether to show the progress panel automatically */
  showProgressPanel: boolean;
}
