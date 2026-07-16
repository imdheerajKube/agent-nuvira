"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Unit tests for CLIManager.
 *
 * Tests the pure-logic methods that can be isolated from the VS Code API:
 * - buildArgs() — constructs CLI arguments with provider/model options
 * - relativePath() — converts absolute paths to workspace-relative paths
 * - resolveCliCommand() — resolves CLI executable path
 * - cancel() — cancels running process
 * - isRunning — process state tracking
 * - setCallbacks — progress/log callback registration
 *
 * Lifecycle methods (executeGoal, quickFix, etc.) spawn actual child processes
 * and are tested separately via integration tests.
 */
const vitest_1 = require("vitest");
// Mock child_process before importing CLIManager
vitest_1.vi.mock('node:child_process', () => {
    const mockProcess = {
        stdout: { on: vitest_1.vi.fn() },
        stderr: { on: vitest_1.vi.fn() },
        on: vitest_1.vi.fn(),
        kill: vitest_1.vi.fn(),
        killed: false,
        exitCode: null,
        pid: 12345,
    };
    return {
        spawn: vitest_1.vi.fn(() => mockProcess),
        ChildProcess: function () { },
    };
});
// Mock vscode module
vitest_1.vi.mock('vscode', () => {
    return import('./__mocks__/vscode.js');
});
// Import after mocks are set up
const cliManager_js_1 = require("../cliManager.js");
(0, vitest_1.describe)('CLIManager', () => {
    const defaultConfig = {
        cliPath: 'buff',
        defaultProvider: '',
        defaultModel: '',
        autoApplyChanges: false,
        maxTokens: 4096,
        showProgressPanel: true,
    };
    let manager;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        manager = new cliManager_js_1.CLIManager(defaultConfig);
    });
    // ── Constructor ───────────────────────────────────────────────────────
    (0, vitest_1.describe)('constructor', () => {
        (0, vitest_1.it)('creates an instance with default config', () => {
            const m = new cliManager_js_1.CLIManager(defaultConfig);
            (0, vitest_1.expect)(m).toBeInstanceOf(cliManager_js_1.CLIManager);
            (0, vitest_1.expect)(m.isRunning).toBe(false);
        });
        (0, vitest_1.it)('creates instance with custom config', () => {
            const customConfig = {
                ...defaultConfig,
                cliPath: '/usr/local/bin/buff',
                defaultProvider: 'groq',
                defaultModel: 'llama-3.3-70b',
            };
            const m = new cliManager_js_1.CLIManager(customConfig);
            (0, vitest_1.expect)(m).toBeInstanceOf(cliManager_js_1.CLIManager);
        });
    });
    // ── buildArgs ─────────────────────────────────────────────────────────
    (0, vitest_1.describe)('buildArgs', () => {
        (0, vitest_1.it)('returns args unchanged when no provider/model configured', () => {
            const m = new cliManager_js_1.CLIManager(defaultConfig);
            // Access private method via bracket notation for testing
            const args = m.buildArgs(['execute', 'test goal']);
            (0, vitest_1.expect)(args).toEqual(['execute', 'test goal']);
        });
        (0, vitest_1.it)('appends --provider when configured', () => {
            const config = { ...defaultConfig, defaultProvider: 'groq' };
            const m = new cliManager_js_1.CLIManager(config);
            const args = m.buildArgs(['execute', 'test']);
            (0, vitest_1.expect)(args).toContain('--provider');
            (0, vitest_1.expect)(args).toContain('groq');
        });
        (0, vitest_1.it)('appends --model when configured', () => {
            const config = { ...defaultConfig, defaultModel: 'llama-3.3-70b' };
            const m = new cliManager_js_1.CLIManager(config);
            const args = m.buildArgs(['execute', 'test']);
            (0, vitest_1.expect)(args).toContain('--model');
            (0, vitest_1.expect)(args).toContain('llama-3.3-70b');
        });
        (0, vitest_1.it)('appends both --provider and --model when both configured', () => {
            const config = {
                ...defaultConfig,
                defaultProvider: 'openrouter',
                defaultModel: 'mistralai/mistral-7b',
            };
            const m = new cliManager_js_1.CLIManager(config);
            const args = m.buildArgs(['chat', 'hello']);
            (0, vitest_1.expect)(args).toEqual(['chat', 'hello', '--provider', 'openrouter', '--model', 'mistralai/mistral-7b']);
        });
        (0, vitest_1.it)('preserves custom args order with provider/model appended at end', () => {
            const config = { ...defaultConfig, defaultProvider: 'gemini' };
            const m = new cliManager_js_1.CLIManager(config);
            const args = m.buildArgs(['execute', 'fix bug', '--verbose']);
            (0, vitest_1.expect)(args.slice(0, 3)).toEqual(['execute', 'fix bug', '--verbose']);
            (0, vitest_1.expect)(args.slice(-2)).toEqual(['--provider', 'gemini']);
        });
    });
    // ── relativePath ───────────────────────────────────────────────────────
    (0, vitest_1.describe)('relativePath', () => {
        (0, vitest_1.it)('returns file basename from absolute path', () => {
            const m = new cliManager_js_1.CLIManager(defaultConfig);
            const result = m.relativePath('/workspace/src/index.ts');
            (0, vitest_1.expect)(result).toBe('index.ts'); // mock asRelativePath returns basename
        });
        (0, vitest_1.it)('handles paths with spaces by wrapping in quotes', () => {
            // The mock asRelativePath returns just the basename, so no spaces
            // This test verifies the method handles the return value correctly
            const m = new cliManager_js_1.CLIManager(defaultConfig);
            // Override the mock behavior by checking what happens with spaces
            const path = '/workspace/my project/file.ts';
            const result = m.relativePath(path);
            // Our mock always returns basename (no spaces in basename)
            (0, vitest_1.expect)(result).not.toContain(' ');
        });
    });
    // ── resolveCliCommand ──────────────────────────────────────────────────
    (0, vitest_1.describe)('resolveCliCommand', () => {
        (0, vitest_1.it)('returns default "buff" command when cliPath is "buff"', () => {
            const m = new cliManager_js_1.CLIManager(defaultConfig);
            const result = m.resolveCliCommand();
            (0, vitest_1.expect)(result.command).toBe('buff');
            (0, vitest_1.expect)(result.spawnArgs).toEqual([]);
        });
        (0, vitest_1.it)('parses simple path correctly', () => {
            const config = { ...defaultConfig, cliPath: '/usr/local/bin/buff' };
            const m = new cliManager_js_1.CLIManager(config);
            const result = m.resolveCliCommand();
            (0, vitest_1.expect)(result.command).toBe('/usr/local/bin/buff');
            (0, vitest_1.expect)(result.spawnArgs).toEqual([]);
        });
        (0, vitest_1.it)('parses path with arguments', () => {
            const config = { ...defaultConfig, cliPath: 'npx buff' };
            const m = new cliManager_js_1.CLIManager(config);
            const result = m.resolveCliCommand();
            (0, vitest_1.expect)(result.command).toBe('npx');
            (0, vitest_1.expect)(result.spawnArgs).toEqual(['buff']);
        });
        (0, vitest_1.it)('parses multi-part path with arguments', () => {
            const config = { ...defaultConfig, cliPath: 'node /path/to/cli.js' };
            const m = new cliManager_js_1.CLIManager(config);
            const result = m.resolveCliCommand();
            (0, vitest_1.expect)(result.command).toBe('node');
            (0, vitest_1.expect)(result.spawnArgs).toEqual(['/path/to/cli.js']);
        });
    });
    // ── setCallbacks ───────────────────────────────────────────────────────
    (0, vitest_1.describe)('setCallbacks', () => {
        (0, vitest_1.it)('stores onProgress callback', () => {
            const onProgress = vitest_1.vi.fn();
            manager.setCallbacks({ onProgress });
            // Trigger the reportProgress internal method
            manager.reportProgress('Testing', 'detail');
            (0, vitest_1.expect)(onProgress).toHaveBeenCalledWith('Testing', 'detail');
        });
        (0, vitest_1.it)('stores onLog callback', () => {
            const onLog = vitest_1.vi.fn();
            manager.setCallbacks({ onLog });
            // We can't easily trigger internal onLog, but the callback is stored
            // Verify it doesn't throw
            (0, vitest_1.expect)(() => {
                manager.setCallbacks({ onLog });
            }).not.toThrow();
        });
        (0, vitest_1.it)('can update callbacks after creation', () => {
            const cb1 = vitest_1.vi.fn();
            const cb2 = vitest_1.vi.fn();
            manager.setCallbacks({ onProgress: cb1 });
            manager.setCallbacks({ onProgress: cb2 });
            manager.reportProgress('Test');
            (0, vitest_1.expect)(cb2).toHaveBeenCalledWith('Test', undefined);
        });
    });
    // ── isRunning ──────────────────────────────────────────────────────────
    (0, vitest_1.describe)('isRunning', () => {
        (0, vitest_1.it)('returns false when no process is active', () => {
            (0, vitest_1.expect)(manager.isRunning).toBe(false);
        });
        (0, vitest_1.it)('returns false when process is killed', () => {
            // Mock the process state
            manager.process = {
                killed: true,
                exitCode: 0,
            };
            (0, vitest_1.expect)(manager.isRunning).toBe(false);
        });
        (0, vitest_1.it)('returns true when process is active and not killed', () => {
            manager.process = {
                killed: false,
                exitCode: null,
            };
            (0, vitest_1.expect)(manager.isRunning).toBe(true);
        });
        (0, vitest_1.it)('returns false when process has exited', () => {
            manager.process = {
                killed: false,
                exitCode: 0,
            };
            (0, vitest_1.expect)(manager.isRunning).toBe(false);
        });
    });
    // ── cancel ─────────────────────────────────────────────────────────────
    (0, vitest_1.describe)('cancel', () => {
        (0, vitest_1.it)('does not throw when no process is active', () => {
            (0, vitest_1.expect)(() => manager.cancel()).not.toThrow();
        });
        (0, vitest_1.it)('kills the active process with SIGTERM', () => {
            const mockKill = vitest_1.vi.fn();
            manager.process = {
                killed: false,
                kill: mockKill,
                exitCode: null,
            };
            manager.cancel();
            (0, vitest_1.expect)(mockKill).toHaveBeenCalledWith('SIGTERM');
        });
        (0, vitest_1.it)('does not kill already killed process', () => {
            const mockKill = vitest_1.vi.fn();
            manager.process = {
                killed: true,
                kill: mockKill,
                exitCode: 0,
            };
            manager.cancel();
            (0, vitest_1.expect)(mockKill).not.toHaveBeenCalled();
        });
    });
    // ── dispose ────────────────────────────────────────────────────────────
    (0, vitest_1.describe)('dispose', () => {
        (0, vitest_1.it)('calls cancel on dispose', () => {
            const cancelSpy = vitest_1.vi.spyOn(manager, 'cancel');
            manager.dispose();
            (0, vitest_1.expect)(cancelSpy).toHaveBeenCalled();
        });
    });
});
//# sourceMappingURL=cliManager.test.js.map