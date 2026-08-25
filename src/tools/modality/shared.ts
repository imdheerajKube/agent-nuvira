/**
 * I2–I5 — shared helpers for the modality packs.
 *
 * Every pack follows a registry + availability-gating model: an
 * `isAvailable()` per backend, graceful degradation when unconfigured, and
 * artifacts written to a sandbox dir (env-overridable, never the project tree).
 */

import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { envBuff } from '../../config/paths';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

// ─── Artifact dir ───────────────────────────────────────────────────────────

/**
 * Resolve the artifact dir for a modality ("images" | "screenshots" | "audio").
 * NUVIRA_ARTIFACTS_DIR overrides the base; default `<cwd>/.nuvira/artifacts`.
 */
export function artifactsDir(kind: string, cwd?: string): string {
  const artifactsEnv = envBuff('ARTIFACTS_DIR');
  const base = artifactsEnv
    ? resolve(artifactsEnv)
    : join(resolve(cwd ?? process.cwd()), '.nuvira', 'artifacts');
  const dir = join(base, kind);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a Buffer to the artifact dir, returning the absolute path. */
export function writeArtifact(kind: string, filename: string, data: Buffer, cwd?: string): string {
  const dir = artifactsDir(kind, cwd);
  const file = join(dir, filename);
  writeFileSync(file, data);
  return file;
}

/** Safe filename: keep extension, strip path separators + control chars. */
export function safeArtifactName(prefix: string, ext: string): string {
  const slug = prefix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'artifact';
  return `${slug}-${Date.now().toString(36)}${ext}`;
}

// ─── Binary availability probe (mirrors vault.ts binaryOnPath) ─────────────

const probeCache = new Map<string, boolean>();

/** Whether a binary is on PATH (cached). Tests reset via resetProbeCache(). */
export function binaryOnPath(name: string): boolean {
  const cached = probeCache.get(name);
  if (cached !== undefined) return cached;
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    probeCache.set(name, true);
    return true;
  } catch {
    probeCache.set(name, false);
    return false;
  }
}

/** Clear the probe cache (test isolation). */
export function resetProbeCache(): void {
  probeCache.clear();
}

/** Whether a file exists (availability of an audio/image input). */
export function fileExists(path: string): boolean {
  return Boolean(path) && existsSync(path);
}

/** Best-effort delete of a temp file (never throws). */
export function cleanupTemp(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* best-effort */ }
}
