/**
 * Theme — semantic colour tokens for the CLI presentation layer.
 *
 * WHY TOKENS, NOT LITERAL COLOURS. The renderers (markdown, code, cards, status
 * lines) must be able to answer "what colour is a heading?" in exactly one
 * place. Call sites ask for a ROLE (`heading`, `keyword`, `error`) and never a
 * hex value, so the whole CLI can be re-themed — dark, light, or a user theme —
 * without touching a single renderer.
 *
 * The same token map feeds BOTH surfaces:
 *   - the ANSI string renderer (`render.ts`) via `chalk.hex(...)`
 *   - the Ink view (`answer-view.tsx`) via `<Text color={...}>`
 * because Ink accepts a hex string as `color` and chalk accepts one via
 * `chalk.hex`. One palette, two outputs — they cannot drift.
 *
 * Selection: `NUVIRA_THEME=dark|light|none` (default `dark`). `none` means the
 * renderer should not colour at all (handled by the caller / chalk's own level
 * detection). The theme never reaches into `process.stdout.isTTY` — that is the
 * presenter's decision.
 */

export type ThemeRole =
  | 'accent' // primary brand accent (assistant name, prompt caret)
  | 'heading'
  | 'text'
  | 'muted'
  | 'faint'
  | 'success'
  | 'error'
  | 'warn'
  | 'info'
  | 'link'
  | 'code' // inline + block code foreground
  | 'codeBorder'
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'func'
  | 'type'
  | 'punct'
  | 'border'
  | 'user'
  | 'assistant'
  | 'diffAdd'
  | 'diffDel'
  | 'diffHunk';

export interface Theme {
  name: string;
  color: Record<ThemeRole, string>;
}

/** Dark palette — tuned for a terminal on a dark background. */
export const DARK_THEME: Theme = {
  name: 'dark',
  color: {
    accent: '#7aa2f7',
    heading: '#89b4fa',
    text: '#c0caf5',
    muted: '#7f8ea3',
    faint: '#4a5568',
    success: '#9ece6a',
    error: '#f7768e',
    warn: '#e0af68',
    info: '#7dcfff',
    link: '#7dcfff',
    code: '#e6c07b',
    codeBorder: '#3b4261',
    keyword: '#bb9af7',
    string: '#9ece6a',
    number: '#ff9e64',
    comment: '#565f89',
    func: '#7aa2f7',
    type: '#2ac3de',
    punct: '#9aa5ce',
    border: '#3b4261',
    user: '#7aa2f7',
    assistant: '#bb9af7',
    diffAdd: '#9ece6a',
    diffDel: '#f7768e',
    diffHunk: '#7dcfff',
  },
};

/** Light palette — for a light-background terminal. */
export const LIGHT_THEME: Theme = {
  name: 'light',
  color: {
    accent: '#2f5fd0',
    heading: '#1f4fbf',
    text: '#24292f',
    muted: '#57606a',
    faint: '#8c959f',
    success: '#1a7f37',
    error: '#cf222e',
    warn: '#9a6700',
    info: '#0969da',
    link: '#0969da',
    code: '#7a3e00',
    codeBorder: '#d0d7de',
    keyword: '#8250df',
    string: '#0a3069',
    number: '#953800',
    comment: '#6e7781',
    func: '#2f5fd0',
    type: '#116329',
    punct: '#57606a',
    border: '#d0d7de',
    user: '#0969da',
    assistant: '#8250df',
    diffAdd: '#1a7f37',
    diffDel: '#cf222e',
    diffHunk: '#0969da',
  },
};

export type ThemeName = 'dark' | 'light' | 'none';

/** Resolve the active theme from the environment (default: dark). */
export function resolveTheme(env: NodeJS.ProcessEnv = process.env): { name: ThemeName; theme: Theme } {
  const raw = (env.NUVIRA_THEME || '').trim().toLowerCase();
  if (raw === 'light') return { name: 'light', theme: LIGHT_THEME };
  if (raw === 'none' || raw === 'plain') return { name: 'none', theme: { ...DARK_THEME, name: 'none' } };
  return { name: 'dark', theme: DARK_THEME };
}
