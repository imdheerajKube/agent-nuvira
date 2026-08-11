import { describe, it, expect, vi } from 'vitest';

import type { LLMCallFn } from '../../src/agents/agent.js';
import {
  verifyIntent,
  parseVerifyResponse,
  analyzeRequest,
  extractDeterministicEntities,
} from '../../src/nlu/entities.js';
import { classifyIntent, RULE_TRUST_THRESHOLD } from '../../src/nlu/intent.js';

/** Deterministic "today" so temporal tests never depend on wall-clock time. */
const REF = new Date('2026-08-09T12:00:00Z');

function makeCallLLM(respond: (prompt: string) => string): { fn: LLMCallFn; calls: string[] } {
  const calls: string[] = [];
  const fn: LLMCallFn = async (prompt) => {
    calls.push(prompt);
    return respond(prompt);
  };
  return { fn, calls };
}

const validResponse = JSON.stringify({
  intent: 'create',
  confidence: 0.55,
  entities: {
    files: ['src/routes/auth.ts'],
    frameworks: ['express'],
    keywords: ['jwt', 'refresh'],
  },
  memoryHint: 'Prior auth setup would help',
});

// ─── Rule fast-path: no LLM call above threshold ────────────────────────────

describe('verifyIntent — rule fast-path (no LLM)', () => {
  it('returns the rule result with entities and does NOT call the LLM when confidence ≥ threshold', async () => {
    const { fn, calls } = makeCallLLM(() => {
      throw new Error('LLM should not be called');
    });
    const rule = classifyIntent('create a new CLI tool', REF);
    expect(rule.confidence).toBeGreaterThanOrEqual(RULE_TRUST_THRESHOLD);

    const result = await verifyIntent('create a new CLI tool', rule, fn, '/tmp/proj');
    expect(calls).toHaveLength(0);
    expect(result.source).toBe('rule');
    expect(result.intent).toBe('create');
    expect(result.modeHint).toBe('dev');
    expect(result.entities).toBeDefined();
    expect(result.entities.files).toEqual([]);
  });

  it('attaches deterministic entities (files, frameworks) on the rule path', async () => {
    const { fn } = makeCallLLM(() => '');
    const rule = classifyIntent('fix the bug in src/login.ts using react', REF);
    const result = await verifyIntent('fix the bug in src/login.ts using react', rule, fn);
    expect(result.entities.files).toContain('src/login.ts');
    expect(result.entities.frameworks).toContain('react');
  });
});

// ─── LLM verify below threshold ─────────────────────────────────────────────

describe('verifyIntent — LLM verify below threshold', () => {
  it('calls the LLM once and merges entities + memoryHint when the response is valid', async () => {
    const { fn, calls } = makeCallLLM(() => validResponse);
    // Low-confidence rule result (unknown → confidence 0).
    const rule = classifyIntent('hmm something about auth maybe?', REF);
    expect(rule.confidence).toBeLessThan(RULE_TRUST_THRESHOLD);

    const result = await verifyIntent('hmm something about auth maybe?', rule, fn, '/tmp/proj');
    expect(calls).toHaveLength(1);
    expect(result.source).toBe('llm');
    expect(result.intent).toBe('create');
    expect(result.confidence).toBe(0.55);
    expect(result.memoryHint).toBe('Prior auth setup would help');
    // Deterministic files merged with LLM files.
    expect(result.entities.files).toContain('src/routes/auth.ts');
  });

  it('derives modeHint from the LLM intent (never diverges from intent)', async () => {
    // Rule says unknown (modeHint null); LLM verifies create — modeHint must
    // become 'dev', not stay null (C3 action-map invariant).
    const { fn } = makeCallLLM(() =>
      JSON.stringify({ intent: 'create', confidence: 0.6, entities: {} }),
    );
    const rule = classifyIntent('vague words that mean nothing', REF);
    expect(rule.modeHint).toBeNull();
    const result = await verifyIntent('vague words that mean nothing', rule, fn);
    expect(result.source).toBe('llm');
    expect(result.intent).toBe('create');
    expect(result.modeHint).toBe('dev');
  });

  it('keeps the deterministic project id when cwd is provided (A2 deriveProjectId)', async () => {
    const { fn } = makeCallLLM(() => validResponse);
    const rule = classifyIntent('something about auth?', REF);
    const result = await verifyIntent('something about auth?', rule, fn, process.cwd());
    // In a git repo, the project id is repo:<owner/repo>; else cwd:<hash>.
    expect(result.entities.project).toMatch(/^(repo:|cwd:)/);
  });

  it('merges deterministic + LLM files without duplicates', async () => {
    const { fn } = makeCallLLM(() =>
      JSON.stringify({
        intent: 'create',
        confidence: 0.5,
        entities: { files: ['src/app.ts'], frameworks: [], keywords: [] },
      }),
    );
    const rule = classifyIntent('create src/app.ts and fix src/login.ts?', REF);
    const result = await verifyIntent('create src/app.ts and fix src/login.ts?', rule, fn);
    expect(result.entities.files).toContain('src/app.ts');
    expect(result.entities.files).toContain('src/login.ts');
    expect(new Set(result.entities.files).size).toBe(result.entities.files.length);
  });
});

// ─── Garbage tolerance + fallback ───────────────────────────────────────────

