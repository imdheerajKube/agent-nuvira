/**
 * TestModule — Runs tests in a sandboxed environment and returns structured results.
 * Phase 8 of the architecture migration: extract from TesterAgent into
 * a pluggable module with EventBus integration.
 *
 * Creates a temp sandbox, copies project files, installs dependencies,
 * applies file changes, executes tests, and parses the output to extract
 * pass/fail/total counts. Supports multiple test frameworks (vitest, jest, mocha).
 *
 * @see ARCHITECTURE.md §3.4 — Test Module specification
 */
import type { EventBus } from '../observability/event-bus.js';
import type { FileChange } from './agent.js';
export interface TestResult {
    /** Whether all tests passed */
    success: boolean;
    /** Full test output (stdout + stderr) */
    output: string;
    /** Test exit code */
    exitCode: number;
    /** Path to the sandbox directory */
    sandboxPath: string;
    /** How many tests passed (parsed from output) */
    passed?: number;
    /** How many tests failed (parsed from output) */
    failed?: number;
    /** How many tests total (parsed from output) */
    total?: number;
    /** Error message if test execution failed */
    error?: string;
}
/** Parameters for the TestModule.runTests() method */
export interface TestParams {
    /** Working directory of the original project */
    workingDirectory: string;
    /** File changes to apply before running tests */
    fileChanges: FileChange[];
    /** Optional explicit test command (if not provided, auto-detected) */
    testCommand?: string;
    /** Optional timeout in milliseconds (default: 180000) */
    timeoutMs?: number;
}
/**
 * TestModule — Run tests in a sandboxed copy of the project.
 *
 * @example
 * ```typescript
 * const module = new DefaultTestModule();
 * const result = await module.runTests({
 *   workingDirectory: '/project',
 *   fileChanges: changedFiles,
 * });
 * console.log(`${result.passed}/${result.total} tests passed`);
 * ```
 */
export interface TestModule {
    /**
     * Run tests in a sandboxed copy of the project.
     */
    runTests(params: TestParams): Promise<TestResult>;
}
/**
 * DefaultTestModule — Built-in test module implementation.
 *
 * Creates a sandboxed copy of the project, applies file changes,
 * installs dependencies, runs tests, and parses output.
 * Supports autodetection of test commands from package.json.
 */
export declare class DefaultTestModule implements TestModule {
    /** The event bus for emitting observability events */
    private eventBus;
    constructor(eventBus?: EventBus);
    /**
     * Run tests in a sandboxed copy of the project.
     */
    runTests(params: TestParams): Promise<TestResult>;
    /**
     * Detect the test command from package.json scripts.
     * Returns null if no test script is found.
     */
    private detectTestCommand;
    /**
     * Detect the test framework from the project.
     */
    private detectFramework;
    /**
     * Copy project files to the sandbox, excluding large/generated dirs.
     */
    private copyProject;
    /**
     * Apply file changes to the sandbox directory.
     */
    private applyChanges;
    /**
     * Does the project declare any dependencies to install? A package.json with
     * no dependencies/devDependencies/etc. needs no `npm install` — skipping it
     * makes sandboxed test runs fast, offline-safe, and immune to npm registry
     * latency (the source of a flaky CI test).
     */
    private hasDependencies;
    /**
     * Run npm install in the sandbox.
     */
    private runInstall;
    /**
     * Run the test command and capture output.
     */
    private runTestCommand;
    /**
     * Parse test output to extract pass/fail/total counts.
     * Supports vitest, jest, mocha, and generic output formats.
     */
    private parseTestOutput;
}
/**
 * Clean up a specific sandbox directory.
 */
export declare function cleanupSandbox(sandboxPath: string): void;
//# sourceMappingURL=test-module.d.ts.map