/**
 * RunnerAgent — Executes shell commands in the project directory and captures output.
 *
 * This is the agent that makes agent-nuvira capable of *running* the programs
 * it creates. Without this, the system can write files but can never execute
 * them or show the user what happened.
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-03-run", "description": "Run: python hello.py", "agentType": "runner", "dependsOn": ["step-02-write"] }
 * ```
 *
 * The command to run is determined by:
 * 1. The task description — if it contains a command wrapped in backticks
 *    (e.g., "Run `python hello.py`"), that command is extracted and executed.
 * 2. The "Run:" prefix — if the description starts with "Run:", the rest is
 *    treated as the command (e.g., "Run: python hello.py").
 * 3. The LLM fallback — if no explicit command is found, the LLM is asked
 *    what command to run based on the current context (files created, project type).
 *
 * Output is stored in context metadata as `runResult` and returned in the summary.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent } from '../agent.js';
import { logger } from '../../utils/logger.js';
import { getHostShell } from '../../utils/shell.js';
import { SandboxManager } from '../../sandbox/manager.js';
import { detectProjectImage } from '../../sandbox/images.js';
import { getSandboxConfig } from '../../sandbox/types.js';
/** Maximum stdout/stderr length to store in context metadata */
const MAX_OUTPUT_LENGTH = 10_000;
/** Timeout per command in milliseconds (default: 2 minutes) */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Maximum number of fallback attempts when command validation fails */
const MAX_FALLBACK_ATTEMPTS = 2;
/**
 * RunnerAgent — Executes shell commands and captures output.
 */
