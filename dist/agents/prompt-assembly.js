/**
 * PromptAssembly — Hermes-style layered prompt construction.
 *
 * Adopts the proven pattern from Hermes Agent's prompt_builder.py:
 *   Layer 1: STABLE  — identity, tool guidance, skills
 *   Layer 2: CONTEXT — project context files, knowledge files, framework detection
 *   Layer 3: VOLATILE — task-specific instructions, timestamp, session info
 *
 * Reference: https://github.com/NousResearch/hermes-agent/blob/main/agent/prompt_builder.py
 *
 * Key design decisions (from Hermes AGENTS.md):
 * - Per-conversation prompt caching is sacred. The stable layer must be
 *   byte-stable across turns so the LLM provider can cache the prefix.
 * - Context files (knowledge.md, AGENTS.md, CLAUDE.md) provide persistent
 *   project-specific instructions that survive across sessions.
 * - The volatile layer is task-specific and changes per call.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
// ─── Constants ──────────────────────────────────────────────────────────────
/** Context file names in priority order (first match wins). */
const CONTEXT_FILE_NAMES = [
    'AGENTS.md',
    'CLAUDE.md',
    '.cursorrules',
    'knowledge.md',
    '.nuvira.md',
];
/** Directories to scan for context files (up to git root). */
const CONTEXT_SCAN_DIRS = ['.agents', '.nuvira', '.cursor'];
// ─── Project Assessment ─────────────────────────────────────────────────────
/**
 * Assess the project before executing tasks.
 * Adopts Codebuff's pattern: detect framework, language, and project state
 * before generating prompts. This replaces the generic context-gatherer
 * with a fast, deterministic assessment.
 */
export function assessProject(workingDirectory) {
    const assessment = {
        isGreenfield: true,
        hasTests: false,
        keyFiles: [],
    };
    try {
        // Scan for project indicators
        const files = safeReaddir(workingDirectory);
        const allFiles = scanDirectory(workingDirectory, 0, 3);
        // Detect framework
        assessment.framework = detectFramework(workingDirectory, files, allFiles);
        assessment.language = detectLanguage(workingDirectory, files, allFiles);
        assessment.packageManager = detectPackageManager(workingDirectory, files);
        // Check if greenfield (no source files exist)
        const sourceFiles = allFiles.filter(f => /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|c|cpp|h)$/i.test(f));
        assessment.isGreenfield = sourceFiles.length === 0;
        // Check for tests
        assessment.hasTests = allFiles.some(f => /\.(test|spec)\.(ts|tsx|js|jsx|py)$/i.test(f) ||
            f.includes('__tests__') ||
            f.includes('test/'));
        // Find key files
        assessment.keyFiles = findKeyFiles(workingDirectory, files);
        // Load context files (Hermes pattern: AGENTS.md, knowledge.md)
        assessment.agentsMdContent = loadContextFile(workingDirectory, 'AGENTS.md');
        assessment.knowledgeContent = loadContextFile(workingDirectory, 'knowledge.md');
    }
    catch {
        // Best-effort — assessment must never break the pipeline
    }
    return assessment;
}
// ─── Framework Detection ────────────────────────────────────────────────────
function detectFramework(cwd, rootFiles, allFiles) {
    // Check package.json for framework
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (deps.react || deps['react-dom'])
                return 'react';
            if (deps.vue || deps['@vue/core'])
                return 'vue';
            if (deps.next)
                return 'nextjs';
            if (deps.nuxt)
                return 'nuxt';
            if (deps.svelte || deps['@sveltejs/kit'])
                return 'svelte';
            if (deps.angular || deps['@angular/core'])
                return 'angular';
            if (deps.express)
                return 'express';
            if (deps.fastify)
                return 'fastify';
            if (deps.nestjs || deps['@nestjs/core'])
                return 'nestjs';
            if (deps.tailwindcss)
                return 'tailwind';
        }
        catch {
            // Best-effort
        }
    }
    // Check for Python frameworks
    if (allFiles.some(f => f.endsWith('requirements.txt') || f.endsWith('pyproject.toml'))) {
        const pyprojectPath = join(cwd, 'pyproject.toml');
        if (existsSync(pyprojectPath)) {
            const content = readFileSync(pyprojectPath, 'utf-8');
            if (content.includes('django'))
                return 'django';
            if (content.includes('flask'))
                return 'flask';
            if (content.includes('fastapi'))
                return 'fastapi';
        }
        return 'python';
    }
    // Check for Go
    if (rootFiles.includes('go.mod'))
        return 'go';
    // Check for Rust
    if (rootFiles.includes('Cargo.toml'))
        return 'rust';
    return undefined;
}
function detectLanguage(cwd, rootFiles, allFiles) {
    // Count file extensions
    const extCounts = new Map();
    for (const f of allFiles) {
        const ext = f.split('.').pop()?.toLowerCase();
        if (ext) {
            extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
        }
    }
    // Find the dominant language
    const langMap = {
        ts: 'typescript', tsx: 'typescript',
        js: 'javascript', jsx: 'javascript',
        py: 'python',
        go: 'go',
        rs: 'rust',
        java: 'java',
        kt: 'kotlin',
        rb: 'ruby',
        php: 'php',
        c: 'c', cpp: 'cpp', h: 'c',
    };
    let maxCount = 0;
    let dominantLang;
    for (const [ext, count] of extCounts) {
        if (count > maxCount && langMap[ext]) {
            maxCount = count;
            dominantLang = langMap[ext];
        }
    }
    return dominantLang;
}
function detectPackageManager(cwd, rootFiles) {
    if (rootFiles.includes('pnpm-lock.yaml'))
        return 'pnpm';
    if (rootFiles.includes('yarn.lock'))
        return 'yarn';
    if (rootFiles.includes('package-lock.json'))
        return 'npm';
    if (rootFiles.includes('bun.lockb'))
        return 'bun';
    if (rootFiles.includes('Pipfile.lock') || rootFiles.includes('requirements.txt'))
        return 'pip';
    if (rootFiles.includes('poetry.lock') || rootFiles.includes('pyproject.toml'))
        return 'poetry';
    if (rootFiles.includes('Cargo.lock'))
        return 'cargo';
    if (rootFiles.includes('go.sum'))
        return 'go';
    return undefined;
}
// ─── Context File Loading (Hermes pattern) ──────────────────────────────────
/**
 * Load a context file from the project.
 * Follows Hermes's priority system: AGENTS.md > CLAUDE.md > knowledge.md
 * Reference: Hermes prompt_builder.py build_context_files_prompt()
 */
