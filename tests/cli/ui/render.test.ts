/**
 * ANSI renderer tests — assertions run with `color: false`, so they check the
 * LAYOUT (borders, bullets, wrapping) rather than escape sequences. Colour is
 * chalk's own concern and is not re-tested here.
 */

import { describe, it, expect } from 'vitest';

import { renderMarkdown, renderCard, visibleWidth } from '../../../src/cli/ui/render.js';

const opts = { color: false, width: 60 } as const;

describe('visibleWidth', () => {
  it('counts plain ASCII', () => {
    expect(visibleWidth('abc')).toBe(3);
  });

  it('counts wide glyphs as two columns', () => {
    expect(visibleWidth('你好')).toBe(4);
  });

  it('ignores ANSI escapes', () => {
    expect(visibleWidth('\u001b[31mred\u001b[39m')).toBe(3);
  });
});

describe('renderMarkdown', () => {
  it('renders headings with a level bar', () => {
    expect(renderMarkdown('# Title', opts)).toContain('▍ Title');
    expect(renderMarkdown('## Sub', opts)).toContain('▎ Sub');
  });

  it('renders a code block as a bordered box preserving code', () => {
    const out = renderMarkdown('```ts\nconst x = 1\n```', opts);
    expect(out).toContain('┌');
    expect(out).toContain('└');
    expect(out).toContain('ts');
    expect(out).toContain('const x = 1');
  });

  it('never drops code that overflows the box (wraps instead)', () => {
    const long = 'const value = "' + 'z'.repeat(200) + '"';
    const out = renderMarkdown('```ts\n' + long + '\n```', opts);
    // Every z is still present — the display wraps, it does not truncate.
    expect((out.match(/z/g) ?? []).length).toBe(200);
  });

  it('renders lists with bullets and ordered markers', () => {
    expect(renderMarkdown('- one\n- two', opts)).toContain('• one');
    expect(renderMarkdown('1. one\n2. two', opts)).toContain('1. one');
  });

  it('keeps a bullet nested under an ordered list as a bullet', () => {
    const out = renderMarkdown('1. first\n2. second\n  - nested', opts);
    expect(out).toContain('1. first');
    expect(out).toContain('  • nested');
    expect(out).not.toContain('3. nested');
  });

  it('never strands trailing punctuation on its own line after a link', () => {
    const md = 'see the ' + 'padding '.repeat(9) + '[docs](https://example.com).';
    const lines = renderMarkdown(md, { color: false, width: 60 }).trimEnd().split('\n');
    for (const line of lines) expect(line.trim()).not.toBe('.');
    expect(lines.join(' ')).toContain('(https://example.com).');
  });

  it('renders a table with box borders', () => {
    const out = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |', opts);
    expect(out).toContain('┌');
    expect(out).toContain('│ A │ B │');
    expect(out).toContain('└');
  });

  it('wraps a long paragraph within the width', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const lines = renderMarkdown(words, opts).trimEnd().split('\n');
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    expect(lines.length).toBeGreaterThan(1);
  });

  it('renders a rule and leaves no trailing blank lines', () => {
    const out = renderMarkdown('a\n\n---\n\nb', opts);
    expect(out).toContain('─');
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});

describe('renderCard', () => {
  it('draws a titled box with body lines', () => {
    const out = renderCard({ icon: '🔧', title: 'tool: read_file', lines: ['src/a.ts'], role: 'info' }, opts);
    expect(out).toContain('╭');
    expect(out).toContain('🔧 tool: read_file');
    expect(out).toContain('╰');
    expect(out).toContain('src/a.ts');
  });
});
