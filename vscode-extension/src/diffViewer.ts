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
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import type { FileChange } from './types.js';

// ─── DiffViewer ─────────────────────────────────────────────────────────────

export class DiffViewer {
  private tempDir: string;
  private tempFiles: string[] = [];

  constructor(context: vscode.ExtensionContext) {
    // Use extension's global storage path for temp files
    this.tempDir = join(context.globalStorageUri.fsPath, 'proposed-changes');
    this.ensureTempDir();
  }

  /**
   * Show diff for all proposed changes in a group.
   * Opens VS Code's diff editor for each file change.
   */
  async showChanges(changes: FileChange[]): Promise<void> {
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
  private async showSingleDiff(change: FileChange): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }

    const originalPath = join(workspaceRoot, change.path);

    switch (change.type) {
      case 'created': {
        // Show empty file vs new content
        const proposedUri = await this.createTempFile(change.path, change.newContent || '');
        const emptyUri = vscode.Uri.parse(`untitled:${change.path}`);

        await vscode.commands.executeCommand(
          'vscode.diff',
          emptyUri,
          proposedUri,
          `${change.path} (created)`,
        );
        break;
      }

      case 'modified': {
        // Show original vs proposed
        const proposedUri = await this.createTempFile(change.path, change.newContent || '');

        // Check if original exists
        if (existsSync(originalPath)) {
          const originalUri = vscode.Uri.file(originalPath);

          await vscode.commands.executeCommand(
            'vscode.diff',
            originalUri,
            proposedUri,
            `${change.path} (proposed changes)`,
          );
        } else {
          // Original doesn't exist, show warning
          vscode.window.showWarningMessage(
            `Original file not found: ${change.path}. Showing proposed content only.`,
          );
          await vscode.commands.executeCommand('vscode.open', proposedUri);
        }
        break;
      }

      case 'deleted': {
        // Show original vs empty
        if (existsSync(originalPath)) {
          const originalUri = vscode.Uri.file(originalPath);
          const emptyUri = await this.createTempFile(
            change.path.replace(/\.\w+$/, '-removed$&'),
            '',
          );

          await vscode.commands.executeCommand(
            'vscode.diff',
            originalUri,
            emptyUri,
            `${change.path} (deleted)`,
          );
        } else {
          vscode.window.showWarningMessage(
            `File already deleted: ${change.path}`,
          );
        }
        break;
      }
    }
  }

  /**
   * Apply all accepted changes to the workspace.
   * Returns the number of successfully applied changes.
   */
  async applyChanges(changes: FileChange[]): Promise<number> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return 0;
    }

    let applied = 0;

    for (const change of changes) {
      const fullPath = join(workspaceRoot, change.path);

      try {
        switch (change.type) {
          case 'created': {
            // Create the file with new content
            const dir = dirname(fullPath);
            if (!existsSync(dir)) {
              mkdirSync(dir, { recursive: true });
            }
            writeFileSync(fullPath, change.newContent || '', 'utf-8');
            change.applied = true;
            applied++;
            break;
          }

          case 'modified': {
            // Overwrite the file with new content
            if (existsSync(fullPath)) {
              writeFileSync(fullPath, change.newContent || '', 'utf-8');
              change.applied = true;
              applied++;
            }
            break;
          }

          case 'deleted': {
            // Delete the file
            if (existsSync(fullPath)) {
              unlinkSync(fullPath);
              change.applied = true;
              applied++;
            }
            break;
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to apply change to ${change.path}: ${errorMsg}`);
      }
    }

    // Refresh the VS Code workspace to show changes
    if (applied > 0) {
      // Reload the affected files in the editor
      for (const change of changes) {
        if (change.applied && (change.type === 'created' || change.type === 'modified')) {
          const fullPath = join(workspaceRoot, change.path);
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

      vscode.window.showInformationMessage(
        `Applied ${applied} change${applied !== 1 ? 's' : ''}.`,
      );
    }

    // Clean up temp files
    this.cleanupTempFiles();

    return applied;
  }

  /**
   * Reject all changes (just cleans up temp files).
   */
  rejectChanges(): void {
    this.cleanupTempFiles();
    vscode.window.showInformationMessage('All changes rejected.');
  }

  /**
   * Create a temporary file for diff preview.
   */
  private async createTempFile(relativePath: string, content: string): Promise<vscode.Uri> {
    this.ensureTempDir();

    // Create a unique temp filename to avoid collisions
    const safeName = relativePath.replace(/[/\\]/g, '_');
    const tempPath = join(this.tempDir, `proposed-${safeName}`);
    const dir = dirname(tempPath);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(tempPath, content, 'utf-8');
    this.tempFiles.push(tempPath);

    return vscode.Uri.file(tempPath);
  }

  /**
   * Ensure the temp directory exists.
   */
  private ensureTempDir(): void {
    if (!existsSync(this.tempDir)) {
      mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Clean up all temporary files.
   */
  private cleanupTempFiles(): void {
    for (const filePath of this.tempFiles) {
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
      } catch {
        // Non-critical cleanup
      }
    }
    this.tempFiles = [];

    // Try to clean up the temp directory if empty
    try {
      if (existsSync(this.tempDir)) {
        const remaining = readdirSync(this.tempDir);
        if (remaining.length === 0) {
          rmdirSync(this.tempDir);
        }
      }
    } catch {
      // Non-critical
    }
  }

  /**
   * Show a queue of remaining changes with navigation.
   */
  private showChangeQueue(changes: FileChange[]): void {
    if (changes.length === 0) return;

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
  dispose(): void {
    this.cleanupTempFiles();
  }
}
