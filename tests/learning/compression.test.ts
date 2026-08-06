/**
 * M4.4 Conservative compression tests.
 *
 * The property contract: compression is LOSSLESS FOR CODE — every identifier /
 * string literal / symbol in a fenced code block must survive byte-for-byte,
 * while only PROSE is elided. Off by default → pass-through with zero change.
 */

import { describe, it, expect } from 'vitest';
import {
  compressLossless,
  extractCodeTokens,
  isLosslessForCode,
  splitCodeAndProse,
} from '../../src/learning/compression.js';

// ─── Property: identifiers/symbols always survive ───────────────────────────

describe('M4.4 conservative compression — lossless for code', () => {
  const CODE_SAMPLE = `Here is the implementation:

\`\`\`typescript
export interface UserProfile {
  id: string;
  displayName: string;
  score: number;
}

const DEFAULT_SCORE = 0;
export function updateScore(profile: UserProfile, delta: number): UserProfile {
  const next = Math.max(0, profile.score + delta);
  return { ...profile, score: next };
}
\`\`\`

That covers the update path. The token budget is ${'${'}MAX_TOKENS${'}'} and the key is "sk-abc123".`;

  it('keeps every code identifier + string literal present after compression', () => {
    // Long prose BEFORE and AFTER the code block — long enough to exceed the
    // default minProseChars (800) so the elision path is actually exercised.
    const longProse = 'Context narration '.repeat(60); // ~1050 chars
    const sample = `${longProse}\n${CODE_SAMPLE}\n${longProse}`;
    const result = compressLossless(sample, { enabled: true, keepRatio: 0.4 });
    // Code must be preserved verbatim (property).
    expect(isLosslessForCode(sample, result.text)).toBe(true);
    // Spot-check the valuable symbols specifically.
    for (const token of ['UserProfile', 'displayName', 'DEFAULT_SCORE', 'updateScore', '"sk-abc123"']) {
      expect(result.text).toContain(token);
    }
    // And the elision actually saved tokens.
    expect(result.elided).toBe(true);
    expect(result.compressedTokens).toBeLessThan(result.originalTokens);
    expect(result.codeBlocks).toBe(1);
  });

  it('extractCodeTokens finds the identifiers the property relies on', () => {
    const tokens = extractCodeTokens(`const snake_case = fn("hello"); let x = 0x1F;`);
    expect(tokens.has('snake_case')).toBe(true);
    expect(tokens.has('"hello"')).toBe(true);
    expect(tokens.has('0x1F')).toBe(true);
  });

  it('splitCodeAndProse preserves order across multiple blocks', () => {
    const parts = splitCodeAndProse(`a \`\`\`js\nlet x\n\`\`\` b \`\`\`py\nprint(1)\n\`\`\` c`);
    expect(parts.map((p) => p.kind)).toEqual(['prose', 'code', 'prose', 'code', 'prose']);
    expect(parts.filter((p) => p.kind === 'code').length).toBe(2);
  });

  it('isLosslessForCode returns true when nothing changes and false when code is dropped', () => {
    expect(isLosslessForCode('```ts\nlet a = 1\n```', '```ts\nlet a = 1\n```')).toBe(true);
    expect(isLosslessForCode('```ts\nconst keepMe = 42\n```', 'const keepMe = 42\n```')).toBe(false);
  });

  it('isLosslessForCode is vacuously true when there is no code', () => {
    expect(isLosslessForCode('just prose, no fences', 'just prose')).toBe(true);
  });

  // ── Off-by-default behavior ────────────────────────────────────────────

  it('is a pure pass-through when disabled (off by default — M4.4 contract)', () => {
    const result = compressLossless(CODE_SAMPLE); // enabled defaults to false
    expect(result.text).toBe(CODE_SAMPLE);
    expect(result.elided).toBe(false);
    expect(result.compressedTokens).toBe(result.originalTokens);
  });

  it('short prose passes through untouched even when enabled (zero overhead)', () => {
    const short = 'A tiny prompt that is well under the minimum prose threshold.';
    const result = compressLossless(short, { enabled: true });
    expect(result.text).toBe(short);
    expect(result.elided).toBe(false);
  });

  it('only prose is elided — prose length drops, code length stays identical', () => {
    const longProse = 'x'.repeat(3000);
    const result = compressLossless(`${longProse}\`\`\`go\nfunc main() {}\n\`\`\``, {
      enabled: true,
      keepRatio: 0.5,
    });
    expect(result.text).toContain('```go\nfunc main() {}\n```');
    expect(result.text.length).toBeLessThan(3000 + 100);
    expect(result.proseCharsRemoved).toBeGreaterThan(1000);
  });

  it('elision marker is present so downstream agents know prose was compacted', () => {
    const result = compressLossless(`${'y'.repeat(2000)} hello world`, {
      enabled: true,
      keepRatio: 0.3,
    });
    expect(result.text).toContain('elided');
  });
});
