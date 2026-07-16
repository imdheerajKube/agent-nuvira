"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiffViewer = void 0;
const vscode = __importStar(require("vscode"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
// ─── DiffViewer ─────────────────────────────────────────────────────────────
class DiffViewer {
    tempDir;
    tempFiles = [];
    constructor(context) {
        // Use extension's global storage path for temp files
        this.tempDir = (0, node_path_1.join)(context.globalStorageUri.fsPath, 'proposed-changes');
        this.ensureTempDir();
    }
    /**
     * Show diff for all proposed changes in a group.
     * Opens VS Code's diff editor for each file change.
     */
    async showChanges(changes) {
        if (changes.length === 0) {
            vscode.window.showInformationMessage('No changes to preview.');
            return;
        }
        // Show first change immediately
        const first = changes[0];
        await this.showSingleDiff(first);
        // Queue remaining changes (user can navigate via "Next" buttons)
        if (changes.length > 1) {
            this.showChangeQueue(changes.slice(1));
        }
    }
    /**
     * Show a single file change in the diff editor.
     * For created files: shows empty vs proposed
     * For modified files: shows original vs proposed
     * For deleted files: shows original vs empty
     */
    async showSingleDiff(change) {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }
        const originalPath = (0, node_path_1.join)(workspaceRoot, change.path);
        switch (change.type) {
            case 'created': {
                // Show empty file vs new content
                const proposedUri = await this.createTempFile(change.path, change.newContent || '');
                const emptyUri = vscode.Uri.parse(`untitled:${change.path}`);
                await vscode.commands.executeCommand('vscode.diff', emptyUri, proposedUri, `${change.path} (created)`);
                break;
            }
            case 'modified': {
                // Show original vs proposed
                const proposedUri = await this.createTempFile(change.path, change.newContent || '');
                // Check if original exists
                if ((0, node_fs_1.existsSync)(originalPath)) {
                    const originalUri = vscode.Uri.file(originalPath);
                    await vscode.commands.executeCommand('vscode.diff', originalUri, proposedUri, `${change.path} (proposed changes)`);
                }
                else {
                    // Original doesn't exist, show warning
                    vscode.window.showWarningMessage(`Original file not found: ${change.path}. Showing proposed content only.`);
                    await vscode.commands.executeCommand('vscode.open', proposedUri);
                }
                break;
            }
            case 'deleted': {
                // Show original vs empty
                if ((0, node_fs_1.existsSync)(originalPath)) {
                    const originalUri = vscode.Uri.file(originalPath);
                    const emptyUri = await this.createTempFile(change.path.replace(/\.\w+$/, '-removed$&'), '');
                    await vscode.commands.executeCommand('vscode.diff', originalUri, emptyUri, `${change.path} (deleted)`);
                }
                else {
                    vscode.window.showWarningMessage(`File already deleted: ${change.path}`);
                }
                break;
            }
        }
    }
    /**
     * Apply all accepted changes to the workspace.
     * Returns the number of successfully applied changes.
     */
    async applyChanges(changes) {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return 0;
        }
        let applied = 0;
        for (const change of changes) {
            const fullPath = (0, node_path_1.join)(workspaceRoot, change.path);
            try {
                switch (change.type) {
                    case 'created': {
                        // Create the file with new content
                        const dir = (0, node_path_1.dirname)(fullPath);
                        if (!(0, node_fs_1.existsSync)(dir)) {
                            (0, node_fs_1.mkdirSync)(dir, { recursive: true });
                        }
                        (0, node_fs_1.writeFileSync)(fullPath, change.newContent || '', 'utf-8');
                        change.applied = true;
                        applied++;
                        break;
                    }
                    case 'modified': {
                        // Overwrite the file with new content
                        if ((0, node_fs_1.existsSync)(fullPath)) {
                            (0, node_fs_1.writeFileSync)(fullPath, change.newContent || '', 'utf-8');
                            change.applied = true;
                            applied++;
                        }
                        break;
                    }
                    case 'deleted': {
                        // Delete the file
                        if ((0, node_fs_1.existsSync)(fullPath)) {
                            (0, node_fs_1.unlinkSync)(fullPath);
                            change.applied = true;
                            applied++;
                        }
                        break;
                    }
                }
            }
            catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Failed to apply change to ${change.path}: ${errorMsg}`);
            }
        }
        // Refresh the VS Code workspace to show changes
        if (applied > 0) {
            // Reload the affected files in the editor
            for (const change of changes) {
                if (change.applied && (change.type === 'created' || change.type === 'modified')) {
                    const fullPath = (0, node_path_1.join)(workspaceRoot, change.path);
                    const uri = vscode.Uri.file(fullPath);
                    // If the file is open in an editor, reload it
                    const visibleEditors = vscode.window.visibleTextEditors;
                    for (const editor of visibleEditors) {
                        if (editor.document.uri.fsPath === fullPath) {
                            // Show information that file was updated
                            void vscode.window.showTextDocument(editor.document, { preview: false });
                            break;
                        }
                    }
                }
            }
            vscode.window.showInformationMessage(`Applied ${applied} change${applied !== 1 ? 's' : ''}.`);
        }
        // Clean up temp files
        this.cleanupTempFiles();
        return applied;
    }
    /**
     * Reject all changes (just cleans up temp files).
     */
    rejectChanges() {
        this.cleanupTempFiles();
        vscode.window.showInformationMessage('All changes rejected.');
    }
    /**
     * Create a temporary file for diff preview.
     */
    async createTempFile(relativePath, content) {
        this.ensureTempDir();
        // Create a unique temp filename to avoid collisions
        const safeName = relativePath.replace(/[/\\]/g, '_');
        const tempPath = (0, node_path_1.join)(this.tempDir, `proposed-${safeName}`);
        const dir = (0, node_path_1.dirname)(tempPath);
        if (!(0, node_fs_1.existsSync)(dir)) {
            (0, node_fs_1.mkdirSync)(dir, { recursive: true });
        }
        (0, node_fs_1.writeFileSync)(tempPath, content, 'utf-8');
        this.tempFiles.push(tempPath);
        return vscode.Uri.file(tempPath);
    }
    /**
     * Ensure the temp directory exists.
     */
    ensureTempDir() {
        if (!(0, node_fs_1.existsSync)(this.tempDir)) {
            (0, node_fs_1.mkdirSync)(this.tempDir, { recursive: true });
        }
    }
    /**
     * Clean up all temporary files.
     */
    cleanupTempFiles() {
        for (const filePath of this.tempFiles) {
            try {
                if ((0, node_fs_1.existsSync)(filePath)) {
                    (0, node_fs_1.unlinkSync)(filePath);
                }
            }
            catch {
                // Non-critical cleanup
            }
        }
        this.tempFiles = [];
        // Try to clean up the temp directory if empty
        try {
            if ((0, node_fs_1.existsSync)(this.tempDir)) {
                const remaining = (0, node_fs_1.readdirSync)(this.tempDir);
                if (remaining.length === 0) {
                    (0, node_fs_1.rmdirSync)(this.tempDir);
                }
            }
        }
        catch {
            // Non-critical
        }
    }
    /**
     * Show a queue of remaining changes with navigation.
     */
    showChangeQueue(changes) {
        if (changes.length === 0)
            return;
        // Show quick pick with remaining changes
        const items = changes.map((c, i) => ({
            label: `${c.type === 'created' ? '📄' : c.type === 'modified' ? '✏️' : '🗑️'} ${c.path}`,
            description: c.type,
            detail: `Change ${i + 2} of ${changes.length + 1}`,
            change: c,
        }));
        vscode.window.showQuickPick(items, {
            placeHolder: `More changes available (${changes.length} remaining). Select to preview:`,
        }).then((selected) => {
            if (selected) {
                this.showSingleDiff(selected.change);
            }
        });
    }
    /**
     * Dispose temp files on extension deactivation.
     */
    dispose() {
        this.cleanupTempFiles();
    }
}
exports.DiffViewer = DiffViewer;
//# sourceMappingURL=diffViewer.js.map