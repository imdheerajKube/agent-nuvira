/**
 * PlannerAgent — Analyzes a user goal and produces an ordered, dependency-aware
 * execution plan consisting of TaskSteps for other agents to execute.
 *
 * The planner is the first agent to run in every orchestration session.
 * It now receives the project file tree (injected by the Orchestrator via
 * context.metadata.projectFileTree) so it can make informed decisions about
 * which files to create, modify, or reference in its plan.
 */
import { Agent } from '../agent.js';
const PLANNER_SYSTEM_PROMPT = [
    'You are a senior software architect. Your job is to decompose a user\'s goal into a detailed, ordered execution plan.',
    '',
    'For each step, specify:',
    '- id: A short unique identifier (e.g., "step-01-gather-context")',
    '- description: What needs to be done in clear language',
    '- agentType: One of "context-gatherer", "writer", "reviewer", "tester", "debugger", "runner", "security", "mcp", "git", "gitlab", "pr-review"',
    '- dependsOn: Array of step IDs that must complete before this one (empty array for first steps)',
    '- complexity: One of "trivial", "simple", "moderate", "complex", "critical" — label THIS subtask\'s difficulty (routing uses it to pick the cheapest adequate model)',
    '',
    'Rules:',
    '1. Start with a "context-gatherer" step to understand the codebase (if files exist)',
    '2. Add one or more "writer" steps to implement changes (max 2-3 files per step)',
    '3. If the project is EMPTY or the goal is to CREATE something from scratch,',
    '   skip the context-gatherer step and go straight to writer steps.',
    '4. For goals that require running something (like "create a Python script and run it"),',
    '   add a "runner" step AFTER the writer step(s).',
    '   Use the description to specify the command: "Run: python hello.py" or "Run `node index.js`"',
    '   IMPORTANT: Only suggest "npm test" if the project already has a "test" script in its package.json!',
    '   Check the project structure above — if there\'s no test script, skip the test step.',
    '5. End with a "reviewer" step to validate the work',
    '6. Set dependsOn correctly so steps run in the right order',
    '7. Keep steps granular — each step should change at most 2-3 files',
    '8. Maximum 12 steps total',
    '9. PARALLELISM: independent steps run CONCURRENTLY — the execution engine',
    '   batches every step whose dependencies are satisfied, so do NOT chain',
    '   steps serially when they could run in parallel. When the goal has',
    '   independent parts (separate files/modules/concerns), create MULTIPLE',
    '   writer steps with EMPTY or shared dependencies (so they run at the same',
    '   time) and ONE reviewer step whose dependsOn lists ALL of them.',
    '',
    'Return ONLY a valid JSON array. No markdown, no explanations.',
    '',
    'CRITICAL — DO NOT COPY THE EXAMPLES:',
    'The examples below show the JSON STRUCTURE and dependency pattern ONLY.',
    'Never copy their content, file paths, domains, or topics. Every step must',
    'directly serve the User Goal below — if the goal is about something other',
    'than authentication, your steps must NOT mention routes/auth/JWT/middleware.',
    'Steps must be specific to the user\'s goal, not a generic template.',
    '',
    'Example (modifying an existing project — structure only):',
    '[',
    '  {',
    '    "id": "step-01-understand",',
    '    "description": "Scan the codebase to understand the current project structure and identify files related to the inventory sync feature",',
    '    "agentType": "context-gatherer",',
    '    "complexity": "simple",',
    '    "dependsOn": []',
    '  },',
    '  {',
    '    "id": "step-02-add-routes",',
    '    "description": "Create the inventory sync endpoint in src/sync/inventory.ts that reads the local catalog and reconciles it with the remote store",',
    '    "agentType": "writer",',
    '    "complexity": "moderate",',
    '    "dependsOn": ["step-01-understand"]',
    '  },',
    '  {',
    '    "id": "step-03-add-middleware",',
    '    "description": "Add validation for the sync input format in src/sync/validate.ts",',
    '    "agentType": "writer",',
    '    "complexity": "moderate",',
    '    "dependsOn": ["step-01-understand"]',
    '  },',
    '  {',
    '    "id": "step-04-security-scan",',
    '    "description": "Scan the new sync code for PII and injection vulnerabilities",',
    '    "agentType": "security",',
    '    "complexity": "moderate",',
    '    "dependsOn": ["step-02-add-routes", "step-03-add-middleware"]',
    '  },',
    '  {',
    '    "id": "step-05-review",',
    '    "description": "Review all changes for correctness, security, and code quality",',
    '    "agentType": "reviewer",',
    '    "complexity": "complex",',
    '    "dependsOn": ["step-02-add-routes", "step-03-add-middleware"]',
    '  }',
    ']',
    '',
    'Note: step-02 and step-03 depend only on step-01, so the engine runs them in',
    'PARALLEL; step-04 (security) and step-05 (review) then run after BOTH finish.',
    '',
    'Example (creating from scratch + running):',
    '[',
    '  {',
    '    "id": "step-01-create-script",',
    '    "description": "Create a Python script hello.py that prints Hello, World!",',
    '    "agentType": "writer",',
    '    "dependsOn": []',
    '  },',
    '  {',
    '    "id": "step-02-run-script",',
    '    "description": "Run: python hello.py', '    "agentType": "runner",',
    '    "dependsOn": ["step-01-create-script"]',
    '  },',
    '  {',
    '    "id": "step-03-review",',
    '    "description": "Verify the output is correct",',
    '    "agentType": "reviewer",',
    '    "dependsOn": ["step-02-run-script"]',
    '  }',
    ']',
].join('\n');
/**
 * PlannerAgent — Decomposes user goals into ordered task plans.
 * Now accepts `projectFileTree` from context.metadata to make informed plans.
 */
