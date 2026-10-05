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

  it('does not match electron-app on a generic `packaging` tag (C4)', async () => {
    const { hasRealGoalEvidence } = await loadHint();
    const electronApp = {
      name: 'electron-app',
      tags: ['electron', 'desktop', 'app', 'ipc', 'packaging'],
      goalPattern: 'electron desktop app main process renderer IPC auto-update native modules packaging',
      description:
        'Build an Electron desktop application: main process, renderer process, IPC communication, auto-updates, and native modules.',
    };
    // Live false positive (2026-10-02): a PyQt6 bundle fix matched electron-app
    // on the single generic tag `packaging` and injected Electron methodology
    // into a macOS packaging turn.
    expect(
      hasRealGoalEvidence(
        'Fix the macOS hotkey permission and packaging defects in this project, changing app behavior as little as possible.',
        electronApp,
      ),
    ).toBe(false);
    // Real Electron intent is unaffected — the domain name word still matches.
    expect(
      hasRealGoalEvidence('build an electron desktop app with IPC and auto-update support', electronApp),
    ).toBe(true);
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

  /**
   * A document-FORMAT skill must not fire on the generic act of reading a
   * document.
   *
   * Live false positive (2026-10-03): "read my health report - blood test
   * report and share me findings which are concerning and what changes i should
   * do" injected the **docx** methodology into a PDF lab-report turn. The two
   * words that cleared the two-distinct-word bar were `read` (docx's
   * goalPattern) and `changes` (docx's description, "tracked changes") —
   * neither names a document format. The model then reported the PDF as a
   * `.docx` with blank tables.
   *
   * Locked on the REAL bundled skill, not a synthetic copy, so a future edit to
   * its tags/goalPattern/description is caught here rather than on a user's chat.
   */
  it('never activates the REAL bundled docx skill on a generic read/report goal', async () => {
    const { hasRealGoalEvidence, isSkillActivated } = await loadHint();
    const { docxSkill } = await import('../../src/skills/bundled-skills.js');
    const goals = [
      'read my health report - blood test report and share me findings which are concerning and what changes i should do to improve my health withreference to issues found in blood report.',
      'can you read pdfs?',
      'read this report and share findings',
      'read this document and tell me what changes it describes',
      // The exact hub-description false positive: `documents` + `produce` + `page`.
      'Read the health report PDF at /tmp/report.pdf using the read_extract tool. Then produce a thorough assessment.',
    ];
    for (const goal of goals) {
      expect(hasRealGoalEvidence(goal, docxSkill)).toBe(false);
      expect(isSkillActivated(goal, docxSkill)).toBe(false);
    }
    // Real docx intent is unaffected — the format NAME or a domain TAG still matches.
    expect(isSkillActivated('create a docx file for this report', docxSkill)).toBe(true);
    expect(isSkillActivated('edit the word document and add tracked changes', docxSkill)).toBe(true);
    expect(isSkillActivated('convert this to a .dotx template', docxSkill)).toBe(true);
  });

  /**
   * A generic word must not activate a skill whose whole name is that word.
   *
   * Live false positive (2026-10-03): removing the docx match unmasked this
   * one — the goal "read my health report - blood test report and share me
   * findings which are concerning…" matched the **test-strategy** skill on the
   * single name word `test` and injected a unit/integration/e2e software-
   * testing methodology into a PDF lab-report turn. `test` is a medical noun
   * there, not a request to test software.
   *
   * The rule is evidence-based, not a blunt stopword: a generic name word used
   * as a COMPOUND-NOUN modifier ("blood test report") is dropped, while the
   * verb use ("test the project") and the skill's own domain vocabulary
   * (unit/integration/regression/coverage) still match. Locked on the REAL
   * bundled skill so a future edit to its name/tags/goalPattern is caught here.
   */
  it('never activates the REAL bundled test-strategy on a health/lab-report goal', async () => {
    const { hasRealGoalEvidence, isSkillActivated } = await loadHint();
    const { testStrategySkill } = await import('../../src/skills/bundled-skills.js');
    const healthGoals = [
      'read my health report - blood test report and share me findings which are concerning and what changes i should do to improve my health withreference to issues found in blood report.',
      'here is my blood test report, summarise the abnormal values',
      'explain the results of my thyroid test report',
    ];
    for (const goal of healthGoals) {
      expect(hasRealGoalEvidence(goal, testStrategySkill)).toBe(false);
      expect(isSkillActivated(goal, testStrategySkill)).toBe(false);
    }
    // Real software-test intent is unaffected — the verb use, and the skill's
    // own domain vocabulary, both still match.
    expect(isSkillActivated('test the project and check for regressions', testStrategySkill)).toBe(true);
    expect(isSkillActivated('run the unit and integration tests', testStrategySkill)).toBe(true);
    expect(isSkillActivated('prove this change is safe and report coverage', testStrategySkill)).toBe(true);
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

describe('buildSkillCatalogHint — model-selected skills replace keyword injection', () => {
  it('lists the available skills with a load instruction, so the model decides', async () => {
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const { buildSkillCatalogHint } = await loadHint();
    // A high cap so the installed skill is inside the window (the bundled
    // catalog is large; the default cap is deliberately smaller than the list).
    const hint = await buildSkillCatalogHint(undefined, { maxSkills: 500 });
    expect(hint).toContain('## Available skills');
    expect(hint).toContain('zorbafier');
    expect(hint).toContain('{"skill":"<name>"}');
    // It is a CATALOG, not a forced recommendation — the model is told to load
    // one only when it genuinely applies.
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
});

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

// ─── buildConfiguredSkillHint — the mode gate ───────────────────────────────

describe('buildConfiguredSkillHint — the full catalog is OPT-IN, never the default', () => {
  afterEach(() => {
    delete process.env.NUVIRA_SKILL_CATALOG;
    delete process.env.BUFF_SKILL_CATALOG;
  });

  it('resolves to `match` by default, `catalog` from env/config, `off` on request', async () => {
    const { resolveSkillHintMode, parseSkillHintMode, DEFAULT_SKILL_HINT_MODE } = await loadHint();
    expect(DEFAULT_SKILL_HINT_MODE).toBe('match');
    expect(resolveSkillHintMode()).toBe('match');

    process.env.NUVIRA_SKILL_CATALOG = 'catalog';
    expect(resolveSkillHintMode()).toBe('catalog');
    process.env.NUVIRA_SKILL_CATALOG = 'off';
    expect(resolveSkillHintMode()).toBe('off');
    delete process.env.NUVIRA_SKILL_CATALOG;

    const cm = { getAll: () => ({ skills: { catalogHint: 'catalog' } }) } as unknown as ConfigManager;
    expect(resolveSkillHintMode(cm)).toBe('catalog');

    expect(parseSkillHintMode('nonsense')).toBeNull();
    expect(parseSkillHintMode('')).toBeNull();
    // `names` is its own mode (a trimmed catalog), not a synonym of full/off.
    expect(parseSkillHintMode('names')).toBe('names');
    expect(parseSkillHintMode('names-only')).toBe('names');
  });

  it('in the default (match) mode does NOT inject the catalog on a goal with no skill', async () => {
    // The regression this whole gate exists for: 3.3.11 appended the catalog
    // (24,543 chars for this goal) to EVERY turn, taking the chat system prompt
    // from 7,653 → 32,809 chars. With no override the hint must stay small.
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const { buildConfiguredSkillHint } = await loadHint();
    const hint = await buildConfiguredSkillHint('create mac od gui app');
    expect(hint).not.toContain('## Available skills');
    expect(hint.length).toBeLessThan(2000);
  });

  it('in `catalog` mode injects the full list (and `off` injects nothing)', async () => {
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const { buildConfiguredSkillHint } = await loadHint();

    process.env.NUVIRA_SKILL_CATALOG = 'catalog';
    const catalog = await buildConfiguredSkillHint('create mac od gui app');
    expect(catalog).toContain('## Available skills');
    expect(catalog).toContain('zorbafier');

    process.env.NUVIRA_SKILL_CATALOG = 'off';
    expect(await buildConfiguredSkillHint('create mac od gui app')).toBe('');
  });

  it('in `names` mode lists names WITHOUT descriptions, and is smaller than `catalog`', async () => {
    installHubSkill('zorbafier', 'Zorbafies the widget frobnicator');
    const { buildConfiguredSkillHint } = await loadHint();

    process.env.NUVIRA_SKILL_CATALOG = 'names';
    const names = await buildConfiguredSkillHint('create mac od gui app');
    expect(names).toContain('## Available skills');
    expect(names).toContain('zorbafier');
    // The description never rides along, but the load instruction still does.
    expect(names).not.toContain('Zorbafies the widget frobnicator');
    expect(names).toContain('{"skill":"<name>"}');

    process.env.NUVIRA_SKILL_CATALOG = 'catalog';
    const catalog = await buildConfiguredSkillHint('create mac od gui app');
    expect(names.length).toBeLessThan(catalog.length);
  });
});
