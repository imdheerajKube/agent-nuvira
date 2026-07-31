"use strict";
/**
 * Code Lens Provider — Adds interactive actions above functions/classes in the
 * editor. Clicking the lens opens a quick pick menu with 4 agent actions:
 * Test, Review, Explain, and Quick Fix.
 *
 * Supports: TypeScript, JavaScript, Python, Go, Rust, Java
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
exports.CodeLensProvider = void 0;
const vscode = __importStar(require("vscode"));
const CONFIGS = {
    typescript: {
        patterns: [
            /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m,
            /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m,
            /^(?:export\s+)?interface\s+(\w+)/m,
            /^(?:export\s+)?type\s+(\w+)\s*=/m,
            /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:async\s+)?(\w+)\s*\(/m,
        ],
        comment: '//',
    },
    javascript: {
        patterns: [
            /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m,
            /^(?:export\s+)?class\s+(\w+)/m,
        ],
        comment: '//',
    },
    python: {
        patterns: [
            /^(?:async\s+)?def\s+(\w+)/m,
            /^class\s+(\w+)/m,
        ],
        comment: '#',
    },
    go: {
        patterns: [
            /^func\s+(?:\w+\s+)?(\w+)/m,
            /^type\s+(\w+)\s+struct/m,
        ],
        comment: '//',
    },
    rust: {
        patterns: [
            /^fn\s+(\w+)/m,
            /^(?:pub\s+)?(?:struct|enum|trait|impl)\s+(\w+)/m,
        ],
        comment: '//',
    },
    java: {
        patterns: [
            /^(?:public|private|protected)\s+(?:static\s+)?(?:\w+)\s+(\w+)\s*\(/m,
            /^class\s+(\w+)/m,
        ],
        comment: '//',
    },
};
// ─── CodeLensProvider ───────────────────────────────────────────────────────
class CodeLensProvider {
    static lensCommandId = 'agent-nuvira.codeLensAction';
    cliManager;
    constructor(cliManager) {
        this.cliManager = cliManager;
    }
    provideCodeLenses(document, _token) {
        const config = this.getConfig(document.languageId);
        if (!config)
            return [];
        const lenses = [];
        const lines = document.getText().split('\n');
        for (let i = 0; i < lines.length; i++) {
            for (const pattern of config.patterns) {
                const match = lines[i].match(pattern);
                if (match) {
                    const name = match[1] || 'anonymous';
                    const range = new vscode.Range(i, 0, i, lines[i].length);
                    const bodyRange = this.findBody(lines, i, config);
                    const lens = new vscode.CodeLens(range, {
                        title: `$(sparkle) AI: ${name}`,
                        command: CodeLensProvider.lensCommandId,
                        arguments: [document.uri, name, document.languageId, i, bodyRange],
                    });
                    lenses.push(lens);
                    break;
                }
            }
        }
        return lenses;
    }
    /**
     * Handle code lens click — shows quick pick menu with 4 actions.
     */
    async handleLensClick(uri, name, language, line, bodyRange) {
        const action = await vscode.window.showQuickPick([
            { label: '$(beaker) Generate Test', description: `Generate unit tests for ${name}`, id: 'test' },
            { label: '$(search) Review Code', description: `Review ${name} for bugs and improvements`, id: 'review' },
            { label: '$(lightbulb) Explain', description: `Explain ${name} in detail`, id: 'explain' },
            { label: '$(tools) Quick Fix', description: `Fix issues in ${name}`, id: 'fix' },
        ], { placeHolder: `AI actions for ${name}:` });
        if (!action)
            return;
        // Read the document to get the code context
        let code;
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            code = doc.getText();
        }
        catch {
            vscode.window.showErrorMessage('Could not read file.');
            return;
        }
        // Extract relevant code section
        const relevantCode = bodyRange
            ? code.split('\n').slice(bodyRange.start.line, Math.min(bodyRange.end.line + 1, 500)).join('\n')
            : `// ${name} at line ${line + 1}`;
        switch (action.id) {
            case 'test':
                await this.executeLensAction('Generating tests', `Generate comprehensive unit tests for the following ${language} code. Include edge cases and describe what each test verifies.\n\n\`\`\`${language}\n${relevantCode}\n\`\`\``, language);
                break;
            case 'review':
                await this.executeLensAction('Reviewing code', `Review the following ${language} code. Check for bugs, security vulnerabilities, performance issues, and style problems. Provide a structured report.\n\n\`\`\`${language}\n${relevantCode}\n\`\`\``, 'markdown');
                break;
            case 'explain':
                await this.executeLensAction('Explaining code', `Explain the following ${language} code in detail. Cover what it does, how it works, parameters, return values, and any important patterns.\n\n\`\`\`${language}\n${relevantCode}\n\`\`\``, 'markdown');
                break;
            case 'fix':
                await this.executeLensAction('Fixing code', `Fix any issues in the following ${language} code. Check for bugs, error handling, performance, and style. Return the complete fixed code.\n\n\`\`\`${language}\n${relevantCode}\n\`\`\``, language);
                break;
        }
    }
    /**
     * Execute a CLI action with progress and error handling.
     */
    async executeLensAction(title, prompt, displayLanguage) {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${title}...`, cancellable: false }, async () => {
            try {
                const result = await this.cliManager.executeGoal(prompt);
                if (result?.success && result.stdout) {
                    const doc = await vscode.workspace.openTextDocument({
                        content: result.stdout,
                        language: displayLanguage,
                    });
                    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
                }
                else {
                    vscode.window.showWarningMessage('No output generated. Try a more specific prompt.');
                }
            }
            catch (err) {
                vscode.window.showErrorMessage(`Agent action failed: ${err.message || 'Unknown error'}`);
            }
        });
    }
    /**
     * Find function/class body range via brace counting.
     */
    findBody(lines, start, config) {
        let depth = 0;
        let opened = false;
        for (let i = start; i < Math.min(lines.length, start + 200); i++) {
            const line = lines[i];
            const ci = line.indexOf(config.comment);
            const clean = ci >= 0 ? line.slice(0, ci) : line;
            for (const ch of clean) {
                if (ch === '{') {
                    depth++;
                    opened = true;
                }
                else if (ch === '}') {
                    depth--;
                }
            }
            if (opened && depth === 0) {
                return new vscode.Range(start, 0, i, lines[i].length);
            }
        }
        return null;
    }
    getConfig(lang) {
        const map = { ts: 'typescript', js: 'javascript', py: 'python', go: 'go', rs: 'rust', java: 'java' };
        return CONFIGS[map[lang] || lang] || null;
    }
}
exports.CodeLensProvider = CodeLensProvider;
//# sourceMappingURL=codeLensProvider.js.map