describe('verifyIntent — garbage tolerance + fallback', () => {
  it('falls back to the rule result when the LLM returns garbage', async () => {
    const { fn } = makeCallLLM(() => 'I am sorry, I cannot help with that.');
    const rule = classifyIntent('whatever this is about', REF);
    const result = await verifyIntent('whatever this is about', rule, fn);
    expect(result.source).toBe('rule-fallback');
    expect(result.intent).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  it('falls back to the rule result when the LLM call THROWS (provider failure)', async () => {
    const { fn } = makeCallLLM(() => {
      throw new Error('401 unauthorized');
    });
    const rule = classifyIntent('something unclear', REF);
    const result = await verifyIntent('something unclear', rule, fn);
    expect(result.source).toBe('rule-fallback');
    expect(result.intent).toBe(rule.intent);
  });

  it('falls back when the LLM returns an invalid intent (schema violation)', async () => {
    const { fn } = makeCallLLM(() =>
      JSON.stringify({ intent: 'frobnicate', confidence: 0.9, entities: {} }),
    );
    const rule = classifyIntent('ambiguous words here', REF);
    const result = await verifyIntent('ambiguous words here', rule, fn);
    expect(result.source).toBe('rule-fallback');
    expect(result.intent).toBe('unknown');
  });

  it('falls back when confidence is out of range (schema violation)', async () => {
    const { fn } = makeCallLLM(() =>
      JSON.stringify({ intent: 'create', confidence: 1.5, entities: {} }),
    );
    const rule = classifyIntent('ambiguous words here', REF);
    const result = await verifyIntent('ambiguous words here', rule, fn);
    expect(result.source).toBe('rule-fallback');
  });
});

// ─── parseVerifyResponse (schema validation) ────────────────────────────────

describe('parseVerifyResponse — parse strategies', () => {
  it('parses a ```json code block', () => {
    const parsed = parseVerifyResponse(`Here you go:\n\`\`\`json\n${validResponse}\n\`\`\``);
    expect(parsed).not.toBeNull();
    expect(parsed!.intent).toBe('create');
  });

  it('parses bare direct JSON', () => {
    const parsed = parseVerifyResponse(validResponse);
    expect(parsed).not.toBeNull();
    expect(parsed!.entities.frameworks).toContain('express');
  });

  it('parses a greedy first-{ last-} slice with prose around it', () => {
    const parsed = parseVerifyResponse(`Result: ${validResponse} — hope that helps!`);
    expect(parsed).not.toBeNull();
    expect(parsed!.confidence).toBe(0.55);
  });

  it('returns null for non-JSON garbage', () => {
    expect(parseVerifyResponse('nope nope nope')).toBeNull();
    expect(parseVerifyResponse('')).toBeNull();
  });

  it('returns null for JSON that violates the schema (bad intent)', () => {
    expect(
      parseVerifyResponse(JSON.stringify({ intent: 'whatever', confidence: 0.5 })),
    ).toBeNull();
  });

  it('defaults entities when the LLM omits them', () => {
    const parsed = parseVerifyResponse(JSON.stringify({ intent: 'fix', confidence: 0.6 }));
    expect(parsed).not.toBeNull();
    expect(parsed!.entities.files).toEqual([]);
    expect(parsed!.entities.frameworks).toEqual([]);
  });
});

// ─── analyzeRequest (full C2 pipeline) ──────────────────────────────────────

describe('analyzeRequest — full pipeline', () => {
  it('skips the LLM for confident rules', async () => {
    const { fn, calls } = makeCallLLM(() => {
      throw new Error('should not be called');
    });
    const result = await analyzeRequest("continue last week's ecommerce plan", fn, '/tmp/proj');
    expect(calls).toHaveLength(0);
    expect(result.intent).toBe('continue');
    expect(result.source).toBe('rule');
    expect(result.timeRange).toBeDefined();
  });

  it('verifies via LLM for ambiguous input and returns a usable result', async () => {
    const { fn } = makeCallLLM(() => validResponse);
    const result = await analyzeRequest('hmm something about auth?', fn, '/tmp/proj');
    expect(result.source).toBe('llm');
    expect(result.intent).toBe('create');
  });
});

// ─── extractDeterministicEntities (pure) ────────────────────────────────────

describe('extractDeterministicEntities — pure function', () => {
  it('extracts quoted and path-style file tokens', () => {
    const e = extractDeterministicEntities(
      'edit "src/utils/logger.ts" and src/config/types.ts then run tests',
    );
    expect(e.files).toContain('src/utils/logger.ts');
    expect(e.files).toContain('src/config/types.ts');
  });

  it('extracts framework hints case-insensitively', () => {
    const e = extractDeterministicEntities('a React + Django app with Postgres');
    expect(e.frameworks).toContain('react');
    expect(e.frameworks).toContain('django');
    expect(e.frameworks).toContain('postgres');
  });

  it('extracts temporal refs via the recognizer', () => {
    const e = extractDeterministicEntities("continue last week's plan");
    expect(e.timeRange).toBeDefined();
    expect(e.timeRange!.text).toBe('last week');
  });

  it('returns empty arrays for plain text', () => {
    const e = extractDeterministicEntities('hello there');
    expect(e.files).toEqual([]);
    expect(e.frameworks).toEqual([]);
    expect(e.timeRange).toBeUndefined();
  });

  it('honors an explicit project id without touching cwd', () => {
    const e = extractDeterministicEntities('fix the bug', 'repo:acme/widgets');
    expect(e.project).toBe('repo:acme/widgets');
  });
});
