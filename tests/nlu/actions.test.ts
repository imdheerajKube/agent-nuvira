import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ACTION_BY_INTENT,
  resolveAction,
  taskTypeForIntent,
  shouldAutoDispatch,
  resolveDispatch,
  type DispatchDescriptor,
} from '../../src/nlu/actions.js';
import { parseRequestSync } from '../../src/nlu/parser.js';
import { RULE_TRUST_THRESHOLD, type NluIntent } from '../../src/nlu/intent.js';

/**
 * The FIVE canonical prompts (plan E3 acceptance) — assess / create addon /
 * fix test / generate image / continue. Every action command must resolve
 * these to the SAME intent→action with zero mode selection.
 */
const CANONICAL_PROMPTS: Array<{
  prompt: string;
  intent: NluIntent;
  action: string;
  mode: string;
}> = [
  { prompt: 'assess the current state of the project', intent: 'explain', action: 'assess', mode: 'chat' },
  { prompt: 'create an NVDA addon that says hello when I press a key', intent: 'create', action: 'build', mode: 'dev' },
  { prompt: 'fix the failing test in the login module', intent: 'fix', action: 'repair', mode: 'execute' },
  { prompt: 'generate an image of a sunset', intent: 'create', action: 'build', mode: 'dev' },
  { prompt: "continue last week's ecommerce plan", intent: 'continue', action: 'resume', mode: 'recall' },
];

/** Every action command that consumes the parser (run.ts = shell runner, no LLM surface). */
const ACTION_COMMANDS = ['chat', 'execute', 'plan', 'edit'] as const;

