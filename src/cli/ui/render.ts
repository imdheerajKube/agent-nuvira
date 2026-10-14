/**
 * ANSI renderer — turns the shared markdown AST into a styled terminal string.
 *
 * This is the workhorse for two paths:
 *   - the FINAL frame of a streamed answer (the presenter unmounts Ink, then
 *     writes this string, exactly as `PipelineBoard.finish()` writes its final
 *     frame — so the answer is not erased by Ink's unmount)
 *   - NON-TTY output (pipes, CI, `--json-events`), where Ink must not mount
 *
 * It is intentionally a PURE function of (blocks, options): no globals, no
 * terminal probing. Width and colour are passed in, so tests assert on plain
 * strings with `color: false`.
 */

import chalk from 'chalk';

import { parseMarkdown, type Block, type Inline, type ListItem } from './markdown.js';
import { DARK_THEME, type Theme, type ThemeRole } from './theme.js';
import type { TokenKind } from './highlight.js';

export interface RenderOptions {
  theme?: Theme;
  /** Terminal width (columns). Defaults to 80. */
  width?: number;
  /** Emit ANSI colour. Defaults to true (chalk still honours its own level). */
  color?: boolean;
}

interface Seg {
  text: string;
  style: (s: string) => string;
}

const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/** Visible width of a string: ANSI stripped, wide glyphs counted as two. */
export function visibleWidth(s: string): number {
  const plain = s.replace(ANSI_RE, '');
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

class Painter {
  readonly theme: Theme;
  readonly color: boolean;
  readonly width: number;

  constructor(opts: RenderOptions = {}) {
    this.theme = opts.theme ?? DARK_THEME;
    this.width = Math.max(20, opts.width ?? 80);
    this.color = (opts.color ?? true) && this.theme.name !== 'none';
  }

  paint(role: ThemeRole, s: string): string {
    if (!this.color) return s;
    return chalk.hex(this.theme.color[role])(s);
  }

  bold(s: string): string {
    return this.color ? chalk.bold(s) : s;
  }

  italic(s: string): string {
    return this.color ? chalk.italic(s) : s;
  }

  dim(s: string): string {
    return this.color ? chalk.dim(s) : s;
  }

  underline(s: string): string {
    return this.color ? chalk.underline(s) : s;
  }

  repeat(ch: string, n: number): string {
    return ch.repeat(Math.max(0, n));
  }
}

const TOKEN_ROLE: Record<TokenKind, ThemeRole> = {
  plain: 'code',
  keyword: 'keyword',
  boolean: 'number',
  string: 'string',
  number: 'number',
  comment: 'comment',
  func: 'func',
  type: 'type',
  punct: 'punct',
  operator: 'punct',
};

/** Render inline runs to styled segments. */
function inlineSegments(inlines: readonly Inline[], p: Painter, wrap?: (s: string) => string): Seg[] {
  const out: Seg[] = [];
  const box = (s: string): string => (wrap ? wrap(s) : s);
  for (const inl of inlines) {
    switch (inl.kind) {
      case 'text':
        out.push({ text: inl.text, style: (s) => box(p.paint('text', s)) });
        break;
      case 'code':
        out.push({ text: inl.text, style: (s) => box(p.paint('code', s)) });
        break;
      case 'strong':
        out.push(...inlineSegments(inl.children, p, (s) => box(p.bold(s))));
        break;
      case 'em':
        out.push(...inlineSegments(inl.children, p, (s) => box(p.italic(s))));
        break;
      case 'link':
        out.push({ text: inl.text, style: (s) => box(p.underline(p.paint('link', s))) });
        if (inl.href && inl.href !== inl.text) {
          out.push({ text: ` (${inl.href})`, style: (s) => box(p.dim(s)) });
        }
        break;
    }
  }
  return out;
}

/**
 * Greedy wrap over styled segments.
 *
 * Works on PIECES, preserving the original whitespace rather than rejoining
 * words with a single space. That matters for markdown fidelity: a link
 * followed by a period (`[x](y).`) is three runs — `x`, ` (y)`, `.` — and
 * re-inserting a separator between every run would print `x (y) .`. Whitespace
 * runs are the only break opportunities, and a break strips the trailing space.
 */
function wrapSegments(segs: readonly Seg[], width: number, indent: string, restIndent = indent): string[] {
  interface Piece {
    text: string;
    style: (s: string) => string;
    space: boolean;
  }
  const pieces: Piece[] = [];
  for (const seg of segs) {
    for (const part of seg.text.split(/(\s+)/)) {
      if (part === '') continue;
      pieces.push({ text: part, style: seg.style, space: /^\s+$/.test(part) });
    }
  }
  if (pieces.length === 0) return [indent.trimEnd()];

  // Group pieces joined WITHOUT whitespace into atomic chunks, so a period (or
  // any punctuation run) can never be stranded on a line by itself: the whole
  // `(https://example.com).` unit moves together.
  const chunks: Piece[][] = [];
  let current: Piece[] = [];
  for (const pc of pieces) {
    if (pc.space) {
      if (current.length) chunks.push(current);
      current = [];
      chunks.push([pc]);
    } else {
      current.push(pc);
    }
  }
  if (current.length) chunks.push(current);

  const restLen = visibleWidth(restIndent);
  const lines: string[] = [];
  let line = indent;
  let len = visibleWidth(indent);

  const flush = (): void => {
    lines.push(line.replace(/\s+$/, ''));
    line = restIndent;
    len = restLen;
  };

  for (const chunk of chunks) {
    const text = chunk.map((c) => c.style(c.text)).join('');
    const w = chunk.reduce((a, c) => a + visibleWidth(c.text), 0);
    if (chunk[0].space) {
      line += text;
      len += w;
      continue;
    }
    if (len + w > width && len > restLen) flush();
    line += text;
    len += w;
  }
  if (line.trim()) lines.push(line.replace(/\s+$/, ''));
  return lines;
}

/** Render a code block as a bordered, highlighted box. */
function renderCodeBox(lang: string, tokens: readonly { text: string; kind: TokenKind }[][], p: Painter, indent: string): string[] {
  const inner = Math.max(10, p.width - visibleWidth(indent) - 4);
  const rendered: Seg[][] = [];
  for (const line of tokens) {
    const runs: Seg[] = line.map((t) => ({ text: t.text, style: (s: string) => p.paint(TOKEN_ROLE[t.kind], s) }));
    rendered.push(...wrapCodeLine(runs, inner));
  }
  if (rendered.length === 0) rendered.push([]);

  const label = lang ? ` ${lang} ` : '';
  const topFill = p.repeat('─', inner - visibleWidth(label));
  const dim = (s: string): string => p.paint('codeBorder', s);

  const lines: string[] = [];
  lines.push(indent + dim('┌') + (lang ? p.paint('accent', label) : '') + dim(topFill + '┐'));
  for (const runs of rendered) {
    const content = runs.map((r) => r.style(r.text)).join('');
    const used = runs.reduce((a, r) => a + visibleWidth(r.text), 0);
    lines.push(indent + dim('│') + content + p.repeat(' ', inner - used) + dim('│'));
  }
  lines.push(indent + dim('└' + p.repeat('─', inner) + '┘'));
  return lines;
}

function wrapCodeLine(runs: readonly Seg[], width: number): Seg[][] {
  const out: Seg[][] = [];
  let cur: Seg[] = [];
  let len = 0;
  const pushChar = (ch: string, style: (s: string) => string): void => {
    if (len >= width) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    const last = cur[cur.length - 1];
    if (last && last.style === style) last.text += ch;
    else cur.push({ text: ch, style });
    len += 1;
  };
  for (const run of runs) for (const ch of run.text) pushChar(ch, run.style);
  out.push(cur);
  return out;
}

function inlineToPlain(inl: Inline): string {
  switch (inl.kind) {
    case 'text':
    case 'code':
      return inl.text;
    case 'link':
      return inl.text;
    case 'strong':
    case 'em':
      return inl.children.map(inlineToPlain).join('');
  }
}

/** Render a pipe table with box-drawing borders. */
function renderTable(block: Extract<Block, { type: 'table' }>, p: Painter, indent: string): string[] {
  const cols = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
  const widths: number[] = new Array(cols).fill(1);
  const cellText = (inl: Inline[]): string => inl.map((x) => (x.kind === 'code' ? x.text : inlineToPlain(x))).join('');

  block.header.forEach((cell, idx) => {
    widths[idx] = Math.max(widths[idx], visibleWidth(cellText(cell)));
  });
  for (const row of block.rows) {
    row.forEach((cell, idx) => {
      if (idx < cols) widths[idx] = Math.max(widths[idx], visibleWidth(cellText(cell)));
    });
  }

  const overhead = indent.length + cols * 3 + 1;
  let total = widths.reduce((a, b) => a + b, 0) + overhead;
  while (total > p.width) {
    let widest = 0;
    for (let c = 1; c < cols; c++) if (widths[c] > widths[widest]) widest = c;
    if (widths[widest] <= 1) break;
    widths[widest]--;
    total--;
  }

  const border = (left: string, mid: string, right: string): string =>
    indent + p.paint('border', left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right);

  const rowLine = (cells: Inline[][]): string => {
    const parts: string[] = [];
    for (let c = 0; c < cols; c++) {
      const cell = cells[c] ?? [];
      const text = inlineSegments(cell, p).map((s) => s.style(s.text)).join('');
      const pad = Math.max(0, widths[c] - visibleWidth(cellText(cell)));
      parts.push(' ' + text + ' '.repeat(pad) + ' ');
    }
    return indent + p.paint('border', '│') + parts.join(p.paint('border', '│')) + p.paint('border', '│');
  };

  const lines = [border('┌', '┬', '┐'), rowLine(block.header), border('├', '┼', '┤')];
  for (const row of block.rows) lines.push(rowLine(row));
  lines.push(border('└', '┴', '┘'));
  return lines;
}

function renderList(block: Extract<Block, { type: 'list' }>, p: Painter, indent: string): string[] {
  const lines: string[] = [];
  block.items.forEach((item: ListItem, idx) => {
    const base = indent + '  '.repeat(item.depth);
    // Each item carries its OWN marker kind, so a bullet nested under an
    // ordered list keeps its bullet instead of inheriting the numbering.
    const marker = item.ordered ? `${item.index || block.start + idx}. ` : '• ';
    const markerWidth = visibleWidth(marker);
    const segs = inlineSegments(item.inlines, p);
    const wrapped = wrapSegments(segs, p.width, base + p.paint('accent', marker), base + ' '.repeat(markerWidth));
    lines.push(...wrapped);
  });
  return lines;
}

/** Render the block AST to a string. */
export function renderBlocks(blocks: readonly Block[], opts: RenderOptions = {}): string {
  const p = new Painter(opts);
  const indent = '  ';
  const out: string[] = [];
  let prev: Block['type'] | undefined;

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        if (out.length && prev !== 'heading') out.push('');
        const text = inlineSegments(block.inlines, p).map((s) => s.style(s.text)).join('');
        const bar = block.level === 1 ? '▍ ' : block.level === 2 ? '▎ ' : '';
        out.push(indent + p.bold(p.paint('heading', bar + text)));
        out.push('');
        break;
      }
      case 'paragraph': {
        out.push(...wrapSegments(inlineSegments(block.inlines, p), p.width, indent));
        out.push('');
        break;
      }
      case 'code':
        out.push(...renderCodeBox(block.lang, block.tokens, p, indent));
        out.push('');
        break;
      case 'list':
        out.push(...renderList(block, p, indent));
        out.push('');
        break;
      case 'quote': {
        const inner = renderBlocks(block.blocks, { ...opts, width: p.width - 2 });
        for (const line of inner.replace(/\n+$/, '').split('\n')) {
          out.push(indent + p.paint('muted', '▏ ') + p.italic(p.paint('muted', line.trim())));
        }
        out.push('');
        break;
      }
      case 'table':
        out.push(...renderTable(block, p, indent));
        out.push('');
        break;
      case 'hr':
        out.push(indent + p.paint('faint', '─'.repeat(Math.max(4, p.width - 4))));
        out.push('');
        break;
    }
    prev = block.type;
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}

