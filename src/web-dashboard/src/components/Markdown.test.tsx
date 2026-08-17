/**
 * Phase 1 — Markdown renderer tests (react-markdown + remark-gfm +
 * rehype-highlight stack).
 *
 * The chat answer renderer must turn the agent's markdown into rich blocks:
 * headings, lists, bold/italic, inline code, fenced code blocks with a copy
 * button, GFM tables/strikethrough/task lists, autolinks — while NEVER
 * injecting unsafe hrefs (react-markdown's defaultUrlTransform strips
 * javascript:/data:). The zero-dep fallback (`MarkdownZeroDep`) gets a smoke
 * test so the one-import switch stays verified.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import Markdown from './Markdown';
import MarkdownZeroDep from './MarkdownZeroDep';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Markdown (react-markdown stack)', () => {
  it('renders plain prose as paragraphs', () => {
    const { container } = render(<Markdown text={'hello world\n\nsecond para'} />);
    expect(container.querySelectorAll('p.md-para')).toHaveLength(2);
    expect(screen.getByText('hello world')).toBeTruthy();
    expect(screen.getByText('second para')).toBeTruthy();
  });

  it('renders headings at the right level', () => {
    const { container } = render(<Markdown text={'# Big\n\n### Small'} />);
    expect(container.querySelector('h1')?.textContent).toBe('Big');
    expect(container.querySelector('h3')?.textContent).toBe('Small');
  });

  it('renders bold, italic, inline code and links', () => {
    const { container } = render(
      <Markdown text={'**bold** and *italic* and `code` and [docs](https://example.com)'} />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector(':not(pre) > code')?.textContent).toBe('code');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  });

  it('never turns a javascript: link into a clickable href (defaultUrlTransform)', () => {
    const { container } = render(<Markdown text={'[click](javascript:alert(1))'} />);
    // v10 renders the text with an EMPTY href — never a javascript: URL.
    const a = container.querySelector('a');
    expect(a?.getAttribute('href') ?? '').not.toMatch(/^javascript:/);
    expect(screen.getByText('click')).toBeTruthy();
  });

  it('renders bullet and numbered lists as groups', () => {
    const { container } = render(<Markdown text={'- one\n- two\n- three'} />);
    const ul = container.querySelector('ul.md-list');
    expect(ul).toBeTruthy();
    expect(ul?.querySelectorAll('li')).toHaveLength(3);

    const { container: c2 } = render(<Markdown text={'1. first\n2. second'} />);
    expect(c2.querySelector('ol.md-list')).toBeTruthy();
  });

  it('handles nested lists (CommonMark depth the old renderer could not)', () => {
    const { container } = render(<Markdown text={'- outer\n  - inner\n- again'} />);
    const ul = container.querySelector('ul.md-list');
    // The inner list is a real nested <ul>, not flattened text.
    expect(ul?.querySelector('ul')?.querySelector('li')?.textContent).toBe('inner');
    expect(screen.getByText('outer')).toBeTruthy();
    expect(screen.getByText('again')).toBeTruthy();
  });

  it('renders GFM strikethrough, task lists and autolinks', () => {
    const { container } = render(
      <Markdown text={'~~gone~~\n\n- [x] done\n- [ ] todo\n\nvisit <https://example.com> now'} />,
    );
    expect(container.querySelector('del')?.textContent).toBe('gone');
    // Task-list checkboxes are real inputs.
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(container.querySelector('input[type="checkbox"]')?.hasAttribute('checked')).toBe(true);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  });

  it('renders a fenced code block with a language label, syntax highlight and copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Markdown text={'```ts\nconst x = 1;\n```'} />);
    expect(screen.getByText('ts')).toBeTruthy();
    // rehype-highlight tokenized the body — the raw text is intact on the <code>.
    const codeEl = document.querySelector('.md-code-pre code');
    expect(codeEl?.textContent?.trim()).toBe('const x = 1;');
    expect(codeEl?.querySelector('.hljs-keyword')?.textContent).toBe('const');

    fireEvent.click(screen.getByRole('button', { name: /Copy/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const x = 1;\n'));
    await waitFor(() => expect(screen.getByText(/Copied/)).toBeTruthy());
  });

  it('keeps text inside code fences literal (no bold parsing)', () => {
    const { container } = render(<Markdown text={'```\n**not bold**\n```'} />);
    expect(container.querySelector('strong')).toBeNull();
    expect(screen.getByText('**not bold**')).toBeTruthy();
  });

  it('renders blockquotes and GFM tables', () => {
    const { container } = render(<Markdown text={'> a note\n\n| a | b |\n|---|---|\n| 1 | 2 |'} />);
    expect(container.querySelector('blockquote')?.textContent?.trim()).toBe('a note');
    const table = container.querySelector('table.md-table');
    expect(table).toBeTruthy();
    expect(table?.querySelectorAll('th')).toHaveLength(2);
    expect(table?.querySelectorAll('td')).toHaveLength(2);
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('renders an empty string safely', () => {
    const { container } = render(<Markdown text={''} />);
    const root = container.querySelector('.md-root');
    expect(root).toBeTruthy();
    expect(root?.querySelector('p, pre, table, ul, ol, blockquote, h1, h2, h3, h4, h5, h6')).toBeNull();
  });
});

describe('MarkdownZeroDep (zero-dependency fallback)', () => {
  it('still renders prose and fenced code with a copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<MarkdownZeroDep text={'hello\n\n```js\nconsole.log(1)\n```'} />);
    expect(screen.getByText('hello')).toBeTruthy();
    expect(screen.getByText('js')).toBeTruthy();
    expect(screen.getByText('console.log(1)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('console.log(1)'));
  });

  it('still strips unsafe link schemes', () => {
    const { container } = render(<MarkdownZeroDep text={'[click](javascript:alert(1))'} />);
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText('click')).toBeTruthy();
  });
});