function loadContextFile(cwd, filename) {
    const candidates = [
        join(cwd, filename),
        join(cwd, '.agents', filename),
        join(cwd, '.nuvira', filename),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            try {
                const content = readFileSync(candidate, 'utf-8').trim();
                // Security: scan for prompt injection (Hermes pattern)
                if (content.includes('ignore previous') || content.includes('ignore all prior')) {
                    return undefined; // Blocked — potential prompt injection
                }
                // Truncate to reasonable size (Hermes uses context_file_max_chars)
                return content.slice(0, 10_000);
            }
            catch {
                // Best-effort
            }
        }
    }
    return undefined;
}
// ─── Prompt Assembly ────────────────────────────────────────────────────────
/**
 * Assemble a layered prompt following Hermes's pattern.
 *
 * @param stablePrompt - Identity and tool guidance (byte-stable for caching)
 * @param projectAssessment - Detected project context
 * @param taskDescription - The specific task to execute
 * @param agentType - The agent type (writer, planner, etc.)
 */
export function assemblePrompt(stablePrompt, projectAssessment, taskDescription, agentType) {
    const layers = [];
    // Layer 1: STABLE — identity and tool guidance
    // This layer is byte-stable across turns for prompt caching
    layers.push(stablePrompt);
    // Layer 2: CONTEXT — project assessment and knowledge files
    // This layer changes when the project changes, not per-task
    const contextParts = [];
    if (projectAssessment.framework) {
        contextParts.push(`Project framework: ${projectAssessment.framework}`);
    }
    if (projectAssessment.language) {
        contextParts.push(`Primary language: ${projectAssessment.language}`);
    }
    if (projectAssessment.packageManager) {
        contextParts.push(`Package manager: ${projectAssessment.packageManager}`);
    }
    if (projectAssessment.isGreenfield) {
        contextParts.push('Project type: Greenfield (from scratch — no existing source files)');
    }
    if (projectAssessment.hasTests) {
        contextParts.push('Testing: Project has existing tests');
    }
    // Inject knowledge files (Hermes pattern: AGENTS.md, knowledge.md)
    if (projectAssessment.agentsMdContent) {
        contextParts.push(`\n## Project Instructions (AGENTS.md)\n${projectAssessment.agentsMdContent}`);
    }
    if (projectAssessment.knowledgeContent) {
        contextParts.push(`\n## Project Knowledge\n${projectAssessment.knowledgeContent}`);
    }
    if (contextParts.length > 0) {
        layers.push(`# Project Context\n${contextParts.join('\n')}`);
    }
    // Layer 3: VOLATILE — task-specific instructions
    // This layer changes per call
    const volatileParts = [];
    volatileParts.push(`## Task\n${taskDescription}`);
    volatileParts.push(`Agent: ${agentType}`);
    volatileParts.push(`Timestamp: ${new Date().toISOString()}`);
    layers.push(volatileParts.join('\n\n'));
    return layers.join('\n\n');
}
// ─── Helper Functions ───────────────────────────────────────────────────────
function safeReaddir(dir) {
    try {
        return readdirSync(dir);
    }
    catch {
        return [];
    }
}
function scanDirectory(dir, depth, maxDepth) {
    if (depth > maxDepth)
        return [];
    const results = [];
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules')
                continue;
            const fullPath = join(dir, entry.name);
            if (entry.isFile()) {
                results.push(relative(dir, fullPath));
            }
            else if (entry.isDirectory()) {
                results.push(...scanDirectory(fullPath, depth + 1, maxDepth).map(f => join(entry.name, f)));
            }
        }
    }
    catch {
        // Best-effort
    }
    return results;
}
function findKeyFiles(cwd, rootFiles) {
    const keyFiles = [];
    const importantFiles = [
        'package.json', 'tsconfig.json', 'pyproject.toml', 'go.mod', 'Cargo.toml',
        'README.md', '.env.example', 'docker-compose.yml', 'Dockerfile',
        'Makefile', 'CMakeLists.txt', 'build.gradle', 'pom.xml',
    ];
    for (const f of importantFiles) {
        if (rootFiles.includes(f))
            keyFiles.push(f);
    }
    return keyFiles;
}
//# sourceMappingURL=prompt-assembly.js.map