export class PlannerAgent extends Agent {
    name = 'Planner';
    description = 'Analyzes user goals and creates detailed execution plans';
    async execute(context, callLLM) {
        try {
            // Check for file tree (injected by Orchestrator) and memory context
            const fileTree = context.metadata.projectFileTree;
            const inspection = context.metadata.projectInspection;
            const memoryContext = context.metadata.memoryContext;
            this.report(context, 'analyzing', 'Analyzing goal and current project structure…');
            const routingContext = context.metadata.routingContext;
            const promptParts = [
                PLANNER_SYSTEM_PROMPT,
                '',
                '## User Goal',
                context.goal,
                '',
                '## Working Directory',
                context.workingDirectory,
            ];
            if (routingContext?.taskProfile) {
                const routingNotes = routingContext.taskProfile.notes?.filter(Boolean) ?? [];
                const guidanceLines = [
                    '',
                    '## Routing Guidance',
                ];
                if (routingContext.taskProfile.intent) {
                    guidanceLines.push(`Task intent: ${routingContext.taskProfile.intent}`);
                }
                if (routingContext.taskProfile.requiresVerification) {
                    guidanceLines.push('This is verification-heavy work. Include an explicit validation step and end with a reviewer step.');
                }
                if (routingNotes.length > 0) {
                    guidanceLines.push(`Notes: ${routingNotes.join(' ')}`);
                }
                if (routingContext.explanation) {
                    guidanceLines.push(`Rationale: ${routingContext.explanation}`);
                }
                promptParts.push(...guidanceLines);
            }
            // Inject the project file tree so the planner knows what exists
            if (fileTree) {
                const treeLines = fileTree.split('\n').length;
                promptParts.push('', '## Current Project Structure', fileTree || '(empty directory — no source files found)', treeLines > 1 ? `\n(${treeLines} files/directories visible)` : ' (empty)');
            }
            else {
                promptParts.push('', '## Current Project Structure', '(unknown — file tree not available)');
            }
            // Inject the deterministic pre-flight inspection digest (framework, test
            // suite, git state) so the plan reuses what already exists instead of
            // reworking it — e.g. don't add a test step when tests already exist.
            if (inspection) {
                promptParts.push('', '## Pre-flight Project Inspection', inspection);
            }
            // Append memory/few-shot examples if available
            if (memoryContext) {
                promptParts.push('', memoryContext);
            }
            promptParts.push('', 'Create an execution plan for this goal. Return ONLY a valid JSON array of task steps.');
            const prompt = promptParts.join('\n');
            this.report(context, 'drafting', 'Drafting a dependency-aware execution plan…');
            const response = await callLLM(prompt, {
                temperature: 0.3, // Low temperature for structured output
                maxTokens: 4096,
            });
            const rawPlan = this.parsePlan(response);
            // Normalize and validate each step
            // LLMs often return numbers for id, null for dependsOn, or different formats
            const plan = [];
            for (const step of rawPlan) {
                if (!step || typeof step !== 'object')
                    continue;
                if (!step.description || !step.agentType)
                    continue;
                // Normalize: convert id to string if it's a number
                const id = String(step.id ?? `step-${plan.length + 1}`);
                // Normalize: dependsOn can be null, undefined, a single string, or an array
                let dependsOn = [];
                if (Array.isArray(step.dependsOn)) {
                    dependsOn = step.dependsOn.map((d) => String(d));
                }
                else if (typeof step.dependsOn === 'string' || typeof step.dependsOn === 'number') {
                    dependsOn = [String(step.dependsOn)];
                }
                // Normalize the per-subtask complexity label (assessment item #1).
                // Only accept valid levels; anything else is left undefined so the
                // orchestrator applies a deterministic analyzeComplexity fallback.
                const rawComplexity = step.complexity;
                const VALID_COMPLEXITY = ['trivial', 'simple', 'moderate', 'complex', 'critical'];
                const complexity = VALID_COMPLEXITY.includes(rawComplexity)
                    ? rawComplexity
                    : undefined;
                plan.push({
                    id,
                    description: String(step.description),
                    agentType: String(step.agentType),
                    dependsOn,
                    complexity,
                    status: 'pending',
                });
            }
            if (plan.length === 0) {
                this.report(context, 'failed', 'Could not produce a valid plan — retrying with a different approach');
                return {
                    success: false,
                    summary: 'Planner produced an empty or invalid plan',
                    details: response,
                    error: 'The LLM returned a plan with no valid task steps',
                };
            }
            // ── Goal-fidelity guard (assessment P0: "deliver the goal, not a template") ──
            // Reject plans that don't reference the goal at all. This catches the
            // failure mode where a confused model regurgitates the few-shot EXAMPLE
            // (e.g. JWT routes) for an unrelated goal (e.g. an NVDA addon), or plans
            // around a memory pattern that doesn't match. The plan must share at
            // least one significant goal token with its step descriptions.
            // Goal-fidelity: the plan must share at least one significant goal token.
            // Require ≥ 2 goal tokens for the word check: a 1-token goal (e.g. "add
            // authentication") is too easy for a faithful PARAPHRASED plan to miss
            // ("login routes with JWT" shares no word with "authentication"), which
            // would false-reject good work. For short 1-token goals we instead check
            // for EXAMPLE-COPY markers — the observed failure mode where a confused
            // model regurgitates the few-shot example verbatim (JWT routes for an
            // NVDA-addon goal).
            const goalTokens = significantGoalTokens(context.goal);
            const planText = plan
                .map((s) => `${s.description} ${s.agentType}`)
                .join(' ')
                .toLowerCase();
            let goalMismatch = false;
            if (goalTokens.length >= 2) {
                const matched = goalTokens.filter((t) => hasWordBoundary(planText, t));
                goalMismatch = matched.length === 0;
            }
            else if (goalTokens.length === 1) {
                // Short goal: reject only when the plan ALSO looks like a verbatim
                // template copy (≥ 2 example markers) — a paraphrase of a 1-token
                // goal is otherwise impossible to distinguish reliably.
                const markerHits = EXAMPLE_COPY_MARKERS.filter((m) => planText.includes(m));
                const tokenMatched = hasWordBoundary(planText, goalTokens[0]);
                goalMismatch = markerHits.length >= 2 && !tokenMatched;
            }
            if (goalMismatch) {
                this.report(context, 'failed', 'Plan is unrelated to the goal — retrying');
                return {
                    success: false,
                    summary: 'Planner produced a plan unrelated to the user\'s goal',
                    details: response,
                    error: `The plan is unrelated to the user's goal. ` +
                        `Goal mentions: ${goalTokens.slice(0, 8).join(', ')}... ` +
                        'None of the planned steps reference these terms. Re-plan steps that directly implement the user\'s goal.',
                };
            }
            // Store the parsed plan directly in the shared context for the orchestrator
            context.taskPlan.push(...plan);
            this.report(context, 'decided', `Plan ready: ${plan.length} step(s) — ${plan.map((s) => s.agentType).join(', ')}`);
            return {
                success: true,
                summary: `Created ${plan.length} task steps`,
                details: plan.map((s) => `  [${s.agentType}] ${s.description}`).join('\n'),
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Detect non-chat-model errors and provide helpful suggestions
            let summary = 'Planner failed';
            if (msg.includes('does not support chat completions')) {
                summary = 'Planner failed — selected model does not support text chat. Use a text model like llama-3.3-70b-versatile or llama-3.1-8b-instant';
            }
            return {
                success: false,
                summary,
                error: msg,
            };
        }
    }
    /**
     * Extract the task plan from the LLM response.
     * Tries JSON.parse first, then falls back to extracting from code blocks.
     */
    parsePlan(response) {
        // Try direct JSON parse
        const trimmed = response.trim();
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed))
                return parsed;
        }
        catch {
            // Not direct JSON — try extracting from code block
        }
        // Try extracting from ```json ... ``` block
        const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[1].trim());
                if (Array.isArray(parsed))
                    return parsed;
            }
            catch {
                // Fall through
            }
        }
        // Try finding a JSON array anywhere in the response
        const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
            try {
                const parsed = JSON.parse(arrayMatch[0]);
                if (Array.isArray(parsed))
                    return parsed;
            }
            catch {
                // Fall through
            }
        }
        return [];
    }
}
// ─── Goal-fidelity helpers ──────────────────────────────────────────────────
/**
 * Common English stopwords + generic task verbs excluded from goal tokens.
 * Keeps the relevance check focused on the goal's SUBJECT (the domain nouns),
 * not generic scaffolding words like "create", "add", or "please".
 */
