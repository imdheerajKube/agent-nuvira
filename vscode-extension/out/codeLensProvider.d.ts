/**
 * Code Lens Provider — Adds interactive actions above functions/classes in the
 * editor. Clicking the lens opens a quick pick menu with 4 agent actions:
 * Test, Review, Explain, and Quick Fix.
 *
 * Supports: TypeScript, JavaScript, Python, Go, Rust, Java
 */
import * as vscode from 'vscode';
import { CLIManager } from './cliManager.js';
export declare class CodeLensProvider implements vscode.CodeLensProvider {
    static readonly lensCommandId = "agent-nuvira.codeLensAction";
    private cliManager;
    constructor(cliManager: CLIManager);
    provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.CodeLens[];
    /**
     * Handle code lens click — shows quick pick menu with 4 actions.
     */
    handleLensClick(uri: vscode.Uri, name: string, language: string, line: number, bodyRange: vscode.Range | null): Promise<void>;
    /**
     * Execute a CLI action with progress and error handling.
     */
    private executeLensAction;
    /**
     * Find function/class body range via brace counting.
     */
    private findBody;
    private getConfig;
}
//# sourceMappingURL=codeLensProvider.d.ts.map