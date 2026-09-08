/**
 * Loop skill hint tests (`tests/tools/loop-skill-hint.test.ts`) —
 * AGENTIC_CAPABILITY_ASSESSMENT Addendum v4 Phase 3.2: the chat/execute loop
 * must hear about the orchestrator's skill layer (compiled store + hub
 * catalog) the same way the pipeline does — deterministically, with the
 * disabled + website-deploy activation gates honored, best-effort on any
 * failure, and bounded to ONE methodology block.
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

import type { LoopSkillHintMatch } from '../../src/tools/loop-skill-hint.js';
import { ConfigManager } from '../../src/config/manager.js';

// ─── Isolation scaffolding ──────────────────────────────────────────────────

let memDir = '';
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
  homeDir = mkdtempSync(join(tmpdir(), 'buff-hint-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'buff-hint-proj-'));
  // Pin home: the compiled SkillStore reads ~/.nuvira/skills (import-time
  // pin via the dynamic import below); the hub catalog reads <project>/.agents/skills
  // + ~/.nuvira/skills (call-time homedir()).
  process.env.HOME = homeDir;
  process.chdir(projectDir);
});

afterEach(() => {
  if (envBackup.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = envBackup.HOME;
  process.chdir(cwdBackup);
  vi.resetModules();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  void memDir;
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

// ─── Matching (compiled + hub, gates) ───────────────────────────────────────

describe('findLoopSkillMatch — compiled store + hub catalog', () => {
  it('matches a compiled first-party capability skill (P5b batch) and reports its source', async () => {
    const { findLoopSkillMatch } = await loadHint();
    // The bundled capability skills seed into the fresh temp store; the goal
    // carries real evidence ("assess" + "code quality" + "recommendations").
    const match = await findLoopSkillMatch('assess the code quality of this project and give recommendations');
    expect(match).not.toBeNull();
    expect(match!.source).toBe('compiled');
  });

  it('prefers the compiled batch over a same-name hub skill (compiled wins ties)', async () => {
    installHubSkill('website-deploy', 'Publish a static website to cloudflare pages');
    const { findLoopSkillMatch } = await loadHint();
    const match = await findLoopSkillMatch('deploy my website to cloudflare pages');
    expect(match).not.toBeNull();
    expect(match!.source).toBe('compiled');
    expect(match!.id).toBe('skill-website-deploy');
  });

  it('falls through to the hub catalog when the compiled store has nothing', async () => {
    // Invented vocabulary no first-party goalPattern can contain.
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const { findLoopSkillMatch } = await loadHint();
    const match = await findLoopSkillMatch('zorbafy the widget frobnicator');
    expect(match).not.toBeNull();
    expect(match!.source).toBe('hub');
    expect(match!.id).toBe('zorbafier');
  });

  it('returns null when no skill matches (never a forced match)', async () => {
    const { findLoopSkillMatch } = await loadHint();
    expect(await findLoopSkillMatch('completely unrelated goal about alpaca husbandry')).toBeNull();
  });

  it('returns null for an empty goal', async () => {
    const { findLoopSkillMatch } = await loadHint();
    expect(await findLoopSkillMatch('')).toBeNull();
    expect(await findLoopSkillMatch('   ')).toBeNull();
  });
});

describe('findLoopSkillMatch — gates', () => {
  it('excludes a hub skill listed in skills.disabled (hub branch gate)', async () => {
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const cm = new ConfigManager(join(projectDir, 'cfg'));
    cm.save({ skills: { disabled: ['zorbafier'] } });
    const { findLoopSkillMatch } = await loadHint();
    expect(await findLoopSkillMatch('zorbafy the widget frobnicator', cm)).toBeNull();
  });

  it('excludes a compiled skill listed in skills.disabled (compiled branch gate)', async () => {
    const cm = new ConfigManager(join(projectDir, 'cfg'));
    cm.save({ skills: { disabled: ['skill-website-deploy'] } });
    const { findLoopSkillMatch } = await loadHint();
    const match = await findLoopSkillMatch('deploy my website to cloudflare pages', cm);
    // The compiled website-deploy skill is gated; the hub branch has nothing
    // installed here → no match at all.
    if (match) expect(match.id).not.toBe('skill-website-deploy');
  });

  it('website-deploy methodology requires hosting intent (orchestrator parity)', async () => {
    installHubSkill('website-deploy', 'Publish a static website to cloudflare pages');
    const { findLoopSkillMatch } = await loadHint();
    // Hosting intent → injected.
    expect(await findLoopSkillMatch('put my site online — deploy the website')).not.toBeNull();
    // "Deploy the API" → NOT website methodology (the activation gate).
    const WEBSITE_DEPLOY = /website[-_ ]?deploy/i;
    const apiMatch = await findLoopSkillMatch('deploy the API to production');
    if (apiMatch) {
      expect(WEBSITE_DEPLOY.test(apiMatch.id) || WEBSITE_DEPLOY.test(apiMatch.name)).toBe(false);
    }
  });
});

// ─── Hint text ──────────────────────────────────────────────────────────────

describe('buildLoopSkillHint', () => {
  it('embeds the compiled methodology + the exact skill-tool load syntax, and echoes the match', async () => {
    const { buildLoopSkillHint } = await loadHint();
    const injected: { value: LoopSkillHintMatch | null } = { value: null };
    const hint = await buildLoopSkillHint('deploy my website to cloudflare pages', undefined, injected);
    expect(hint).toContain('## Matched skill');
    expect(hint).toContain('website-deploy');
    expect(hint).toContain('RECOMMENDATION');
    // Compiled methodology: ordered steps with agent types.
    expect(hint).toMatch(/Step 1 \[/);
    expect(hint).toContain('{"skill":"website-deploy"}');
    expect(injected.value?.id).toBe('skill-website-deploy');
    expect(injected.value?.source).toBe('compiled');
  });

  it("returns '' when nothing matched (and echoes null)", async () => {
    const { buildLoopSkillHint } = await loadHint();
    const injected: { value: LoopSkillHintMatch | null } = { value: null };
    const hint = await buildLoopSkillHint('no skill covers alpaca husbandry whatsoever', undefined, injected);
    expect(hint).toBe('');
    expect(injected.value).toBeNull();
  });

  it('is bounded to ONE methodology block per prompt', async () => {
    installHubSkill('assessor', 'assess code quality and give recommendations');
    const { buildLoopSkillHint } = await loadHint();
    const hint = await buildLoopSkillHint('deploy my website to cloudflare and assess the code quality');
    expect(hint.split('## Matched skill').length - 1).toBe(1);
  });

  it('caps the hub body text', async () => {
    const longBody = 'X'.repeat(5000);
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator', longBody);
    const { buildLoopSkillHint } = await loadHint();
    const hint = await buildLoopSkillHint('zorbafy the widget frobnicator');
    expect(hint.length).toBeLessThan(3500);
    expect(hint).toContain('…');
  });

  it('never throws on a pathological goal — falls back to no hint', async () => {
    const { buildLoopSkillHint } = await loadHint();
    const hint = await buildLoopSkillHint('x'.repeat(100_000));
    expect(typeof hint).toBe('string');
  });
});

// ─── markLoopSkillUsed ──────────────────────────────────────────────────────

describe('markLoopSkillUsed', () => {
  it('bumps the compiled skill usage counter and never throws on hub skills', async () => {
    const { findLoopSkillMatch, markLoopSkillUsed } = await loadHint();
    const match = await findLoopSkillMatch('assess the code quality of this project and give recommendations');
    if (match && match.source === 'compiled') {
      const { getSkillStore } = await import('../../src/learning/skill-store.js');
      const before = getSkillStore().get(match.id)?.usageCount ?? 0;
      await markLoopSkillUsed(match);
      expect(getSkillStore().get(match.id)?.usageCount ?? 0).toBe(before + 1);
    }
    // Hub + null are no-ops (never throw).
    await expect(markLoopSkillUsed({ name: 'hub-one', id: 'hub-one', source: 'hub' })).resolves.toBeUndefined();
    await expect(markLoopSkillUsed(null)).resolves.toBeUndefined();
  });
});
