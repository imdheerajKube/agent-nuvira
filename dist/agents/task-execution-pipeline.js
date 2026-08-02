/**
 * TaskExecutionPipeline — Structured 6-step task execution pipeline.
 *
 * Enforces a deterministic execution order with automatic data flow between steps:
 *
 *   plan → inspect → edit → test → verify → summarize
 *
 * Each step feeds its output directly into the next step. The pipeline supports
 * retry loops: if verification fails, the pipeline loops back to edit with
 * failure context. Every action is logged to an audit trail for replay/debugging.
 *
 * @see ARCHITECTURE.md §3 — Module Specifications
 * @see ARCHITECTURE.md §4.4 — Data Flow
 *
 * Phase 7 of the architecture migration — replaces ad-hoc agent dispatch with
 * a structured, enforceable pipeline.
 */
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import { logger } from '../utils/logger.js';
import { DefaultInspectModule } from './inspect-module.js';
import { DefaultVerifyModule } from './verify-module.js';
import { DefaultReportModule } from './report-module.js';
import { PipelineAudit } from './pipeline-audit.js';
// ─── Constants ──────────────────────────────────────────────────────────────
const DEFAULT_MAX_VERIFY_RETRIES = 1;
const SOURCE_EXTENSIONS = new Set([
    '.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rs', '.java', '.rb', '.php',
    '.css', '.scss', '.html', '.json', '.yaml', '.yml',
    '.md', '.sql', '.sh', '.bash', '.zsh',
]);
// ─── Task Execution Pipeline ────────────────────────────────────────────────
/**
 * TaskExecutionPipeline — Structured 6-step execution pipeline.
 *
 * Usage:
 * ```typescript
 * const pipeline = new TaskExecutionPipeline();
 * const result = await pipeline.execute('Add JWT auth', {
 *   callLLM,
 *   workingDirectory: process.cwd(),
 *   verbose: true,
 * });
 * console.log(result.success);
 * console.log(result.audit.replay()); // Full audit log
 * ```
 */
