/**
 * Ink view — the LIVE rendering of a streaming answer.
 *
 * WHY INK (and not just ANSI writes). While tokens arrive, the frame changes
 * every few dozen milliseconds. Writing raw ANSI for each update would fight the
 * terminal's own scrollback and duplicates the layout logic. Ink owns the
 * frame: it diffs and repaints in place, and gives real layout (flexbox) and
 * per-run styling — the same toolkit the pipeline board already uses.
 *
 * THE IMPORTANT CONTRACT. Ink's frame is TRANSIENT. When the answer is complete
 * the presenter unmounts this view and writes the final frame with the ANSI
 * renderer (`render.ts`), so the finished answer stays in the transcript. This
 * view therefore only needs to look right while streaming; it is not the
 * archival output.
 *
 * Both surfaces consume the SAME `Block[]` from `markdown.ts`, so the live view
 * and the final frame cannot disagree about structure.
 */

import type { ReactElement } from 'react';
import { Box, Text } from 'ink';

import { parseMarkdown, inlineText, type Block, type Inline, type ListItem } from './markdown.js';
import type { Theme, ThemeRole } from './theme.js';
import type { TokenKind } from './highlight.js';

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

function colorOf(theme: Theme, role: ThemeRole): string {
  return theme.color[role];
}

/** Render inline runs as nested Ink `<Text>` runs. */
function InlineRuns({ inlines, theme, dim }: { inlines: readonly Inline[]; theme: Theme; dim?: boolean }): ReactElement {
  return (
    <Text color={colorOf(theme, dim ? 'muted' : 'text')}>
      {inlines.map((inl, i) => {
        switch (inl.kind) {
          case 'text':
            return <Text key={i}>{inl.text}</Text>;
          case 'code':
            return (
              <Text key={i} color={colorOf(theme, 'code')}>
                {inl.text}
              </Text>
            );
          case 'strong':
            return (
              <Text key={i} bold>
                <InlineRuns inlines={inl.children} theme={theme} dim={dim} />
              </Text>
            );
          case 'em':
            return (
              <Text key={i} italic>
                <InlineRuns inlines={inl.children} theme={theme} dim={dim} />
              </Text>
            );
          case 'link':
            return (
              <Text key={i} color={colorOf(theme, 'link')} underline>
                {inl.text}
              </Text>
            );
        }
      })}
    </Text>
  );
}

function CodeBlock({ block, theme }: { block: Extract<Block, { type: 'code' }>; theme: Theme }): ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={colorOf(theme, 'codeBorder')} flexDirection="column" paddingX={1}>
        {block.lang ? (
          <Text color={colorOf(theme, 'accent')} dimColor>
            {block.lang}
          </Text>
        ) : null}
        {block.tokens.length === 0 ? <Text> </Text> : null}
        {block.tokens.map((line, i) => (
          <Text key={i}>
            {line.length === 0 ? ' ' : line.map((t, k) => (
              <Text key={k} color={colorOf(theme, TOKEN_ROLE[t.kind])}>
                {t.text}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function ListBlock({ block, theme }: { block: Extract<Block, { type: 'list' }>; theme: Theme }): ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {block.items.map((item: ListItem, i) => (
        <Box key={i} paddingLeft={item.depth * 2}>
          <Text color={colorOf(theme, 'accent')}>{item.ordered ? `${item.index || block.start + i}. ` : '• '}</Text>
          <InlineRuns inlines={item.inlines} theme={theme} />
        </Box>
      ))}
    </Box>
  );
}

/** One block of the answer. */
function BlockView({ block, theme }: { block: Block; theme: Theme }): ReactElement | null {
  switch (block.type) {
    case 'heading': {
      const bar = block.level === 1 ? '▍ ' : block.level === 2 ? '▎ ' : '';
      return (
        <Box marginTop={1} marginBottom={block.level <= 2 ? 0 : 0}>
          <Text bold color={colorOf(theme, 'heading')}>
            {bar}
          </Text>
          <Text bold color={colorOf(theme, 'heading')}>
            <InlineRuns inlines={block.inlines} theme={theme} />
          </Text>
        </Box>
      );
    }
    case 'paragraph':
      return (
        <Box marginBottom={1}>
          <InlineRuns inlines={block.inlines} theme={theme} />
        </Box>
      );
    case 'code':
      return <CodeBlock block={block} theme={theme} />;
    case 'list':
      return <ListBlock block={block} theme={theme} />;
    case 'quote':
      return (
        <Box flexDirection="column" marginBottom={1}>
          {block.blocks.map((b, i) => (
            <Box key={i}>
              <Text color={colorOf(theme, 'muted')}>▏ </Text>
              <BlockView block={b} theme={theme} />
            </Box>
          ))}
        </Box>
      );
    case 'table':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={colorOf(theme, 'heading')}>
            {block.header.map((c) => inlineText(c)).join('  │  ')}
          </Text>
          {block.rows.map((row, i) => (
            <Text key={i} color={colorOf(theme, 'text')}>
              {row.map((c) => inlineText(c)).join('  │  ')}
            </Text>
          ))}
        </Box>
      );
    case 'hr':
      return (
        <Box marginBottom={1}>
          <Text color={colorOf(theme, 'faint')}>{'─'.repeat(24)}</Text>
        </Box>
      );
  }
  return null;
}

export interface LiveAnswerProps {
  /** The answer markdown accumulated so far. */
  text: string;
  theme: Theme;
  /** Optional header line: agent · model · elapsed. */
  header?: string;
  headerColor?: ThemeRole;
  /** True once the model has finished and the final frame is imminent. */
  done?: boolean;
  /** Inline note under the header (e.g. "thinking…"). */
  note?: string;
}

/**
 * The live streaming view: a header line plus the markdown parsed so far.
 * Exported for tests (rendered via ink-testing-library).
 */
export function LiveAnswer({ text, theme, header, headerColor = 'assistant', done, note }: LiveAnswerProps): ReactElement {
  const blocks = text.trim() ? parseMarkdown(text) : [];
  return (
    <Box flexDirection="column">
      {header ? (
        <Box marginBottom={0}>
          <Text color={colorOf(theme, headerColor)}>{done ? '✔ ' : '◆ '}</Text>
          <Text color={colorOf(theme, headerColor)} bold>
            {header}
          </Text>
          {note ? <Text color={colorOf(theme, 'muted')}>  {note}</Text> : null}
        </Box>
      ) : null}
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} theme={theme} />
      ))}
      {!done && text.trim() ? <Text color={colorOf(theme, 'faint')}>▌</Text> : null}
    </Box>
  );
}
