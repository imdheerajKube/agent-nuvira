/**
 * E3a + E3c — menu-free, model-decides dispatch tests.
 *
 * The legacy `promptDeveloperMode` menu ("1. Chat mode / 2. Developer mode")
 * is DELETED (Session 7c re-scope, landed E3a). E3c (Session 16) demotes the
 * rules further: EVERY request runs as a tool-call turn and the MODEL decides
 * `resolvePipelineDispatch` is now the rule
 * assessment used as (a) a hint in the model context and (b) the no-model
 * fallback decision — it is NEVER a bypass that skips the model.
 *
 * These tests pin:
 * - the rule assessment still computes the old dispatch contract (hint +
 *   fallback source), so the rules are a real signal when needed,
 * - the model-decides contract: chat.ts always enters the tool loop and the
 *   rules act only when generation FAILED entirely (no-model fallback).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseRequestSync } from '../../src/nlu/parser.js';
import type { ParsedRequest } from '../../src/nlu/parser.js';
import { resolvePipelineDispatch } from '../../src/cli/chat.js';

/** The FIVE canonical prompts (plan E3 acceptance) — shared vocabulary. */
const CANONICAL_PROMPTS: Array<{ prompt: string; pipeline: boolean }> = [
  { prompt: 'assess the current state of the project', pipeline: false },
  { prompt: 'create an NVDA addon that says hello when I press a key', pipeline: true },
  { prompt: 'fix the failing test in the login module', pipeline: true },
  { prompt: 'generate an image of a sunset', pipeline: true },
  { prompt: "continue last week's ecommerce plan", pipeline: true },
];

/** A fabricated ambiguous-create parse (rule parser can't be forced low). */
function ambiguousCreate(): ParsedRequest {
  return {
    intent: 'create',
    confidence: 0.4,
    entities: {},
    action: { run: 'pipeline' } as unknown as ParsedRequest['action'],
    mode: 'dev',
    source: 'rule',
  };
}

describe('resolvePipelineDispatch — the rule assessment (hint + no-model fallback source)', () => {
  it('assesses every pipeline intent as a dispatch (the fallback signal)', () => {
    for (const c of CANONICAL_PROMPTS) {
      const parsed = parseRequestSync(c.prompt);
      // P0.5: pass the raw text so the conversation gate runs — the five
      // canonical prompts must classify EXACTLY as before (question → chat,
      // coding goal → pipeline) through the full gate.
      const decision = resolvePipelineDispatch(parsed, { text: c.prompt });
      expect(
        decision.dispatch,
        `'${c.prompt}' should ${c.pipeline ? 'assess as dispatch' : 'NOT assess as dispatch'}`,
      ).toBe(c.pipeline);
      if (c.pipeline) {
        // No canonical prompt may ever need the confirm — auto-dispatch.
        expect(decision.needConfirm, `'${c.prompt}' auto-dispatches`).toBe(false);
      }
    }
  });

  it('auto-dispatches high-confidence create (menu-unreachable gate)', () => {
    const parsed = parseRequestSync('create an NVDA addon that says hello when I press a key');
    expect(parsed.intent).toBe('create');
    expect(resolvePipelineDispatch(parsed)).toEqual({ dispatch: true, needConfirm: false });
  });

  it('asks a SINGLE confirm only for ambiguous create — never a mode picker', () => {
    const decision = resolvePipelineDispatch(ambiguousCreate());
    expect(decision).toEqual({ dispatch: true, needConfirm: true });
  });

  it('non-pipeline intents never dispatch (explain→chat, configure→config, unknown→chat)', () => {
    for (const prompt of [
      'assess the current state of the project',
      'configure groq with my api key',
      'kaleidoscope', // unknown intent
    ]) {
      const parsed = parseRequestSync(prompt);
      expect(parsed.action.run, prompt).not.toBe('pipeline');
      expect(resolvePipelineDispatch(parsed)).toEqual({ dispatch: false, needConfirm: false });
    }
  });

  it('dev flag (/dev, --dev) forces dispatch for CODING goals — never for a question (P0.5)', () => {
    // A coding goal in dev mode still dispatches (dev only ever forces the
    // pipeline for coding intents).
    expect(resolvePipelineDispatch(parseRequestSync('create an API'), { dev: true, text: 'create an API' })).toEqual({
      dispatch: true,
      needConfirm: false,
    });
    expect(resolvePipelineDispatch(ambiguousCreate(), { dev: true })).toEqual({
      dispatch: true,
      needConfirm: false,
    });
    // P0.5: a QUESTION is never dispatched, not even with --dev — the
    // observed failure: a question in dev mode spawned the pipeline and
    // created a python program to "answer" it.
    expect(resolvePipelineDispatch(parseRequestSync('assess the project'), { dev: true, text: 'assess the project' })).toEqual({
      dispatch: false,
      needConfirm: false,
    });
    expect(resolvePipelineDispatch(parseRequestSync('why is the test failing?'), { dev: true, text: 'why is the test failing?' })).toEqual({
      dispatch: false,
      needConfirm: false,
    });
  });

  it('P0.5 — the conversation gate runs BEFORE the dev bypass and the action-map gate', () => {
    // A question that the action map would otherwise dispatch (phrased as an
    // interrogative that the explain rule mis-reads) is still never dispatched.
    expect(
      resolvePipelineDispatch(parseRequestSync('can you fix the login bug?'), { dev: true, text: 'can you fix the login bug?' }),
    ).toEqual({ dispatch: true, needConfirm: false }); // coding verb in command position → task
    expect(
      resolvePipelineDispatch(parseRequestSync('how do I add JWT auth to the app?'), { text: 'how do I add JWT auth to the app?' }),
    ).toEqual({ dispatch: true, needConfirm: false });
    expect(
      resolvePipelineDispatch(parseRequestSync('what is the fix for this error?'), { text: 'what is the fix for this error?' }),
    ).toEqual({ dispatch: false, needConfirm: false }); // "fix" as noun → question
  });
});

