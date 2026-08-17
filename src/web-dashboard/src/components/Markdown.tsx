/**
 * Markdown — a small, dependency-free renderer for chat answers (Phase 1 of
 * DASHBOARD_FIRST_PLAN: "the chat currently renders answers as raw text").
 *
 * The agent's replies are markdown (headings, lists, bold, inline code,
 * fenced code blocks, links). Rendering them is the single highest-impact
 * change toward a professional-assistant feel. We deliberately do NOT pull
 * react-markdown: the plan's risk table says "use a small renderer; verify
 * what's already bundled first" — and the project's ethos is dependency-free
 * (the gateway adapters are pure fetch). This is ~150 lines, handles the
 * shapes the engine actually emits, and never uses dangerouslySetInnerHTML
 * (React escaping + an href allowlist are the XSS guards).
 *
 * Supported: fenced code blocks (```lang, with copy button), headings
 * (#..######), bold (**), italic (*), inline code (`), links
 * ([text](url) — http/https/mailto only), bullet + numbered lists,
 * blockquotes (>), tables (| a | b |), horizontal rules (---).
 */

import { useMemo, useState } from 'react';

interface CodeBlock {
  type: 'code';
  lang: string;
  code: string;
}

interface ProseBlock {
  type: 'prose';
  /** Raw lines (no code fences) — inline-parsed during render. */
  lines: string[];
}

type Block = CodeBlock | ProseBlock;

/** Split on ``` fences; everything outside becomes prose lines. */
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const fenceRe = /^```([\w+-]*)\s*$/;
  const lines = text.split('\n');
  let i = 0;
  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length > 0) {
      blocks.push({ type: 'prose', lines: prose });
      prose = [];
    }
  };
  while (i < lines.length) {
    const m = fenceRe.exec(lines[i].trim());
    if (m) {
      flushProse();
      const lang = m[1] || 'text';
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      blocks.push({ type: 'code', lang, code: code.join('\n') });
    } else {
      prose.push(lines[i]);
      i += 1;
    }
  }
  flushProse();
  return blocks;
}

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

/**
 * Inline tokenizer: `code` first (so ** inside code stays literal), then
 * **bold**, *italic*, [text](url). Everything else is plain text. Returns
 * React nodes — no HTML strings, so no injection surface.
 */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const [, code, bold, ital, , linkText, linkHref] = m;
    if (code !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-c${k}`} className="md-inline-code">
          {code.slice(1, -1)}
        </code>,
      );
    } else if (bold !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-b${k}`}>{bold.slice(2, -2)}</strong>);
    } else if (ital !== undefined) {
      nodes.push(<em key={`${keyPrefix}-i${k}`}>{ital.slice(1, -1)}</em>);
    } else if (linkHref !== undefined && SAFE_HREF.test(linkHref)) {
      nodes.push(
        <a key={`${keyPrefix}-l${k}`} href={linkHref} target="_blank" rel="noreferrer">
          {linkText}
        </a>,
      );
    } else if (linkHref !== undefined) {
      // Unsafe scheme — render the text, never the href.
      nodes.push(<span key={`${keyPrefix}-l${k}`}>{linkText}</span>);
    }
    last = m.index + m[0].length;
    k += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Group consecutive list items so a run renders as one <ul>/<ol>. */
interface ListItem {
  type: 'ul' | 'ol';
  text: string;
}

/** Render one prose line; list items and tables accumulate into groups. */
function Prose({ lines }: { lines: string[] }) {
  const rows: React.ReactNode[] = [];
  let listRun: ListItem[] | null = null;
  let tableRun: string[][] | null = null;
  let key = 0;

  const flushList = () => {
    if (!listRun) return;
    const items = listRun;
    const Tag = items[0].type === 'ol' ? 'ol' : 'ul';
    rows.push(
      <Tag key={`md-l${key++}`} className={`md-list md-${items[0].type}`}>
        {items.map((it, i) => (
          <li key={i}>{inline(it.text, `md-li${key}-${i}`)}</li>
        ))}
      </Tag>,
    );
    listRun = null;
  };
  const flushTable = () => {
    if (!tableRun) return;
    const t = tableRun;
    rows.push(
      <table key={`md-t${key++}`} className="md-table">
        <thead>
          <tr>
            {t[0].map((h, i) => (
              <th key={i}>{inline(h, `md-th${i}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.slice(2).map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td key={ci}>{inline(c, `md-td${ri}-${ci}`)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>,
    );
    tableRun = null;
  };

  for (const raw of lines) {
    const line = raw;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      flushTable();
      const level = h[1].length;
      const Tag = (`h${Math.min(level, 6)}`) as 'h1';
      rows.push(<Tag key={`md-h${key++}`} className={`md-heading md-h${level}`}>{inline(h[2], `md-h${key}`)}</Tag>);
      continue;
    }
    const hr = /^\s*(---+|\*\*\*+|___+)\s*$/.exec(line);
    if (hr) {
      flushList();
      flushTable();
      rows.push(<hr key={`md-r${key++}`} className="md-hr" />);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushList();
      flushTable();
      rows.push(<blockquote key={`md-q${key++}`} className="md-quote">{inline(quote[1], `md-q${key}`)}</blockquote>);
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul) {
      flushTable();
      if (listRun && listRun[0].type === 'ul') listRun.push({ type: 'ul', text: ul[1] });
      else {
        flushList();
        listRun = [{ type: 'ul', text: ul[1] }];
      }
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flushTable();
      if (listRun && listRun[0].type === 'ol') listRun.push({ type: 'ol', text: ol[1] });
      else {
        flushList();
        listRun = [{ type: 'ol', text: ol[1] }];
      }
      continue;
    }
    const tbl = /^\s*\|.*\|\s*$/.exec(line);
    if (tbl) {
      flushList();
      const cells = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
      if (!tableRun) tableRun = [cells];
      else tableRun.push(cells);
      continue;
    }
    flushList();
    flushTable();
    if (line.trim() === '') {
      rows.push(<div key={`md-p${key++}`} className="md-blank" />);
    } else {
      rows.push(<p key={`md-p${key++}`} className="md-para">{inline(line, `md-p${key}`)}</p>);
    }
  }
  flushList();
  flushTable();
  return <>{rows}</>;
}

/** A fenced code block with a language label and a copy button. */
function CodeBlockView({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (non-secure context / jsdom) — button no-ops */
    }
  };
  return (
    <div className="md-code-block">
      <div className="md-code-head">
        <span className="md-code-lang">{lang}</span>
        <button type="button" className="md-code-copy" onClick={() => void copy()}>
          {copied ? '✓ Copied' : '⧉ Copy'}
        </button>
      </div>
      <pre className="md-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Top-level renderer: split into code/prose blocks, render each. */
export default function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => splitBlocks(text ?? ''), [text]);
  return (
    <div className="md-root">
      {blocks.map((b, i) =>
        b.type === 'code' ? <CodeBlockView key={`b${i}`} lang={b.lang} code={b.code} /> : <Prose key={`b${i}`} lines={b.lines} />,
      )}
    </div>
  );
}
