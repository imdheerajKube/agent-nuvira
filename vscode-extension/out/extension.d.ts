/**
 * Agent-Baba-D VS Code Extension — Main Entry Point
 *
 * This extension brings Agent-Baba-D's multi-agent AI capabilities
 * directly into the VS Code editor, allowing users to:
 * - Execute multi-agent goals (plan, write, review, test)
 * - Quick fix files with AI
 * - Review and explain code
 * - Generate unit tests
 * - Run workflow templates
 * - Preview and apply proposed changes via diff viewer
 *
 * Architecture:
 * - CLI Backend: The existing agent-baba-d CLI is spawned as a child process
 * - Webview Panel: Real-time agent progress and results
 * - Command Palette: All agent operations accessible via commands
 * - Context Menus: Right-click on files/editors for quick actions
 * - Keybindings: Ctrl+Shift+A prefix for all agent commands
 * - Diff Viewer: VS Code's native diff editor for reviewing changes
 */
import * as vscode from 'vscode';
/**
 * Called when the extension is activated (first command is run).
 */
export declare function activate(context: vscode.ExtensionContext): void;
/**
 * Called when the extension is deactivated.
 * Clean up all resources.
 */
export declare function deactivate(): void;
//# sourceMappingURL=extension.d.ts.map