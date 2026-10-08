/**
 * Skill hint tests (`tests/tools/loop-skill-hint.test.ts`) — MODEL-DRIVEN skill
 * selection.
 *
 * HISTORY: this module used to keyword-match ONE skill to the goal and inject
 * its methodology. The scorer was retired — a word list cannot decide what a
 * goal MEANS, and each stopword added to fix one false positive made a real
 * match wrong. Selection is now the MODEL's job: the harness injects a bounded
 * DISCOVERY POINTER (the `skill` tool + the capability search) by default, with
 * the full catalog available OPT-IN.
 *
 * Isolation: the compiled SkillStore pins ~/.nuvira/skills at MODULE IMPORT
 * time, so the hint module is imported DYNAMICALLY (vi.resetModules + import)
 * AFTER HOME has been pinned to a temp dir. Hub skills install under the temp
 * project's .agents/skills/ (the catalog re-reads at call time). No test ever
 * touches the developer's real ~/.nuvira.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../../src/config/manager.js';

// ─── Isolation scaffolding ──────────────────────────────────────────────────

let projectDir = '';
let homeDir = '';
const envBackup: Record<string, string | undefined> = {};
const cwdBackup = process.cwd();

function skillMd(name: string, description: string, body = 'Methodology steps: 1) gather 2) verify'): string {
  return `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\n---\n\n${body}\n`;
}

beforeEach(() => {
  vi.resetModules();
  envBackup.HOME = process.env.HOME;
  delete process.env.NUVIRA_SKILL_CATALOG;
  delete process.env.BUFF_SKILL_CATALOG;
  homeDir = mkdtempSync(join(tmpdir(), 'buff-hint-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'buff-hint-proj-'));
  process.env.HOME = homeDir;
  process.chdir(projectDir);
});

afterEach(() => {
  if (envBackup.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = envBackup.HOME;
  delete process.env.NUVIRA_SKILL_CATALOG;
  delete process.env.BUFF_SKILL_CATALOG;
  process.chdir(cwdBackup);
  vi.resetModules();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

/** Import the hint module AFTER the env pins (dynamic import). */
async function loadHint() {
  return await import('../../src/tools/loop-skill-hint.js');
}

/** Install a hub skill (SKILL.md) into the temp project. */
function installHubSkill(name: string, description: string, body?: string): void {
  const dir = join(projectDir, '.agents', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMd(name, description, body), 'utf-8');
}

// ─── collectSkillEntries ────────────────────────────────────────────────────

describe('collectSkillEntries — the catalog the model picks from', () => {
  it('includes the bundled compiled skills and installed hub skills', async () => {
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const { collectSkillEntries } = await loadHint();
    const entries = await collectSkillEntries();
    expect(entries.some((e) => e.name === 'zorbafier')).toBe(true);
    // The bundled first-party batch seeds into the fresh temp store.
    expect(entries.length).toBeGreaterThan(1);
  });

  it('excludes a disabled hub skill (the toggle is never cosmetic)', async () => {
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const cm = new ConfigManager(join(projectDir, 'cfg'));
    cm.save({ skills: { disabled: ['zorbafier'] } });
    const { collectSkillEntries } = await loadHint();
    const entries = await collectSkillEntries(cm);
    expect(entries.some((e) => e.name === 'zorbafier')).toBe(false);
  });
});

// ─── buildSkillPointerHint — the default ────────────────────────────────────

describe('buildSkillPointerHint — the model-driven default', () => {
  it('names the two discovery paths (the skill tool and the capability search)', async () => {
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const { buildSkillPointerHint } = await loadHint();
    const hint = await buildSkillPointerHint();
    expect(hint).toContain('## Skills');
    // BOTH model-driven paths must be present — this is what replaced the scorer.
    expect(hint).toContain('skill tool');
    expect(hint).toContain('tool_search');
    expect(hint).toContain('kind "skill"');
    // It is a POINTER, not a catalog, and not a recommendation.
    expect(hint).not.toContain('## Available skills');
    expect(hint.length).toBeLessThan(1200);
  });

  it('points the pipeline tail at skill_view instead of the loop skill tool', async () => {
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const { buildSkillPointerHint } = await loadHint();
    const hint = await buildSkillPointerHint(undefined, 'skill-view');
    expect(hint).toContain('skill_view');
    expect(hint).not.toContain('{"skill":"<name>"}');
  });
});

// ─── buildSkillCatalogHint — the opt-in catalog ─────────────────────────────

