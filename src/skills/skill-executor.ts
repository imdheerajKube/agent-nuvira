/**
 * Skill Executor — Runs skills as scripts in any language.
 *
 * This is the core capability that agent-nuvira was missing vs Hermes.
 * Hermes can execute Python, JS, shell scripts from the marketplace.
 * This module provides the same capability.
 *
 * Flow:
 * 1. Skill declares `runtime` in frontmatter (python, node, shell, auto)
 * 2. Executor detects language from runtime or file extension
 * 3. Spawns a sandboxed process with API keys injected
 * 4. Captures output and returns it to the agent
 */

import { spawn, SpawnOptions } from 'node:child_process';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ─── Types ───────────────────────────────────────────────────────────────

export type SkillRuntime = 'python' | 'node' | 'shell' | 'ruby' | 'go' | 'rust' | 'auto';

export interface SkillExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  runtime: SkillRuntime;
  durationMs: number;
}

export interface SkillExecutionContext {
  /** Working directory for the execution */
  cwd: string;
  /** Environment variables to inject (API keys, etc.) */
  env?: Record<string, string>;
  /** Arguments to pass to the script */
  args?: string[];
  /** Timeout in milliseconds (default: 30s) */
  timeoutMs?: number;
  /** Maximum output size in bytes (default: 1MB) */
  maxOutputBytes?: number;
  /** Whether to use sandboxed execution (Docker/Modal) */
  sandboxed?: boolean;
}

// ─── Runtime Detection ───────────────────────────────────────────────────

/**
 * Detect the runtime for a skill based on its content or file extension.
 */
export function detectRuntime(
  skillContent: string,
  filePath?: string
): SkillRuntime {
  // 1. Check frontmatter for explicit runtime declaration
  const runtimeMatch = skillContent.match(
    /^runtime:\s*(python|node|shell|auto)/m
  );
  if (runtimeMatch) {
    const declared = runtimeMatch[1] as SkillRuntime;
    if (declared !== 'auto') return declared;
  }

  // 2. Check file extension
  if (filePath) {
    const ext = extname(filePath).toLowerCase();
    if (ext === '.py') return 'python';
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'node';
    if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'node';
    if (ext === '.rb') return 'ruby';
    if (ext === '.go') return 'go';
    if (ext === '.rs') return 'rust';
    if (ext === '.sh' || ext === '.bash') return 'shell';
  }

  // 3. Heuristic: check for shebang or language markers
  if (skillContent.includes('#!/usr/bin/env python') || skillContent.includes('#!/usr/bin/python')) {
    return 'python';
  }
  if (skillContent.includes('#!/usr/bin/env node') || skillContent.includes('#!/usr/bin/env tsx') || skillContent.includes('#!/usr/bin/env ts-node')) {
    return 'node';
  }
  if (skillContent.includes('#!/usr/bin/env ruby') || skillContent.includes('#!/usr/bin/ruby')) {
    return 'ruby';
  }
  if (skillContent.includes('#!/usr/bin/env go') || skillContent.includes('package main')) {
    return 'go';
  }
  if (skillContent.includes('fn main()') || skillContent.includes('use std::')) {
    return 'rust';
  }
  if (skillContent.includes('#!/bin/bash') || skillContent.includes('#!/usr/bin/env bash')) {
    return 'shell';
  }
  if (skillContent.includes('def ') && skillContent.includes(':') && skillContent.includes('import ')) {
    return 'python';
  }
  if (skillContent.includes('console.log') || skillContent.includes('const ') || skillContent.includes('require(') || skillContent.includes('process.argv')) {
    return 'node';
  }
  if (skillContent.includes('puts ') || skillContent.includes('end')) {
    return 'ruby';
  }
  if (skillContent.includes('func ') && skillContent.includes('return')) {
    return 'go';
  }
  if (skillContent.includes('fn ') && skillContent.includes('let ')) {
    return 'rust';
  }

  // 4. Default to shell (most portable)
  return 'shell';
}

// ─── Execution ───────────────────────────────────────────────────────────

/**
 * Execute a skill script in the appropriate runtime.
 *
 * @param scriptContent - The script content to execute
 * @param context - Execution context (cwd, env, timeout, etc.)
 * @param filePath - Optional file path hint for runtime detection
 * @returns Execution result with stdout, stderr, exit code
 */
