/**
 * Phase 1 — Markdown renderer tests.
 *
 * The chat answer renderer must turn the agent's markdown into rich blocks:
 * headings, lists, bold/italic, inline code, fenced code blocks with a copy
 * button, links, tables, blockquotes — while NEVER injecting raw HTML (the
 * only XSS surface in a chat view).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import Markdown from './Markdown';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Markdown', () => {
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
    expect(container.querySelector('code.md-inline-code')?.textContent).toBe('code');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  });

  it('never turns a javascript: link into an anchor href', () => {
    const { container } = render(<Markdown text={'[click](javascript:alert(1))'} />);
    expect(container.querySelector('a')).toBeNull();
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

  it('renders a fenced code block with a language label and copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Markdown text={'```ts\nconst x = 1;\n```'} />);
    const lang = screen.getByText('ts');
    expect(lang).toBeTruthy();
    expect(screen.getByText('const x = 1;')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Copy/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const x = 1;'));
    await waitFor(() => expect(screen.getByText(/Copied/)).toBeTruthy());
  });

  it('keeps text inside code fences literal (no bold parsing)', () => {
    const { container } = render(<Markdown text={'```\n**not bold**\n```'} />);
    expect(container.querySelector('strong')).toBeNull();
    expect(screen.getByText('**not bold**')).toBeTruthy();
  });

  it('renders blockquotes and tables', () => {
    const { container } = render(<Markdown text={'> a note\n\n| a | b |\n|---|---|\n| 1 | 2 |'} />);
    expect(container.querySelector('blockquote')?.textContent).toBe('a note');
    const table = container.querySelector('table.md-table');
    expect(table).toBeTruthy();
    expect(table?.querySelectorAll('th')).toHaveLength(2);
    expect(table?.querySelectorAll('td')).toHaveLength(2);
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('renders an empty string safely', () => {
    const { container } = render(<Markdown text={''} />);
    // Empty input renders the root with no content blocks (no crash, no HTML).
    const root = container.querySelector('.md-root');
    expect(root).toBeTruthy();
    expect(root?.querySelector('p, pre, table, ul, ol, blockquote, h1, h2, h3, h4, h5, h6')).toBeNull();
  });
});
