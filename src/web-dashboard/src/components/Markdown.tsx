/**
 * Markdown — chat answer renderer (Phase 1 of DASHBOARD_FIRST_PLAN).
 *
 * Stack (decision reviewed 2026-08-17 with the user): react-markdown v10 +
 * remark-gfm + rehype-highlight. The earlier custom renderer covered ~90% of
 * CommonMark but mangled real agent output (nested lists, ***bold italic***,
 * autolinks, strikethrough, task lists) and had NO syntax highlighting — the
 * user's exact concern ("is your custom a weak fix?"). react-markdown is the
 * spec-complete, battle-tested standard; it adds ~10 KB gzipped to a 219 KB
 * bundle (<5%) and builds React elements (no dangerouslySetInnerHTML) with
 * built-in URL sanitization — the same security model as before.
 *
 * The zero-dependency custom renderer is preserved as `MarkdownZeroDep.tsx`
 * (unused by the app) for anyone who wants a dependency-free build — switch
 * the import in ChatPage.tsx to use it.
 *
 * Supported: full CommonMark + GFM (tables, strikethrough, task lists,
 * autolinks), syntax-highlighted fenced code blocks with a copy button,
 * headings, lists, blockquotes, links (react-markdown's defaultUrlTransform
 * strips javascript:/data: hrefs).
 */

import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import ts from 'highlight.js/lib/languages/typescript';
import js from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import python from 'highlight.js/lib/languages/python';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import diff from 'highlight.js/lib/languages/diff';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import plaintext from 'highlight.js/lib/languages/plaintext';

/**
 * Curated highlight languages — the set the agent actually emits (ts, js,
 * json, bash, python, markdown, yaml, diff, sql, html/xml, css). rehype-
 * highlight's DEFAULT lowlight bundle carries ~37 grammars; registering only
 * these keeps the dashboard bundle ~80 KB smaller (measured: gzip 322 KB →
 * ~240 KB) while still highlighting every real code block. rehype-highlight
 * expects a name → grammar RECORD (it builds its own lowlight internally).
 */
const HIGHLIGHT_LANGUAGES = {
  ts,
  typescript: ts,
  js,
  javascript: js,
  json,
  bash,
  shell,
  sh: shell,
  python,
  py: python,
  markdown,
  md: markdown,
  yaml,
  yml: yaml,
  diff,
  sql,
  html: xml,
  xml,
  css,
  text: plaintext,
  plaintext,
};

/** Walk a hast node to its raw text (highlight spans included). */
function hastText(node: unknown): string {
  if (node == null) return '';
  const n = node as { value?: unknown; children?: unknown[] };
  if (typeof n.value === 'string') return n.value;
  if (Array.isArray(n.children)) return n.children.map(hastText).join('');
  return '';
}

/** A fenced code block: language label + copy button + highlighted body. */
function CodeBlockView({ lang, code, children }: { lang: string; code: string; children: React.ReactNode }) {
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
        <code>{children}</code>
      </pre>
    </div>
  );
}

/**
 * Custom `pre` renderer: wraps every fenced block in the copy-button shell.
 * `node` is the hast element — walk it for the RAW code text (rehype-highlight
 * has already split children into spans), and read `language-*` for the label.
 * Blocks without a language still get the shell (lang "text").
 */
function Pre({ node, children }: { node?: unknown; children?: React.ReactNode }) {
  const codeNode = (node as { children?: Array<{ properties?: { className?: unknown } }> })?.children?.[0];
  const classes = Array.isArray(codeNode?.properties?.className)
    ? (codeNode?.properties?.className as string[])
    : [];
  const lang = classes.find((c) => typeof c === 'string' && c.startsWith('language-'))?.slice(9) ?? 'text';
  const raw = useMemo(() => hastText(codeNode), [codeNode]);
  return (
    <CodeBlockView lang={lang} code={raw}>
      {children}
    </CodeBlockView>
  );
}

/** Top-level renderer: react-markdown with GFM + highlighting + the shell. */
export default function Markdown({ text }: { text: string }) {
  const components = useMemo(
    () => ({
      h1: ({ node: _n, ...p }: { node?: unknown }) => <h1 className="md-heading md-h1" {...p} />,
      h2: ({ node: _n, ...p }: { node?: unknown }) => <h2 className="md-heading md-h2" {...p} />,
      h3: ({ node: _n, ...p }: { node?: unknown }) => <h3 className="md-heading md-h3" {...p} />,
      h4: ({ node: _n, ...p }: { node?: unknown }) => <h4 className="md-heading md-h4" {...p} />,
      h5: ({ node: _n, ...p }: { node?: unknown }) => <h5 className="md-heading md-h5" {...p} />,
      h6: ({ node: _n, ...p }: { node?: unknown }) => <h6 className="md-heading md-h6" {...p} />,
      p: ({ node: _n, ...p }: { node?: unknown }) => <p className="md-para" {...p} />,
      ul: ({ node: _n, ...p }: { node?: unknown }) => <ul className="md-list md-ul" {...p} />,
      ol: ({ node: _n, ...p }: { node?: unknown }) => <ol className="md-list md-ol" {...p} />,
      blockquote: ({ node: _n, ...p }: { node?: unknown }) => <blockquote className="md-quote" {...p} />,
      hr: ({ node: _n, ...p }: { node?: unknown }) => <hr className="md-hr" {...p} />,
      table: ({ node: _n, ...p }: { node?: unknown }) => <table className="md-table" {...p} />,
      a: ({ node: _n, ...p }: { node?: unknown }) => <a target="_blank" rel="noreferrer" {...p} />,
      pre: Pre,
    }),
    [],
  );

  return (
    <div className="md-root">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { languages: HIGHLIGHT_LANGUAGES }]]} components={components}>
        {text ?? ''}
      </ReactMarkdown>
    </div>
  );
}
