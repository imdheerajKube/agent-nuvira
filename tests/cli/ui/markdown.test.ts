/**
 * Markdown parser tests — the AST is the contract both renderers consume, so
 * these assert on structure (block/inline shapes) rather than on coloured bytes.
 */

import { describe, it, expect } from 'vitest';

import {
  blocksToPlainText,
  inlineText,
  parseInline,
  parseMarkdown,
} from '../../../src/cli/ui/markdown.js';

describe('parseMarkdown blocks', () => {
  it('parses ATX headings with their level', () => {
    const blocks = parseMarkdown('# One\n\n### Three');
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    expect(inlineText((blocks[0] as any).inlines)).toBe('One');
    expect(blocks[1]).toMatchObject({ type: 'heading', level: 3 });
  });

  it('joins consecutive lines into one paragraph', () => {
    const blocks = parseMarkdown('line one\nline two\n\nsecond para');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('paragraph');
    expect(inlineText((blocks[0] as any).inlines)).toBe('line one line two');
  });

  it('parses a fenced code block with a language and highlighted tokens', () => {
    const blocks = parseMarkdown('```ts\nconst x = 1\n```');
    const code = blocks[0] as Extract<(typeof blocks)[number], { type: 'code' }>;
    expect(code.type).toBe('code');
    expect(code.lang).toBe('ts');
    expect(code.code).toBe('const x = 1');
    expect(code.tokens[0].some((t) => t.kind === 'keyword')).toBe(true);
  });

  it('keeps an unterminated fence rather than dropping it', () => {
    const blocks = parseMarkdown('```\nabc');
    expect(blocks[0].type).toBe('code');
    expect((blocks[0] as any).code).toBe('abc');
  });

  it('parses ordered and unordered lists with nesting depth', () => {
    const ul = parseMarkdown('- a\n- b')[0] as any;
    expect(ul).toMatchObject({ type: 'list', ordered: false, start: 1 });
    expect(ul.items.map((i: any) => inlineText(i.inlines))).toEqual(['a', 'b']);

    const nested = parseMarkdown('- a\n  - b')[0] as any;
    expect(nested.items.map((i: any) => i.depth)).toEqual([0, 1]);

    const ol = parseMarkdown('3. three\n4. four')[0] as any;
    expect(ol).toMatchObject({ type: 'list', ordered: true, start: 3 });
  });

  it('records each item\u2019s own marker kind (a bullet nested under an ordered list)', () => {
    const list = parseMarkdown('1. first\n2. second\n  - nested')[0] as any;
    expect(list.items.map((i: any) => i.ordered)).toEqual([true, true, false]);
    expect(list.items.map((i: any) => i.index)).toEqual([1, 2, 0]);
  });

  it('parses a pipe table with alignment', () => {
    const blocks = parseMarkdown('| A | B |\n|---|:--:|\n| 1 | 2 |');
    const t = blocks[0] as any;
    expect(t.type).toBe('table');
    expect(t.header.map(inlineText)).toEqual(['A', 'B']);
    expect(t.rows).toHaveLength(1);
    expect(t.align).toEqual([null, 'center']);
  });

  it('parses block quotes and rules', () => {
    const blocks = parseMarkdown('> quoted text\n\n---');
    expect(blocks[0].type).toBe('quote');
    expect(blocks[1].type).toBe('hr');
  });
});

describe('parseInline', () => {
  it('parses strong, emphasis, code and links', () => {
    const runs = parseInline('a **b** _c_ `d` [e](https://x)');
    const kinds = runs.map((r) => r.kind);
    expect(kinds).toContain('strong');
    expect(kinds).toContain('em');
    expect(kinds).toContain('code');
    expect(kinds).toContain('link');
    expect(runs.find((r) => r.kind === 'link')).toMatchObject({ text: 'e', href: 'https://x' });
  });

  it('leaves unmatched markers as literal text', () => {
    expect(inlineText(parseInline('2 * 3 = 6'))).toBe('2 * 3 = 6');
    expect(inlineText(parseInline('[not a link'))).toBe('[not a link');
  });

  it('keeps marker characters inside inline code literal', () => {
    const runs = parseInline('use `a_b_c` here');
    expect(runs.find((r) => r.kind === 'code')).toMatchObject({ text: 'a_b_c' });
  });
});

describe('blocksToPlainText', () => {
  it('produces readable text with no markup or colour', () => {
    const text = blocksToPlainText(parseMarkdown('# Hi\n\n- one\n- two\n\n```ts\nconst x = 1\n```'));
    expect(text).toContain('Hi');
    expect(text).toContain('- one');
    expect(text).toContain('const x = 1');
    expect(text).not.toContain('#');
    expect(text).not.toContain('```');
  });
});
