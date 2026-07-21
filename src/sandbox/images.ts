/**
 * Sandbox images — Pre-defined Docker images for common programming languages.
 *
 * These are used as base images for sandbox containers. Each image definition
 * includes the Docker image name, language/runtime details, and default
 * install/test commands.
 *
 * Images are pulled on first use if not present locally.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { SandboxImage } from './types.js';

/**
 * Pre-defined sandbox images for common runtimes.
 */
export const BUILTIN_SANDBOX_IMAGES: SandboxImage[] = [
  // ── Node.js ────────────────────────────────────────────────────────────
  {
    image: 'node:20-slim',
    label: 'Node.js 20 (slim)',
    runtimes: ['node', 'npm', 'npx'],
    installCommand: 'npm install',
    // testCommand omitted — TesterAgent detects from package.json at runtime
    shell: '/bin/bash',
  },
  {
    image: 'node:20',
    label: 'Node.js 20 (full)',
    runtimes: ['node', 'npm', 'npx'],
    installCommand: 'npm install',
    // testCommand omitted — TesterAgent detects from package.json at runtime
    shell: '/bin/bash',
  },
  {
    image: 'node:18-slim',
    label: 'Node.js 18 (slim)',
    runtimes: ['node', 'npm', 'npx'],
    installCommand: 'npm install',
    // testCommand omitted — TesterAgent detects from package.json at runtime
    shell: '/bin/bash',
  },

  // ── Python ─────────────────────────────────────────────────────────────
  {
    image: 'python:3.12-slim',
    label: 'Python 3.12 (slim)',
    runtimes: ['python3', 'pip3'],
    installCommand: 'pip install -r requirements.txt 2>/dev/null; pip install pytest 2>/dev/null',
    testCommand: 'python -m pytest -v 2>&1 || python -m unittest discover 2>&1',
    shell: '/bin/bash',
  },
  {
    image: 'python:3.11-slim',
    label: 'Python 3.11 (slim)',
    runtimes: ['python3', 'pip3'],
    installCommand: 'pip install -r requirements.txt 2>/dev/null; pip install pytest 2>/dev/null',
    testCommand: 'python -m pytest -v 2>&1 || python -m unittest discover 2>&1',
    shell: '/bin/bash',
  },

  // ── Go ─────────────────────────────────────────────────────────────────
  {
    image: 'golang:1.22',
    label: 'Go 1.22',
    runtimes: ['go'],
    installCommand: 'go mod download 2>/dev/null',
    testCommand: 'go test ./... 2>&1',
    shell: '/bin/bash',
  },

  // ── Rust ───────────────────────────────────────────────────────────────
  {
    image: 'rust:1.77-slim',
    label: 'Rust 1.77 (slim)',
    runtimes: ['cargo', 'rustc'],
    installCommand: 'cargo fetch 2>/dev/null',
    testCommand: 'cargo test 2>&1',
    shell: '/bin/bash',
  },

  // ── Universal (multi-runtime) ──────────────────────────────────────────
  {
    image: 'ubuntu:22.04',
    label: 'Ubuntu 22.04 (universal)',
    runtimes: ['bash', 'sh', 'apt-get'],
    installCommand: 'apt-get update -qq && apt-get install -y -qq curl wget git 2>/dev/null',
    testCommand: 'echo "No default test command for universal image"',
    shell: '/bin/bash',
  },
];

/**
 * Find a built-in sandbox image by language/runtime name (case-insensitive).
 *
 * Examples:
 *   resolveSandboxImage('node')        → node:20-slim
 *   resolveSandboxImage('python')      → python:3.12-slim
 *   resolveSandboxImage('go')          → golang:1.22
 *   resolveSandboxImage('golang')      → golang:1.22
 *   resolveSandboxImage('rust')        → rust:1.77-slim
 */
export function resolveSandboxImage(runtime: string): SandboxImage | undefined {
  const normalized = runtime.toLowerCase().trim();

  // Exact match on label
  const byLabel = BUILTIN_SANDBOX_IMAGES.find(
    (img) => img.label.toLowerCase().includes(normalized),
  );
  if (byLabel) return byLabel;

  // Match on runtimes
  const byRuntime = BUILTIN_SANDBOX_IMAGES.find(
    (img) => img.runtimes.some((r) => r.includes(normalized)),
  );
  if (byRuntime) return byRuntime;

  // Match on image name
  const byImage = BUILTIN_SANDBOX_IMAGES.find(
    (img) => img.image.toLowerCase().includes(normalized),
  );
  if (byImage) return byImage;

  return undefined;
}

/**
 * Get the default sandbox image based on detected project type.
 * Checks for common project files to determine runtime.
 */
export function detectProjectImage(projectDir: string): SandboxImage {
  // Check for common project files
  if (existsSync(join(projectDir, 'package.json'))) return BUILTIN_SANDBOX_IMAGES[0]; // node:20-slim
  if (existsSync(join(projectDir, 'requirements.txt')) || existsSync(join(projectDir, 'setup.py')) || existsSync(join(projectDir, 'Pipfile'))) return BUILTIN_SANDBOX_IMAGES[3]; // python:3.12-slim
  if (existsSync(join(projectDir, 'go.mod'))) return BUILTIN_SANDBOX_IMAGES[5]; // golang:1.22
  if (existsSync(join(projectDir, 'Cargo.toml'))) return BUILTIN_SANDBOX_IMAGES[6]; // rust:1.77-slim

  // Fall back to Node.js (most common for agent-nuvira)
  return BUILTIN_SANDBOX_IMAGES[0];
}
