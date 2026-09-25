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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { homedir } from 'node:os';
import { formatWorkingState, getWorkingState } from '../learning/working-state.js';
import { handoffBlockFor } from './step-handoff.js';

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

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PromptLayer {
  /** Stable layer: identity, tool guidance (byte-stable for caching). */
  stable: string;
  /** Context layer: project files, knowledge, framework detection. */
  context: string;
  /** Volatile layer: task-specific instructions, timestamp. */
  volatile: string;
}

export interface ProjectAssessment {
  /** Detected framework (react, vue, python, express, etc.) */
  framework?: string;
  /** Detected language (typescript, python, go, rust, etc.) */
  language?: string;
  /** Detected package manager (npm, yarn, pnpm, pip, cargo, etc.) */
  packageManager?: string;
  /** Whether this is a greenfield (from-scratch) project */
  isGreenfield: boolean;
  /** Whether the project has existing tests */
  hasTests: boolean;
  /** Key project files found */
  keyFiles: string[];
  /** Knowledge file content if found */
  knowledgeContent?: string;
  /** AGENTS.md content if found */
  agentsMdContent?: string;
  /**
   * Enterprise G4 — the project's working state (files already changed,
   * outstanding verification debt, user-reported regressions), formatted as a
   * compact block. Populated by {@link assessProject}; left undefined for a
   * pristine project so it adds no prompt weight. This is how the ORCHESTRATOR
   * path inherits the cross-turn memory the chat path gained.
   */
  workingState?: string;
  /**
   * The durable hand-off block: work earlier attempts in THIS project started
   * and did not finish, with the artifacts already on disk and the ones still
   * missing. Populated by {@link assessProject} from step-handoff.ts, so every
   * agent prompt carries it without each agent having to remember to ask.
   *
   * Distinct from `workingState` on purpose: the ledger is per-session prose
   * memory (what changed, what the user reported broken), the hand-off is
   * per-STEP and disk-verified (what this step still owes).
   */
  openHandoffs?: string;
}

// ─── Project Assessment ─────────────────────────────────────────────────────

/**
 * Assess the project before executing tasks.
 * Detect framework, language, and project state before generating prompts.
 * This replaces the generic context-gatherer with a fast, deterministic
 * assessment.
 */
export function assessProject(workingDirectory: string): ProjectAssessment {
  const assessment: ProjectAssessment = {
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
    const sourceFiles = allFiles.filter(f =>
      /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|c|cpp|h)$/i.test(f)
    );
    assessment.isGreenfield = sourceFiles.length === 0;

    // Check for tests
    assessment.hasTests = allFiles.some(f =>
      /\.(test|spec)\.(ts|tsx|js|jsx|py)$/i.test(f) ||
      f.includes('__tests__') ||
      f.includes('test/')
    );

    // Find key files
    assessment.keyFiles = findKeyFiles(workingDirectory, files);

    // Load context files (Hermes pattern: AGENTS.md, knowledge.md)
    assessment.agentsMdContent = loadContextFile(workingDirectory, 'AGENTS.md');
    assessment.knowledgeContent = loadContextFile(workingDirectory, 'knowledge.md');

  } catch {
    // Best-effort — assessment must never break the pipeline
  }

  // Enterprise G4 — carry the project's working state (files already changed,
  // verification debt, user-reported regressions) into every agent prompt, so
  // the ORCHESTRATOR path stops re-deriving what previous turns established.
  // Best-effort and empty for a pristine project (no prompt weight added).
  try {
    assessment.workingState = formatWorkingState(getWorkingState(workingDirectory)) || undefined;
  } catch {
    // Best-effort — the ledger must never break assessment.
  }

  // The durable hand-off — work a previous attempt in this project started and
  // did not finish. Read on EVERY assessment (not only on an explicit resume),
  // which is what stops a repeated or reworded ask from re-planning a step that
  // already has half its artifacts on disk (see step-handoff.ts). Reconciled
  // against the filesystem on read, so a step whose files have since vanished is
  // correctly reported as outstanding again.
  try {
    assessment.openHandoffs = handoffBlockFor(workingDirectory) || undefined;
  } catch {
    // Best-effort — a hand-off read must never break assessment.
  }

  return assessment;
}

// ─── Framework Detection ────────────────────────────────────────────────────

function detectFramework(cwd: string, rootFiles: string[], allFiles: string[]): string | undefined {
  // Check package.json for framework
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.react || deps['react-dom']) return 'react';
      if (deps.vue || deps['@vue/core']) return 'vue';
      if (deps.next) return 'nextjs';
      if (deps.nuxt) return 'nuxt';
      if (deps.svelte || deps['@sveltejs/kit']) return 'svelte';
      if (deps.angular || deps['@angular/core']) return 'angular';
      if (deps.express) return 'express';
      if (deps.fastify) return 'fastify';
      if (deps.nestjs || deps['@nestjs/core']) return 'nestjs';
      if (deps.tailwindcss) return 'tailwind';
    } catch {
      // Best-effort
    }
  }

  // Check for Python frameworks
  if (allFiles.some(f => f.endsWith('requirements.txt') || f.endsWith('pyproject.toml'))) {
    const pyprojectPath = join(cwd, 'pyproject.toml');
    if (existsSync(pyprojectPath)) {
      const content = readFileSync(pyprojectPath, 'utf-8');
      if (content.includes('django')) return 'django';
      if (content.includes('flask')) return 'flask';
      if (content.includes('fastapi')) return 'fastapi';
    }
    return 'python';
  }

  // Check for Go
  if (rootFiles.includes('go.mod')) return 'go';

  // Check for Rust
  if (rootFiles.includes('Cargo.toml')) return 'rust';

  return undefined;
}