describe('buildSkillCatalogHint — the full list, when chosen', () => {
  it('lists the available skills with a load instruction, so the model decides', async () => {
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const { buildSkillCatalogHint } = await loadHint();
    // A high cap so the installed skill is inside the window.
    const hint = await buildSkillCatalogHint(undefined, { maxSkills: 500 });
    expect(hint).toContain('## Available skills');
    expect(hint).toContain('zorbafier');
    expect(hint).toContain('{"skill":"<name>"}');
    expect(hint).toMatch(/ONLY when it genuinely applies/);
  });

  it('never lists a disabled skill (the toggle is never cosmetic)', async () => {
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const cm = new ConfigManager(join(projectDir, 'cfg'));
    cm.save({ skills: { disabled: ['zorbafier'] } });
    const { buildSkillCatalogHint } = await loadHint();
    const hint = await buildSkillCatalogHint(cm);
    expect(hint).not.toContain('zorbafier');
  });

  it('is bounded — descriptions are capped', async () => {
    installHubSkill('zorbafier', 'X'.repeat(2000));
    const { buildSkillCatalogHint } = await loadHint();
    const hint = await buildSkillCatalogHint(undefined, { descriptionChars: 80 });
    expect(hint).toContain('…');
  });

  it('namesOnly drops descriptions but keeps the load instruction', async () => {
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const { buildSkillCatalogHint } = await loadHint();
    const hint = await buildSkillCatalogHint(undefined, { namesOnly: true });
    expect(hint).toContain('zorbafier');
    expect(hint).not.toContain('Zorbafies the widget frobnicator');
  });
});

// ─── mode resolution ────────────────────────────────────────────────────────

describe('skill-hint mode — pointer by default, catalog is OPT-IN', () => {
  it('resolves to `pointer` by default, `catalog` from env/config, `off` on request', async () => {
    const { resolveSkillHintMode, parseSkillHintMode, DEFAULT_SKILL_HINT_MODE } = await loadHint();
    expect(DEFAULT_SKILL_HINT_MODE).toBe('pointer');
    expect(resolveSkillHintMode()).toBe('pointer');

    process.env.NUVIRA_SKILL_CATALOG = 'catalog';
    expect(resolveSkillHintMode()).toBe('catalog');
    process.env.NUVIRA_SKILL_CATALOG = 'off';
    expect(resolveSkillHintMode()).toBe('off');
    delete process.env.NUVIRA_SKILL_CATALOG;

    const cm = { getAll: () => ({ skills: { catalogHint: 'catalog' } }) } as unknown as ConfigManager;
    expect(resolveSkillHintMode(cm)).toBe('catalog');

    expect(parseSkillHintMode('nonsense')).toBeNull();
    expect(parseSkillHintMode('')).toBeNull();
    expect(parseSkillHintMode('names')).toBe('names');
    expect(parseSkillHintMode('names-only')).toBe('names');
    // Back-compat: the retired `match`/`keyword` values now mean the pointer.
    expect(parseSkillHintMode('match')).toBe('pointer');
    expect(parseSkillHintMode('keyword')).toBe('pointer');
  });
});

// ─── buildConfiguredSkillHint — the one entry point ─────────────────────────

describe('buildConfiguredSkillHint — the full catalog is OPT-IN, never the default', () => {
  it('in the DEFAULT (pointer) mode the hint stays small and is not the catalog', async () => {
    // The regression this whole gate exists for: 3.3.11 appended the catalog
    // (24,543 chars) to EVERY turn, taking the chat system prompt from
    // 7,653 → 32,809 chars. The default must stay small.
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const { buildConfiguredSkillHint } = await loadHint();
    const hint = await buildConfiguredSkillHint();
    expect(hint).not.toContain('## Available skills');
    expect(hint).toContain('## Skills');
    expect(hint.length).toBeLessThan(2000);
  });

  it('in `catalog` mode injects the full list (and `off` injects nothing)', async () => {
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const { buildConfiguredSkillHint } = await loadHint();

    process.env.NUVIRA_SKILL_CATALOG = 'catalog';
    const catalog = await buildConfiguredSkillHint();
    expect(catalog).toContain('## Available skills');
    expect(catalog).toContain('zorbafier');

    process.env.NUVIRA_SKILL_CATALOG = 'off';
    expect(await buildConfiguredSkillHint()).toBe('');
  });

  it('in `names` mode lists names WITHOUT descriptions, and is smaller than `catalog`', async () => {
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const { buildConfiguredSkillHint } = await loadHint();

    process.env.NUVIRA_SKILL_CATALOG = 'names';
    const names = await buildConfiguredSkillHint();
    expect(names).toContain('zorbafier');
    expect(names).not.toContain('Zorbafies the widget frobnicator');
    expect(names).toContain('{"skill":"<name>"}');

    process.env.NUVIRA_SKILL_CATALOG = 'catalog';
    const catalog = await buildConfiguredSkillHint();
    expect(names.length).toBeLessThan(catalog.length);
  });
});
