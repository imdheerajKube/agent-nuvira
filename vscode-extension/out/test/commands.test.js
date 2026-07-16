"use strict";
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
/**
 * Unit tests for CommandRegistrar.
 *
 * Tests the pure-logic methods that can be isolated from the VS Code API:
 * - parseCLIOutput() — parses CLI stdout into structured AgentResult
 * - generateSummary() — generates human-readable change summaries
 * - updateConfig() — runtime config updates
 * - dispose() — cleanup
 *
 * The command registration (registerAll) and task execution methods
 * require VS Code API integration and are tested separately.
 */
const vitest_1 = require("vitest");
// Mock vscode module before importing
vitest_1.vi.mock('vscode', () => {
    return import('./__mocks__/vscode.js');
});
// We need to mock cliManager and other deps
vitest_1.vi.mock('../cliManager.js', () => ({
    CLIManager: vitest_1.vi.fn().mockImplementation(() => ({
        setCallbacks: vitest_1.vi.fn(),
        executeGoal: vitest_1.vi.fn(),
        quickFix: vitest_1.vi.fn(),
        reviewFile: vitest_1.vi.fn(),
        explainCode: vitest_1.vi.fn(),
        generateTests: vitest_1.vi.fn(),
        runWorkflow: vitest_1.vi.fn(),
        cancel: vitest_1.vi.fn(),
        dispose: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock('../agentPanel.js', () => ({
    AgentPanel: vitest_1.vi.fn().mockImplementation(() => ({
        createOrShow: vitest_1.vi.fn(),
        updateProgress: vitest_1.vi.fn(),
        updateStatus: vitest_1.vi.fn(),
        showResult: vitest_1.vi.fn(),
        showError: vitest_1.vi.fn(),
        showDiffs: vitest_1.vi.fn(),
        clear: vitest_1.vi.fn(),
        setCallbacks: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock('../diffViewer.js', () => ({
    DiffViewer: vitest_1.vi.fn().mockImplementation(() => ({
        showChanges: vitest_1.vi.fn(),
        applyChanges: vitest_1.vi.fn().mockResolvedValue(0),
        rejectChanges: vitest_1.vi.fn(),
        dispose: vitest_1.vi.fn(),
    })),
}));
const commands_js_1 = require("../commands.js");
const vscode = __importStar(require("vscode"));
// Re-import with actual types after mock
const cliManager_js_1 = require("../cliManager.js");
const agentPanel_js_1 = require("../agentPanel.js");
const diffViewer_js_1 = require("../diffViewer.js");
(0, vitest_1.describe)('CommandRegistrar', () => {
    const defaultConfig = {
        cliPath: 'buff',
        defaultProvider: '',
        defaultModel: '',
        autoApplyChanges: false,
        maxTokens: 4096,
        showProgressPanel: true,
    };
    // Minimal context mock
    const contextMock = {
        subscriptions: [],
    };
    let registrar;
    let mockCliManager;
    let mockAgentPanel;
    let mockDiffViewer;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        mockCliManager = new cliManager_js_1.CLIManager(defaultConfig);
        mockAgentPanel = new agentPanel_js_1.AgentPanel();
        mockDiffViewer = new diffViewer_js_1.DiffViewer(contextMock);
        registrar = new commands_js_1.CommandRegistrar(contextMock, mockCliManager, mockAgentPanel, mockDiffViewer, defaultConfig);
    });
    // ── Constructor ───────────────────────────────────────────────────────
    (0, vitest_1.describe)('constructor', () => {
        (0, vitest_1.it)('creates an instance with required dependencies', () => {
            (0, vitest_1.expect)(registrar).toBeInstanceOf(commands_js_1.CommandRegistrar);
        });
    });
    // ── updateConfig ──────────────────────────────────────────────────────
    (0, vitest_1.describe)('updateConfig', () => {
        (0, vitest_1.it)('updates the internal config', () => {
            const newConfig = {
                ...defaultConfig,
                cliPath: '/custom/path/buff',
                autoApplyChanges: true,
            };
            // updateConfig is public
            registrar.updateConfig(newConfig);
            // Verify by checking internal state via parseCLIOutput behavior
            // (config doesn't affect parseCLIOutput directly, but updateConfig shouldn't throw)
            (0, vitest_1.expect)(() => registrar.updateConfig(newConfig)).not.toThrow();
        });
        (0, vitest_1.it)('can update config multiple times', () => {
            registrar.updateConfig({ ...defaultConfig, autoApplyChanges: true });
            registrar.updateConfig({ ...defaultConfig, cliPath: '/new/path' });
            registrar.updateConfig(defaultConfig);
            (0, vitest_1.expect)(() => registrar.updateConfig(defaultConfig)).not.toThrow();
        });
    });
    // ── parseCLIOutput ─────────────────────────────────────────────────────
    (0, vitest_1.describe)('parseCLIOutput', () => {
        (0, vitest_1.it)('returns success with empty changes for empty output', () => {
            const result = registrar.parseCLIOutput('');
            (0, vitest_1.expect)(result.success).toBe(true);
            (0, vitest_1.expect)(result.changes).toEqual([]);
            (0, vitest_1.expect)(result.output).toBe('');
        });
        (0, vitest_1.it)('detects created files from emoji markers', () => {
            const output = '📄 src/new-file.ts (created)\nTask completed.';
            const result = registrar.parseCLIOutput(output);
            (0, vitest_1.expect)(result.changes).toHaveLength(1);
            (0, vitest_1.expect)(result.changes[0].path).toBe('src/new-file.ts');
            (0, vitest_1.expect)(result.changes[0].type).toBe('created');
            (0, vitest_1.expect)(result.changes[0].applied).toBe(false);
        });
        (0, vitest_1.it)('detects modified files from emoji markers', () => {
            const output = '✏️ src/app.ts (modified)\nDone.';
            const result = registrar.parseCLIOutput(output);
            (0, vitest_1.expect)(result.changes).toHaveLength(1);
            (0, vitest_1.expect)(result.changes[0].path).toBe('src/app.ts');
            (0, vitest_1.expect)(result.changes[0].type).toBe('modified');
        });
        (0, vitest_1.it)('detects deleted files from emoji markers', () => {
            const output = '🗑️ src/old-file.ts (deleted)\nRemoved.';
            const result = registrar.parseCLIOutput(output);
            (0, vitest_1.expect)(result.changes).toHaveLength(1);
            (0, vitest_1.expect)(result.changes[0].path).toBe('src/old-file.ts');
            (0, vitest_1.expect)(result.changes[0].type).toBe('deleted');
        });
        (0, vitest_1.it)('detects created files from text markers', () => {
            const output = 'Created: src/new-component.tsx\nUpdated some files.';
            const result = registrar.parseCLIOutput(output);
            (0, vitest_1.expect)(result.changes).toHaveLength(1);
            (0, vitest_1.expect)(result.changes[0].path).toBe('src/new-component.tsx');
            (0, vitest_1.expect)(result.changes[0].type).toBe('created');
        });
        (0, vitest_1.it)('detects modified files from text markers', () => {
            const output = 'Modified: src/utils/helper.ts\nAll done.';
            const result = registrar.parseCLIOutput(output);
            (0, vitest_1.expect)(result.changes).toHaveLength(1);
            (0, vitest_1.expect)(result.changes[0].path).toBe('src/utils/helper.ts');
            (0, vitest_1.expect)(result.changes[0].type).toBe('modified');
        });
        (0, vitest_1.it)('detects diff headers', () => {
            const output = '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,5 +1,6 @@';
            const result = registrar.parseCLIOutput(output);
            (0, vitest_1.expect)(result.changes).toHaveLength(1);
            (0, vitest_1.expect)(result.changes[0].path).toBe('src/index.ts');
        });
        (0, vitest_1.it)('avoids duplicate file entries', () => {
            const output = '📄 src/app.ts (created)\nModified: src/app.ts\n✏️ src/app.ts (modified)';
            const result = registrar.parseCLIOutput(output);
            // Should have exactly 1 entry for app.ts (first match wins)
            (0, vitest_1.expect)(result.changes).toHaveLength(1);
        });
        (0, vitest_1.it)('detects multiple files of different types', () => {
            const output = [
                '📄 src/new-file.ts (created)',
                '✏️ src/existing.ts (modified)',
                '🗑️ src/old.ts (deleted)',
                'Updated: src/another.ts',
            ].join('\n');
            const result = registrar.parseCLIOutput(output);
            (0, vitest_1.expect)(result.changes).toHaveLength(4);
            const types = result.changes.map((c) => c.type);
            (0, vitest_1.expect)(types).toContain('created');
            (0, vitest_1.expect)(types).toContain('modified');
            (0, vitest_1.expect)(types).toContain('deleted');
        });
        (0, vitest_1.it)('handles file paths with spaces', () => {
            const output = '📄 src/my components/button.tsx (created)';
            const result = registrar.parseCLIOutput(output);
            (0, vitest_1.expect)(result.changes).toHaveLength(1);
            (0, vitest_1.expect)(result.changes[0].path).toBe('src/my components/button.tsx');
        });
    });
    // ── generateSummary ────────────────────────────────────────────────────
    (0, vitest_1.describe)('generateSummary', () => {
        (0, vitest_1.it)('returns "Changes:" with counts when there are changes', () => {
            const changes = [
                { path: 'a.ts', type: 'created', applied: false },
                { path: 'b.ts', type: 'modified', applied: false },
                { path: 'c.ts', type: 'modified', applied: false },
                { path: 'd.ts', type: 'deleted', applied: false },
            ];
            const summary = registrar.generateSummary(changes, '');
            (0, vitest_1.expect)(summary).toContain('1 created');
            (0, vitest_1.expect)(summary).toContain('2 modified');
            (0, vitest_1.expect)(summary).toContain('1 deleted');
            (0, vitest_1.expect)(summary).toContain('Changes:');
        });
        (0, vitest_1.it)('returns first meaningful line when no changes', () => {
            const output = 'ℹ Info line\n✔ Success\nThis is a meaningful result line with actual content.\n';
            const summary = registrar.generateSummary([], output);
            (0, vitest_1.expect)(summary).toBe('This is a meaningful result line with actual content.');
        });
        (0, vitest_1.it)('returns "Task completed." when no changes and no meaningful output', () => {
            const summary = registrar.generateSummary([], '');
            (0, vitest_1.expect)(summary).toBe('Task completed.');
        });
        (0, vitest_1.it)('filters out short lines', () => {
            const output = 'ok\n[x]\nA meaningful sentence describing what was done.\n';
            const summary = registrar.generateSummary([], output);
            (0, vitest_1.expect)(summary).toBe('A meaningful sentence describing what was done.');
        });
    });
    // ── registerAll ────────────────────────────────────────────────────────
    (0, vitest_1.describe)('registerAll', () => {
        (0, vitest_1.it)('returns an array of disposables', () => {
            const disposables = registrar.registerAll();
            (0, vitest_1.expect)(Array.isArray(disposables)).toBe(true);
            (0, vitest_1.expect)(disposables.length).toBeGreaterThan(0);
        });
        (0, vitest_1.it)('registers all expected commands', () => {
            const disposables = registrar.registerAll();
            // All disposables should be registered (9 commands)
            (0, vitest_1.expect)(disposables).toHaveLength(9);
            // Verify registerCommand was called 9 times
            (0, vitest_1.expect)(vscode.commands.registerCommand).toHaveBeenCalledTimes(9);
        });
    });
    // ── dispose ────────────────────────────────────────────────────────────
    (0, vitest_1.describe)('dispose', () => {
        (0, vitest_1.it)('disposes all registered disposables without throwing', () => {
            registrar.registerAll();
            (0, vitest_1.expect)(() => registrar.dispose()).not.toThrow();
        });
        (0, vitest_1.it)('can be called multiple times without error', () => {
            (0, vitest_1.expect)(() => {
                registrar.dispose();
                registrar.dispose();
            }).not.toThrow();
        });
        (0, vitest_1.it)('does not throw when called before registerAll', () => {
            (0, vitest_1.expect)(() => registrar.dispose()).not.toThrow();
        });
    });
    // ── Edge Cases ─────────────────────────────────────────────────────────
    (0, vitest_1.describe)('parseCLIOutput edge cases', () => {
        (0, vitest_1.it)('handles newline variant (\\r\\n)', () => {
            const output = '📄 file1.ts (created)\r\n✏️ file2.ts (modified)';
            const result = registrar.parseCLIOutput(output);
            (0, vitest_1.expect)(result.changes).toHaveLength(2);
        });
        (0, vitest_1.it)('extracts path from +++ style diff headers', () => {
            const output = '+++ b/src/components/Button.tsx';
            const result = registrar.parseCLIOutput(output);
            (0, vitest_1.expect)(result.changes).toHaveLength(1);
            (0, vitest_1.expect)(result.changes[0].path).toBe('src/components/Button.tsx');
            (0, vitest_1.expect)(result.changes[0].type).toBe('modified');
        });
        (0, vitest_1.it)('handles New: text marker (case insensitive)', () => {
            const output = 'New: generated-file.ts\nCompleted.';
            const result = registrar.parseCLIOutput(output);
            (0, vitest_1.expect)(result.changes).toHaveLength(1);
            (0, vitest_1.expect)(result.changes[0].path).toBe('generated-file.ts');
        });
        (0, vitest_1.it)('handles Removed: text marker (case insensitive)', () => {
            const output = 'Removed: deprecated-module.ts\nDone.';
            const result = registrar.parseCLIOutput(output);
            (0, vitest_1.expect)(result.changes).toHaveLength(1);
            (0, vitest_1.expect)(result.changes[0].path).toBe('deprecated-module.ts');
            (0, vitest_1.expect)(result.changes[0].type).toBe('deleted');
        });
        (0, vitest_1.it)('detects Updated: text marker', () => {
            const output = 'Updated: config.json\nDone.';
            const result = registrar.parseCLIOutput(output);
            (0, vitest_1.expect)(result.changes).toHaveLength(1);
            (0, vitest_1.expect)(result.changes[0].type).toBe('modified');
        });
    });
});
//# sourceMappingURL=commands.test.js.map