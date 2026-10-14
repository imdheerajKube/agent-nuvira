/**
 * Syntax highlighting — a small, dependency-free, line-based tokenizer.
 *
 * WHY NOT A LIBRARY. The codebase deliberately keeps a small runtime dependency
 * footprint, and the CLI only needs to colour the ~10 languages that appear in
 * model answers (ts/js, json, shell, python, go, rust, sql, yaml, css). A full
 * TextMate/Shiki grammar is orders of magnitude heavier than that job. This
 * tokenizer is heuristic by design: it never needs to be *correct*, only to make
 * code readable, and every rule is a pure function with a unit test.
 *
 * The output is a per-line, per-token structure of `{ text, kind }`. Both the
 * ANSI renderer and the Ink view map `kind` through the shared theme, so code
 * colouring is identical on both surfaces.
 */

export type TokenKind =
  | 'plain'
  | 'keyword'
  | 'boolean'
  | 'string'
  | 'number'
  | 'comment'
  | 'func'
  | 'type'
  | 'punct'
  | 'operator';

export interface Token {
  text: string;
  kind: TokenKind;
}

/** Per-line token stream. */
export type TokenizedCode = Token[][];

const KEYWORDS: Record<string, readonly string[]> = {
  js: [
    'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default',
    'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for', 'from', 'function',
    'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'of',
    'package', 'private', 'protected', 'public', 'readonly', 'return', 'set', 'static', 'super',
    'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
    'type', 'namespace', 'declare', 'abstract', 'satisfies', 'keyof', 'infer',
  ],
  python: [
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
    'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
    'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  ],
  shell: [
    'case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in', 'select',
    'then', 'until', 'while', 'export', 'local', 'return', 'source', 'echo',
  ],
  go: [
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough',
    'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range',
    'return', 'select', 'struct', 'switch', 'type', 'var',
  ],
  rust: [
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern',
    'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub',
    'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type',
    'unsafe', 'use', 'where', 'while',
  ],
  sql: [
    'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create',
    'table', 'alter', 'drop', 'join', 'inner', 'left', 'right', 'outer', 'on', 'group', 'by',
    'order', 'having', 'limit', 'offset', 'as', 'and', 'or', 'not', 'null', 'distinct', 'union',
    'primary', 'key', 'foreign', 'references', 'index',
  ],
  css: ['important', 'media', 'keyframes', 'supports', 'import', 'from', 'to', 'and', 'not'],
};

const LITERALS = new Set([
  'true', 'false', 'null', 'undefined', 'nil', 'None', 'True', 'False', 'NULL', 'NaN', 'Infinity',
]);

const HASH_COMMENT_LANGS = new Set(['python', 'shell', 'yaml', 'ruby', 'toml', 'make']);
const DASH_COMMENT_LANGS = new Set(['sql']);

/** Map many aliases to the canonical language key used by {@link highlightCode}. */
export function normalizeLang(raw: string): string {
  const l = (raw || '').trim().toLowerCase();
  if (!l) return 'plain';
  if (['ts', 'tsx', 'typescript', 'mts', 'cts'].includes(l)) return 'js';
  if (['js', 'jsx', 'javascript', 'mjs', 'cjs', 'node'].includes(l)) return 'js';
  if (['py', 'python3'].includes(l)) return 'python';
  if (['sh', 'bash', 'zsh', 'shell', 'console', 'shellsession'].includes(l)) return 'shell';
  if (['json', 'jsonc'].includes(l)) return 'json';
  if (['golang'].includes(l)) return 'go';
  if (['rs'].includes(l)) return 'rust';
  if (['yml'].includes(l)) return 'yaml';
  if (['postgres', 'postgresql', 'mysql', 'sqlite'].includes(l)) return 'sql';
  if (KEYWORDS[l]) return l;
  return 'plain';
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** Is this language one where `/` starts a regex rather than division? */
function slashStartsComment(lang: string): boolean {
  return !DASH_COMMENT_LANGS.has(lang) && lang !== 'python' && lang !== 'shell';
}

interface LineState {
  blockComment: boolean;
  template: boolean;
}

/**
 * Highlight a code block into per-line tokens.
 *
 * Block comments (`/​* ... *​/`) and backtick template literals are tracked across
 * lines through {@link LineState}, so a multi-line comment is coloured as a
 * comment on every line rather than only the first.
 */
export function highlightCode(code: string, lang: string): TokenizedCode {
  const language = normalizeLang(lang);
  const keywords = new Set(KEYWORDS[language] ?? []);
  const hashComment = HASH_COMMENT_LANGS.has(language);
  const dashComment = DASH_COMMENT_LANGS.has(language);
  const supportsSlash = slashStartsComment(language);
  const lines = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const state: LineState = { blockComment: false, template: false };

  return lines.map((line) => tokenizeLine(line, { language, keywords, hashComment, dashComment, supportsSlash, state }));
}

interface TokenizeCtx {
  language: string;
  keywords: Set<string>;
  hashComment: boolean;
  dashComment: boolean;
  supportsSlash: boolean;
  state: LineState;
}

function tokenizeLine(line: string, ctx: TokenizeCtx): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (text: string, kind: TokenKind): void => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };

  // Continue a block comment / template string from the previous line.
  if (ctx.state.blockComment) {
    const end = line.indexOf('*/');
    if (end === -1) {
      push(line, 'comment');
      return out;
    }
    push(line.slice(0, end + 2), 'comment');
    ctx.state.blockComment = false;
    i = end + 2;
  }
  if (ctx.state.template) {
    const end = findUnescaped(line, i, '`');
    if (end === -1) {
      push(line.slice(i), 'string');
      return out;
    }
    push(line.slice(i, end + 1), 'string');
    ctx.state.template = false;
    i = end + 1;
  }

  const n = line.length;
  while (i < n) {
    const ch = line[i];
    const rest = line.slice(i);

    // ── Comments ──────────────────────────────────────────────────────
    if (ctx.supportsSlash && rest.startsWith('//')) {
      push(line.slice(i), 'comment');
      break;
    }
    if (ctx.supportsSlash && rest.startsWith('/*')) {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) {
        push(line.slice(i), 'comment');
        ctx.state.blockComment = true;
        break;
      }
      push(line.slice(i, end + 2), 'comment');
      i = end + 2;
      continue;
    }
    if (ctx.hashComment && ch === '#') {
      push(line.slice(i), 'comment');
      break;
    }
    if (ctx.dashComment && rest.startsWith('--')) {
      push(line.slice(i), 'comment');
      break;
    }

    // ── Strings ───────────────────────────────────────────────────────
    if (ch === '"' || ch === "'") {
      const end = findUnescaped(line, i + 1, ch);
      if (end === -1) {
        push(line.slice(i), 'string');
        break;
      }
      push(line.slice(i, end + 1), 'string');
      i = end + 1;
      continue;
    }
    if (ch === '`' && ctx.language === 'js') {
      const end = findUnescaped(line, i + 1, '`');
      if (end === -1) {
        push(line.slice(i), 'string');
        ctx.state.template = true;
        break;
      }
      push(line.slice(i, end + 1), 'string');
      i = end + 1;
      continue;
    }

    // ── Numbers ───────────────────────────────────────────────────────
    if (isDigit(ch) || (ch === '.' && isDigit(line[i + 1] ?? ''))) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXoObB._]/.test(line[j])) j++;
      push(line.slice(i, j), 'number');
      i = j;
      continue;
    }

    // ── Identifiers ───────────────────────────────────────────────────
    if (isIdentStart(ch)) {
      let j = i;
      while (j < n && isIdentPart(line[j])) j++;
      const word = line.slice(i, j);
      let kind: TokenKind = 'plain';
      if (LITERALS.has(word)) kind = 'boolean';
      else if (ctx.keywords.has(word)) kind = 'keyword';
      else if (word === word.toUpperCase() && word.length > 1 && /^[A-Z0-9_]+$/.test(word)) kind = 'type';
      else if (line[j] === '(') kind = 'func';
      else if (/^[A-Z]/.test(word)) kind = 'type';
      push(word, kind);
      i = j;
      continue;
    }

    // ── Punctuation / operators ───────────────────────────────────────
    if ('(){}[];,.:'.includes(ch)) {
      push(ch, 'punct');
      i++;
      continue;
    }
    if ('+-*/%=<>!&|^~?'.includes(ch)) {
      push(ch, 'operator');
      i++;
      continue;
    }

    push(ch, 'plain');
    i++;
  }

  return out;
}

/** Index of the next unescaped `quote` at or after `from`, or -1. */
function findUnescaped(line: string, from: number, quote: string): number {
  let escaped = false;
  for (let k = from; k < line.length; k++) {
    const c = line[k];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === quote) return k;
  }
  return -1;
}
