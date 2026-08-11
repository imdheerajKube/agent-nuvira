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