export class RunnerAgent extends Agent {
    name = 'Runner';
    description = 'Executes shell commands and captures output';
    /** Stored LLM call function for command suggestion fallback */
    _callLLM;
    async execute(context, callLLM) {
        // Store the LLM function for command validation fallback
        this._callLLM = callLLM;
        try {
            // 1. Determine which command to run
            const command = await this.determineCommand(context, callLLM);
            if (!command) {
                return {
                    success: false,
                    summary: 'No command to run',
                    error: 'Could not determine which command to execute from the task description or context.',
                };
            }
            // Check if we should run inside a Docker sandbox
            const useDocker = context.metadata.useDockerSandbox === true ||
                getSandboxConfig().enabled === true;
            if (useDocker) {
                return await this.executeWithDocker(context, command);
            }
            // 2. Execute the command on the host via shared method
            return await this.executeOnHost(context, command);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                success: false,
                summary: 'Runner failed',
                error: msg,
            };
        }
    }
    /**
     * Determine the command to run.
     *
     * Priority order:
     * 1. Parse from task description (backtick-wrapped command or "Run:" prefix)
     * 2. Ask the LLM what command to run based on the files that were created
     */
    async determineCommand(context, callLLM) {
        // Find the current 'runner' task in the plan
        const runnerTask = context.taskPlan.find((s) => s.agentType === 'runner' && s.status === 'running');
        const description = runnerTask?.description || context.goal;
        // Strategy 1: Extract command from backticks in the description
        // e.g., "Run `python hello.py` and verify output"
        const backtickMatch = description.match(/`([^`]+)`/);
        if (backtickMatch) {
            return backtickMatch[1].trim();
        }
        // Strategy 2: Extract from "Run:" prefix
        // e.g., "Run: python hello.py"
        const runPrefixMatch = description.match(/^Run:\s*(.+)/i);
        if (runPrefixMatch) {
            return runPrefixMatch[1].trim();
        }
        // Strategy 3: Ask the LLM what command to run
        return await this.askLLMForCommand(context, callLLM);
    }
    /**
     * Execute a command inside a Docker sandbox container.
     * Falls back to host execution if Docker is not available.
     */
    async executeWithDocker(context, command) {
        const sandboxManager = new SandboxManager();
        let containerId = '';
        try {
            // Check Docker availability
            const dockerAvailable = await sandboxManager.isDockerAvailable();
            if (!dockerAvailable) {
                // Fall back to host execution
                return this.executeOnHost(context, command);
            }
            // Detect the right image for the project
            const image = detectProjectImage(context.workingDirectory);
            // Allow timeout override via context.metadata.runnerTimeout
            const timeoutMs = (typeof context.metadata.runnerTimeout === 'number')
                ? context.metadata.runnerTimeout
                : DEFAULT_TIMEOUT_MS;
            // Create a Docker container (use default /workspace as workdir)
            containerId = await sandboxManager.createContainer(image.image, {
                memoryLimit: '512m',
                cpuLimit: 0.5,
                timeoutMs,
                networkAccess: false,
            });
            // Copy project files to the container's workspace
            await sandboxManager.copyProjectToContainer(containerId, context.workingDirectory);
            // Run the command inside the container
            if (context.metadata.verboseLogging) {
                logger.info(`     Running (Docker): ${command}`);
            }
            const result = await sandboxManager.runCommand(containerId, command, timeoutMs);
            // Build run result from sandbox result
            const runResult = {
                success: result.success,
                command,
                exitCode: result.exitCode,
                stdout: result.stdout.slice(0, MAX_OUTPUT_LENGTH),
                stderr: result.stderr.slice(0, MAX_OUTPUT_LENGTH),
                duration: result.durationMs,
                error: result.error,
            };
            context.metadata['runResult'] = runResult;
            // Build summary
            const lines = [];
            lines.push(`Command: ${command} (Docker)`);
            lines.push(`Exit code: ${result.exitCode}`);
            lines.push(`Duration: ${result.durationMs}ms`);
            if (result.stdout) {
                const truncated = result.stdout.length > 500;
                lines.push(`stdout:${truncated ? ' (first 500 chars)' : ''}`);
                lines.push(result.stdout.slice(0, 500));
                if (truncated)
                    lines.push(`... (${result.stdout.length - 500} more chars)`);
            }
            if (result.stderr && result.exitCode !== 0) {
                const truncated = result.stderr.length > 500;
                lines.push(`stderr:${truncated ? ' (first 500 chars)' : ''}`);
                lines.push(result.stderr.slice(0, 500));
                if (truncated)
                    lines.push(`... (${result.stderr.length - 500} more chars)`);
            }
            // Clean up
            await sandboxManager.destroyContainer(containerId).catch(() => { });
            return {
                success: result.exitCode === 0,
                summary: result.exitCode === 0
                    ? `✅ Command succeeded (Docker): ${command}`
                    : `❌ Command failed (exit ${result.exitCode}): ${command}`,
                details: lines.join('\n'),
                error: result.error || undefined,
            };
        }
        catch (err) {
            if (containerId) {
                await sandboxManager.destroyContainer(containerId).catch(() => { });
            }
            const msg = err instanceof Error ? err.message : String(err);
            return {
                success: false,
                summary: 'Docker sandbox execution failed',
                error: msg,
            };
        }
    }
    /**
     * Check whether a command is likely to succeed before executing it.
     * Currently validates:
     * - `npm test` / `npm run test`: checks that the project's package.json has a `test` script
     */
    isCommandAvailable(command, workingDir) {
        // Check npm test commands
        const npmTestPattern = /^npm\s+(run\s+)?test(\s|$)/;
        if (npmTestPattern.test(command.trim())) {
            const pkgPath = join(workingDir, 'package.json');
            if (existsSync(pkgPath)) {
                try {
                    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
                    if (!pkg.scripts?.test) {
                        return {
                            available: false,
                            reason: `Project at ${workingDir} has no "test" script in package.json. ` +
                                `The command "${command}" would fail with "Missing script: test".`,
                        };
                    }
                }
                catch {
                    return {
                        available: false,
                        reason: `Could not parse package.json at ${pkgPath} to check for a test script.`,
                    };
                }
            }
            else {
                return {
                    available: false,
                    reason: `No package.json found at ${workingDir}. The command "${command}" requires an npm project.`,
                };
            }
        }
        return { available: true };
    }
    /**
     * Execute a command directly on the host machine.
     * Validates the command first, and falls back to LLM suggestion if the command is not available.
     */
    async executeOnHost(context, command, fallbackAttempts = 0) {
        // Validate the command before executing
        const validation = this.isCommandAvailable(command, context.workingDirectory);
        if (!validation.available) {
            if (context.metadata.verboseLogging) {
                logger.info(`     ⚠️  Command validation: ${validation.reason}`);
            }
            // Try LLM fallback (up to MAX_FALLBACK_ATTEMPTS times)
            if (fallbackAttempts < MAX_FALLBACK_ATTEMPTS && this._callLLM) {
                const altCommand = await this.askLLMForCommand(context, this._callLLM);
                if (altCommand && altCommand !== command) {
                    if (context.metadata.verboseLogging) {
                        logger.info(`     🔄 LLM suggested alternative command (attempt ${fallbackAttempts + 1}): ${altCommand}`);
                    }
                    return this.executeOnHost(context, altCommand, fallbackAttempts + 1);
                }
            }
            // No alternative — return a clear error instead of running a broken command
            return {
                success: false,
                summary: `Command not available: ${command}`,
                error: validation.reason,
            };
        }
        if (context.metadata.verboseLogging) {
            logger.info(`     Running: ${command}`);
        }
        const timeoutMs = (typeof context.metadata.runnerTimeout === 'number')
            ? context.metadata.runnerTimeout
            : DEFAULT_TIMEOUT_MS;
        const startTime = Date.now();
        let exitCode = 0;
        let stdout = '';
        let stderr = '';
        let execError;
        try {
            const output = execSync(command, {
                cwd: context.workingDirectory,
                timeout: timeoutMs,
                stdio: 'pipe',
                encoding: 'utf-8',
                shell: getHostShell(),
                maxBuffer: 1024 * 1024,
            });
            stdout = output.trim();
        }
        catch (err) {
            const error = err;
            exitCode = error.status ?? 1;
            stdout = (typeof error.stdout === 'string' ? error.stdout : String(error.stdout || '')).trim();
            stderr = (typeof error.stderr === 'string' ? error.stderr : String(error.stderr || '')).trim();
            execError = error.message;
        }
        const duration = Date.now() - startTime;
        const runResult = {
            success: exitCode === 0,
            command,
            exitCode,
            stdout: stdout.slice(0, MAX_OUTPUT_LENGTH),
            stderr: stderr.slice(0, MAX_OUTPUT_LENGTH),
            duration,
            error: execError,
        };
        context.metadata['runResult'] = runResult;
        const lines = [];
        lines.push(`Command: ${command}`);
        lines.push(`Exit code: ${exitCode}`);
        lines.push(`Duration: ${duration}ms`);
        if (stdout) {
            const truncated = stdout.length > 500;
            lines.push(`stdout:${truncated ? ' (first 500 chars)' : ''}`);
            lines.push(stdout.slice(0, 500));
            if (truncated)
                lines.push(`... (${stdout.length - 500} more chars)`);
        }
        if (stderr && exitCode !== 0) {
            const truncated = stderr.length > 500;
            lines.push(`stderr:${truncated ? ' (first 500 chars)' : ''}`);
            lines.push(stderr.slice(0, 500));
            if (truncated)
                lines.push(`... (${stderr.length - 500} more chars)`);
        }
        return {
            success: exitCode === 0,
            summary: exitCode === 0
                ? `✅ Command succeeded: ${command}`
                : `❌ Command failed (exit ${exitCode}): ${command}`,
            details: lines.join('\n'),
            error: execError && exitCode !== 0 ? execError : undefined,
        };
    }
    /**
     * Fallback: ask the LLM what command to run based on the project context.
     * Includes project's package.json metadata so the LLM can make an informed choice.
     */
    async askLLMForCommand(context, callLLM) {
        const fileList = context.fileChanges
            .map((c) => `  - ${c.path} (${c.status})`)
            .join('\n');
        const artifactList = context.artifacts
            .slice(0, 5)
            .map((a) => `  - ${a.path}`)
            .join('\n');
        // Read available npm scripts if package.json exists
        let scriptsInfo = '';
        try {
            const pkgPath = join(context.workingDirectory, 'package.json');
            if (existsSync(pkgPath)) {
                const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
                if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
                    scriptsInfo = 'Available npm scripts:\n' +
                        Object.entries(pkg.scripts)
                            .map(([name, cmd]) => `  - npm run ${name}: ${cmd}`)
                            .join('\n');
                }
            }
        }
        catch {
            // Ignore — scriptsInfo stays empty
        }
        const prompt = [
            'You are a build-and-run expert. Given the context below, what single shell command should be executed',
            'to verify the work that was done?',
            '',
            'IMPORTANT: Check if "npm test" is available. Only suggest it if the project',
            'actually has a test script defined in package.json.',
            '',
            `Goal: ${context.goal}`,
            '',
            'Files changed:',
            fileList || '  (no files changed)',
            '',
            'Relevant project files:',
            artifactList || '  (empty project)',
            '',
            scriptsInfo || 'No npm scripts available.',
            '',
            'Return ONLY the command to run. Examples: "python hello.py" or "node index.js" or "go run main.go".',
            'Rules:',
            '- Return a single line command only',
            '- No backticks, no explanation, no $ prefix',
            '- Use absolute or working-directory-relative paths',
            '- If unsure, suggest the most appropriate verification command',
            '- NEVER suggest "npm test" if there is no test script in package.json!',
        ].join('\n');
        try {
            const response = await callLLM(prompt, {
                temperature: 0.1,
                maxTokens: 256,
            });
            const command = response.trim().replace(/^```(?:bash|sh)?\s*|\s*```$/g, '').trim();
            if (command && !command.includes('\n') && command.length < 500) {
                return command;
            }
        }
        catch {
            // LLM fallback failed — return null
        }
        return null;
    }
}
//# sourceMappingURL=runner.js.map