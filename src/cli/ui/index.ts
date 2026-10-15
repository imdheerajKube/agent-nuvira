/**
 * CLI presentation layer — markdown, syntax highlighting, cards and streaming.
 *
 * Consumers import from here, never from the individual modules, so the internal
 * split (parser → renderers → presenter) can change without touching call sites.
 */

export { DARK_THEME, LIGHT_THEME, resolveTheme } from './theme.js';
export type { Theme, ThemeRole, ThemeName } from './theme.js';

export { highlightCode, normalizeLang } from './highlight.js';
export type { Token, TokenKind, TokenizedCode } from './highlight.js';

export { parseMarkdown, parseInline, inlineText, blocksToPlainText } from './markdown.js';
export type { Block, Inline, Align, ListItem } from './markdown.js';

export { renderMarkdown, renderBlocks, renderCard, visibleWidth } from './render.js';
export type { RenderOptions, CardOptions, CardLine } from './render.js';

export {
  attachShellCards,
  diffLineRole,
  formatDuration,
  gitDiffCard,
  shellCard,
  toolCallCard,
} from './cards.js';
export type { ShellEndPayload, ToolCallCardInfo } from './cards.js';

export { LiveAnswer } from './answer-view.js';
export type { LiveAnswerProps } from './answer-view.js';

export {
  AnswerStream,
  createCardSink,
  createRunStream,
  presentAnswer,
  presentCard,
  renderAnswer,
  shouldUseRichUi,
  THINKING_NOTE,
} from './presenter.js';
export type {
  CardSinkOverrides,
  PresenterOptions,
  RunStream,
  RunStreamOverrides,
  StreamMeta,
} from './presenter.js';