const GOAL_STOPWORDS = new Set([
    // articles / pronouns / conjunctions / prepositions
    'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'without', 'from', 'into',
    'onto', 'of', 'to', 'in', 'on', 'at', 'by', 'as', 'is', 'are', 'was', 'were',
    'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'there',
    'here', 'i', 'you', 'he', 'she', 'we', 'they', 'them', 'my', 'your', 'our',
    'their', 'his', 'her', 'me', 'us', 'who', 'whom', 'whose', 'which', 'what',
    'when', 'where', 'why', 'how', 'all', 'any', 'some', 'each', 'every', 'both',
    'either', 'neither', 'few', 'more', 'most', 'other', 'another', 'such', 'own',
    'same', 'so', 'than', 'too', 'very', 'can', 'could', 'will', 'would', 'should',
    'may', 'might', 'must', 'shall', 'do', 'does', 'did', 'have', 'has', 'had',
    'get', 'got', 'make', 'made', 'let', 'please', 'help', 'need', 'want', 'like',
    'user', 'users', 'using', 'used', 'via', 'say', 'says', 'saying', 'press',
    'presses', 'pressed', 'pressing', 'key', 'keys', 'hello', 'build', 'built',
    // generic task verbs
    'create', 'creates', 'creating', 'build', 'builds', 'building', 'write',
    'writes', 'writing', 'add', 'adds', 'adding', 'implement', 'implements',
    'implementing', 'develop', 'develops', 'developing', 'fix', 'fixes', 'fixing',
    'update', 'updates', 'updating', 'change', 'changes', 'changing', 'improve',
    'improves', 'improving', 'use', 'uses', 'using', 'run', 'runs', 'running',
    'test', 'tests', 'testing', 'check', 'checks', 'checking', 'verify',
    'verifies', 'verifying', 'review', 'reviews', 'reviewing', 'scan', 'scans',
    'scanning', 'ensure', 'ensures', 'ensuring', 'refactor', 'refactors',
    'refactoring', 'optimize', 'optimizes', 'optimizing', 'setup', 'setups',
    'configure', 'configures', 'configuring', 'install', 'installs', 'installing',
    'deploy', 'deploys', 'deploying', 'clean', 'cleanup', 'remove', 'removes',
    'removing', 'make', 'made', 'work', 'works', 'working', 'task', 'tasks',
    'step', 'steps', 'plan', 'plans', 'planning', 'goal', 'goals', 'app', 'apps',
    'application', 'applications', 'code', 'codes', 'coding', 'project', 'projects',
    'file', 'files', 'directory', 'directories', 'folder', 'folders', 'function',
    'functions', 'module', 'modules', 'component', 'components', 'system', 'systems',
    'feature', 'features', 'thing', 'things', 'stuff', 'way', 'ways', 'part', 'parts',
]);
/**
 * Extract significant subject tokens from a goal: lowercase, alphanumeric-only,
 * ≥ 4 chars, not a stopword. These are the domain nouns a faithful plan MUST
 * reference (e.g. "nvda", "addon", "anuj").
 */
function significantGoalTokens(goal) {
    const tokens = goal
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4 && !GOAL_STOPWORDS.has(t));
    return [...new Set(tokens)];
}
/**
 * Distinctive phrases from the few-shot examples. When a short goal's plan
 * contains ≥ 2 of these, the model almost certainly regurgitated the template
 * instead of planning for the goal (the observed NVDA-addon failure).
 */
const EXAMPLE_COPY_MARKERS = [
    'scan the codebase to understand the current project structure',
    'pii and injection vulnerabilities',
    'review all changes for correctness, security, and code quality',
    'reads the local catalog and reconciles it with the remote store',
    'prints hello, world',
    'run: python',
];
/** True when `word` appears in `text` as a whole word (word-boundary aware). */
function hasWordBoundary(text, word) {
    // Escape regex metacharacters (tokens are alphanumeric, but be safe).
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(text);
}
//# sourceMappingURL=planner.js.map