export class TaskExecutionPipeline {
    eventBus;
    inspectModule;
    verifyModule;
    reportModule;
    constructor(config) {
        this.eventBus = config?.eventBus ?? getEventBus();
        this.inspectModule = config?.inspectModule ?? new DefaultInspectModule(this.eventBus);
        this.verifyModule = config?.verifyModule ?? new DefaultVerifyModule(this.eventBus);
        this.reportModule = config?.reportModule ?? new DefaultReportModule(this.eventBus);
    }
    /**
     * Execute the full 6-step pipeline.
     *
     * Steps:
     * 1. Plan — Decompose the goal into a structured plan
     * 2. Inspect — Scan codebase for relevant files
     * 3. Edit — Generate code changes
     * 4. Test — Run tests and capture results
     * 5. Verify — Validate changes against quality gates
     * 6. Summarize — Produce final structured report
     */
    async execute(goal, config) {
        const startTime = Date.now();
        const audit = new PipelineAudit(`pipeline-${Date.now()}`, goal);
        const { callLLM, workingDirectory } = config;
        const maxRetries = config.maxVerifyRetries ?? DEFAULT_MAX_VERIFY_RETRIES;
        const verbose = config.verbose ?? false;
        // ── Init ──────────────────────────────────────────────────────────
        audit.log('pipeline', 'pipeline:starting', 'info', `Starting 6-step pipeline for: ${goal.slice(0, 100)}`);
        this.emitEvent(EventNames.ORCHESTRATOR_PIPELINE_STARTED, { goal });
        let retryCount = 0;
        let wasRetried = false;
        // ── Step 1: Plan ──────────────────────────────────────────────────
        const planResult = await this.stepPlan(goal, callLLM, audit, verbose);
        audit.snapshot(0, 'plan', {
            artifactsCollected: 0,
            filesChanged: 0,
            testsPassed: 0,
            testsFailed: 0,
        });
        if (!planResult.success) {
            audit.complete(false);
            this.emitEvent(EventNames.ORCHESTRATOR_PIPELINE_COMPLETED, { goal, success: false });
            return this.buildResult(goal, {
                plan: planResult,
                inspect: { success: false, summary: 'Skipped — plan failed', durationMs: 0 },
                edit: { success: false, summary: 'Skipped — plan failed', durationMs: 0 },
                test: { success: false, summary: 'Skipped — plan failed', durationMs: 0 },
                verify: { success: false, summary: 'Skipped — plan failed', durationMs: 0 },
                summarize: { success: false, summary: 'Skipped — plan failed', durationMs: 0 },
            }, audit, startTime, wasRetried, retryCount);
        }
        // ── Step 2: Inspect ───────────────────────────────────────────────
        const planOutput = planResult.data;
        const inspectResult = await this.stepInspect(planOutput, callLLM, workingDirectory, audit, verbose);
        audit.snapshot(1, 'inspect', {
            artifactsCollected: inspectResult.data?.artifacts.length ?? 0,
            filesChanged: 0,
            testsPassed: 0,
            testsFailed: 0,
        });
        if (!inspectResult.success) {
            audit.complete(false);
            return this.buildResult(goal, { plan: planResult, inspect: inspectResult, ...skipRemaining() }, audit, startTime, wasRetried, retryCount);
        }
        // ── Step 3–5: Edit → Test → Verify (with retry loop) ─────────────
        let editResult = skipStep();
        let testResult = skipStep();
        let verifyResult = skipStep();
        const inspectionOutput = inspectResult.data;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                wasRetried = true;
                retryCount = attempt;
                audit.log('pipeline', 'pipeline:retrying', 'info', `Edit→Verify cycle ${attempt}/${maxRetries}`);
                if (verbose)
                    logger.info(`\n🔄 Retry cycle ${attempt}/${maxRetries}: re-editing after verification failure`);
            }
            // ── Step 3: Edit ──────────────────────────────────────────────
            editResult = await this.stepEdit(planOutput, inspectionOutput, callLLM, workingDirectory, audit, verbose, attempt > 0);
            if (attempt === 0) {
                audit.snapshot(2, 'edit', {
                    artifactsCollected: inspectionOutput.artifacts.length,
                    filesChanged: editResult.data?.changes.length ?? 0,
                    testsPassed: 0,
                    testsFailed: 0,
                });
            }
            if (!editResult.success) {
                audit.log('pipeline', 'pipeline:edit-failed', 'error', editResult.error || 'Edit step failed');
                testResult = { success: false, summary: 'Skipped — edit failed', durationMs: 0 };
                verifyResult = { success: false, summary: 'Skipped — edit failed', durationMs: 0 };
                break;
            }
            // ── Apply changes to disk (unless dry-run) ───────────────────
            if (!config.dryRun && editResult.data) {
                this.applyChanges(editResult.data.changes, workingDirectory, audit, verbose);
            }
            // ── Step 4: Test ──────────────────────────────────────────────
            testResult = await this.stepTest(editResult.data, callLLM, workingDirectory, audit, verbose);
            audit.snapshot(3, 'test', {
                artifactsCollected: inspectionOutput.artifacts.length,
                filesChanged: editResult.data?.changes.length ?? 0,
                testsPassed: testResult.data?.passedCount ?? 0,
                testsFailed: testResult.data?.failedCount ?? 0,
            });
            // ── Step 5: Verify ────────────────────────────────────────────
            verifyResult = await this.stepVerify(editResult.data, testResult.data, planOutput.goal, callLLM, config.strictness, audit, verbose);
            audit.snapshot(4, 'verify', {
                artifactsCollected: inspectionOutput.artifacts.length,
                filesChanged: editResult.data?.changes.length ?? 0,
                testsPassed: testResult.data?.passedCount ?? 0,
                testsFailed: testResult.data?.failedCount ?? 0,
            });
            // If verification passed, break out of retry loop
            if (verifyResult.success) {
                break;
            }
            // If verification failed and we have retries left, log and loop
            if (attempt < maxRetries) {
                audit.log('verify', 'verify:retrying', 'warning', 'Verification failed — retrying edit cycle');
                if (verbose)
                    logger.warn('\n⚠️  Verification failed — re-entering edit phase with failure context');
            }
        }
        // ── Step 6: Summarize ─────────────────────────────────────────────
        const summarizeResult = await this.stepSummarize(goal, { plan: planResult, inspect: inspectResult, edit: editResult, test: testResult, verify: verifyResult }, startTime, audit, verbose);
        // ── Complete ────────────────────────────────────────────────────
        const success = verifyResult?.success ?? false;
        audit.complete(success);
        this.emitEvent(EventNames.ORCHESTRATOR_PIPELINE_COMPLETED, { goal, success });
        if (verbose) {
            logger.success(`\n📋 Pipeline complete: ${success ? '✅ Passed' : '❌ Failed'}`);
            logger.info(`   Duration: ${this.formatElapsed(Date.now() - startTime)}`);
            logger.info(`   Audit trail: ${audit.getTrail().entries.length} entries, ${audit.getTrail().snapshots.length} snapshots`);
        }
        return this.buildResult(goal, {
            plan: planResult,
            inspect: inspectResult,
            edit: editResult,
            test: testResult,
            verify: verifyResult,
            summarize: summarizeResult,
        }, audit, startTime, wasRetried, retryCount);
    }
    // ─── Step Implementations ─────────────────────────────────────────────
    /**
     * Step 1: Plan — Decompose the user's goal into a structured execution plan.
     *
     * Uses the LLM to produce a list of task descriptions that guide the
     * subsequent inspect and edit steps.
     */
    async stepPlan(goal, callLLM, audit, verbose) {
        const stepStart = Date.now();
        audit.log('plan', 'plan:started', 'info', 'Decomposing goal into tasks');
        if (verbose)
            logger.highlight('\n📋 Phase 1: Plan');
        if (verbose)
            logger.info('   Decomposing goal into structured task plan...');
        try {
            const prompt = this.buildPlanPrompt(goal);
            const response = await callLLM(prompt, { temperature: 0.3, maxTokens: 1024 });
            const tasks = this.parsePlanResponse(response);
            if (tasks.length === 0) {
                audit.log('plan', 'plan:empty', 'warning', 'LLM returned no tasks — using goal as single task');
                tasks.push(goal);
            }
            const complexity = tasks.length <= 3 ? 'simple' : tasks.length <= 7 ? 'moderate' : 'complex';
            const output = { goal, tasks, complexity };
            const duration = Date.now() - stepStart;
            audit.log('plan', 'plan:completed', 'success', `Plan created: ${tasks.length} tasks (${complexity})`, {
                taskCount: tasks.length,
                complexity,
            });
            if (verbose) {
                logger.success(`   ✅ Plan created: ${tasks.length} tasks (${complexity})`);
                for (let i = 0; i < tasks.length; i++) {
                    logger.info(`      ${i + 1}. ${tasks[i].slice(0, 80)}`);
                }
            }
            // Inject the plan event via a plain string
            this.eventBus.emit('plan:step-created', {
                goal,
                taskCount: tasks.length,
                complexity,
            }, 'task-execution-pipeline');
            return { success: true, summary: `Created ${tasks.length} tasks`, data: output, durationMs: duration };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            audit.log('plan', 'plan:failed', 'error', `Planning failed: ${msg}`);
            if (verbose)
                logger.error(`   ❌ Planning failed: ${msg}`);
            return { success: false, summary: 'Planning failed', error: msg, durationMs: Date.now() - stepStart };
        }
    }
    /**
     * Step 2: Inspect — Scan the codebase for files relevant to the goal.
     *
     * Delegates to the InspectModule (Phase 5/6) which uses LLM-based
     * file classification with keyword-scanning fallback.
     */
    async stepInspect(plan, callLLM, workingDirectory, audit, verbose) {
        const stepStart = Date.now();
        audit.log('inspect', 'inspect:started', 'info', 'Scanning codebase for relevant files');
        if (verbose)
            logger.highlight('\n📁 Phase 2: Inspect');
        if (verbose)
            logger.info('   Scanning codebase for relevant files...');
        try {
            const result = await this.inspectModule.inspect({
                goal: plan.goal,
                workingDirectory,
                taskDescriptions: plan.tasks,
                maxFiles: 15,
                callLLM,
            });
            const duration = Date.now() - stepStart;
            audit.log('inspect', 'inspect:completed', 'success', `Found ${result.artifacts.length} relevant files (${result.stats.totalFiles} total scanned)`, {
                artifactsFound: result.artifacts.length,
                totalFiles: result.stats.totalFiles,
                llmFallback: result.stats.llmFallbackUsed,
            });
            if (verbose) {
                logger.success(`   ✅ Found ${result.artifacts.length} relevant files across ${result.stats.totalFiles} total`);
                if (result.stats.llmFallbackUsed) {
                    logger.info('      (keyword-scanning fallback used)');
                }
                for (const art of result.artifacts.slice(0, 5)) {
                    logger.info(`      📄 ${art.path}`);
                }
                if (result.artifacts.length > 5) {
                    logger.info(`      ... and ${result.artifacts.length - 5} more`);
                }
            }
            return { success: true, summary: `Found ${result.artifacts.length} files`, data: result, durationMs: duration };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            audit.log('inspect', 'inspect:failed', 'error', `Codebase inspection failed: ${msg}`);
            if (verbose)
                logger.error(`   ❌ Inspection failed: ${msg}`);
            return { success: false, summary: 'Inspection failed', error: msg, durationMs: Date.now() - stepStart };
        }
    }
    /**
     * Step 3: Edit — Generate code changes based on the plan and inspection results.
     *
     * Uses the LLM to produce file changes. Each change includes before/after
     * content for auditability.
     */
    async stepEdit(plan, inspection, callLLM, workingDirectory, audit, verbose, isRetry) {
        const stepStart = Date.now();
        const label = isRetry ? ' (retry)' : '';
        audit.log('edit', 'edit:started', 'info', `Generating code changes${label}`);
        if (verbose)
            logger.highlight(`\n✍️  Phase 3: Edit${label}`);
        if (verbose)
            logger.info('   Generating code changes...');
        try {
            const changes = [];
            const warnings = [];
            // Build a single prompt with all context
            const prompt = this.buildEditPrompt(plan, inspection, isRetry);
            const response = await callLLM(prompt, { temperature: isRetry ? 0.1 : 0.3, maxTokens: 4096 });
            // Parse file changes from the LLM response
            const parsed = this.parseEditResponse(response, workingDirectory);
            changes.push(...parsed.changes);
            warnings.push(...parsed.warnings);
            if (changes.length === 0) {
                audit.log('edit', 'edit:no-changes', 'warning', 'No file changes were generated');
                if (verbose)
                    logger.warn('   ⚠️  No changes generated');
            }
            else {
                audit.log('edit', 'edit:completed', 'success', `Generated ${changes.length} file change(s)`, {
                    changeCount: changes.length,
                    createdCount: changes.filter((c) => c.status === 'created').length,
                    modifiedCount: changes.filter((c) => c.status === 'modified').length,
                });
                if (verbose) {
                    logger.success(`   ✅ Generated ${changes.length} file change(s)`);
                    for (const change of changes) {
                        const icon = change.status === 'created' ? '🆕' : change.status === 'modified' ? '✏️' : '🗑️';
                        logger.info(`      ${icon} ${change.path} (${change.status})`);
                    }
                    if (warnings.length > 0) {
                        for (const w of warnings)
                            logger.warn(`      ⚠️  ${w}`);
                    }
                }
            }
            const output = { changes, warnings };
            return { success: true, summary: `Generated ${changes.length} changes`, data: output, durationMs: Date.now() - stepStart };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            audit.log('edit', 'edit:failed', 'error', `Edit generation failed: ${msg}`);
            if (verbose)
                logger.error(`   ❌ Edit failed: ${msg}`);
            return { success: false, summary: 'Edit failed', error: msg, durationMs: Date.now() - stepStart };
        }
    }
    /**
     * Step 4: Test — Run tests and capture results.
     *
     * Uses the LLM to determine the test command or falls back to npm test.
     */
    async stepTest(editOutput, callLLM, workingDirectory, audit, verbose) {
        const stepStart = Date.now();
        audit.log('test', 'test:started', 'info', 'Running tests');
        if (verbose)
            logger.highlight('\n🧪 Phase 4: Test');
        if (editOutput.changes.length === 0) {
            audit.log('test', 'test:skipped', 'info', 'No changes to test — skipping');
            if (verbose)
                logger.info('   No changes to test — skipping');
            return {
                success: true,
                summary: 'Skipped (no changes)',
                data: { passed: true, passedCount: 0, failedCount: 0, totalCount: 0, output: '' },
                durationMs: 0,
            };
        }
        try {
            if (verbose)
                logger.info('   Determining test command...');
            // Determine best test command — try common patterns
            const testCommand = this.detectTestCommand(workingDirectory);
            if (verbose)
                logger.info(`   Test command: ${testCommand}`);
            audit.log('test', 'test:command', 'info', `Running: ${testCommand}`);
            // Execute the test command
            let stdout;
            let stderr;
            let exitCode;
            try {
                const result = execSync(testCommand, {
                    cwd: workingDirectory,
                    timeout: 60_000,
                    maxBuffer: 10 * 1024 * 1024,
                    stdio: 'pipe',
                    shell: true,
                    windowsHide: true,
                });
                stdout = typeof result === 'string' ? result : result.toString();
                stderr = '';
                exitCode = 0;
            }
            catch (execErr) {
                stdout = execErr.stdout?.toString() || '';
                stderr = execErr.stderr?.toString() || '';
                exitCode = execErr.status ?? 1;
            }
            // Parse test results from output
            const parsed = this.parseTestOutput(stdout + '\n' + stderr, exitCode);
            const output = {
                passed: parsed.failedCount === 0,
                passedCount: parsed.passedCount,
                failedCount: parsed.failedCount,
                totalCount: parsed.totalCount,
                output: stdout.slice(0, 2000) + (stderr ? `\nstderr:\n${stderr.slice(0, 1000)}` : ''),
            };
            const duration = Date.now() - stepStart;
            audit.log('test', 'test:completed', output.passed ? 'success' : 'warning', `${output.passedCount}/${output.totalCount} tests passed (exit code: ${exitCode})`, { passed: output.passedCount, failed: output.failedCount, total: output.totalCount, exitCode });
            if (verbose) {
                if (output.passed) {
                    logger.success(`   ✅ ${output.passedCount}/${output.totalCount} tests passed`);
                }
                else {
                    logger.warn(`   ⚠️  ${output.failedCount}/${output.totalCount} tests failed`);
                }
                logger.info(`      Duration: ${this.formatElapsed(duration)}`);
            }
            return { success: output.passed || exitCode === 0, summary: `${output.passedCount}/${output.totalCount} passed`, data: output, durationMs: duration };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            audit.log('test', 'test:failed', 'error', `Test execution failed: ${msg}`);
            if (verbose)
                logger.error(`   ❌ Tests failed: ${msg}`);
            return {
                success: false,
                summary: 'Test execution failed',
                error: msg,
                data: { passed: false, passedCount: 0, failedCount: 0, totalCount: 0 },
                durationMs: Date.now() - stepStart,
            };
        }
    }
    /**
     * Step 5: Verify — Validate changes against quality gates.
     *
     * Checks: security, goal-alignment, test results, code quality.
     * If verification fails, the pipeline can retry the edit step.
     */
    async stepVerify(editOutput, testOutput, goal, callLLM, strictness, audit, verbose) {
        const stepStart = Date.now();
        audit.log('verify', 'verify:started', 'info', 'Running verification checks');
        if (verbose)
            logger.highlight('\n🔍 Phase 5: Verify');
        if (verbose)
            logger.info('   Running verification checks (security, alignment, tests)...');
        try {
            const result = await this.verifyModule.verify({
                changes: editOutput.changes.map((c) => ({
                    path: c.path,
                    status: c.status,
                    newContent: c.newContent,
                    originalContent: c.originalContent,
                })),
                goal,
                testResults: testOutput ? { passed: testOutput.passedCount, failed: testOutput.failedCount, total: testOutput.totalCount } : undefined,
                strictness: strictness ?? 'medium',
                callLLM,
            });
            const duration = Date.now() - stepStart;
            audit.log('verify', 'verify:completed', result.passed ? 'success' : 'warning', `Verification: ${(result.overallScore * 100).toFixed(0)}% score, ${result.blockers.length} blocker(s)`, { score: result.overallScore, checks: result.checks.length, blockers: result.blockers.length });
            if (verbose) {
                const statusIcon = result.passed ? '✅' : '❌';
                logger.info(`   ${statusIcon} Verification score: ${(result.overallScore * 100).toFixed(0)}%`);
                for (const check of result.checks) {
                    const icon = check.passed ? '✅' : check.severity === 'blocking' ? '❌' : '⚠️';
                    logger.info(`      ${icon} ${check.type}: ${check.details.slice(0, 80)}`);
                }
                if (result.blockers.length > 0) {
                    logger.warn(`   🚫 ${result.blockers.length} blocker(s) to resolve`);
                }
                if (result.suggestions.length > 0) {
                    logger.info(`   💡 ${result.suggestions.length} suggestion(s)`);
                }
            }
            return { success: result.passed, summary: `${(result.overallScore * 100).toFixed(0)}% score`, data: result, durationMs: duration };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            audit.log('verify', 'verify:failed', 'error', `Verification failed: ${msg}`);
            if (verbose)
                logger.error(`   ❌ Verification failed: ${msg}`);
            return { success: false, summary: 'Verification failed', error: msg, durationMs: Date.now() - stepStart };
        }
    }
    /**
     * Step 6: Summarize — Produce a final structured report.
     *
     * Delegates to the ReportModule which supports multiple output formats.
     */
    async stepSummarize(goal, stepResults, startTime, audit, verbose) {
        const stepStart = Date.now();
        audit.log('summarize', 'summarize:started', 'info', 'Generating execution summary');
        if (verbose)
            logger.highlight('\n📋 Phase 6: Summarize');
        try {
            const success = stepResults.verify.success;
            const durationMs = Date.now() - startTime;
            // Build agent results from pipeline steps
            const agentResults = [
                { agent: 'Planner', success: stepResults.plan.success, summary: stepResults.plan.summary },
                { agent: 'Inspector', success: stepResults.inspect.success, summary: stepResults.inspect.summary },
                { agent: 'Editor', success: stepResults.edit.success, summary: stepResults.edit.summary },
                { agent: 'Tester', success: stepResults.test.success, summary: stepResults.test.summary },
                { agent: 'Verifier', success: stepResults.verify.success, summary: stepResults.verify.summary },
            ];
            // Build file changes list
            const fileChanges = (stepResults.edit.data?.changes ?? []).map((c) => ({
                path: c.path,
                status: c.status,
            }));
            // Build test summary
            const testSummary = stepResults.test.data
                ? `${stepResults.test.data.passedCount}/${stepResults.test.data.totalCount} tests passed`
                : undefined;
            // Generate the report
            const report = await this.reportModule.generate({
                goal,
                agentResults,
                fileChanges,
                hasFailures: !success,
                durationMs,
                testSummary,
                runOutput: stepResults.test.data?.output,
                error: !success ? (stepResults.verify.error || 'Verification failed') : undefined,
                verificationScore: stepResults.verify.data?.overallScore,
            });
            audit.log('summarize', 'summarize:completed', 'success', 'Execution summary generated', {
                formats: ['text', 'json', 'markdown'],
            });
            if (verbose) {
                const textReport = this.reportModule.format(report, 'text');
                logger.success(`\n📊 Final Report:\n${textReport}`);
            }
            return { success: true, summary: 'Report generated', data: report, durationMs: Date.now() - stepStart };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            audit.log('summarize', 'summarize:failed', 'error', `Report generation failed: ${msg}`);
            return { success: false, summary: 'Report failed', error: msg, durationMs: Date.now() - stepStart };
        }
    }
    // ─── Prompt Builders ──────────────────────────────────────────────────
    /**
     * Build the prompt for the Plan step.
     */
    buildPlanPrompt(goal) {
        return `You are a senior software engineer breaking down a development task.

Goal: ${goal}

Break this goal into 2-8 numbered subtasks that represent a logical implementation order.
Each subtask should be a clear, actionable step that can be implemented independently.

Respond with ONLY a numbered list. No preamble, no explanation.

Example:
1. Create the authentication middleware
2. Add JWT token generation utility
3. Implement login route handler
4. Add protected route guard
5. Write unit tests for auth flow`;
    }
    /**
     * Build the prompt for the Edit step.
     */
    buildEditPrompt(plan, inspection, isRetry) {
        const fileContext = inspection.artifacts
            .map((a) => `--- ${a.path} ---\n${a.content.slice(0, 3000)}`)
            .join('\n\n');
        const taskList = plan.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n');
        const retryNote = isRetry
            ? '\n\nNOTE: Previous attempt did not pass verification. Please ensure your changes are complete and correct.'
            : '';
        return `You are an expert software engineer implementing changes to a codebase.

## Goal
${plan.goal}

## Task Plan
${taskList}

## Relevant Source Files
${fileContext || '(No existing files found — create new files as needed)'}

## Instructions
Implement the changes needed to accomplish the goal. For each file you create or modify, return:
- The COMPLETE updated file content
- A clear filepath: prefix on the code block

Format:
\`\`\`filepath:path/to/file.ts
// FULL file content here
\`\`\`

Rules:
- Return FULL file content, not diffs
- Preserve existing code style
- Add appropriate error handling${retryNote}`;
    }
    // ─── Response Parsers ─────────────────────────────────────────────────
    /**
     * Parse the LLM plan response into a list of task strings.
     */
    parsePlanResponse(response) {
        const lines = response.split('\n');
        const tasks = [];
        for (const line of lines) {
            const trimmed = line.trim();
            // Match numbered lines like "1. Do something" or "- Do something"
            const match = trimmed.match(/^(?:\d+\.|[-*])\s+(.+)/);
            if (match) {
                tasks.push(match[1].trim());
            }
        }
        return tasks;
    }
    /**
     * Parse the LLM edit response into file changes.
     */
    parseEditResponse(response, workingDirectory) {
        const changes = [];
        const warnings = [];
        // Match code blocks with filepath
        const blockRegex = /```(?:[a-zA-Z0-9+#]*\s+)?(?:filepath:)?([^\n`]+(?:\.[a-zA-Z0-9]+|\/[^\n`]+))\n([\s\S]*?)```/g;
        let match;
        while ((match = blockRegex.exec(response)) !== null) {
            let filePath = match[1].trim();
            const content = match[2].trim();
            filePath = filePath.replace(/^['"]|['"]$/g, '').trim();
            if (!filePath || !content)
                continue;
            // Check if file exists
            const absolutePath = isAbsolute(filePath) ? filePath : join(workingDirectory, filePath);
            const exists = existsSync(absolutePath);
            const status = exists ? 'modified' : 'created';
            changes.push({
                path: filePath,
                status,
                newContent: content,
                originalContent: exists ? readFileSafe(absolutePath) : undefined,
            });
        }
        return { changes, warnings };
    }
    /**
     * Parse test output to extract pass/fail counts.
     */
    parseTestOutput(output, exitCode) {
        // Try to parse standard test framework output patterns
        const patterns = [
            // vitest: "Tests  1 failed (3 tests passed, 4 total)"
            /(\d+)\s+passed.*?(\d+)\s+failed/i,
            // jest: "Tests: 1 failed, 2 passed, 3 total"
            /(?:Tests|Test Files):\s*(?:\d+\s+failed,\s*)?(\d+)\s+passed.*?(\d+)\s+total/i,
            // generic: "X passed, Y failed"
            /(\d+)\s+passed.*?(\d+)\s+failed/i,
            // fallback: just total tests
            /(\d+)\s+tests?/i,
        ];
        for (const pattern of patterns) {
            const match = output.match(pattern);
            if (match) {
                const passed = parseInt(match[1], 10) || 0;
                const failed = match[2] ? parseInt(match[2], 10) : 0;
                const total = passed + failed;
                if (total > 0)
                    return { passedCount: passed, failedCount: failed, totalCount: total };
            }
        }
        // If no pattern matched, infer from exit code
        return {
            passedCount: exitCode === 0 ? 1 : 0,
            failedCount: exitCode === 0 ? 0 : 1,
            totalCount: 1,
        };
    }
    /**
     * Detect the best test command for the project.
     */
    detectTestCommand(workingDirectory) {
        const packageJsonPath = join(workingDirectory, 'package.json');
        if (existsSync(packageJsonPath)) {
            try {
                const pkg = JSON.parse(readFileSafe(packageJsonPath) || '{}');
                const testScript = pkg.scripts?.test;
                if (testScript)
                    return testScript;
            }
            catch { /* fall through */ }
        }
        // Check for common test frameworks
        if (existsSync(join(workingDirectory, 'vitest.config.ts')))
            return 'npx vitest run';
        if (existsSync(join(workingDirectory, 'jest.config.js')))
            return 'npx jest';
        if (existsSync(join(workingDirectory, 'pytest.ini')))
            return 'python -m pytest';
        if (existsSync(join(workingDirectory, 'go.mod')))
            return 'go test ./...';
        return 'npm test';
    }
    // ─── File Operations ──────────────────────────────────────────────────
    /**
     * Apply file changes to disk with atomic writes.
     */
    applyChanges(changes, workingDirectory, audit, verbose) {
        let applied = 0;
        for (const change of changes) {
            if (change.status === 'deleted')
                continue;
            if (!change.newContent)
                continue;
            try {
                const absolutePath = isAbsolute(change.path)
                    ? change.path
                    : resolve(workingDirectory, change.path);
                // Ensure directory exists
                const dir = dirname(absolutePath);
                if (!existsSync(dir)) {
                    mkdirSync(dir, { recursive: true });
                }
                // Write file to disk
                writeFileSync(absolutePath, change.newContent, 'utf-8');
                applied++;
                audit.log('edit', 'edit:file-written', 'success', `Written: ${change.path}`, {
                    path: change.path,
                    bytes: change.newContent.length,
                    status: change.status,
                });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                audit.log('edit', 'edit:write-failed', 'error', `Failed to write ${change.path}: ${msg}`);
                if (verbose)
                    logger.error(`      ❌ Failed to write ${change.path}: ${msg}`);
            }
        }
        if (verbose && applied > 0) {
            logger.info(`      💾 Applied ${applied} change(s) to disk`);
        }
    }
    // ─── Helpers ──────────────────────────────────────────────────────────
    /**
     * Emit an event on the event bus.
     */
    emitEvent(event, data) {
        try {
            this.eventBus.emit(event, data, 'task-execution-pipeline');
        }
        catch {
            // Non-critical — event bus may not have all events registered
        }
    }
    /**
     * Format elapsed time as human-readable string.
     */
    formatElapsed(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        if (minutes > 0)
            return `${minutes}m ${seconds % 60}s`;
        if (seconds > 0)
            return `${seconds}.${Math.floor((ms % 1000) / 100)}s`;
        return `${ms}ms`;
    }
    /**
     * Build the final PipelineResult from all step results.
     */
    buildResult(goal, steps, audit, startTime, wasRetried, retryCount) {
        return {
            success: steps.verify.success,
            goal,
            steps,
            audit: audit.getTrail(),
            totalDurationMs: Date.now() - startTime,
            wasRetried,
            retryCount,
        };
    }
}
// ─── Module-level Helpers ───────────────────────────────────────────────────
/**
 * Generate skip results for remaining steps.
 */
function skipStep() {
    return { success: false, summary: 'Skipped', durationMs: 0 };
}
function skipRemaining() {
    return {
        edit: skipStep(),
        test: skipStep(),
        verify: skipStep(),
        summarize: skipStep(),
    };
}
/**
 * Safely read a file, returning undefined on error.
 */
function readFileSafe(filePath) {
    try {
        return readFileSync(filePath, 'utf-8');
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=task-execution-pipeline.js.map