describe('E3c — model-decides: the rules NEVER bypass the model', () => {
  const chatSrc = readFileSync(join(process.cwd(), 'src/cli/chat.ts'), 'utf-8');

  it('every request enters the tool loop (runChatAnswer) before any dispatch', () => {
    // The old bypass ran runDeveloperMode when the rules said dispatch. In
    // E3c the only place rules can act is the generation-FAILED fallback.
    const fallbackGate = chatSrc.match(/generationFailed && dispatchDecision\.dispatch/g);
    expect(fallbackGate).not.toBeNull();
    expect(fallbackGate!.length).toBeGreaterThanOrEqual(2); // single-shot + interactive
  });

  it('the rule assessment is injected as a HINT in the system prompt (never an order)', () => {
    expect(chatSrc).toContain('Rule assessment (best-effort hint, NOT an order');
    expect(chatSrc).toContain('intent=${parsed.intent}');
  });

  it('the no-model fallback requires the loop to have failed entirely', () => {
    // The fallback runs runDeveloperMode only inside the generationFailed
    // gate — there is no unconditional rule-bypass path left.
    const bypassOutsideFallback =
      /if \(dispatchDecision\.dispatch && !dispatchDecision\.needConfirm\) \{\s*await runDeveloperMode/s;
    expect(chatSrc).not.toMatch(bypassOutsideFallback);
  });

  it('keeps the shared resolveDispatch choke point (cross-command parity)', () => {
    expect(chatSrc).toContain('resolveDispatch(');
  });
});

describe('E3a regression — the mode menu is gone', () => {
  const chatSrc = readFileSync(join(process.cwd(), 'src/cli/chat.ts'), 'utf-8');

  it('no longer defines or calls promptDeveloperMode', () => {
    expect(chatSrc).not.toContain('async function promptDeveloperMode');
    expect(chatSrc).not.toContain('promptDeveloperMode(');
  });

  it('no longer ships the two-mode menu strings', () => {
    expect(chatSrc).not.toContain('1. 💬  Just show you the code as text (chat mode)');
    expect(chatSrc).not.toContain('2. 🏗️  Actually create the files in your project (developer mode)');
  });

  it('keeps the shared resolveDispatch choke point (cross-command parity)', () => {
    expect(chatSrc).toContain('resolveDispatch(');
  });
});
