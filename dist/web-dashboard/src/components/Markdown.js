"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Markdown;
const react_1 = require("react");
const react_markdown_1 = __importDefault(require("react-markdown"));
const remark_gfm_1 = __importDefault(require("remark-gfm"));
const rehype_highlight_1 = __importDefault(require("rehype-highlight"));
const typescript_1 = __importDefault(require("highlight.js/lib/languages/typescript"));
const javascript_1 = __importDefault(require("highlight.js/lib/languages/javascript"));
const json_1 = __importDefault(require("highlight.js/lib/languages/json"));
const bash_1 = __importDefault(require("highlight.js/lib/languages/bash"));
const shell_1 = __importDefault(require("highlight.js/lib/languages/shell"));
const python_1 = __importDefault(require("highlight.js/lib/languages/python"));
const markdown_1 = __importDefault(require("highlight.js/lib/languages/markdown"));
const yaml_1 = __importDefault(require("highlight.js/lib/languages/yaml"));
const diff_1 = __importDefault(require("highlight.js/lib/languages/diff"));
const sql_1 = __importDefault(require("highlight.js/lib/languages/sql"));
const xml_1 = __importDefault(require("highlight.js/lib/languages/xml"));
const css_1 = __importDefault(require("highlight.js/lib/languages/css"));
const plaintext_1 = __importDefault(require("highlight.js/lib/languages/plaintext"));
/**
 * Curated highlight languages — the set the agent actually emits (ts, js,
 * json, bash, python, markdown, yaml, diff, sql, html/xml, css). rehype-
 * highlight's DEFAULT lowlight bundle carries ~37 grammars; registering only
 * these keeps the dashboard bundle ~80 KB smaller (measured: gzip 322 KB →
 * ~240 KB) while still highlighting every real code block. rehype-highlight
 * expects a name → grammar RECORD (it builds its own lowlight internally).
 */
const HIGHLIGHT_LANGUAGES = {
    ts: typescript_1.default,
    typescript: typescript_1.default,
    js: javascript_1.default,
    javascript: javascript_1.default,
    json: json_1.default,
    bash: bash_1.default,
    shell: shell_1.default,
    sh: shell_1.default,
    python: python_1.default,
    py: python_1.default,
    markdown: markdown_1.default,
    md: markdown_1.default,
    yaml: yaml_1.default,
    yml: yaml_1.default,
    diff: diff_1.default,
    sql: sql_1.default,
    html: xml_1.default,
    xml: xml_1.default,
    css: css_1.default,
    text: plaintext_1.default,
    plaintext: plaintext_1.default,
};
/** Walk a hast node to its raw text (highlight spans included). */
function hastText(node) {
    if (node == null)
        return '';
    const n = node;
    if (typeof n.value === 'string')
        return n.value;
    if (Array.isArray(n.children))
        return n.children.map(hastText).join('');
    return '';
}
/** A fenced code block: language label + copy button + highlighted body. */
function CodeBlockView({ lang, code, children }) {
    const [copied, setCopied] = (0, react_1.useState)(false);
    const copy = async () => {
        try {
            await navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }
        catch {
            /* clipboard unavailable (non-secure context / jsdom) — button no-ops */
        }
    };
    return (<div className="md-code-block">
      <div className="md-code-head">
        <span className="md-code-lang">{lang}</span>
        <button type="button" className="md-code-copy" onClick={() => void copy()}>
          {copied ? '✓ Copied' : '⧉ Copy'}
        </button>
      </div>
      <pre className="md-code-pre">
        <code>{children}</code>
      </pre>
    </div>);
}
/**
 * Custom `pre` renderer: wraps every fenced block in the copy-button shell.
 * `node` is the hast element — walk it for the RAW code text (rehype-highlight
 * has already split children into spans), and read `language-*` for the label.
 * Blocks without a language still get the shell (lang "text").
 */
function Pre({ node, children }) {
    const codeNode = node?.children?.[0];
    const classes = Array.isArray(codeNode?.properties?.className)
        ? codeNode?.properties?.className
        : [];
    const lang = classes.find((c) => typeof c === 'string' && c.startsWith('language-'))?.slice(9) ?? 'text';
    const raw = (0, react_1.useMemo)(() => hastText(codeNode), [codeNode]);
    return (<CodeBlockView lang={lang} code={raw}>
      {children}
    </CodeBlockView>);
}
/** Top-level renderer: react-markdown with GFM + highlighting + the shell. */
function Markdown({ text }) {
    const components = (0, react_1.useMemo)(() => ({
        h1: ({ node: _n, ...p }) => <h1 className="md-heading md-h1" {...p}/>,
        h2: ({ node: _n, ...p }) => <h2 className="md-heading md-h2" {...p}/>,
        h3: ({ node: _n, ...p }) => <h3 className="md-heading md-h3" {...p}/>,
        h4: ({ node: _n, ...p }) => <h4 className="md-heading md-h4" {...p}/>,
        h5: ({ node: _n, ...p }) => <h5 className="md-heading md-h5" {...p}/>,
        h6: ({ node: _n, ...p }) => <h6 className="md-heading md-h6" {...p}/>,
        p: ({ node: _n, ...p }) => <p className="md-para" {...p}/>,
        ul: ({ node: _n, ...p }) => <ul className="md-list md-ul" {...p}/>,
        ol: ({ node: _n, ...p }) => <ol className="md-list md-ol" {...p}/>,
        blockquote: ({ node: _n, ...p }) => <blockquote className="md-quote" {...p}/>,
        hr: ({ node: _n, ...p }) => <hr className="md-hr" {...p}/>,
        table: ({ node: _n, ...p }) => <table className="md-table" {...p}/>,
        a: ({ node: _n, ...p }) => <a target="_blank" rel="noreferrer" {...p}/>,
        pre: Pre,
    }), []);
    return (<div className="md-root">
      <react_markdown_1.default remarkPlugins={[remark_gfm_1.default]} rehypePlugins={[[rehype_highlight_1.default, { languages: HIGHLIGHT_LANGUAGES }]]} components={components}>
        {text ?? ''}
      </react_markdown_1.default>
    </div>);
}
