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

  it('does not treat generic process vocabulary as goal evidence', async () => {
    const { hasRealGoalEvidence } = await loadHint();
    const roadmap = {
      name: 'technical-roadmap',
      tags: ['roadmap', 'planning', 'migration', 'architecture', 'phases', 'strategy'],
      goalPattern: 'roadmap migration plan technical plan phased upgrade path target state current state phases dependencies milestones',
    };
    // Live false positive (2026-09-20): a TRAVEL prompt matched this skill on the
    // single generic tag `planning` and injected a phased-migration methodology
    // into the turn. Neither a name word nor a domain tag is present here.
    expect(
      hasRealGoalEvidence('am planning to travel to vietnam — beach, casino, 8-12 days, avoid hanoi', roadmap),
    ).toBe(false);
    // Real evidence is unaffected: the skill's own name word, or a domain tag
    // (`migration` is a domain word, not process vocabulary).
    expect(hasRealGoalEvidence('build a migration roadmap for this codebase', roadmap)).toBe(true);
    expect(hasRealGoalEvidence('plan the phases for the migration', roadmap)).toBe(true);
  });

  /**
   * A TARGET PLATFORM is a constraint on the work, not evidence for a
   * methodology.
   *
   * Live false positive (2026-09-21): "…a multiple screen calculator and unit
   * converter, it should be GUI and cross platform for Windows and Linux"
   * activated `wsl-setup` (tags `wsl, windows, linux, development, gpu`) and
   * injected WSL distribution/GPU-passthrough methodology into a Flutter app
   * plan. BOTH tag hits and BOTH pattern hits came from the platform names
   * alone. Observed on the real chat engine, twice (chat + the pipeline path).
   */
  it('does not treat platform/OS names as goal evidence', async () => {
    const { hasRealGoalEvidence, isPlatformName, isSkillActivated } = await loadHint();
    const wsl = {
      name: 'wsl-setup',
      tags: ['wsl', 'windows', 'linux', 'development', 'gpu'],
      goalPattern: 'WSL windows subsystem linux setup configuration development environment GPU networking',
    };

    // The exact live goal: no platform-only evidence. A relevant skill (the hub
    // `cross-platform-build`) may match instead — what must never happen is the
    // PLATFORM names acting as the evidence.
    expect(
      hasRealGoalEvidence(
        'Create a project plan to develop a multiple screen calculator and unit converter , it should be GUI and cross platform for Windows and Linux',
        wsl,
      ),
    ).toBe(false);
    expect(hasRealGoalEvidence('build a desktop app for macOS and Windows', wsl)).toBe(false);
    expect(hasRealGoalEvidence('make it work on windows and linux', wsl)).toBe(false);

    // Real intent still matches — domain words from the pattern, not platform names.
    expect(hasRealGoalEvidence('configure wsl networking and development environment', wsl)).toBe(true);
    expect(hasRealGoalEvidence('set up a linux development environment', wsl)).toBe(true);

    // The exclusion is narrow: HOSTS only. Tooling/cloud domains stay evidence,
    // because "deploy to AWS" IS a request for deployment methodology.
    expect(isPlatformName('Windows')).toBe(true);
    expect(isPlatformName('ubuntu')).toBe(true);
    expect(isPlatformName('wsl')).toBe(true);
    expect(isPlatformName('docker')).toBe(false);
    expect(isPlatformName('kubernetes')).toBe(false);
    expect(isPlatformName('postgres')).toBe(false);

    // …and the composed gate keeps the website-deploy rule intact.
    expect(isSkillActivated('deploy the api', { id: 'skill-website-deploy', name: 'website-deploy' })).toBe(false);
    expect(
      isSkillActivated('deploy my website to cloudflare pages', { id: 'skill-website-deploy', name: 'website-deploy' }),
    ).toBe(true);
  });

  /**
   * Integration lock on the REAL bundled definition, not a synthetic copy.
   *
   * The cases above use a made-up `wsl-setup` object; this one drives the
   * ACTUAL `wslSetupSkill` shipped in `src/skills/bundled-skills-phase3.ts`
   * (id `skill-wsl-setup`, tags `wsl, windows, linux, development, gpu`) with
   * the three live ambiguous goals from the user's report. If a future edit to
   * that skill's tags/goalPattern reintroduces platform-name evidence, this
   * test — not a user's WhatsApp reply — catches it.
   */
  it('never activates the REAL bundled wsl-setup on the live ambiguous goals', async () => {
    const { isSkillActivated, hasRealGoalEvidence } = await loadHint();
    const { wslSetupSkill } = await import('../../src/skills/bundled-skills-phase3.js');
    const goals = [
      'Create a project plan to develop a multiple screen calculator and unit converter , it should be GUI and cross platform for Windows and Linux',
      'Create a plan for diet and exercise to loose wait by 10 KGs in 3 months , i have bad knee',
      'Can you create plan to enable my child learn spoken English',
    ];
    for (const goal of goals) {
      expect(hasRealGoalEvidence(goal, wslSetupSkill)).toBe(false);
      expect(isSkillActivated(goal, wslSetupSkill)).toBe(false);
    }
    // The skill still fires for its OWN intent — the gate is a filter, not an off-switch.
    expect(isSkillActivated('set up wsl with gpu passthrough and networking', wslSetupSkill)).toBe(true);
  });

  /**
   * Evidence matching is by WHOLE WORD. `q.includes(word)` let a skill's
   * goalPattern word match inside an unrelated goal word — measured:
   * `feature-flags` ("…kill switch…") matched "no skill covers alpaca husbandry
   * whatsoever" because "kill" sits inside "s-KILL". `mac` inside "machine" and
   * `arch` inside "search" are the same bug.
   */
  it('matches whole words only, never substrings', async () => {
    const { hasRealGoalEvidence } = await loadHint();
    const featureFlags = {
      name: 'feature-flags',
      tags: ['feature-flags', 'toggle', 'rollout'],
      goalPattern: 'feature flag toggle rollout ab testing kill switch launchdarkly unleash',
    };
    const featureFlagsHub = {
      ...featureFlags,
      description: 'Implement feature flags for gradual rollouts, A/B testing and kill switches.',
    };
    for (const skill of [featureFlags, featureFlagsHub]) {
      expect(hasRealGoalEvidence('no skill covers alpaca husbandry whatsoever', skill)).toBe(false);
      expect(hasRealGoalEvidence('which architecture does this use', skill)).toBe(false);
    }
    // Real domain evidence still matches.
    expect(hasRealGoalEvidence('add a kill switch for this feature', featureFlagsHub)).toBe(true);
  });

  /**
   * Pattern evidence must be two DISTINCT words.
   *
   * The evidence text is `goalPattern + description`, so a plain counter let
   * ONE word that a skill repeats in BOTH fields count twice and clear the
   * two-word bar on its own. Measured live (2026-09-21): "Create a book which
   * teaches math's devision for class 4 student" activated `game-development`
   * — its only overlap with the goal is the word `create`, present in its
   * goalPattern (`game create build …`) AND again in its description ("Use
   * when the goal asks to create, build, or develop a game").
   */
  it('requires two DISTINCT pattern words (a repeated word is ONE hit)', async () => {
    const { hasRealGoalEvidence } = await loadHint();
    const gameDev = {
      name: 'game-development',
      tags: ['game', 'gui', 'board-game', '2d', 'interactive', 'entertainment'],
      goalPattern: 'game create build develop snake ladder tic tac toe chess board card puzzle 2d platformer GUI play win lose',
      description:
        'Create a GUI game with graphics, input handling, game logic, and packaging. Use when the goal asks to create, build, or develop a game (board games, card games, puzzle games, 2D games, snake-and-ladder, tic-tac-toe, chess, etc.).',
    };
    // The live false positive: the only shared word is `create`.
    expect(
      hasRealGoalEvidence("Create a book which teaches math's devision for class 4 student", gameDev),
    ).toBe(false);
    expect(hasRealGoalEvidence('Create a plan for diet and exercise to lose weight', {
      name: 'zorbafier',
      tags: ['zorbafy'],
      goalPattern: 'create a widget zorbafy frobnicator',
    })).toBe(false);
    // Real game intent still matches — via the name word or distinct domain words.
    expect(hasRealGoalEvidence('build a 2d platformer game with pygame', gameDev)).toBe(true);
    expect(hasRealGoalEvidence('create a tic tac toe game', gameDev)).toBe(true);
    expect(hasRealGoalEvidence('make a board game with chess pieces', gameDev)).toBe(true);
  });

  it('gates a hub match on its NAME, not its description prose', async () => {
    const { isSkillActivated, hasRealGoalEvidence } = await loadHint();
    // A hub match carries id/name/description only. The scorer ranks on name +
    // DESCRIPTION keywords with no evidence check, so a description that merely
    // names the target platform used to be enough.
    const hubWsl = { id: 'wsl-setup', name: 'wsl-setup' };
    expect(
      isSkillActivated(
        'Create a project plan to develop a multiple screen calculator and unit converter , it should be GUI and cross platform for Windows and Linux',
        hubWsl,
      ),
    ).toBe(false);
    expect(isSkillActivated('wsl setup and configuration for gpu passthrough', hubWsl)).toBe(true);

    // …and a description is NEVER evidence for a compiled skill either: prose
    // words like "covers" used to make matching WIDER (measured: `feature-flags`
    // matched "no skill covers alpaca husbandry whatsoever").
    const compiled = {
      name: 'feature-flags',
      tags: ['feature-flags', 'toggle', 'rollout', 'ab-testing', 'gradual', 'kill-switch'],
      goalPattern: 'feature flag toggle rollout ab testing kill switch launchdarkly unleash',
    };
    expect(hasRealGoalEvidence('no skill covers alpaca husbandry whatsoever', compiled)).toBe(false);
    expect(hasRealGoalEvidence('set up feature flags for a gradual rollout', compiled)).toBe(true);
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
