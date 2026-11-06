/**
 * RELEASE GATE — agent behaviour contracts.
 *
 * WHY THIS FILE EXISTS. v3.3.11 shipped a regression no test caught: the skill
 * CATALOG (24.5K chars) was injected into the chat system prompt on EVERY turn,
 * taking it from 7,653 → 32,809 chars. That buried the task for weak/free-tier
 * models and made 16K-token tiers impossible; on a provider wobble it also let
 * the fallback hand a real build to a 0.5-B local model that fabricated success.
 * Nothing asserted the prompt's SIZE, so nothing failed.
 *
 * These are not unit tests of one function — they are the contracts a RELEASE
 * must satisfy. They are deliberately cheap and deterministic (no network, no
 * live provider), so they can gate every publish. When one fails, the release
 * is wrong, not the test: fix the behaviour or raise the budget on purpose,
 * never delete the assertion.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildToolSystemPrompt } from '../../src/cli/chat.js';
import {
  buildConfiguredSkillHint,
  resolveSkillHintMode,
  DEFAULT_SKILL_HINT_MODE,
} from '../../src/tools/loop-skill-hint.js';
import { analyzeTaskProfile } from '../../src/learning/auto-router.js';
import { isKnownSystemTool } from '../../src/cli/tool-install-prompt.js';

/** The intents that mean "this is code work" — never served by a trivial tier. */
const SOFTWARE_INTENTS = new Set([
  'coding',
  'debugging',
  'verification',
  'migration',
  'architecture',
  'security',
  'planning',
]);

/** A representative software ask (the exact goal that exposed the 3.3.11 blow-up). */
const SAMPLE_GOAL = 'create mac od gui app';

describe('RELEASE GATE — system prompt budget', () => {
  beforeEach(() => {
    delete process.env.NUVIRA_SKILL_CATALOG;
    delete process.env.BUFF_SKILL_CATALOG;
  });
  afterEach(() => {
    delete process.env.NUVIRA_SKILL_CATALOG;
    delete process.env.BUFF_SKILL_CATALOG;
  });

  it('the base tool prompt stays within its budget', () => {
    // 12.3K measured after the `## Working out loud` clause (the "say what you are
    // doing while you work" rule). The cap moves by exactly that clause rather than
    // by a guess: 12.5K is the measured size plus a few hundred characters, so the
    // next addition still has to justify itself here.
    //
    // 2026-11-05 — moved by the WRITE-PERMISSION clause: "Appending … a refusal
    // that names a question". It replaces a contradiction in the prompt (the write
    // rule said "call ask_user", the rule two lines below said "NEVER ask for
    // permission") that two live traces resolved by never asking at all and
    // dropping the deliverable — 12,577 measured, so the cap is that plus ~100
    // characters of headroom rather than a rounder number pulled from the air.
    expect(buildToolSystemPrompt().length).toBeLessThan(12_700);
  });

  it('the DEFAULT skill hint is a bounded INDEX (name + trigger), never the catalog', async () => {
    // Model-driven default: every skill by NAME with the clause that says WHEN
    // it applies. It replaces the old `pointer`, which named no skill at all, so
    // the model had to guess that a skill existed before it could read anything
    // about it — the measured routing failure this change exists for.
    expect(DEFAULT_SKILL_HINT_MODE).toBe('index');
    expect(resolveSkillHintMode()).toBe('index');
    const hint = await buildConfiguredSkillHint();
    expect(hint).toContain('## Skills');
    // Bounded: the full catalog is ~24.5K and must never be the default shape.
    expect(hint.length).toBeLessThan(13_000);
    expect(hint).not.toContain('## Available skills');
  });

  it('base prompt + default skill hint stay within the per-turn budget', async () => {
    const hint = await buildConfiguredSkillHint();
    const total = buildToolSystemPrompt().length + hint.length;
    // The regression was ~32.8K (base 7.6K + the 24.5K catalog on EVERY turn).
    // The index carries a trigger for all 156 bundled skills in ~10.8K, so the
    // measured default is ~23.4K — bounded, and it buys routing signal rather
    // than prose. The cap moved 20K → 25K with that measurement; it is still
    // well below the regression, and the hint itself is capped at 13K above so
    // the two assertions cannot both creep.
    expect(total).toBeLessThan(25_000);
  });

  it('only an EXPLICIT opt-in turns the full catalog on', async () => {
    process.env.NUVIRA_SKILL_CATALOG = 'catalog';
    const catalog = await buildConfiguredSkillHint(SAMPLE_GOAL);
    // It may exceed the default budget — that is the operator's explicit choice.
    expect(catalog).toContain('## Available skills');
  });
});

describe('RELEASE GATE — system prompt contract clauses', () => {
  it('states the agent runs on the REAL machine and must install missing prerequisites itself', () => {
    // The live failure this guards: a permitted user was told "I cannot install
    // system-level software … I am physically unable" (trace
    // trace-1791127992452-qzgodi). The contract must forbid that refusal.
    const prompt = buildToolSystemPrompt();
    expect(prompt).toMatch(/NOT sandboxed/);
    expect(prompt).toMatch(/run_terminal/);
    expect(prompt).toMatch(/command not found/);
  });

  it('asks the turn to say what it is doing WHILE it works, not only at the end', () => {
    // The turn is reviewable only if its intent is visible while it runs. The
    // rule is one line per batch plus a current plan — an output style, not a
    // step: nothing here may be read as licence to skip a tool call.
    const prompt = buildToolSystemPrompt();
    expect(prompt).toMatch(/## Working out loud/);
    expect(prompt).toMatch(/ONE line/);
    expect(prompt).toMatch(/plan_todo/);
  });
});

describe('RELEASE GATE — routing policy', () => {
  it('classifies canonical software asks as software work (never routed as chit-chat)', () => {
    const asks = [
      'create a mac os gui app',
      'fix the failing login test',
      'refactor the auth module',
      'add unit tests for the parser',
      'review the security of this endpoint',
    ];
    for (const ask of asks) {
      expect(SOFTWARE_INTENTS.has(analyzeTaskProfile(ask).intent), ask).toBe(true);
    }
  });

  it('every common build prerequisite has an install recipe (the takeover can act)', () => {
    for (const tool of ['cargo', 'git', 'make', 'cmake', 'ffmpeg', 'go', 'docker']) {
      expect(isKnownSystemTool(tool), tool).toBe(true);
    }
  });
});