function detectLanguage(cwd: string, rootFiles: string[], allFiles: string[]): string | undefined {
  // Count file extensions
  const extCounts = new Map<string, number>();
  for (const f of allFiles) {
    const ext = f.split('.').pop()?.toLowerCase();
    if (ext) {
      extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
    }
  }

  // Find the dominant language
  const langMap: Record<string, string> = {
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
  let dominantLang: string | undefined;
  for (const [ext, count] of extCounts) {
    if (count > maxCount && langMap[ext]) {
      maxCount = count;
      dominantLang = langMap[ext];
    }
  }

  return dominantLang;
}

function detectPackageManager(cwd: string, rootFiles: string[]): string | undefined {
  if (rootFiles.includes('pnpm-lock.yaml')) return 'pnpm';
  if (rootFiles.includes('yarn.lock')) return 'yarn';
  if (rootFiles.includes('package-lock.json')) return 'npm';
  if (rootFiles.includes('bun.lockb')) return 'bun';
  if (rootFiles.includes('Pipfile.lock') || rootFiles.includes('requirements.txt')) return 'pip';
  if (rootFiles.includes('poetry.lock') || rootFiles.includes('pyproject.toml')) return 'poetry';
  if (rootFiles.includes('Cargo.lock')) return 'cargo';
  if (rootFiles.includes('go.sum')) return 'go';
  return undefined;
}

// ─── Context File Loading (Hermes pattern) ──────────────────────────────────

/**
 * Load a context file from the project.
 * Follows Hermes's priority system: AGENTS.md > CLAUDE.md > knowledge.md
 * Reference: Hermes prompt_builder.py build_context_files_prompt()
 */
function loadContextFile(cwd: string, filename: string): string | undefined {
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
      } catch {
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
export function assemblePrompt(
  stablePrompt: string,
  projectAssessment: ProjectAssessment,
  taskDescription: string,
  agentType: string,
): string {
  const layers: string[] = [];

  // Layer 1: STABLE — identity and tool guidance
  // This layer is byte-stable across turns for prompt caching
  layers.push(stablePrompt);

  // Layer 2: CONTEXT — project assessment and knowledge files
  // This layer changes when the project changes, not per-task
  const contextParts: string[] = [];

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

  // Enterprise G4 — the cross-turn working state (files changed, verification
  // debt, user-reported regressions). Already self-labelled, so no extra
  // heading; absent entirely for a pristine project.
  if (projectAssessment.workingState) {
    contextParts.push(`\n${projectAssessment.workingState}`);
  }

  // The unfinished-work hand-off (already self-labelled and self-bounded).
  if (projectAssessment.openHandoffs) {
    contextParts.push(`\n${projectAssessment.openHandoffs}`);
  }

  if (contextParts.length > 0) {
    layers.push(`# Project Context\n${contextParts.join('\n')}`);
  }

  // Layer 3: VOLATILE — task-specific instructions
  // This layer changes per call
  const volatileParts: string[] = [];
  volatileParts.push(`## Task\n${taskDescription}`);
  volatileParts.push(`Agent: ${agentType}`);
  volatileParts.push(`Timestamp: ${new Date().toISOString()}`);

  layers.push(volatileParts.join('\n\n'));

  return layers.join('\n\n');
}

// ─── Helper Functions ───────────────────────────────────────────────────────

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function scanDirectory(dir: string, depth: number, maxDepth: number): string[] {
  if (depth > maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isFile()) {
        results.push(relative(dir, fullPath));
      } else if (entry.isDirectory()) {
        results.push(...scanDirectory(fullPath, depth + 1, maxDepth).map(f => join(entry.name, f)));
      }
    }
  } catch {
    // Best-effort
  }
  return results;
}

function findKeyFiles(cwd: string, rootFiles: string[]): string[] {
  const keyFiles: string[] = [];
  const importantFiles = [
    'package.json', 'tsconfig.json', 'pyproject.toml', 'go.mod', 'Cargo.toml',
    'README.md', '.env.example', 'docker-compose.yml', 'Dockerfile',
    'Makefile', 'CMakeLists.txt', 'build.gradle', 'pom.xml',
  ];
  for (const f of importantFiles) {
    if (rootFiles.includes(f)) keyFiles.push(f);
  }
  return keyFiles;
}
