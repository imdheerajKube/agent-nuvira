/**
 * Diff Viewer — Displays proposed file changes in VS Code's built-in diff editor
 * so users can review agent-suggested modifications before applying them.
 *
 * Features:
 * - Opens VS Code's native diff editor for side-by-side comparison
 * - Creates temporary "proposed" documents for preview
 * - Handles create/modify/delete operations
 * - Groups changes for batch processing
 * - Manages temporary files cleanup
 */
import * as vscode from 'vscode';
import type { FileChange } from './types.js';
export declare class DiffViewer {
    private tempDir;
    private tempFiles;
    constructor(context: vscode.ExtensionContext);
    /**
     * Show diff for all proposed changes in a group.
     * Opens VS Code's diff editor for each file change.
     */
    showChanges(changes: FileChange[]): Promise<void>;
    /**
     * Show a single file change in the diff editor.
     * For created files: shows empty vs proposed
     * For modified files: shows original vs proposed
     * For deleted files: shows original vs empty
     */
    private showSingleDiff;
    /**
     * Apply all accepted changes to the workspace.
     * Returns the number of successfully applied changes.
     */
    applyChanges(changes: FileChange[]): Promise<number>;
    /**
     * Reject all changes (just cleans up temp files).
     */
    rejectChanges(): void;
    /**
     * Create a temporary file for diff preview.
     */
    private createTempFile;
    /**
     * Ensure the temp directory exists.
     */
    private ensureTempDir;
    /**
     * Clean up all temporary files.
     */
    private cleanupTempFiles;
    /**
     * Show a queue of remaining changes with navigation.
     */
    private showChangeQueue;
    /**
     * Dispose temp files on extension deactivation.
     */
    dispose(): void;
}
//# sourceMappingURL=diffViewer.d.ts.map