describe('action map — totals', () => {
  it('resolves EVERY intent to a complete action descriptor', () => {
    const intents: NluIntent[] = ['create', 'continue', 'fix', 'explain', 'configure', 'unknown'];
    for (const intent of intents) {
      const action = resolveAction(intent);
      expect(action.name).toBeTruthy();
      expect(action.description).toBeTruthy();
      expect(action.mode).toBeTruthy();
      expect(action.run).toMatch(/^(pipeline|chat|config)$/);
      expect(action.taskIntent).toBeTruthy();
      expect(action.inputSchema).toBeTruthy();
    }
  });

  it('maps intents to the router task-type vocabulary (single source of truth)', () => {
    expect(taskTypeForIntent('create')).toBe('coding');
    expect(taskTypeForIntent('continue')).toBe('coding');
    expect(taskTypeForIntent('fix')).toBe('debugging');
    expect(taskTypeForIntent('explain')).toBe('unknown');
    expect(taskTypeForIntent('configure')).toBe('unknown');
    expect(taskTypeForIntent('unknown')).toBe('unknown');
  });

  it('exposes a zod input schema per action for native tool-calling providers (H1)', () => {
    // Each action's schema accepts ONLY its own canonical input key.
    const CANONICAL_KEY: Record<NluIntent, string> = {
      create: 'goal',
      continue: 'query',
      fix: 'goal',
      explain: 'question',
      configure: 'request',
      write: 'prompt',
      unknown: 'question',
    };
    for (const intent of Object.keys(ACTION_BY_INTENT) as NluIntent[]) {
      const schema = resolveAction(intent).inputSchema;
      expect(schema.safeParse({ [CANONICAL_KEY[intent]]: 'x' }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
    }
  });
});

describe('menu-unreachable contract (C3 acceptance a/c)', () => {
  it('auto-dispatches all five canonical prompts with zero mode selection', () => {
    for (const c of CANONICAL_PROMPTS) {
      const parsed = parseRequestSync(c.prompt);
      expect(parsed.intent).toBe(c.intent);
      expect(parsed.confidence).toBeGreaterThanOrEqual(RULE_TRUST_THRESHOLD);
      expect(parsed.action.name).toBe(c.action);
      expect(parsed.mode).toBe(c.mode);
      expect(shouldAutoDispatch(parsed.intent, parsed.confidence)).toBe(true);
    }
  });

  it('keeps the menu ONLY as the ambiguous-create fallback', () => {
    expect(shouldAutoDispatch('create', 0.99)).toBe(true);
    expect(shouldAutoDispatch('create', 0.4)).toBe(false);
    // Non-create intents never show a menu — even at low confidence.
    expect(shouldAutoDispatch('fix', 0.4)).toBe(true);
    expect(shouldAutoDispatch('unknown', 0)).toBe(true);
    expect(shouldAutoDispatch('explain', 0.4)).toBe(true);
  });
});

describe('cross-command parity (STANDING RULE)', () => {
  it('resolves the five canonical prompts identically for every action command', () => {
    // The dispatch descriptor is the shared contract: every command derives it
    // from the SAME resolveDispatch choke point, so no command can diverge.
    const INFORMATIVE = ['create', 'fix', 'continue'];
    const expectedByPrompt: Record<string, DispatchDescriptor> = {};
    for (const c of CANONICAL_PROMPTS) {
      expectedByPrompt[c.prompt] = {
        action: c.action,
        mode: c.mode,
        // explain/configure map to router 'unknown' — never seeded as a hint.
        taskIntentHint: INFORMATIVE.includes(c.intent) ? taskTypeForIntent(c.intent) : undefined,
        autoDispatch: true,
      };
    }
    for (const cmd of ACTION_COMMANDS) {
      for (const c of CANONICAL_PROMPTS) {
        const parsed = parseRequestSync(c.prompt);
        expect(resolveDispatch(parsed)).toEqual(expectedByPrompt[c.prompt]);
      }
    }
  });

  it('omits the router seed below the trust threshold (callers never guess)', () => {
    const dispatch = resolveDispatch({ intent: 'create', confidence: 0.3 });
    expect(dispatch.taskIntentHint).toBeUndefined();
    expect(dispatch.autoDispatch).toBe(false);
    const confident = resolveDispatch({ intent: 'create', confidence: 0.9 });
    expect(confident.taskIntentHint).toBe('coding');
    expect(confident.autoDispatch).toBe(true);
  });

  it('never seeds a meaningless unknown task-intent (explain/configure)', () => {
    expect(resolveDispatch({ intent: 'explain', confidence: 0.8 }).taskIntentHint).toBeUndefined();
    expect(resolveDispatch({ intent: 'configure', confidence: 0.85 }).taskIntentHint).toBeUndefined();
    expect(resolveDispatch({ intent: 'fix', confidence: 0.85 }).taskIntentHint).toBe('debugging');
  });

  it('S4: a creative/writing request is a CHAT answer in every command (no coding pipeline)', () => {
    // The observed failure: "write an essay" was classified create → the
    // no-model fallback spun up the full multi-agent pipeline. Through the
    // SHARED choke point, chat/execute/plan/edit all derive this exact
    // dispatch — so the fix is inherited everywhere, not chat-only.
    const parsed = parseRequestSync('Write an essay on the elephant in exactly 10 lines for a class 4 student.');
    expect(parsed.intent).toBe('write');
    const dispatch = resolveDispatch(parsed);
    expect(dispatch.action).toBe('write');
    expect(dispatch.mode).toBe('chat');
    // run: 'chat' → the no-model fallback NEVER enters the pipeline (the
    // `action.run !== 'pipeline'` gate in resolvePipelineDispatch).
    expect(resolveAction(parsed.intent).run).toBe('chat');
    // The router seed is the 'creative' task intent → the S5 reasoning floor.
    expect(dispatch.taskIntentHint).toBe('creative');
    expect(dispatch.autoDispatch).toBe(true);
  });

  it('S4: coding-style "write a test" still resolves to create (regression guard)', () => {
    const parsed = parseRequestSync('write a test for the login function');
    expect(parsed.intent).toBe('create');
    expect(resolveDispatch(parsed).action).toBe('build');
    expect(resolveAction(parsed.intent).run).toBe('pipeline');
  });

  it('S4-live: "Write a song in hindi … for my daughter" NEVER reaches the developer pipeline', () => {
    // Trace-1788970301803-8302u5 (WhatsApp, 918800604222): a father's song
    // request for his 9-year-old daughter was routed to the DEVELOPER
    // pipeline ("senior software architect … decide Language/Framework")
    // because 'song' was missing from the writing-object list. Pin the exact
    // message plus its near-neighbors to chat — forever.
    const MSG =
      'Write a song in hindi Feeling Loved Mood caring and loving , gratitude For my daughter Kashvi Age of daughter 9 years Who is requesting Dheeraj Sharma ( Her Daddy )';
    const parsed = parseRequestSync(MSG);
    expect(parsed.intent).toBe('write');
    expect(resolveAction(parsed.intent).run).toBe('chat');
    expect(resolveDispatch(parsed).taskIntentHint).toBe('creative');
    // Creative nouns beyond the explicit list + creative frames must ALSO
    // stay out of the pipeline ("write a lullaby" has no listed artifact).
    for (const t of [
      'write a lullaby for my daughter',
      'compose a shayari in hindi about love',
      'make a rap about my dog',
      'write a song for my daughter Kashvi',
    ]) {
      const p = parseRequestSync(t);
      expect(resolveAction(p.intent).run, t).toBe('chat');
    }
  });

  it('S4-live: the creative-frame guard never eats real coding asks', () => {
    for (const t of [
      'write a test for the login function',
      'add auth to the app',
      'create a CLI tool',
      'build an api for orders',
    ]) {
      const p = parseRequestSync(t);
      expect(resolveAction(p.intent).run, t).toBe('pipeline');
    }
  });

  it('guards the actual command wiring — every action command consumes the shared choke point', () => {
    // STRUCTURAL guard (the shared-contract assertions above can't catch a
    // command that stops calling resolveDispatch). Each action command must
    // import and invoke the parser + dispatcher directly.
    const root = new URL('../../src/cli/', import.meta.url);
    for (const cmd of ['chat', 'execute', 'plan', 'edit']) {
      const src = readFileSync(new URL(`${cmd}.ts`, root), 'utf-8');
      expect(src).toContain("from '../nlu/parser.js'");
      expect(src).toContain("from '../nlu/actions.js'");
      expect(src).toContain('resolveDispatch(');
    }
    // run.ts is a shell runner with no LLM surface — exempt by design.
  });
});
