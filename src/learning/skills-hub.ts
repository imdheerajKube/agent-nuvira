/**
 * J3 — Skills hub + sync (`src/learning/skills-hub.ts`).
 *
 * A community-skill hub with
 * `.agents/skills` + `npx skills add` flow: discover, install, update, and
 * audit community skills from a configurable registry.
 *
 * Registry layout (same shape as the workflow registry):
 *   .agents/skills/index.json          — master index (HubSkillEntry[])
 *   .agents/skills/<name>/SKILL.md     — the skill (markdown w/ frontmatter)
 *   .agents/skills/<name>/manifest.json — optional extra metadata (author, tags)
 *
 * Security model (mirrors `skills_hub.py`):
 * - **Sandboxed install**: skill names are validated (`^[a-z0-9-]+$`) and the
 *   target path is always `<project>/.agents/skills/<name>/` — no traversal.
 * - **Provenance + checksum**: every install records `{source, version,
 *   installedAt, sha256, origin}` in `~/.buff/skills-hub/provenance.json`; the
 *   checksum is re-verified on update and a mismatch quarantines the skill
 *   (moved to `~/.buff/skills-hub/quarantine/`) instead of overwriting.
 * - **Availability-gated**: unset registry → the built-in default (GitHub raw);
 *   `BUFF_SKILLS_REGISTRY` overrides (can point at a local dir for offline use).
 * - Registry index cached with a 1h TTL (same as workflow registry).
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveNuviraHome } from '../config/paths.js';

import { logger } from '../utils/logger.js';
import { compareVersions } from '../workflow/registry.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A skill entry in the registry index. */
export interface HubSkillEntry {
  /** Skill name — must match `^[a-z0-9-]+$` (the sandbox allowlist). */
  name: string;
  /** One-line description. */
  description: string;
  /** Semantic version (e.g. "1.0.0"). */
  version: string;
  /** Author name or GitHub handle. */
  author: string;
  /** Tags for search/filter. */
  tags: string[];
  /** Source identifier: "owner/repo" (or "local:<dir>" for a local registry). */
  source: string;
  /** When the skill was last updated (ISO string). */
  updatedAt: string;
}

/** The master registry index file format. */
interface HubIndex {
  version: number;
  updatedAt: string;
  skills: HubSkillEntry[];
}

/** Provenance record for an installed skill. */
export interface SkillProvenance {
  name: string;
  source: string;
  version: string;
  installedAt: number;
  /** SHA-256 of the installed SKILL.md (content-addressed trust). */
  sha256: string;
  origin: 'registry' | 'local';
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Built-in default registry. The PACKAGED local dir is preferred (see
 * packagedRegistryDir): the `.agents/skills/` layout ships inside the npm
 * package + the repo checkout, so the default resolves from the install
 * itself — private-repo-independent, offline, and never a silent 404. The
 * GitHub raw URL is the last-resort fallback for unusual installs that lack
 * the packaged dir.
 */
const DEFAULT_REGISTRY_BASE = 'https://raw.githubusercontent.com/imdheerajKube/agent-nuvira/main/.agents/skills';

/** Local store for provenance + quarantine. */
const BUFF_DIR = resolveNuviraHome();
const HUB_DIR = join(BUFF_DIR, 'skills-hub');
const PROVENANCE_PATH = join(HUB_DIR, 'provenance.json');
const QUARANTINE_DIR = join(HUB_DIR, 'quarantine');

/** Index cache (1h TTL, same as the workflow registry). */
const INDEX_CACHE_PATH = join(HUB_DIR, 'index-cache.json');
const INDEX_CACHE_TTL = 60 * 60 * 1000;

/**
 * Per-source cache key: a sha256 of the registry base. I7 P1 multi-source
 * search fetches SEVERAL registries; a single shared cache file would hand
 * source B the stale index of source A. Keying by base keeps each source's
 * index separate (1h TTL each).
 */
function indexCacheKeyFor(base: string): string {
  return createHash('sha256').update(base).digest('hex').slice(0, 16);
}

/** Install root: `<project>/.agents/skills/` (the `npx skills` convention). */
const SKILL_NAME_RE = /^[a-z0-9-]+$/;
const MAX_INDEX_FETCH_MS = 10_000;
const MAX_SKILL_FETCH_MS = 15_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDirs(): void {
  for (const dir of [HUB_DIR, QUARANTINE_DIR]) {
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    }
  }
}

