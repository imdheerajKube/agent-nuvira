/**
 * Markdown → shared AST parser.
 *
 * ONE PARSE, TWO RENDERERS. The CLI needs to show a model's markdown reply both
 * live (Ink) and as a final frame / non-TTY fallback (a plain ANSI string).
 * Parsing twice would guarantee drift, so the parse lives here and each renderer
 * is a pure consumer of {@link Block}[]:
 *
 *   markdown.ts  →  Block[]  →  render.ts      (ANSI string)
 *                            →  answer-view.tsx (Ink elements)
 *
 * A single AST also makes the behaviour testable without a terminal: assertions
 * are made against the parsed structure, not against bytes of coloured output.
 *
 * SCOPE. This is a deliberately small subset — headings, paragraphs, fenced
 * code, ordered/unordered (nested) lists, pipe tables, block quotes and rules,
 * with inline strong/em/code/link. That is what coding-agent answers actually
 * use; anything else degrades to a paragraph. It is not a CommonMark engine.
 */

import { highlightCode, type TokenizedCode } from './highlight.js';

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; text: string; href: string };

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem {
  inlines: Inline[];
  /** Nesting depth (0 = top level), derived from leading indentation. */
  depth: number;
  /** Whether THIS item used an ordered marker (`1.`). */
  ordered: boolean;
  /** The item's own number when ordered (0 for a bullet). */
  index: number;
}

export type Block =
  | { type: 'heading'; level: number; inlines: Inline[] }
  | { type: 'paragraph'; inlines: Inline[] }
  | { type: 'code'; lang: string; code: string; tokens: TokenizedCode }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][]; align: Align[] }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'hr' };

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Parse a markdown string into blocks. */
export function parseMarkdown(md: string): Block[] {
  const lines = (md ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  return parseBlocks(lines);
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2] || '';
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const closing = new RegExp(`^\\s*${marker === '`' ? '`' : '~'}{3,}\\s*$`);
        if (closing.test(lines[i])) {
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      const code = body.join('\n');
      blocks.push({ type: 'code', lang, code, tokens: highlightCode(code, lang) });
      continue;
    }

    // Heading
    const heading = HEADING_RE.exec(line);
    if (heading && !line.trimStart().startsWith('>')) {
      blocks.push({ type: 'heading', level: heading[1].length, inlines: parseInline(heading[2]) });
      i++;
      continue;
    }

    // Horizontal rule
    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Block quote
    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && (QUOTE_RE.test(lines[i]) || lines[i].trim() === '')) {
        if (lines[i].trim() === '') {
          // A blank line ends the quote unless another '>' follows.
          if (!QUOTE_RE.test(lines[i + 1] ?? '')) break;
          inner.push('');
        } else {
          inner.push(QUOTE_RE.exec(lines[i])![1]);
        }
        i++;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner) });
      continue;
    }

    // List (unordered or ordered)
    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      const ordered = ORDERED_RE.test(line) && !BULLET_RE.test(line);
      const start = ordered ? Number(ORDERED_RE.exec(line)![2]) : 1;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const bullet = BULLET_RE.exec(lines[i]);
        const num = ORDERED_RE.exec(lines[i]);
        if (!bullet && !num) break;
        const m = bullet ?? num!;
        const indent = m[1].length;
        const isOrdered = !bullet;
        items.push({
          inlines: parseInline(m[3]),
          depth: Math.min(4, Math.floor(indent / 2)),
          ordered: isOrdered,
          index: isOrdered ? Number(num![2]) : 0,
        });
        i++;
        // Skip blank separator lines between items.
        if (lines[i]?.trim() === '' && (BULLET_RE.test(lines[i + 1] ?? '') || ORDERED_RE.test(lines[i + 1] ?? ''))) {
          i++;
        }
      }
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }

    // Table (a header row followed by a separator row)
    if (line.includes('|') && TABLE_SEP_RE.test(lines[i + 1] ?? '')) {
      const header = splitRow(line);
      const align = parseAlign(lines[i + 1]);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, rows, align });
      continue;
    }

    // Paragraph — consecutive non-blank, non-structural lines.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i], lines[i + 1])) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) {
      blocks.push({ type: 'paragraph', inlines: parseInline(para.join(' ')) });
    } else {
      // Defensive: never loop forever on an unexpected line.
      i++;
    }
  }

  return blocks;
}

function isBlockStart(line: string, next: string | undefined): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    BULLET_RE.test(line) ||
    ORDERED_RE.test(line) ||
    (line.includes('|') && TABLE_SEP_RE.test(next ?? ''))
  );
}

function splitRow(line: string): Inline[][] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => parseInline(cell.trim()));
}

function parseAlign(sep: string): Align[] {
  const cells = sep.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map((c) => {
    const t = c.trim();
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

/**
 * Parse inline markdown into styled runs.
 *
 * Deliberately non-greedy and pragmatic: an unmatched marker such as a lone `*`
 * or a `[` without `](…)` is emitted as literal text, never swallowed, so
 * ordinary prose containing asterisks and brackets survives intact.
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';

  const flush = (): void => {
    if (buf) {
      out.push({ kind: 'text', text: buf });
      buf = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    // Inline code — highest precedence, spans markers as literals.
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        flush();
        out.push({ kind: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Strong: ** or __
    const strong = /^(\*\*|__)([\s\S]+?)\1/.exec(rest);
    if (strong) {
      flush();
      out.push({ kind: 'strong', children: parseInline(strong[2]) });
      i += strong[0].length;
      continue;
    }

    // Emphasis: * or _
    const em = /^(\*|_)([^\s*_][\s\S]*?)\1/.exec(rest);
    if (em) {
      flush();
      out.push({ kind: 'em', children: parseInline(em[2]) });
      i += em[0].length;
      continue;
    }

    // Link: [text](href)
    const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      flush();
      out.push({ kind: 'link', text: link[1], href: link[2] });
      i += link[0].length;
      continue;
    }

    buf += text[i];
    i++;
  }

  flush();
  return out.length ? out : [{ kind: 'text', text }];
}

/** Plain text of an inline run — used for measuring and for non-colour output. */
export function inlineText(inlines: readonly Inline[]): string {
  return inlines
    .map((inl) => {
      switch (inl.kind) {
        case 'text':
        case 'code':
          return inl.text;
        case 'link':
          return inl.text;
        case 'strong':
        case 'em':
          return inlineText(inl.children);
      }
    })
    .join('');
}

/** Plain text of a block tree — a markdown-aware fallback when colour is off. */
export function blocksToPlainText(blocks: readonly Block[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        lines.push(inlineText(b.inlines), '');
        break;
      case 'paragraph':
        lines.push(inlineText(b.inlines), '');
        break;
      case 'code':
        lines.push(...b.code.split('\n'), '');
        break;
      case 'hr':
        lines.push('', '');
        break;
      case 'quote':
        lines.push(blocksToPlainText(b.blocks).trimEnd(), '');
        break;
      case 'list':
      b.items.forEach((it, idx) => {
        const bullet = it.ordered ? `${it.index || b.start + idx}. ` : '- ';
          lines.push('  '.repeat(it.depth) + bullet + inlineText(it.inlines));
        });
        lines.push('');
        break;
      case 'table':
        lines.push(b.header.map(inlineText).join(' | '));
        for (const row of b.rows) lines.push(row.map(inlineText).join(' | '));
        lines.push('');
        break;
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}
