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
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { getEventBus, EventNames } from '../observability/event-bus.js';
// ─── Constants ──────────────────────────────────────────────────────────────
/** Common directories to exclude when copying to the sandbox */
const EXCLUDE_DIRS = ['node_modules', '.git', 'dist', '.next', 'coverage', '.cache'];
/** Track sandbox directories for cleanup */
const activeSandboxes = [];
/** Register cleanup handler for sandbox directories */
function registerCleanup() {
    const cleanup = () => {
        for (const dir of activeSandboxes) {
            try {
                rmSync(dir, { recursive: true, force: true });
            }
            catch { /* best-effort */ }
        }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(1); });
    process.on('SIGTERM', cleanup);
}
let cleanupRegistered = false;
function ensureCleanupRegistered() {
    if (!cleanupRegistered) {
        registerCleanup();
        cleanupRegistered = true;
    }
}
// ─── Default TestModule ─────────────────────────────────────────────────────
/**
 * DefaultTestModule — Built-in test module implementation.
 *
 * Creates a sandboxed copy of the project, applies file changes,
 * installs dependencies, runs tests, and parses output.
 * Supports autodetection of test commands from package.json.
 */
export class DefaultTestModule {
    /** The event bus for emitting observability events */
    eventBus;
    constructor(eventBus) {
        this.eventBus = eventBus ?? getEventBus();
    }
    /**
     * Run tests in a sandboxed copy of the project.
     */
    async runTests(params) {
        const { workingDirectory, fileChanges, testCommand, timeoutMs = 180_000 } = params;
        ensureCleanupRegistered();
        // Detect the test command if not provided
        const command = testCommand || this.detectTestCommand(workingDirectory);
        // If no test script is defined, skip gracefully
        if (!command) {
            this.eventBus.emit(EventNames.TEST_STARTED, {
                framework: 'none',
                command: 'none',
            }, 'test-module');
            return {
                success: true,
                output: '',
                exitCode: 0,
                sandboxPath: '',
                passed: 0,
                failed: 0,
                total: 0,
            };
        }
        // ── Emit: test started ──────────────────────────────────────────
        this.eventBus.emit(EventNames.TEST_STARTED, {
            framework: this.detectFramework(workingDirectory),
            command,
        }, 'test-module');
        let sandboxPath = '';
        try {
            // Create sandbox
            sandboxPath = mkdtempSync(join(tmpdir(), 'buff-test-'));
            activeSandboxes.push(sandboxPath);
            // Copy project files to sandbox
            this.copyProject(workingDirectory, sandboxPath);
            // Apply file changes to the sandbox
            this.applyChanges(sandboxPath, fileChanges);
            // Install dependencies (only if package.json exists)
            const pkgExists = existsSync(join(sandboxPath, 'package.json'));
            if (pkgExists) {
                this.runInstall(sandboxPath);
            }
            // Run tests
            const testResult = this.runTestCommand(sandboxPath, command, timeoutMs);
            // Parse test results
            const parsed = this.parseTestOutput(testResult.output);
            const result = {
                success: testResult.success,
                output: testResult.output,
                exitCode: testResult.exitCode,
                sandboxPath,
                passed: parsed.passed,
                failed: parsed.failed,
                total: parsed.total,
            };
            // ── Emit: test completed ──────────────────────────────────────
            this.eventBus.emit(EventNames.TEST_COMPLETED, {
                success: result.success,
                passed: parsed.passed || 0,
                failed: parsed.failed || 0,
                total: parsed.total || 0,
                exitCode: testResult.exitCode,
            }, 'test-module');
            return result;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // ── Emit: test failure ──────────────────────────────────────
            this.eventBus.emit(EventNames.TEST_FAILURE, {
                error: msg,
            }, 'test-module');
            return {
                success: false,
                output: msg,
                exitCode: 1,
                sandboxPath: sandboxPath || '',
                error: msg,
            };
        }
    }
    /**
     * Detect the test command from package.json scripts.
     * Returns null if no test script is found.
     */
    detectTestCommand(workingDir) {
        try {
            const pkgPath = join(workingDir, 'package.json');
            if (existsSync(pkgPath)) {
                const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
                if (pkg.scripts?.test) {
                    return 'npm run test 2>&1';
                }
            }
        }
        catch {
            // Fall through
        }
        return null;
    }
    /**
     * Detect the test framework from the project.
     */
    detectFramework(workingDir) {
        if (existsSync(join(workingDir, 'vitest.config.ts')) || existsSync(join(workingDir, 'vitest.config.js')))
            return 'vitest';
        if (existsSync(join(workingDir, 'jest.config.js')) || existsSync(join(workingDir, 'jest.config.ts')))
            return 'jest';
        if (existsSync(join(workingDir, 'pytest.ini')))
            return 'pytest';
        if (existsSync(join(workingDir, 'go.mod')))
            return 'go test';
        return 'auto-detect';
    }
    /**
     * Copy project files to the sandbox, excluding large/generated dirs.
     */
    copyProject(sourceDir, targetDir) {
        let entries;
        try {
            entries = readdirSync(sourceDir).sort();
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const srcPath = join(sourceDir, entry);
            const tgtPath = join(targetDir, entry);
            try {
                if (entry.startsWith('.'))
                    continue;
                if (EXCLUDE_DIRS.includes(entry))
                    continue;
                if (existsSync(srcPath)) {
                    cpSync(srcPath, tgtPath, { recursive: true, force: true });
                }
            }
            catch {
                // Skip files we can't copy
            }
        }
    }
    /**
     * Apply file changes to the sandbox directory.
     */
    applyChanges(sandboxPath, changes) {
        for (const change of changes) {
            if (change.status === 'deleted' || !change.newContent)
                continue;
            const filePath = join(sandboxPath, change.path);
            const dir = dirname(filePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            writeFileSync(filePath, change.newContent, 'utf-8');
        }
    }
    /**
     * Run npm install in the sandbox.
     */
    runInstall(sandboxPath) {
        try {
            return execSync('npm install --prefer-offline --no-audit --no-fund 2>&1', {
                cwd: sandboxPath,
                timeout: 120_000,
                stdio: 'pipe',
                encoding: 'utf-8',
            });
        }
        catch (err) {
            const output = err instanceof Error ? err.message : String(err);
            return output;
        }
    }
    /**
     * Run the test command and capture output.
     */
    runTestCommand(sandboxPath, command, timeoutMs) {
        try {
            const output = execSync(command, {
                cwd: sandboxPath,
                timeout: timeoutMs,
                stdio: 'pipe',
                encoding: 'utf-8',
            });
            return { success: true, output, exitCode: 0 };
        }
        catch (err) {
            const error = err;
            const output = [error.stdout || '', error.stderr || '', error.message || ''].filter(Boolean).join('\n');
            return { success: false, output, exitCode: error.status ?? 1 };
        }
    }
    /**
     * Parse test output to extract pass/fail/total counts.
     * Supports vitest, jest, mocha, and generic output formats.
     */
    parseTestOutput(output) {
        // Try vitest format: "Tests  1 failed | 3 passed (4)"
        const vitestMatch = output.match(/Tests\s+(?:(\d+)\s+failed\s*)?(?:\|?\s*)?(?:(\d+)\s+passed)?\s*\((\d+)\)/);
        if (vitestMatch) {
            return {
                failed: vitestMatch[1] ? parseInt(vitestMatch[1], 10) : 0,
                passed: vitestMatch[2] ? parseInt(vitestMatch[2], 10) : 0,
                total: parseInt(vitestMatch[3], 10),
            };
        }
        // Try jest format: "Tests: 1 failed, 3 passed, 4 total"
        const jestMatch = output.match(/Tests:\s*(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed,?\s*)?(\d+)\s+total/);
        if (jestMatch) {
            return {
                failed: jestMatch[1] ? parseInt(jestMatch[1], 10) : 0,
                passed: jestMatch[2] ? parseInt(jestMatch[2], 10) : 0,
                total: parseInt(jestMatch[3], 10),
            };
        }
        // Try generic: "X passing, Y failing"
        const genericMatch = output.match(/(\d+)\s+passing,?\s*(?:(\d+)\s+failing)?/);
        if (genericMatch) {
            return {
                passed: parseInt(genericMatch[1], 10),
                failed: genericMatch[2] ? parseInt(genericMatch[2], 10) : 0,
                total: genericMatch[2] ? parseInt(genericMatch[1], 10) + parseInt(genericMatch[2], 10) : parseInt(genericMatch[1], 10),
            };
        }
        // Count lines with failure/pass markers
        const failLines = (output.match(/[✗❌]|FAIL|failed/g) || []).length;
        const passLines = (output.match(/[✓✅]|PASS|passed/g) || []).length;
        if (passLines > 0 || failLines > 0) {
            return { passed: passLines, failed: failLines, total: passLines + failLines };
        }
        return {};
    }
}
/**
 * Clean up a specific sandbox directory.
 */
export function cleanupSandbox(sandboxPath) {
    try {
        rmSync(sandboxPath, { recursive: true, force: true });
        const idx = activeSandboxes.indexOf(sandboxPath);
        if (idx >= 0)
            activeSandboxes.splice(idx, 1);
    }
    catch { /* best-effort */ }
}
//# sourceMappingURL=test-module.js.map