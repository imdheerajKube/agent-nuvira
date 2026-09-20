/**
 * WriterAgent — Proposes code changes based on the task plan and gathered context.
 *
 * For each "writer" step in the execution plan, this agent:
 * 1. Reads the relevant source files (from artifacts in the context bus)
 * 2. Generates modified versions using the LLM
 * 3. Stores FileChange objects in the context bus for the orchestrator to apply
 *
 * The agent does NOT write to disk — it only proposes changes.
 * The orchestrator decides whether to apply them (based on dry-run mode).
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { Agent } from '../agent.js';
import { logger } from '../../utils/logger.js';
import { detectLanguage } from '../../editing/types.js';
import { validateSyntax } from '../../editing/ast.js';
import { buildStructuralContext } from '../../editing/edit.js';
import { BASE_RETRY_DELAY_MS, LONG_WAIT_THRESHOLD_MS, calculateRetryDelay, isRateLimitError, parseModelName, parseRetryAfterHint, } from '../rate-limit-retry.js';
import { referenceDocsFor } from '../reference-docs.js';
import { assessProject } from '../prompt-assembly.js';
/**
 * Build the writer system prompt with project-specific context.
 * Adopts Hermes's pattern: identity → project conventions → task instructions.
 * The prompt changes based on the detected framework, language, and project state.
 */
function buildWriterSystemPrompt(assessment) {
    const base = `You are an expert software engineer implementing changes to a codebase.

Given file contents and an implementation task, you will:
1. Read the current file content carefully
2. Implement the requested changes
3. Return the COMPLETE updated file content for EACH modified file

## Output Format (MANDATORY)

Wrap EACH file you modify in its own code block. The file path MUST go right after the opening backticks with the prefix "filepath:".

CORRECT (use this format):
\`\`\`filepath:path/to/file.ts
// FULL updated file content here
\`\`\`

INCORRECT (do NOT use these):
- ❌ \`\`\`typescript\n...\n\`\`\` (missing filepath)
- ❌ \`\`\`\n...\n\`\`\` (missing language and filepath)
- ❌ Just describing the changes instead of returning the file

## Rules
- Return the FULL file content, not just the changed parts
- Preserve existing code style and conventions
- Add appropriate error handling
- Write clean, well-documented code
- If you modify multiple files, return ONE code block per file`;
    // Inject project-specific conventions (Codebuff pattern: project-aware prompts)
    const conventions = [];
    if (assessment?.framework) {
        const frameworkConventions = {
            react: 'Use React functional components with hooks. Follow React best practices (useEffect cleanup, memo for expensive computations). Use TypeScript for props interfaces.',
            vue: 'Use Vue 3 Composition API with <script setup>. Follow Vue style guide. Use TypeScript for prop definitions.',
            nextjs: 'Use Next.js App Router conventions. Server components by default, client components only when needed (useState, useEffect). Use next/image for images.',
            express: 'Use Express.js middleware patterns. Handle errors with error-handling middleware. Use async/await for route handlers.',
            fastapi: 'Use FastAPI with Pydantic models for request/response schemas. Use async endpoints where possible. Follow FastAPI dependency injection patterns.',
            django: 'Use Django views with class-based views where appropriate. Follow Django ORM patterns. Use Django REST Framework for APIs.',
            python: 'Follow PEP 8 style guide. Use type hints. Use dataclasses or Pydantic for data structures.',
            go: 'Follow Go conventions (gofmt, go vet). Use error wrapping with fmt.Errorf. Prefer table-driven tests.',
            rust: 'Follow Rust API guidelines. Use Result for error handling. Prefer ? operator over unwrap().',
        };
        if (frameworkConventions[assessment.framework]) {
            conventions.push(frameworkConventions[assessment.framework]);
        }
    }
    if (assessment?.language === 'typescript') {
        conventions.push('Use strict TypeScript. Prefer interfaces over type aliases. Use readonly for immutable data.');
    }
    if (assessment?.isGreenfield) {
        conventions.push('This is a greenfield project — create files from scratch. No need to preserve existing code style.');
    }
    if (conventions.length > 0) {
        return `${base}\n\n## Project Conventions\n${conventions.join('\n')}`;
    }
    return base;
}
const WRITER_SYSTEM_PROMPT = buildWriterSystemPrompt();
/** Maximum files to include in a single writer prompt */
const MAX_CONTEXT_FILES = 10;
/** Language tag → file extension for the lenient parse fallback. */
const EXT_BY_LANG = {
    python: '.py',
    py: '.py',
    ini: '.ini',
    json: '.json',
    javascript: '.js',
    js: '.js',
    typescript: '.ts',
    ts: '.ts',
    tsx: '.tsx',
    jsx: '.jsx',
    yaml: '.yml',
    yml: '.yml',
    bash: '.sh',
    sh: '.sh',
    shell: '.sh',
    powershell: '.ps1',
    html: '.html',
    css: '.css',
    markdown: '.md',
    md: '.md',
    text: '.txt',
    txt: '.txt',
    sql: '.sql',
    go: '.go',
    rust: '.rs',
    java: '.java',
    c: '.c',
    cpp: '.cpp',
    ruby: '.rb',
    php: '.php',
};
/**
 * Extract plain fenced code blocks (```lang\n...\n```) WITHOUT a
 * `filepath:` prefix — the blocks the strict parser rejects but the lenient
 * fallback recovers. Returns { lang, content } pairs.
 */