export async function executeSkill(
  scriptContent: string,
  context: SkillExecutionContext,
  filePath?: string
): Promise<SkillExecutionResult> {
  const startTime = Date.now();
  const runtime = detectRuntime(scriptContent, filePath);
  const timeoutMs = context.timeoutMs ?? 30_000;
  const maxOutputBytes = context.maxOutputBytes ?? 1_024 * 1024;

  // Filter env vars: blocklist prevents automatic passthrough from process.env,
  // but explicit caller-provided env vars are always allowed (caller knows what they're doing).
  const filteredEnv: Record<string, string> = {};
  
  // First, add process.env vars that are NOT in the blocklist
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !PROVIDER_ENV_BLOCKLIST.has(key)) {
      filteredEnv[key] = value;
    }
  }
  
  // Then, overlay caller-provided env vars (always allowed, even if in blocklist)
  if (context.env) {
    for (const [key, value] of Object.entries(context.env)) {
      filteredEnv[key] = value;
    }
  }

  // Check if sandboxed execution is requested
  if (context.sandboxed) {
    // Use Docker sandbox for untrusted skills
    const { executeInSandbox, checkDockerAvailable } = await import('./sandbox-executor.js');
    
    const dockerStatus = await checkDockerAvailable();
    if (!dockerStatus.available) {
      // Fall back to local execution if Docker is not available
      console.warn('Docker not available, falling back to local execution');
    } else {
      // Execute in Docker sandbox
      const result = await executeInSandbox(
        scriptContent,
        filePath ?? 'skill.sh',
        filteredEnv,
        context.args,
        {
          timeoutMs,
          networkMode: 'none',
        }
      );

      return {
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        runtime,
        durationMs: result.durationMs,
      };
    }
  }

  // Local execution (default)
  // Create a temporary file for the script
  const tmpDir = join(tmpdir(), 'skill-exec', randomBytes(8).toString('hex'));
  await mkdir(tmpDir, { recursive: true });

  const extMap: Record<string, string> = {
    python: '.py',
    node: '.js',
    shell: '.sh',
    ruby: '.rb',
    go: '.go',
    rust: '.rs',
  };
  const ext = extMap[runtime] ?? '.sh';
  const scriptPath = join(tmpDir, `skill${ext}`);
  await writeFile(scriptPath, scriptContent, 'utf-8');

  try {
    // Build the command based on runtime
    const { command, args: runtimeArgs } = getRuntimeCommand(runtime, scriptPath);

    // Append user-provided arguments
    const allArgs = [...runtimeArgs, ...(context.args ?? [])];

    // Spawn the process
    const result = await spawnProcess(command, allArgs, {
      cwd: context.cwd,
      env: filteredEnv,
      timeoutMs,
      maxOutputBytes,
    });

    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      runtime,
      durationMs: Date.now() - startTime,
    };
  } finally {
    // Cleanup temp file
    try {
      await unlink(scriptPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Get the runtime command for a given runtime.
 */
function getRuntimeCommand(
  runtime: SkillRuntime,
  scriptPath: string
): { command: string; args: string[] } {
  const isWin = process.platform === 'win32';
  switch (runtime) {
    case 'python':
      // Windows: 'python' (not python3)
      return { command: isWin ? 'python' : 'python3', args: [scriptPath] };
    case 'node':
      return { command: 'node', args: [scriptPath] };
    case 'shell':
      // Windows: use Git Bash if available (handles bash syntax), else PowerShell
      if (isWin) {
        const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
        if (existsSync(gitBash)) {
          return { command: gitBash, args: [scriptPath] };
        }
        // Fallback: try 'bash' in PATH (Git Bash or WSL)
        return { command: 'bash', args: [scriptPath] };
      }
      return { command: 'bash', args: [scriptPath] };
    case 'ruby':
      return { command: 'ruby', args: [scriptPath] };
    case 'go':
      return { command: 'go', args: ['run', scriptPath] };
    case 'rust': {
      if (isWin) {
        // On Windows, use 'cmd.exe /c rustc && run'
        const binaryPath = scriptPath.replace(/\.rs$/, '.exe');
        return { command: 'cmd.exe', args: ['/c', `rustc "${scriptPath}" -o "${binaryPath}" && "${binaryPath}"`] };
      }
      const binaryPath = scriptPath.replace(/\.rs$/, '');
      return { command: 'bash', args: ['-c', `rustc ${scriptPath} -o ${binaryPath} && ${binaryPath}`] };
    }
    default:
      return isWin
        ? { command: 'cmd.exe', args: ['/c', scriptPath] }
        : { command: 'bash', args: [scriptPath] };
  }
}

/**
 * Spawn a process with timeout and output capture.
 */
async function spawnProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Capture stdout
    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      if (stdout.length + chunk.length > options.maxOutputBytes) {
        stdout += chunk.slice(0, options.maxOutputBytes - stdout.length);
        child.kill('SIGTERM');
      } else {
        stdout += chunk;
      }
    });

    // Capture stderr
    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      if (stderr.length + chunk.length > options.maxOutputBytes) {
        stderr += chunk.slice(0, options.maxOutputBytes - stderr.length);
      } else {
        stderr += chunk;
      }
    });

    // Set timeout
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      // Force kill after 2 seconds
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 2000);
    }, options.timeoutMs);

    // Handle completion
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({
          stdout,
          stderr: stderr + '\n[Execution timed out]',
          exitCode: code ?? 124,
        });
      } else {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      }
    });

    // Handle errors
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ─── Env Passthrough ─────────────────────────────────────────────────────

