/**
 * Highlight tests — the tokenizer is heuristic by design, so these pin the
 * handful of rules that matter for readability (comments, strings, keywords,
 * functions, types) plus multi-line state, using the shared `Token[]` shape
 * both renderers consume.
 */

import { describe, it, expect } from 'vitest';

import { highlightCode, normalizeLang } from '../../../src/cli/ui/highlight.js';

/** Flatten one line's tokens into [text, kind] pairs. */
function pairs(code: string, lang: string): Array<[string, string]> {
  return highlightCode(code, lang)[0].map((t) => [t.text, t.kind]);
}

describe('normalizeLang', () => {
  it('maps aliases to canonical languages', () => {
    expect(normalizeLang('ts')).toBe('js');
    expect(normalizeLang('TSX')).toBe('js');
    expect(normalizeLang('py')).toBe('python');
    expect(normalizeLang('bash')).toBe('shell');
    expect(normalizeLang('golang')).toBe('go');
    expect(normalizeLang('yml')).toBe('yaml');
  });

  it('falls back to plain for unknown languages', () => {
    expect(normalizeLang('brainfuck')).toBe('plain');
    expect(normalizeLang('')).toBe('plain');
  });
});

describe('highlightCode (typescript)', () => {
  it('colours keywords, strings, numbers and functions', () => {
    const [kw] = pairs('const x = 1', 'ts');
    expect(kw).toEqual(['const', 'keyword']);

    const line = highlightCode('const name = "nuvira";', 'ts')[0];
    expect(line.find((t) => t.text === '"nuvira"')?.kind).toBe('string');
    expect(line.find((t) => t.text === 'const')?.kind).toBe('keyword');
  });

  it('marks identifiers that precede a call as functions', () => {
    const line = highlightCode('run(1)', 'ts')[0];
    expect(line.find((t) => t.text === 'run')?.kind).toBe('func');
  });

  it('marks capitalized identifiers as types', () => {
    const line = highlightCode('const x: Widget = null', 'ts')[0];
    expect(line.find((t) => t.text === 'Widget')?.kind).toBe('type');
    expect(line.find((t) => t.text === 'null')?.kind).toBe('boolean');
  });

  it('treats // and /* */ as comments', () => {
    expect(pairs('// note', 'ts')).toEqual([['// note', 'comment']]);
    const line = highlightCode('const a = 1; /* tail */', 'ts')[0];
    expect(line.find((t) => t.text === '/* tail */')?.kind).toBe('comment');
  });

  it('carries a block comment across lines', () => {
    const lines = highlightCode('/* first\nsecond */\nconst x = 1', 'ts');
    expect(lines[0]).toEqual([{ text: '/* first', kind: 'comment' }]);
    expect(lines[1]).toEqual([{ text: 'second */', kind: 'comment' }]);
    expect(lines[2].some((t) => t.kind === 'keyword')).toBe(true);
  });
});

describe('highlightCode (other languages)', () => {
  it('uses # for python and shell comments', () => {
    expect(pairs('# note', 'python')).toEqual([['# note', 'comment']]);
    expect(pairs('# note', 'bash')).toEqual([['# note', 'comment']]);
  });

  it('uses -- for sql comments and lowercases keywords', () => {
    expect(pairs('-- note', 'sql')).toEqual([['-- note', 'comment']]);
    const line = highlightCode('select 1', 'sql')[0];
    expect(line.find((t) => t.text === 'select')?.kind).toBe('keyword');
  });

  it('does not treat // as a comment in python (floor division)', () => {
    const line = highlightCode('a = b // c', 'python')[0];
    // The two slashes are merged into one operator token, never a comment.
    expect(line.find((t) => t.text === '//')?.kind).toBe('operator');
    expect(line.some((t) => t.kind === 'comment')).toBe(false);
  });
});