/**
 * A card body line. A bare string is rendered muted; the object form lets a
 * caller colour one line — which is what makes a git diff readable (added /
 * removed / hunk lines each take their own role).
 */
export interface CardLine {
  text: string;
  role?: ThemeRole;
}

export interface CardOptions {
  icon?: string;
  title: string;
  lines?: Array<string | CardLine>;
  /** Accent role for the title. */
  role?: ThemeRole;
}

/**
 * A bordered card for structured events (tool call, shell, diff, plan).
 *
 * Kept separate from block rendering because a card is a single visual unit
 * whose height is computable before it is placed in a live view.
 */
export function renderCard(card: CardOptions, opts: RenderOptions = {}): string {
  const p = new Painter(opts);
  const role = card.role ?? 'accent';
  const indent = '  ';
  const head = `${card.icon ? card.icon + ' ' : ''}${card.title}`;
  const body: CardLine[] = (card.lines ?? []).map((l) => (typeof l === 'string' ? { text: l } : l));
  const content = Math.max(visibleWidth(head), ...body.map((l) => visibleWidth(l.text)), 1);
  const inner = Math.min(content + 2, Math.max(4, p.width - indent.length - 2));

  const lines: string[] = [];
  const border = (s: string): string => p.paint('border', s);
  lines.push(indent + border('╭' + '─'.repeat(inner) + '╮'));
  const headClipped = clip(head, inner - 2);
  lines.push(
    indent + border('│') + ' ' + p.bold(p.paint(role, headClipped)) + ' '.repeat(Math.max(0, inner - 1 - visibleWidth(headClipped))) + border('│'),
  );
  for (const b of body) {
    const clipped = clip(b.text, inner - 2);
    lines.push(
      indent + border('│') + ' ' + p.paint(b.role ?? 'muted', clipped) + ' '.repeat(Math.max(0, inner - 1 - visibleWidth(clipped))) + border('│'),
    );
  }
  lines.push(indent + border('╰' + '─'.repeat(inner) + '╯'));
  return lines.join('\n');
}

/** Clip a plain string to a visible width, appending an ellipsis when cut. */
function clip(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    if (w + 1 > Math.max(0, width - 1)) break;
    out += ch;
    w += 1;
  }
  return out + '…';
}

/** Render a markdown string to an ANSI string. */
export function renderMarkdown(md: string, opts: RenderOptions = {}): string {
  return renderBlocks(parseMarkdown(md), opts);
}