/**
 * Register environment variables for passthrough to skill execution.
 *
 * This mirrors Hermes' env_passthrough.py — skill-declared vars are
 * allowed to pass through to the sandbox, while provider credentials
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.) are blocked for security.
 */

/** Provider env vars that should NEVER be passed to skills */
const PROVIDER_ENV_BLOCKLIST = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_TOKEN',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'TOGETHER_API_KEY',
  'DEEPINFRA_API_KEY',
  'FIREWORKS_API_KEY',
  'OPENROUTER_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'BEDROCK_ACCESS_KEY',
  'BEDROCK_SECRET_KEY',
  'NUVIRA_API_KEY', // Don't pass the agent's own key
]);

/** Session-scoped allowlist of env vars that can pass through */
let sessionAllowlist: Set<string> = new Set();

/**
 * Register env vars for passthrough (called when a skill is loaded).
 */
export function registerEnvPassthrough(varNames: string[]): void {
  for (const name of varNames) {
    if (!PROVIDER_ENV_BLOCKLIST.has(name)) {
      sessionAllowlist.add(name);
    }
  }
}

/**
 * Get the filtered env vars that should be passed to skill execution.
 */
export function getFilteredEnvPassthrough(
  skillEnvVars: string[]
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const name of skillEnvVars) {
    // Block provider credentials
    if (PROVIDER_ENV_BLOCKLIST.has(name)) continue;

    // Must be in allowlist (registered by skill loading)
    if (!sessionAllowlist.has(name)) continue;

    // Must be set in process.env
    const value = process.env[name];
    if (value !== undefined) {
      result[name] = value;
    }
  }

  return result;
}

/**
 * Clear the session allowlist (call at session end).
 */
export function clearEnvPassthrough(): void {
  sessionAllowlist.clear();
}

/**
 * Check if an env var is allowed for passthrough.
 */
export function isEnvPassthroughAllowed(name: string): boolean {
  return !PROVIDER_ENV_BLOCKLIST.has(name) && sessionAllowlist.has(name);
}

// ─── Marketplace Skill Execution ─────────────────────────────────────────

/**
 * Execute a marketplace skill.
 *
 * This is the main entry point for executing skills from the marketplace.
 * It handles:
 * 1. Reading the skill file
 * 2. Detecting the runtime
 * 3. Injecting API keys
 * 4. Executing the script
 * 5. Returning the result
 */
export async function executeMarketplaceSkill(
  skillPath: string,
  context: SkillExecutionContext
): Promise<SkillExecutionResult> {
  // Read the skill file
  const content = await readFile(skillPath, 'utf-8');

  // Parse required_environment_variables from frontmatter
  const envVarMatch = content.match(
    /^required_environment_variables:\s*\[([^\]]*)\]/m
  );
  const requiredEnvVars = envVarMatch
    ? envVarMatch[1].split(',').map((v) => v.trim().replace(/['"]/g, ''))
    : [];

  // Get filtered env vars for injection
  const env = {
    ...context.env,
    ...getFilteredEnvPassthrough(requiredEnvVars),
  };

  // Execute the skill
  return executeSkill(content, { ...context, env }, skillPath);
}