function extractPlainCodeBlocks(response) {
    const blocks = [];
    const fenceRegex = /```([a-zA-Z0-9+#_-]*)\n([\s\S]*?)```/g;
    let m;
    while ((m = fenceRegex.exec(response)) !== null) {
        const lang = (m[1] || '').trim();
        const content = m[2];
        // Skip strict-format blocks (filepath:...) — those are already handled.
        if (/^filepath\s*:/.test(content.trim()))
            continue;
        blocks.push({ lang, content });
    }
    return blocks;
}
/**
 * Extract plausible file-path mentions from free text: tokens ending in a
 * known code extension, optionally prefixed by a directory (e.g.
 * `manifest.ini`, `globalPlugins/hello.py`, `src/utils.ts`). Conservative —
 * dedupes and drops quoted/backticked noise.
 */
function extractPathMentions(text) {
    if (!text)
        return [];
    const seen = new Set();
    const out = [];
    const pathRegex = /([A-Za-z0-9_./-]+\.(?:py|ini|json|js|ts|tsx|jsx|yml|yaml|sh|ps1|html|css|md|txt|sql|go|rs|java|c|cpp|rb|php))\b/g;
    let m;
    while ((m = pathRegex.exec(text)) !== null) {
        let p = m[1];
        // Drop leading ./ and trailing punctuation/quotes.
        p = p.replace(/^[\/.]*/, '').replace(/['"`,;:)]+$/, '').trim();
        if (!p || !p.includes('.'))
            continue;
        if (seen.has(p))
            continue;
        seen.add(p);
        out.push(p);
    }
    return out;
}
/**
 * Maximum total characters across all files sent to the LLM.
 * 16,000 chars ≈ 4,000 tokens — leaves room for the rest of the prompt and response.
 * Files are prioritized: smaller files first, larger files are trunkated if over budget.
 */
const MAX_CONTEXT_CHARS = 16_000;
/** Maximum number of API retry attempts for transient LLM failures (rate limits, timeouts, etc.) */
const MAX_API_RETRIES = 2;
/**
 * Distinguish a GENUINE "no changes needed" LLM judgment from a format
 * failure (Session 46). A writer that explicitly declines — nothing to
 * change, already implemented, no modifications required — produced a valid
 * result and the step is a legitimate no-op. A writer that rambled or was
 * truncated WITHOUT emitting any `filepath:` code block did not do its job;
 * stamping that as a success silently skipped the task's real work (the
 * exact failure observed when a weak model left an NVDA addon incomplete
 * and the reviewer correctly blocked it three times in a row).
 *
 * Exported so sibling LLM-driven modules (EditModule) apply the same
 * decline-vs-format-failure distinction (Session 46 follow-up).
 */
export function responseIndicatesNoChanges(response) {
    const lower = response.toLowerCase();
    return (/no (changes?|modifications?|files?|work) (needed|required|necessary|to (make|change|modify|be made))/.test(lower) ||
        /nothing (to (change|modify|do)|needs (changing|modifying|to be done))/.test(lower) ||
        /(does not|doesn'?t) (need|require) (any )?(changes?|modifications?|work|action)/.test(lower) ||
        /already (implemented|contains|handles|covers|satisfies|satisfied|done|exists|complete|present)/.test(lower) ||
        /no (further|additional) (changes?|work|action) (needed|required)/.test(lower));
}
/**
 * WriterAgent — Proposes code changes by reading files, generating new versions
 * via the LLM, and storing FileChange objects in the shared context.
 * Does NOT write to disk directly; the orchestrator handles that.
 *
 * Retry strategy:
 * 1. Rate-limit (429) errors with LONG wait (>3s): invokes onRateLimit callback
 *    (if available) to let the user choose: wait, switch model, skip, or abort.
 * 2. Rate-limit errors with SHORT wait (<=3s): auto-retry with smart delay.
 * 3. Other transient errors (timeouts, network): auto-retry with backoff.
 * 4. Empty parse results (format issue): retry once with stricter prompt.
 */
export class WriterAgent extends Agent {
    name = 'Writer';
    description = 'Generates code changes based on the plan and context';
    async execute(context, callLLM) {
        let lastError;
        let latestCallLLM = callLLM;
        this.report(context, 'thinking', `Reviewing task and gathered context (${context.artifacts.length} file(s) available)…`);
        // Outer retry loop: handles transient API errors (rate limits, timeouts)
        for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
            try {
                this.report(context, 'drafting', 'Generating code changes…');
                const result = await this.attemptWrite(context, latestCallLLM);
                // Session 46: a GENUINE "no changes needed" decline is a valid no-op —
                // accept it immediately (a misleading "stricter format" retry would
                // only push a declining model to fabricate changes it correctly
                // declined). A FORMAT FAILURE (no filepath: blocks, no decline
                // language) gets one strict-format retry, then FAILS LOUDLY so the
                // orchestrator's repair engine escalates the model instead of
                // silently skipping the task's real work.
                if (result.success && result.summary === 'No files needed changes') {
                    return result;
                }
                if (!result.success && result.summary === 'Writer produced no parseable output') {
                    this.report(context, 'retrying', 'No parseable file changes — retrying with stricter format instructions');
                    const retryResult = await this.attemptWrite(context, latestCallLLM, true);
                    if (retryResult.success && retryResult.summary !== 'No files needed changes') {
                        return retryResult;
                    }
                    return retryResult;
                }
                return result;
            }
            catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
                // ── Rate limit handling with user prompt ─────────────────────
                if (isRateLimitError(lastError) && context.onRateLimit) {
                    const retryAfterMs = parseRetryAfterHint(lastError) || BASE_RETRY_DELAY_MS;
                    if (retryAfterMs >= LONG_WAIT_THRESHOLD_MS) {
                        const modelName = parseModelName(lastError);
                        const action = await context.onRateLimit({
                            retryAfterMs,
                            modelName,
                            agentName: this.name,
                            errorMessage: lastError.slice(0, 300),
                        });
                        if (action.action === 'abort') {
                            logger.error(`Writer aborted by user: ${lastError}`);
                            return {
                                success: false,
                                summary: 'Writer aborted by user due to rate limit',
                                error: lastError,
                            };
                        }
                        if (action.action === 'skip') {
                            logger.info('Writer step skipped by user');
                            return {
                                success: true,
                                summary: 'Skipped by user (rate limit)',
                                details: 'The writer step was skipped because the API rate limit was exceeded.',
                            };
                        }
                        if (action.action === 'switch-model') {
                            logger.info('Switching model per user request...');
                            latestCallLLM = action.callLLM;
                            // Continue the retry loop with the new callLLM
                            await new Promise((resolve) => setTimeout(resolve, 500)); // Brief pause before retry
                            continue;
                        }
                        // 'retry': fall through to wait and retry below
                        logger.warn(`Writer rate limited. Waiting ${(retryAfterMs / 1000).toFixed(1)}s as chosen by user...`);
                        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
                        continue;
                    }
                    // Short wait: auto-retry (fall through to standard retry logic below)
                }
                // ── Standard retry for transient errors ──────────────────────
                if (attempt < MAX_API_RETRIES) {
                    if (isRateLimitError(lastError)) {
                        // Short wait rate limit: auto-retry with smart delay
                        const delayMs = calculateRetryDelay(attempt, lastError);
                        logger.warn(`Writer API error (attempt ${attempt + 1}/${MAX_API_RETRIES + 1}): ` +
                            `${lastError.slice(0, 200)}. Waiting ${(delayMs / 1000).toFixed(1)}s...`);
                        await new Promise((resolve) => setTimeout(resolve, delayMs));
                    }
                    else {
                        // Other transient errors (timeout, network): standard exponential backoff
                        const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
                        logger.warn(`Writer API error (attempt ${attempt + 1}/${MAX_API_RETRIES + 1}): ` +
                            `${lastError.slice(0, 200)}. Retrying in ${(delayMs / 1000).toFixed(1)}s...`);
                        await new Promise((resolve) => setTimeout(resolve, delayMs));
                    }
                    continue;
                }
                // All attempts exhausted
                logger.error(`Writer failed after ${MAX_API_RETRIES + 1} API attempts: ${lastError}`);
                return {
                    success: false,
                    summary: 'Writer failed to generate changes',
                    error: lastError,
                };
            }
        }
        // TypeScript safety — unreachable due to return in catch/finally
        return {
            success: false,
            summary: 'Writer failed to generate changes',
            error: lastError || 'Unknown error',
        };
    }
    /**
     * Perform a single write attempt.
     * Optionally uses a stricter retry prompt.
     */
    async attemptWrite(context, callLLM, isRetry = false) {
        const prompt = this.buildPrompt(context, isRetry);
        // Log prompt size for debugging token limit issues
        const label = isRetry ? 'Retry' : 'Initial';
        logger.debug(`[Writer ${label}] Prompt size: ${prompt.length} chars, ~${Math.ceil(prompt.length / 4)} tokens`);
        const response = await callLLM(prompt, {
            temperature: isRetry ? 0.1 : 0.3, // Lower temperature for retry
            maxTokens: 2048,
        });
        // ── Verbose logging: capture what the LLM actually returned ──────
        logger.debug(`[Writer ${label}] LLM response length: ${response.length} chars`);
        logger.debug(`[Writer ${label}] LLM response preview (first 600 chars):`);
        logger.debug(response.slice(0, 600));
        if (response.length > 600) {
            logger.debug(`[Writer ${label}] ... (${response.length - 600} more chars truncated)`);
        }
        // Extract file changes from the response
        let fileChanges = this.parseFileChanges(response, context.workingDirectory);
        // LENIENT FALLBACK (no-op-escalation gate): when the orchestrator could
        // not escalate to a stronger model (every stronger candidate is blocked —
        // only a weak local model is available), a format-shy model that wraps
        // real code in plain ```lang blocks (no `filepath:` prefix) previously
        // failed the whole task: strict parse → 0 changes → repair → same weak
        // model → same failure until the budget died. The strict contract is
        // still tried FIRST; only when it finds nothing AND the orchestrator
        // explicitly enabled lenient parsing (via metadata) do we recover the
        // model's plain code blocks by inferring each block's path from the task
        // description, reference docs, and the response's own prose.
        if (fileChanges.length === 0 && context.metadata?.lenientFileParsing === true) {
            const lenient = this.parseFileChangesLenient(response, context.workingDirectory, context);
            if (lenient.length > 0) {
                logger.warn(`[Writer ${label}] Strict parse found 0 changes — recovered ${lenient.length} file(s) via lenient inference (no stronger model available)`);
                fileChanges = lenient;
            }
        }
        logger.debug(`[Writer ${label}] Parsed ${fileChanges.length} file change(s)`);
        for (const fc of fileChanges) {
            logger.debug(`[Writer ${label}]   ${fc.status === 'created' ? '\u{1F4C4}' : '\u{270F}\u{FE0F}'} ${fc.path} (${(fc.newContent || '').length} chars)`);
        }
        // Store changes in the shared context
        for (const change of fileChanges) {
            const existing = context.fileChanges.findIndex((c) => c.path === change.path);
            if (existing >= 0) {
                context.fileChanges[existing] = change;
            }
            else {
                context.fileChanges.push(change);
            }
        }
        if (fileChanges.length > 0) {
            const paths = fileChanges.map((c) => c.path).join(', ');
            this.report(context, 'decided', `Proposing changes to ${fileChanges.length} file(s): ${paths}`);
        }
        // ── AST Validation: check syntax for modified files ────────────────
        for (const change of fileChanges) {
            if (change.newContent) {
                const lang = detectLanguage(change.path);
                if (lang !== 'unknown') {
                    const isValid = validateSyntax(change.newContent, lang);
                    if (!isValid) {
                        logger.warn(`[Writer ${label}] Syntax warning: ${change.path} has unbalanced brackets`);
                        // Don't reject — the LLM output may be valid even if our simple
                        // bracket checker fails (e.g., regex patterns with brackets in strings)
                    }
                    else {
                        logger.debug(`[Writer ${label}] Syntax OK: ${change.path}`);
                    }
                }
            }
        }
        const count = fileChanges.length;
        if (count === 0) {
            const excerpt = response.slice(0, 300).replace(/\n/g, '\\n');
            logger.debug(`[Writer ${label}] No files parsed. Response starts with: ${excerpt.slice(0, 200)}...`);
            // Session 46: distinguish a genuine "no changes needed" judgment from a
            // format failure. A model that explicitly declines is a legitimate no-op;
            // a model that returned no `filepath:` code blocks AND did not decline
            // produced an invalid result — surface it as a FAILURE so the repair
            // engine can escalate (the old behavior stamped it success:true, which
            // silently skipped the task's real work and stranded downstream steps).
            if (responseIndicatesNoChanges(response)) {
                return {
                    success: true,
                    summary: 'No files needed changes',
                    details: `Response preview: ${excerpt}...`,
                };
            }
            logger.warn(`[Writer ${label}] LLM returned no parseable file changes (no filepath: code blocks)`);
            return {
                success: false,
                summary: 'Writer produced no parseable output',
                error: `No filepath: code blocks could be parsed from the LLM response (parse error). Response preview: ${excerpt.slice(0, 250)}...`,
            };
        }
        return {
            success: true,
            summary: `Proposed changes to ${count} file${count !== 1 ? 's' : ''}`,
            details: fileChanges
                .map((c) => {
                const icon = c.status === 'created' ? '\u{1F4C4}' : '\u{270F}\u{FE0F}';
                return `  ${icon} ${c.path} (${c.status})`;
            })
                .join('\n'),
        };
    }
    /**
     * Build the prompt for the writer agent from the shared context.
     * Limits the number of files sent to avoid token budget issues.
     * When isRetry is true, uses a more explicit prompt.
     */
    buildPrompt(context, isRetry = false) {
        // Find the writer task for this step. When several writers run in
        // parallel, the orchestrator marks the CURRENT step via
        // metadata.currentTaskId so each writer sees its OWN description.
        const currentTaskId = context.metadata.currentTaskId;
        const writerTask = context.taskPlan.find((s) => s.agentType === 'writer' &&
            (currentTaskId ? s.id === currentTaskId : s.status === 'running'));
        const taskDescription = writerTask?.description || context.goal;
        // Session 46: repair / alternative-approach / review-fix context rides in
        // context.goal (the repair engine appends the failure there, the fix pass
        // appends the review feedback). Surface it whenever it differs from the
        // step description — otherwise a running writer step would swallow the
        // error/fix context and the repair would re-prompt the model with NO
        // information about what failed.
        const goalSection = taskDescription !== context.goal ? `\n\n## Goal\n${context.goal}` : '';
        // Use token-budget-aware file selection: show as many files as possible
        // within MAX_CONTEXT_CHARS, prioritizing smaller files to max context.
        // When the orchestrator's vector-retrieval hook produced a semantic file
        // ranking for this goal (retrievalRanking metadata), prefer those files
        // first so the LLM sees the most RELEVANT code within the token budget
        // (relevance over size — the retrieval layer complements the quota ledger
        // by saving tokens while keeping the important context).
        const retrievalRanking = context.metadata.retrievalRanking || [];
        // Match by BOTH exact path and basename so ranking still works whether the
        // gatherer produced relative or absolute artifact paths (the retrieval
        // index keys may differ in normalization from the artifact path form).
        const rankedPaths = new Set(retrievalRanking.map((r) => r.filePath));
        const rankedBaseNames = new Set(retrievalRanking.map((r) => basename(r.filePath)));
        const isRanked = (p) => rankedPaths.has(p) || rankedBaseNames.has(basename(p));
        // Model-window-aware file budget (T2): the orchestrator sets a budget from
        // the served model's REAL window; fall back to the historical constants when
        // it is unknown, so nothing regresses for a model we cannot discover.
        const fileBudgetChars = typeof context.metadata.contextFileBudgetChars === 'number' && context.metadata.contextFileBudgetChars > 0
            ? context.metadata.contextFileBudgetChars
            : MAX_CONTEXT_CHARS;
        const fileBudgetCount = typeof context.metadata.contextFileBudgetFiles === 'number' && context.metadata.contextFileBudgetFiles > 0
            ? context.metadata.contextFileBudgetFiles
            : MAX_CONTEXT_FILES;
        const filesToSend = this.selectFilesWithinBudget(context.artifacts, fileBudgetChars, (a, b) => {
            const ra = isRanked(a.path) ? 0 : 1;
            const rb = isRanked(b.path) ? 0 : 1;
            if (ra !== rb)
                return ra - rb;
            return 0; // keep the size-first tiebreak inside selectFilesWithinBudget
        }, fileBudgetCount);
        const fileContext = filesToSend.length > 0
            ? filesToSend
                .map(({ artifact, truncated }) => `--- ${artifact.path} ---${truncated ? ` (truncated, ${artifact.content.length}\u2192${truncated.length} chars)` : ''}\n${truncated || artifact.content}`)
                .join('\n\n') +
                (context.artifacts.length > filesToSend.length
                    ? `\n\n... and ${context.artifacts.length - filesToSend.length} more files in the project (excluded to fit token budget)`
                    : '')
            : '(No files found in context — you may need to create new files)';
        // Build structural context for AST-aware editing
        const structuralContexts = context.artifacts
            .filter((a) => a.content)
            .slice(0, 5) // Limit to 5 files to avoid token bloat
            .map((a) => buildStructuralContext(a.content, a.path))
            .filter((s) => s.length > 0);
        const structureSection = structuralContexts.length > 0
            ? `\n## File Structure Overview\n\nHere is the structural layout of the files you need to modify. \nUse these line ranges to understand where each function/class lives.\n\n${structuralContexts.join('\n\n')}\n`
            : '';
        // ── MCP Tools Injection ───────────────────────────────────────────────
        // If MCP servers are connected, inject tool descriptions so the LLM
        // knows what external services are available.
        const mcpToolsFormatted = context.metadata.mcpToolsFormatted;
        const mcpSection = mcpToolsFormatted ? `\n${mcpToolsFormatted}\n` : '';
        // v1.62.4 — Domain reference-docs injection: when the task/goal names a
        // known framework (NVDA addon, ...), inject curated REAL API snippets so
        // the model cannot hallucinate the API. This is the fix for the live
        // NVDA-addon failure (the model invented nvda.register_key_handler instead
        // of using globalPluginHandler/scriptHandler/addonHandler).
        const referenceSection = referenceDocsFor(`${taskDescription} ${context.goal}`);
        const instructions = isRetry
            ? `\n## CRITICAL — Read This Carefully\nThe previous response could not be parsed because the files were not wrapped in correctly formatted code blocks.\n\nYou MUST follow this format EXACTLY for EACH file you modify:\n\n\`\`\`filepath:src/example.ts\n// THE COMPLETE UPDATED FILE CONTENT GOES HERE (every line, full file)\n\`\`\`\n\nIMPORTANT:\n- The filepath: prefix is REQUIRED after the opening backticks\n- Return the FULL file, not a diff or snippet\n- If you modify 2 files, return 2 separate code blocks in this format`
            : `\n## Instructions\nImplement the changes described in the task. Return the complete updated file content for each file you modify. Remember: each file must be wrapped in \`\`\`filepath:...\n\`\`\` format.`;
        // CHANGE-005: Use project-specific writer prompt (Codebuff pattern)
        // Assess the project once and inject framework-specific conventions
        let projectAssessment;
        try {
            projectAssessment = assessProject(context.workingDirectory);
        }
        catch {
            // Best-effort — assessment must never break the writer
        }
        const projectAwarePrompt = buildWriterSystemPrompt(projectAssessment);
        // Skill guidance injection: when the orchestrator matched a skill, inject
        // its methodology into the writer prompt so the implementation follows
        // proven patterns (e.g. deployment commands, game structure, API patterns).
        const skillGuidance = context.metadata.skillGuidance;
        const skillSection = skillGuidance
            ? `\n\n## Skill Guidance (matched: ${skillGuidance.name})\n${skillGuidance.description}\n\nFollow this methodology when implementing:` +
                skillGuidance.steps.map((s) => `\n- [${s.agentType}] ${s.description}`).join('')
            : '';
        // Wire memory into writer prompt (Faiss + SQL integration): failure lessons,
        // patterns, and facts are already stored in the vault by the orchestrator.
        // The planner sees these, but the writer — which actually generates code —
        // must also see them to avoid past mistakes and use proven approaches.
        const failureLessonContext = context.metadata.failureLessonContext;
        const patternContext = context.metadata.patternContext;
        const factContext = context.metadata.factContext;
        const memorySections = [];
        if (failureLessonContext) {
            memorySections.push(`\n\n## Lessons from Past Failures\nAvoid these mistakes — they caused failures in similar tasks:${failureLessonContext}`);
        }
        if (patternContext) {
            memorySections.push(`\n\n## Proven Patterns\nUse these proven approaches from successful similar tasks:${patternContext}`);
        }
        if (factContext) {
            memorySections.push(`\n\n## Project Facts & Preferences\n${factContext}`);
        }
        const memorySection = memorySections.join('');
        return `${projectAwarePrompt}\n\n## Task Description\n${taskDescription}${goalSection}${referenceSection}${skillSection}${memorySection}\n\n## Current File Content\n${fileContext}${structureSection}${mcpSection}\n${instructions}`;
    }
    /**
     * Parse the LLM response to extract file changes.
     */
    parseFileChanges(response, workingDir) {
        const changes = [];
        // Match code blocks containing a real file path.
        const blockRegex = /```(?:[a-zA-Z0-9+#]*\s+)?(?:filepath:)?([^\n`]+(?:\.[a-zA-Z0-9]+|\/[^\n`]+))\n([\s\S]*?)```/g;
        let match;
        while ((match = blockRegex.exec(response)) !== null) {
            let filePath = match[1].trim();
            const content = match[2].trim();
            // Clean up the file path (remove leading/trailing quotes, whitespace)
            filePath = filePath.replace(/^['"]|['"]$/g, '').trim();
            if (!filePath || !content)
                continue;
            this.addFileChange(changes, filePath, content, workingDir);
        }
        return changes;
    }
    /**
     * Lenient file-change recovery — ONLY used when the orchestrator enables it
     * (metadata.lenientFileParsing, set when model escalation is a NO-OP: no
     * stronger model exists). Recovers plain fenced code blocks the model
     * actually emitted (e.g. ```python / ```ini) by inferring each block's
     * path from (1) explicit path mentions in the response's own prose, (2)
     * path mentions in the task description / goal / reference docs, and (3)
     * the block's language tag mapped to a file extension. Conservative: a
     * block with no inferable path is SKIPPED, never guessed.
     */
    parseFileChangesLenient(response, workingDir, context) {
        const changes = [];
        const blocks = extractPlainCodeBlocks(response);
        if (blocks.length === 0)
            return changes;
        // ── Candidate paths, in priority order ───────────────────────────────
        // 1. Explicit paths mentioned in the RESPONSE prose (the model usually
        //    names the file it's writing: "Create manifest.ini" / "in
        //    globalPlugins/hello.py").
        const prosePaths = extractPathMentions(response);
        // 2. Paths named by the task description + goal (e.g. "the addon file
        //    (e.g., hello_dheeraj_addon.py)" / "manifest.ini").
        const taskPaths = extractPathMentions(`${context.goal} ${(context.taskPlan || []).map((s) => s.description).join(' ')}`);
        // 3. Paths named by the reference-docs section (curated real API files:
        //    manifest.ini, globalPlugins/your_addon.py, buildVars.py).
        let refPaths = [];
        try {
            refPaths = extractPathMentions(referenceDocsFor(`${context.goal} ${(context.taskPlan || []).map((s) => s.description).join(' ')}`));
        }
        catch {
            // Best-effort — reference docs must never break the lenient parse.
        }
        const candidates = [...prosePaths, ...taskPaths, ...refPaths].filter(Boolean);
        // ── Match blocks to paths ────────────────────────────────────────────
        // For each plain block, find the FIRST candidate whose extension matches
        // the block's language (python→.py, ini→.ini, json→.json, ...). Fall back
        // to the first candidate when the block has no language tag. Dedupe so
        // two blocks never claim the same file.
        const claimed = new Set();
        for (const block of blocks) {
            const ext = EXT_BY_LANG[block.lang.toLowerCase()];
            let path;
            // Prefer a candidate whose basename the block's prose introduces.
            for (const cand of candidates) {
                if (claimed.has(cand))
                    continue;
                if (ext && cand.toLowerCase().endsWith(ext)) {
                    path = cand;
                    break;
                }
            }
            if (!path && !ext) {
                // Untagged block: take the first unclaimed candidate (only when the
                // response names exactly one file — otherwise ambiguous → skip).
                const unclaimed = candidates.filter((c) => !claimed.has(c));
                if (unclaimed.length === 1)
                    path = unclaimed[0];
            }
            if (!path)
                continue;
            claimed.add(path);
            const content = block.content.trim();
            if (!content)
                continue;
            this.addFileChange(changes, path, content, workingDir);
        }
        return changes;
    }
    /**
     * Select files within the given character budget.
     * Prioritizes smaller files first so the LLM sees as much complete context as possible.
     */
    selectFilesWithinBudget(artifacts, budget, priorityComparator, 
    /** Model-window-aware file cap; defaults to the historical constant. */
    maxFiles = MAX_CONTEXT_FILES) {
        const sorted = [...artifacts]
            .map((a) => ({ artifact: a, size: a.content.length }))
            .sort((a, b) => {
            // Optional priority pass (e.g. retrieval-ranking first), then size-first.
            const cmp = priorityComparator ? priorityComparator(a.artifact, b.artifact) : 0;
            return cmp !== 0 ? cmp : a.size - b.size;
        });
        const result = [];
        let used = 0;
        const OVERHEAD_PER_FILE = 50;
        for (const { artifact, size } of sorted) {
            if (result.length >= maxFiles)
                break;
            const totalNeeded = size + OVERHEAD_PER_FILE;
            if (used + totalNeeded <= budget) {
                result.push({ artifact, truncated: null });
                used += totalNeeded;
            }
            else if (used + OVERHEAD_PER_FILE < budget) {
                const remaining = budget - used - OVERHEAD_PER_FILE;
                if (remaining > 200) {
                    const truncated = artifact.content.slice(0, remaining);
                    result.push({ artifact, truncated });
                    used = budget;
                }
                break;
            }
            else {
                break;
            }
        }
        return result;
    }
    addFileChange(changes, filePath, content, workingDir) {
        const absolutePath = isAbsolute(filePath) ? filePath : join(workingDir, filePath);
        if (existsSync(absolutePath)) {
            const originalContent = readFileSync(absolutePath, 'utf-8');
            if (originalContent.trim() !== content.trim()) {
                changes.push({
                    path: filePath,
                    originalContent,
                    newContent: content,
                    status: 'modified',
                });
            }
        }
        else {
            changes.push({
                path: filePath,
                newContent: content,
                status: 'created',
            });
        }
    }
}
//# sourceMappingURL=writer.js.map