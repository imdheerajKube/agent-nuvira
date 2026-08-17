/**
 * I7 P1 — Multi-source skill registry (`src/learning/skills-registry.ts`).
 *
 * Browse-hub equivalent: skills can be discovered from MORE than one registry.
 * Source adapters normalize every registry shape into the HubSkillEntry
 * contract so search + install behave identically regardless of origin.
 *
 * Source kinds:
 *   - github-raw — the legacy layout (`{base}/index.json` + `{base}/<n>/SKILL.md`).
 *   - local-dir  — a plain folder with the same layout (offline / team shares).
 *   - browse-sh  — the browse.sh API (external browse-hub; mapped to the
 *     HubSkillEntry shape).
 *   - git-repo   — a git repository (any layout) cloned shallowly into
 *     `~/.buff/skills-hub/repos/<hash>/`; the skills root is auto-detected
 *     (repo root / `skills/` / `.claude/skills/` / `.agents/skills/`).
 *
 * Configuration (buffconfig `skills.registries[]`, ordered = priority):
 *   ["https://raw.githubusercontent.com/OWNER/REPO/main/.agents/skills",
 *    "https://browse.sh/api/skills",
 *    "git+https://github.com/OWNER/skills-repo",
 *    "file:///path/to/team-skills"]
 * The legacy `BUFF_SKILLS_REGISTRY` env override remains the single-value
 * fallback when `registries[]` is absent.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';
import { packagedRegistryDir } from './skills-hub.js';
import type { HubSkillEntry } from './skills-hub.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A normalized registry source. */
export interface RegistrySource {
  /** Canonical source id: 'github-raw' | 'local-dir' | 'browse-sh' | 'git-repo'. */
  kind: 'github-raw' | 'local-dir' | 'browse-sh' | 'git-repo';
  /** The configured base (URL, path, or git+ URL). */
  base: string;
}

/** Where a result came from (surfaced in search + install provenance). */
export interface RegistryResult<T> {
  source: RegistrySource;
  value: T;
}

/**
 * P5c #3 — per-source registry reachability. The configured default used to
 * silently 404 ("No skills found") — the probe surfaces WHERE each source
 * failed and with what HTTP status, so the CLI can say so instead of
 * pretending the registry is empty.
 */
export interface RegistryProbe {
  source: RegistrySource;
  /** True when the source's index could be fetched/read and parsed. */
  reachable: boolean;
  /** HTTP status when a remote index fetch answered (404 = the default 404). */
  status?: number;
  /** 'http-error' | 'network' | 'missing-index' | 'invalid-index' | 'clone-failed' | 'no-skills-root'. */
  reason?: string;
  /** Number of skills the source's index exposes. */
  entryCount: number;
}

const GIT_REPO_RE = /^git\+(.+)$/;

// ─── Source resolution ──────────────────────────────────────────────────────

/** Detect a source's kind from its configured base string. */
export function detectSourceKind(base: string): RegistrySource['kind'] {
  if (GIT_REPO_RE.test(base)) return 'git-repo';
  if (base.startsWith('file://') || (!base.includes('://') && existsSync(base))) return 'local-dir';
  if (base.includes('browse.sh')) return 'browse-sh';
  return 'github-raw';
}

/**
 * The configured registry list: buffconfig `skills.registries[]` wins; else
 * the legacy BUFF_SKILLS_REGISTRY env override; else the PACKAGED
 * `.agents/skills/` dir (ships in the npm package + repo checkout — the
 * default resolves from the install itself, private-repo-independent); else
 * the GitHub raw URL as last-resort fallback.
 */
export function configuredRegistries(cm?: ConfigManager): string[] {
  try {
    const cfg = cm?.getAll?.();
    const registries = cfg?.skills?.registries;
    if (Array.isArray(registries) && registries.length > 0) {
      return registries.filter((r): r is string => typeof r === 'string' && r.length > 0);
    }
  } catch { /* fall through to env/default */ }
  const env = process.env.BUFF_SKILLS_REGISTRY;
  if (env) return [env];
  const packaged = packagedRegistryDir();
  if (packaged) return [`file://${packaged}`];
  return ['https://raw.githubusercontent.com/imdheerajKube/agent-nuvira/main/.agents/skills'];
}