function skillsDir(projectRoot = process.cwd()): string {
  return join(projectRoot, '.agents', 'skills');
}

function skillDir(projectRoot: string, name: string): string {
  return join(skillsDir(projectRoot), name);
}

function sha256Of(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * The packaged `.agents/skills/` registry dir (npm-installed or repo
 * checkout) — `file://` base when present, null when absent. Resolved from
 * the module location: dev (tsx) src/learning → ../../ = repo root;
 * compiled dist/learning → ../../ = package root. Both carry `.agents/skills`
 * (committed in the repo, shipped in the npm tarball via package.json files).
 */
export function packagedRegistryDir(): string | null {
  try {
    const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const dir = join(pkgRoot, '.agents', 'skills');
    return existsSync(join(dir, 'index.json')) ? dir : null;
  } catch {
    return null;
  }
}

/** Resolve the registry base: env override → packaged dir → built-in default. */
function registryBase(): string {
  if (process.env.BUFF_SKILLS_REGISTRY) return process.env.BUFF_SKILLS_REGISTRY;
  const packaged = packagedRegistryDir();
  if (packaged) return `file://${packaged}`;
  return DEFAULT_REGISTRY_BASE;
}

/** Is a registry base a local directory (offline mode)? */
function isLocalRegistryBase(base: string): boolean {
  return base.startsWith('file://') || (!base.includes('://') && existsSync(base));
}

/** Back-compat helper: is the CURRENT registry a local directory? */
function isLocalRegistry(): boolean {
  return isLocalRegistryBase(registryBase());
}

// ─── Provenance store ───────────────────────────────────────────────────────

function readProvenance(): SkillProvenance[] {
  try {
    ensureDirs();
    if (!existsSync(PROVENANCE_PATH)) return [];
    return JSON.parse(readFileSync(PROVENANCE_PATH, 'utf-8')) as SkillProvenance[];
  } catch {
    return [];
  }
}

function writeProvenance(records: SkillProvenance[]): void {
  try {
    ensureDirs();
    writeFileSync(PROVENANCE_PATH, JSON.stringify(records, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

/** Record provenance for one skill (replace any previous record of same name). */
export function recordSkillProvenance(record: SkillProvenance): void {
  const records = readProvenance().filter((r) => r.name !== record.name);
  records.push(record);
  writeProvenance(records);
}

// ─── Index fetch (with TTL cache) ───────────────────────────────────────────

function readIndexCache(base: string): HubSkillEntry[] | null {
  try {
    const cachePath = join(HUB_DIR, `index-cache-${indexCacheKeyFor(base)}.json`);
    if (!existsSync(cachePath)) return null;
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as {
      timestamp: number;
      skills: HubSkillEntry[];
    };
    if (Date.now() - raw.timestamp > INDEX_CACHE_TTL) return null;
    return raw.skills;
  } catch {
    return null;
  }
}

function writeIndexCache(base: string, skills: HubSkillEntry[]): void {
  try {
    ensureDirs();
    writeFileSync(join(HUB_DIR, `index-cache-${indexCacheKeyFor(base)}.json`), JSON.stringify({ timestamp: Date.now(), skills }, null, 2), 'utf-8');
  } catch { /* non-critical */ }
}

/**
 * Fetch a registry index (with TTL caching). `base` defaults to the legacy
 * registry resolution (BUFF_SKILLS_REGISTRY env → built-in default); the I7
 * P1 multi-source path passes an explicit base per source. Local-dir
 * registries read the index directly from disk; remote ones fetch over HTTP.
 */
export async function fetchHubIndex(base?: string): Promise<HubSkillEntry[]> {
  const registry = base ?? registryBase();
  const cached = readIndexCache(registry);
  if (cached) return cached;

  try {
    let index: HubIndex;
    if (isLocalRegistryBase(registry)) {
      const local = registry.replace(/^file:\/\//, '');
      const raw = readFileSync(join(local, 'index.json'), 'utf-8');
      index = JSON.parse(raw) as HubIndex;
    } else {
      const res = await fetch(`${registry}/index.json`, {
        headers: { 'User-Agent': 'agent-nuvira/2.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(MAX_INDEX_FETCH_MS),
      });
      if (!res.ok) {
        logger.debug(`Skills index fetch failed (${res.status}), using cache`);
        return cached || [];
      }
      index = (await res.json()) as HubIndex;
    }

    if (!index.skills || !Array.isArray(index.skills)) {
      logger.debug('Invalid skills index format');
      return cached || [];
    }

    writeIndexCache(registry, index.skills);
    return index.skills;
  } catch (err) {
    logger.debug(`Failed to fetch skills index: ${err}`);
    return cached || [];
  }
}

/** Search the registry index for skills matching a query. */
export async function searchHubSkills(query: string): Promise<HubSkillEntry[]> {
  const skills = await fetchHubIndex();
  const q = query.toLowerCase();
  return skills.filter((s) =>
    `${s.name} ${s.description} ${s.tags.join(' ')} ${s.source}`.toLowerCase().includes(q),
  );
}

// ─── Install ────────────────────────────────────────────────────────────────

/** Result of an install/update attempt. */
export interface SkillInstallResult {
  ok: boolean;
  name: string;
  version?: string;
  source?: string;
  quarantined?: boolean;
  reason?: string;
}

/**
 * Read a skill file (SKILL.md) from a registry base (local-dir or HTTP).
 * Exported so the I7 P1 multi-source registry can fetch per-source.
 */
export async function fetchSkillFile(registry: string, path: string): Promise<string | null> {
  try {
    if (registry.startsWith('file://') || (!registry.includes('://') && existsSync(registry))) {
      const base = registry.replace(/^file:\/\//, '');
      const full = join(base, path);
      if (!existsSync(full)) return null;
      return readFileSync(full, 'utf-8');
    }
    const res = await fetch(`${registry}/${path}`, {
      headers: { 'User-Agent': 'agent-nuvira/2.0', Accept: 'text/markdown,text/plain,*/*' },
      signal: AbortSignal.timeout(MAX_SKILL_FETCH_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Install a skill into `<project>/.agents/skills/<name>/` (sandboxed: the name
 * must match `^[a-z0-9-]+$`). Records provenance + checksum; a checksum
 * mismatch on REINSTALL quarantines the incoming copy instead of overwriting.
 * Pass `force: true` (the explicit `buff skills update` path) to overwrite
 * instead of quarantine — an explicit update is the user saying "bring this
 * skill to the registry's latest".
 *
 * @param entry       The registry entry to install.
 * @param projectRoot Project root for the `.agents/skills/` target.
 * @param force       Overwrite an existing skill whose content changed.
 * @param overrides   I7 P1 multi-source: an explicit fetch + registry label
 *                    (the source adapter). Absent → legacy env/base path.
 */
export async function installHubSkill(
  entry: HubSkillEntry,
  projectRoot = process.cwd(),
  force = false,
  overrides?: { fetchSkill?: (name: string) => Promise<string | null>; registry?: string },
): Promise<SkillInstallResult> {
  const { name } = entry;

  // ── Sandbox: validate the name — no traversal, no spaces, no dots. ──────
  if (!SKILL_NAME_RE.test(name) || name === '.' || name === '..') {
    return { ok: false, name, reason: `Refused: skill name '${name}' is not in [a-z0-9-]` };
  }

  const registry = overrides?.registry ?? registryBase();
  const skillMarkdown = overrides?.fetchSkill
    ? await overrides.fetchSkill(name)
    : await fetchSkillFile(registry, `${name}/SKILL.md`);
  if (!skillMarkdown) {
    return { ok: false, name, reason: `SKILL.md not found in registry for '${name}'` };
  }

  // Basic frontmatter sanity: require a `name:` line that matches the entry
  // name, and non-trivial content. NB: `[ \t]*` not `\s*` — `\s` would greedily
  // eat the newline and break `$`; both alternates need `m` for line starts.
  const declaredName = skillMarkdown.match(/^name:\s*([^\s]+)\s*$/m)?.[1];
  if (!/^---[ \t]*$/m.test(skillMarkdown) || !declaredName) {
    return { ok: false, name, reason: `Invalid skill: '${name}' lacks frontmatter (--- + name:)` };
  }
  if (declaredName !== name) {
    return { ok: false, name, reason: `Invalid skill: frontmatter declares name '${declaredName}' but registry entry is '${name}'` };
  }

  const sha = sha256Of(skillMarkdown);
  const target = skillDir(projectRoot, name);
  const targetFile = join(target, 'SKILL.md');

  // ── Checksum verification on existing installs. ─────────────────────────
  if (existsSync(targetFile)) {
    const existing = readFileSync(targetFile, 'utf-8');
    if (sha256Of(existing) === sha) {
      return { ok: true, name, version: entry.version, source: entry.source, reason: 'already up to date' };
    }
    // Content changed. `force` (explicit update) overwrites + re-records;
    // otherwise quarantine the incoming copy, never silently overwrite.
    if (force) {
      try {
        writeFileSync(targetFile, skillMarkdown, 'utf-8');
      } catch (err) {
        return { ok: false, name, reason: `update write failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      recordSkillProvenance({
        name,
        source: entry.source,
        version: entry.version,
        installedAt: Date.now(),
        sha256: sha,
        origin: isLocalRegistry() ? 'local' : 'registry',
      });
      logger.success(`Updated skill: ${name} v${entry.version} → ${targetFile}`);
      return { ok: true, name, version: entry.version, source: entry.source, reason: 'updated' };
    }
    try {
      ensureDirs();
      const quarantinePath = join(QUARANTINE_DIR, `${name}-${Date.now()}.md`);
      writeFileSync(quarantinePath, skillMarkdown, 'utf-8');
      return {
        ok: false,
        name,
        quarantined: true,
        reason: `checksum mismatch — incoming copy quarantined at ${quarantinePath}; remove the installed skill to force reinstall`,
      };
    } catch (err) {
      return { ok: false, name, reason: `quarantine failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ── Fresh install. ──────────────────────────────────────────────────────
  try {
    mkdirSync(target, { recursive: true });
    writeFileSync(targetFile, skillMarkdown, 'utf-8');
  } catch (err) {
    return { ok: false, name, reason: `write failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  recordSkillProvenance({
    name,
    source: entry.source,
    version: entry.version,
    installedAt: Date.now(),
    sha256: sha,
    origin: isLocalRegistry() ? 'local' : 'registry',
  });

  logger.success(`Installed skill: ${name} v${entry.version} (${entry.source}) → ${targetFile}`);
  return { ok: true, name, version: entry.version, source: entry.source };
}

// ─── Uninstall ───────────────────────────────────────────────────────────────

/**
 * Remove an installed skill: deletes `<project>/.agents/skills/<name>/` AND
 * its provenance record (P6d — the dashboard marketplace's uninstall button
 * and `buff skills uninstall`). Sandboxed like install: the name must match
 * `^[a-z0-9-]+$` and the target is always inside the skills root.
 *
 * @returns { ok, reason? } — ok:false only when the skill is not installed
 *          (nothing to remove) or a removal failed.
 */
export function uninstallHubSkill(
  name: string,
  projectRoot = process.cwd(),
): { ok: boolean; name: string; reason?: string } {
  if (!SKILL_NAME_RE.test(name) || name === '.' || name === '..') {
    return { ok: false, name, reason: `Refused: skill name '${name}' is not in [a-z0-9-]` };
  }
  const target = skillDir(projectRoot, name);
  let removed = false;
  try {
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      removed = true;
    }
  } catch (err) {
    return { ok: false, name, reason: `Removal failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Drop the provenance record regardless of on-disk state (a record-only
  // skill is also "uninstalled").
  const before = readProvenance();
  const after = before.filter((r) => r.name !== name);
  if (after.length !== before.length) {
    writeProvenance(after);
    removed = true;
  }
  if (!removed) {
    return { ok: false, name, reason: `Skill '${name}' is not installed.` };
  }
  logger.success(`Uninstalled skill: ${name}`);
  return { ok: true, name };
}

// ─── Update ─────────────────────────────────────────────────────────────────

/**
 * Check installed skills against the registry and reinstall any with a newer
 * version. Returns a summary of what was updated / already current.
 */
export async function updateHubSkills(
  projectRoot = process.cwd(),
): Promise<{ updated: string[]; current: string[]; failed: string[] }> {
  const records = readProvenance();
  if (records.length === 0) {
    return { updated: [], current: [], failed: [] };
  }

  // "Update" means latest: bypass the 1h index TTL so a registry bump within
  // the last hour is seen (the search path keeps the cache + --refresh).
  clearSkillsIndexCache();
  const index = await fetchHubIndex();
  const updated: string[] = [];
  const current: string[] = [];
  const failed: string[] = [];

  for (const rec of records) {
    const entry = index.find((e) => e.name === rec.name);
    if (!entry) {
      failed.push(`${rec.name} (no longer in registry)`);
      continue;
    }
    // Version gate (reuse the workflow registry's semver comparator): only
    // force-overwrite when the registry is actually NEWER. Equal/older keeps
    // the installed copy (a registry revert never downgrades, and a user's
    // local edits to an installed SKILL.md are never clobbered by `update`).
    if (compareVersions(entry.version, rec.version) <= 0) {
      current.push(rec.name);
      continue;
    }
    // force=true: an explicit update may overwrite changed content (the naive
    // reinstall path would quarantine the new copy instead of updating it).
    const result = await installHubSkill(entry, projectRoot, true);
    if (result.ok) {
      if (result.reason === 'already up to date') current.push(rec.name);
      else updated.push(rec.name);
    } else {
      failed.push(`${rec.name} (${result.reason || 'unknown'})`);
    }
  }

  return { updated, current, failed };
}

// ─── List ───────────────────────────────────────────────────────────────────

/**
 * List installed skills with their provenance origin (registry vs local).
 * If `origin` is given, filter to that origin.
 */
export function listHubSkills(
  origin?: 'registry' | 'local',
  projectRoot = process.cwd(),
): Array<{ name: string; source: string; version: string; installedAt: number; origin: 'registry' | 'local'; installed: boolean }> {
  const records = readProvenance();
  const dir = skillsDir(projectRoot);
  const onDisk: string[] = [];
  try {
    onDisk.push(...readdirSync(dir).filter((d) => SKILL_NAME_RE.test(d)));
  } catch { /* dir may not exist yet */ }

  const merged = new Map<string, { name: string; source: string; version: string; installedAt: number; origin: 'registry' | 'local'; installed: boolean }>();
  for (const rec of records) {
    merged.set(rec.name, { ...rec, installed: onDisk.includes(rec.name) });
  }
  for (const name of onDisk) {
    if (!merged.has(name)) {
      merged.set(name, { name, source: 'local', version: '?', installedAt: 0, origin: 'local', installed: true });
    }
  }

  const all = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
  return origin ? all.filter((s) => s.origin === origin) : all;
}

/** Clear ALL per-source index caches (forces a re-fetch on the next search). */
export function clearSkillsIndexCache(): void {
  try {
    for (const file of readdirSync(HUB_DIR)) {
      if (file.startsWith('index-cache-') && file.endsWith('.json')) {
        try { renameSync(join(HUB_DIR, file), join(HUB_DIR, file + '.stale')); } catch { /* best-effort */ }
      }
    }
  } catch { /* non-critical */ }
}

/** Validate + normalize a registry entry's skill name (used by the CLI). */
export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}

/** Resolve a HubSkillEntry from the index by name (used by the CLI). */
export async function getHubSkillEntry(name: string): Promise<HubSkillEntry | null> {
  const skills = await fetchHubIndex();
  return skills.find((s) => s.name === name) || null;
}

// `compareVersions` reused from `../workflow/registry.js` — skills and workflow
// templates share ONE version grammar.