/** Build a ConfigManager against a custom config dir (hermetic tests). */
export function configManagerAt(configDir: string): ConfigManager {
  return new ConfigManager(configDir);
}

/** All sources with their detected kinds. */
export function allSources(cm?: ConfigManager): RegistrySource[] {
  return configuredRegistries(cm).map((base) => ({ kind: detectSourceKind(base), base }));
}

// ─── Adapt a source base to its fetchable root ──────────────────────────────

function baseRoot(source: RegistrySource): string {
  return source.base.replace(/^file:\/\//, '').replace(/^git\+/, '');
}

// ─── browse.sh adapter ──────────────────────────────────────────────────────

const BROWSE_SH_TIMEOUT_MS = 10_000;

/** Fetch skills from a browse.sh API base. */
async function fetchBrowseShIndex(source: RegistrySource): Promise<HubSkillEntry[]> {
  try {
    const base = baseRoot(source);
    const res = await fetch(`${base.replace(/\/$/, '')}/index.json`, {
      headers: { 'User-Agent': 'agent-nuvira/2.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(BROWSE_SH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { skills?: unknown } | { results?: unknown };
    // browse.sh returns an object with either `skills` or `results`.
    const raw = (data as Record<string, unknown>).skills ?? (data as Record<string, unknown>).results;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item: unknown) => normalizeBrowseShEntry(item, base))
      .filter((e): e is HubSkillEntry => e !== null);
  } catch (err) {
    logger.debug(`browse.sh index fetch failed: ${err}`);
    return [];
  }
}

/** Map a browse.sh entry to the HubSkillEntry shape (best-effort). */
function normalizeBrowseShEntry(item: unknown, base: string): HubSkillEntry | null {
  if (typeof item !== 'object' || item === null) return null;
  const o = item as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name : typeof o.id === 'string' ? o.id : '';
  if (!name) return null;
  return {
    name,
    description: typeof o.description === 'string' ? o.description : '',
    version: typeof o.version === 'string' ? o.version : '0.0.0',
    author: typeof o.author === 'string' ? o.author : 'browse.sh',
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
    source: `browse-sh:${base}`,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : new Date().toISOString(),
  };
}

/** Fetch a single SKILL.md from a browse-sh registry. */
async function fetchBrowseShSkill(source: RegistrySource, name: string): Promise<string | null> {
  try {
    const base = baseRoot(source);
    const res = await fetch(`${base.replace(/\/$/, '')}/${name}/SKILL.md`, {
      headers: { 'User-Agent': 'agent-nuvira/2.0', Accept: 'text/markdown,text/plain,*/*' },
      signal: AbortSignal.timeout(BROWSE_SH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ─── git-repo adapter ───────────────────────────────────────────────────────

const REPOS_DIR = join(homedir(), '.buff', 'skills-hub', 'repos');

/** Candidate skills roots inside a cloned repo (probed in order). */
const REPO_SKILL_ROOTS = ['skills', '.claude/skills', '.agents/skills', '.'];

/** Clone (or reuse) a git repo into the local cache, returning its root. */
function cloneRepo(base: string): string {
  const hash = createHash('sha256').update(base).digest('hex').slice(0, 16);
  const target = join(REPOS_DIR, hash);
  if (existsSync(join(target, '.git'))) return target;
  try {
    mkdirSync(REPOS_DIR, { recursive: true });
    execFileSync('git', ['clone', '--depth', '1', '--quiet', base, target], { stdio: 'ignore', timeout: 60_000 });
    return target;
  } catch (err) {
    logger.debug(`git-repo clone failed for ${base}: ${err}`);
    return '';
  }
}

/**
 * Index a cloned repo: find its skills root, then the SKILL.md dirs.
 * Names are validated with the install sandbox rule before any read — a
 * hostile repo entry can never smuggle a traversal path into the catalog.
 */
function indexGitRepo(source: RegistrySource): HubSkillEntry[] {
  const repoRoot = cloneRepo(baseRoot(source));
  if (!repoRoot) return [];
  const root = findRepoSkillsRoot(repoRoot);
  if (!root) return [];
  const out: HubSkillEntry[] = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-z0-9-]+$/.test(entry.name)) continue;
      const skillPath = join(root, entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      try {
        const raw = readFileSync(skillPath, 'utf-8');
        const nameLine = /^name:\s*([^\s]+)\s*$/m.exec(raw)?.[1] || entry.name;
        const descLine = /^description:\s*(.+)$/m.exec(raw)?.[1]?.trim() || '';
        out.push({
          name: nameLine,
          description: descLine,
          version: /^version:\s*([^\s]+)\s*$/m.exec(raw)?.[1] || '0.0.0',
          author: /^author:\s*(.+)$/m.exec(raw)?.[1]?.trim() || 'git-repo',
          tags: [],
          source: `git-repo:${source.base}`,
          updatedAt: new Date().toISOString(),
        });
      } catch { /* skip corrupt skill */ }
    }
  } catch { /* unreadable root */ }
  return out;
}

/** Find the first existing skills root inside a cloned repo. */
function findRepoSkillsRoot(repoRoot: string): string | null {
  for (const rel of REPO_SKILL_ROOTS) {
    const cand = join(repoRoot, rel);
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** Fetch a SKILL.md from a cloned repo (name-validated, sandboxed read). */
function fetchGitRepoSkill(source: RegistrySource, name: string): string | null {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const repoRoot = cloneRepo(baseRoot(source));
  if (!repoRoot) return null;
  const root = findRepoSkillsRoot(repoRoot);
  if (!root) return null;
  const skillPath = join(root, name, 'SKILL.md');
  if (!existsSync(skillPath)) return null;
  try {
    return readFileSync(skillPath, 'utf-8');
  } catch {
    return null;
  }
}

// ─── Unified dispatch ───────────────────────────────────────────────────────

/** Fetch the index from ONE source (normalized to HubSkillEntry[]). */
export async function fetchSourceIndex(source: RegistrySource): Promise<HubSkillEntry[]> {
  switch (source.kind) {
    case 'git-repo':
      return indexGitRepo(source);
    case 'browse-sh':
      return fetchBrowseShIndex(source);
    case 'local-dir':
    case 'github-raw': {
      // Explicit base per source — the legacy path would use the env/default.
      const { fetchHubIndex } = await import('./skills-hub.js');
      return fetchHubIndex(source.base);
    }
  }
}

/** Fetch one SKILL.md from a specific source (null = not found there). */
export async function fetchSourceSkill(source: RegistrySource, name: string): Promise<string | null> {
  switch (source.kind) {
    case 'git-repo':
      return fetchGitRepoSkill(source, name);
    case 'browse-sh':
      return fetchBrowseShSkill(source, name);
    default: {
      const { fetchSkillFile } = await import('./skills-hub.js');
      return fetchSkillFile(source.base, `${name}/SKILL.md`);
    }
  }
}

// ─── Registry health probe (P5c #3 — never silently 404) ────────────────────

/**
 * Probe every configured registry's reachability (status-aware).
 *
 * - local-dir  → index.json present + parseable?
 * - github-raw / browse-sh → HTTP fetch of index.json, recording res.status
 * - git-repo   → clone succeeds AND a skills root is found?
 *
 * Used by the CLI's empty-result paths: when a source is unreachable the user
 * is told WHICH source failed and how to fix it (configure skills.registries[]
 * or BUFF_SKILLS_REGISTRY) — never a silent "no skills found".
 */
export async function probeRegistries(cm?: ConfigManager): Promise<RegistryProbe[]> {
  const sources = allSources(cm);
  const out: RegistryProbe[] = [];
  for (const source of sources) {
    switch (source.kind) {
      case 'local-dir': {
        const base = baseRoot(source);
        try {
          const raw = readFileSync(join(base, 'index.json'), 'utf-8');
          const index = JSON.parse(raw) as { skills?: unknown };
          const skills = Array.isArray(index.skills) ? index.skills : [];
          out.push({ source, reachable: true, entryCount: skills.length });
        } catch {
          out.push({ source, reachable: false, reason: 'missing-index', entryCount: 0 });
        }
        break;
      }
      case 'github-raw':
      case 'browse-sh': {
        try {
          const base = baseRoot(source).replace(/\/$/, '');
          const res = await fetch(`${base}/index.json`, {
            headers: { 'User-Agent': 'agent-nuvira/2.0', Accept: 'application/json' },
            signal: AbortSignal.timeout(BROWSE_SH_TIMEOUT_MS),
          });
          if (!res.ok) {
            out.push({ source, reachable: false, status: res.status, reason: 'http-error', entryCount: 0 });
            break;
          }
          const data = (await res.json()) as { skills?: unknown; results?: unknown };
          const raw = (data as Record<string, unknown>).skills ?? (data as Record<string, unknown>).results;
          const skills = Array.isArray(raw) ? raw : [];
          out.push({ source, reachable: true, status: res.status, entryCount: skills.length });
        } catch (err) {
          out.push({
            source,
            reachable: false,
            reason: err instanceof TypeError ? 'network' : 'http-error',
            entryCount: 0,
          });
        }
        break;
      }
      case 'git-repo': {
        const repoRoot = cloneRepo(baseRoot(source));
        if (!repoRoot) {
          out.push({ source, reachable: false, reason: 'clone-failed', entryCount: 0 });
          break;
        }
        const root = findRepoSkillsRoot(repoRoot);
        if (!root) {
          out.push({ source, reachable: false, reason: 'no-skills-root', entryCount: 0 });
          break;
        }
        const entries = indexGitRepo(source);
        out.push({ source, reachable: true, entryCount: entries.length });
        break;
      }
    }
  }
  return out;
}

/**
 * Human-readable fix hint for unreachable registries — the CLI appends this
 * to empty-result messages so a 404 is EXPLICIT, never silent.
 */
export function unreachableRegistryHint(probes: RegistryProbe[]): string {
  const bad = probes.filter((p) => !p.reachable);
  if (bad.length === 0) return '';
  const lines = bad.map((p) => {
    const status = p.status !== undefined ? ` (HTTP ${p.status})` : '';
    return `  ⚠️  ${p.source.base} — ${p.reason}${status}`;
  });
  return (
    `Unreachable registry source(s):\n${lines.join('\n')}\n` +
    `  Fix: add a reachable registry to buffconfig skills.registries[] or set BUFF_SKILLS_REGISTRY.`
  );
}

// ─── Unified search ─────────────────────────────────────────────────────────

/**
 * Search ALL configured registries, deduped by name (first registry wins).
 * Optionally restrict to one source kind (e.g. --source browse-sh).
 */
export async function searchAllRegistries(query: string, opts?: { sourceKind?: string; cm?: ConfigManager }): Promise<
  Array<HubSkillEntry & { sourceKind: string }>
> {
  const q = query.toLowerCase();
  const sources = allSources(opts?.cm).filter(
    (s) => !opts?.sourceKind || s.kind === opts.sourceKind,
  );
  const seen = new Set<string>();
  const out: Array<HubSkillEntry & { sourceKind: string }> = [];
  for (const source of sources) {
    const index = await fetchSourceIndex(source);
    for (const entry of index) {
      if (seen.has(entry.name)) continue;
      const haystack = `${entry.name} ${entry.description} ${entry.tags.join(' ')} ${entry.source}`.toLowerCase();
      if (haystack.includes(q)) {
        seen.add(entry.name);
        out.push({ ...entry, sourceKind: source.kind });
      }
    }
  }
  return out;
}

/** Find ONE entry by name across all registries (priority order). */
export async function findEntryAcrossRegistries(
  name: string,
  opts?: { sourceKind?: string; cm?: ConfigManager },
): Promise<RegistryResult<HubSkillEntry> | null> {
  const sources = allSources(opts?.cm).filter(
    (s) => !opts?.sourceKind || s.kind === opts.sourceKind,
  );
  for (const source of sources) {
    const index = await fetchSourceIndex(source);
    const entry = index.find((e) => e.name === name);
    if (entry) return { source, value: entry };
  }
  return null;
}

// ─── Install from a specific source ─────────────────────────────────────────

/**
 * Install a skill from a SPECIFIC source. Reuses the sandboxed install path
 * (name validation, frontmatter checks, checksum + provenance) from
 * skills-hub.ts; the source's fetch is injected so provenance records where
 * the skill actually came from.
 */
export async function installFromSource(
  entry: HubSkillEntry,
  source: RegistrySource,
  projectRoot = process.cwd(),
  force = false,
): Promise<{ ok: boolean; name: string; version?: string; source?: string; quarantined?: boolean; reason?: string }> {
  const { installHubSkill } = await import('./skills-hub.js');
  return installHubSkill({ ...entry, source: source.base }, projectRoot, force, {
    registry: source.base,
    fetchSkill: (name) => fetchSourceSkill(source, name),
  });
}
