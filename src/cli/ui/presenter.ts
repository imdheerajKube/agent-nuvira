/**
 * Presenter — decides HOW a model answer reaches the terminal, and owns the
 * streaming lifecycle.
 *
 * THE ONE RULE: rich rendering is a TTY-only affordance. Pipes, CI, `--json-events`
 * and `NUVIRA_UI=plain` all keep the historical plain-text behaviour, so a
 * script consuming stdout is never handed escape codes or reflowed borders.
 * That mirrors the fallback `PipelineBoard` already implements for its board.
 *
 * STREAMING. `AnswerStream` mounts Ink while tokens arrive. Ink's frame is
 * transient, so `finish()` UNMOUNTS Ink and writes the final frame with the ANSI
 * renderer — the same "unmount then write the final frame" step the board uses.
 * The answer therefore survives in the transcript instead of being erased.
 */

import { createElement } from 'react';
import { render, type Instance } from 'ink';

import { renderMarkdown, renderCard, type CardOptions } from './render.js';
import { attachShellCards, gitDiffCard, toolCallCard, type ToolCallCardInfo } from './cards.js';
import { resolveTheme, type Theme, type ThemeName, type ThemeRole } from './theme.js';
import type { GitDiffPayload } from '../../tools/git-tool.js';
import { LiveAnswer } from './answer-view.js';
import { isJsonLogMode } from '../../enterprise/log.js';

export interface PresenterOptions {
  stream?: NodeJS.WriteStream;
  /** Force rich/plain instead of probing the stream. */
  tty?: boolean;
  theme?: Theme;
  width?: number;
  color?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** True when the rich presentation layer may be used for this stream. */
export function shouldUseRichUi(opts: PresenterOptions = {}): boolean {
  const env = opts.env ?? process.env;
  if (isJsonLogMode()) return false;
  const mode = (env.NUVIRA_UI || '').trim().toLowerCase();
  if (mode === 'plain' || mode === 'text' || mode === 'off') return false;
  if (opts.tty !== undefined) return opts.tty;
  const stream = opts.stream ?? process.stdout;
  return stream.isTTY === true;
}

interface Resolved {
  rich: boolean;
  theme: Theme;
  themeName: ThemeName;
  width: number;
  color: boolean;
  stream: NodeJS.WriteStream;
}

function resolve(opts: PresenterOptions): Resolved {
  const env = opts.env ?? process.env;
  const stream = opts.stream ?? process.stdout;
  const { name, theme } = resolveTheme(env);
  const width = opts.width ?? stream.columns ?? 80;
  const rich = shouldUseRichUi(opts);
  const color = opts.color ?? (name !== 'none' && !('NO_COLOR' in env));
  return { rich, theme: opts.theme ?? theme, themeName: name, width, color, stream };
}

/**
 * Render a complete markdown answer to the string that would be printed.
 *
 * The non-rich path is a BYTE-IDENTICAL passthrough: a piped or CI consumer
 * must receive exactly what it received before this layer existed, so the
 * markdown is never rewritten on the way out.
 */
export function renderAnswer(markdown: string, opts: PresenterOptions = {}): string {
  if (!markdown) return '';
  const r = resolve(opts);
  if (!r.rich) return markdown;
  return renderMarkdown(markdown, { theme: r.theme, width: r.width, color: r.color });
}

/**
 * Print a complete answer. Returns the written string so callers (and tests)
 * can assert on exactly what a surface produced.
 *
 * The non-rich path deliberately goes through `console.log` when no stream was
 * injected: that is the channel this CLI has always used for answers, and both
 * the test suite and any log-capturing wrapper depend on it. Rich output is
 * written straight to the stream because it is a composed frame, not a line.
 */
export function presentAnswer(markdown: string, opts: PresenterOptions = {}): string {
  if (!markdown) return '';
  const r = resolve(opts);
  if (!r.rich) {
    if (opts.stream) r.stream.write(markdown + (markdown.endsWith('\n') ? '' : '\n'));
    else console.log(markdown);
    return markdown;
  }
  const out = renderMarkdown(markdown, { theme: r.theme, width: r.width, color: r.color });
  r.stream.write(out + (out.endsWith('\n') ? '' : '\n'));
  return out;
}

/** Print a structured card (tool call, shell, diff, plan). */
export function presentCard(card: CardOptions, opts: PresenterOptions = {}): string {
  const r = resolve(opts);
  const out = renderCard(card, { theme: r.theme, width: r.width, color: r.color });
  r.stream.write(out + '\n');
  return out;
}

/** The turn options a card sink supplies (shape-compatible with the chat and
 *  loop-executor `onToolCall` / `onGitDiff` seams). */
export interface CardSinkOverrides {
  onToolCall?: (phase: 'started' | 'called', info: ToolCallCardInfo) => void;
  onGitDiff?: (payload: GitDiffPayload) => void;
}

/**
 * A card sink for a surface with NO live Ink frame (the `execute` loop arm).
 *
 * Cards are written straight to the transcript as they arrive — no pause/resume
 * is needed because nothing else owns the terminal. The finished tool call is
 * the one that gets a card; `started` is ignored because the outcome is what a
 * reader needs and a card that is replaced a moment later is noise.
 *
 * Off a real terminal this is INERT (no overrides, nothing written), so a piped
 * or CI `execute` keeps the exact bytes it produced before cards existed.
 */
export function createCardSink(opts: PresenterOptions = {}): { overrides: CardSinkOverrides; stop: () => void } {
  if (!shouldUseRichUi(opts)) return { overrides: {}, stop: () => {} };
  const write = (card: CardOptions): void => {
    presentCard(card, opts);
  };
  return {
    overrides: {
      onToolCall: (phase, info) => {
        if (phase === 'called') write(toolCallCard(info));
      },
      onGitDiff: (payload) => write(gitDiffCard(payload)),
    },
    stop: attachShellCards(write),
  };
}

export interface StreamMeta {
  header?: string;
  headerColor?: ThemeRole;
  note?: string;
}

/**
 * Live-streaming answer view.
 *
 * Usage:
 *   const stream = new AnswerStream({ header: 'nuvira · groq/llama-3.3-70b' });
 *   stream.begin();
 *   // ... onToken: (t) => stream.append(t) ...
 *   const final = stream.finish();
 */
export class AnswerStream {
  private readonly r: Resolved;
  private text = '';
  private meta: StreamMeta;
  private ink: Instance | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private pending = false;
  private closed = false;

  constructor(meta: StreamMeta = {}, opts: PresenterOptions = {}) {
    this.r = resolve(opts);
    this.meta = meta;
  }

  /** Begin the live view (mounts Ink on a TTY; a no-op otherwise). */
  begin(meta: StreamMeta = {}): this {
    this.meta = { ...this.meta, ...meta };
    if (this.r.rich) this.mount();
    return this;
  }

  /** Append streamed text. Safe to call with empty/undefined deltas. */
  append(delta: string | undefined): this {
    if (delta) this.text += delta;
    this.scheduleFlush();
    return this;
  }

  /** Replace the inline note (e.g. "thinking…" → "writing…"). */
  setNote(note: string | undefined): this {
    this.meta = { ...this.meta, note };
    this.scheduleFlush();
    return this;
  }

  /**
   * Discard the text accumulated so far.
   *
   * Needed because `onToken` fires for EVERY model call in the tool loop, not
   * only the final answer: without this, the next step's answer would be
   * appended onto the previous step's preamble.
   */
  reset(): this {
    this.text = '';
    this.scheduleFlush();
    return this;
  }

  /** The text accumulated so far. */
  get current(): string {
    return this.text;
  }

  /**
   * Suspend the live view so static output can be written below it.
   *
   * Ink owns the frame, so anything printed while it is mounted collides with
   * the next repaint. Cards are archived output (they must survive), so the
   * frame is unmounted, the card written, then the frame remounted — the same
   * stop/start discipline `PipelineBoard` uses around interactive prompts.
   */
  pause(): this {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.pending = false;
    }
    if (this.ink) {
      try {
        this.ink.unmount();
      } catch {
        /* best-effort */
      }
      this.ink = null;
    }
    return this;
  }

  /** Remount the live view after {@link pause} (no-op when nothing was mounted). */
  resume(): this {
    if (!this.r.rich || this.closed) return this;
    this.mount();
    this.repaint();
    return this;
  }

  /**
   * Print a card into the transcript, above the live view.
   *
   * Rich terminals only: a piped or CI stream keeps the exact bytes it produced
   * before cards existed, which is also why the card is not attempted at all
   * when rich output is unavailable.
   */
  card(card: CardOptions): void {
    if (!this.r.rich) return;
    const wasMounted = this.ink !== null;
    if (wasMounted) this.pause();
    const out = renderCard(card, { theme: this.r.theme, width: this.r.width, color: this.r.color });
    this.r.stream.write(out + '\n');
    if (wasMounted) this.resume();
  }

  private mount(): void {
    try {
      this.ink = render(this.element(), {
        stdout: this.r.stream,
        patchConsole: false,
        // The CLI owns SIGINT (the REPL installs its own handler); letting Ink
        // also grab Ctrl+C would race that handler and can exit the process.
        exitOnCtrlC: false,
      });
    } catch {
      // Rendering must never break a turn — fall back to no live view.
      this.ink = null;
    }
  }

  private element(note?: string): ReturnType<typeof createElement> {
    return createElement(LiveAnswer, {
      text: this.text,
      theme: this.r.theme,
      header: this.meta.header,
      headerColor: this.meta.headerColor,
      note: note ?? this.meta.note,
    });
  }

  /** Coalesce high-frequency token updates into ~20fps repaints. */
  private scheduleFlush(): void {
    if (!this.ink || this.closed) return;
    if (this.pending) return;
    this.pending = true;
    this.flushTimer = setTimeout(() => {
      this.pending = false;
      this.flushTimer = null;
      this.repaint();
    }, 50);
    this.flushTimer.unref?.();
  }

  private repaint(): void {
    if (!this.ink) return;
    try {
      this.ink.rerender(this.element());
    } catch {
      /* a repaint failure must not break the stream */
    }
  }

  /**
   * Finish the stream: unmount the transient Ink frame, then write the final
   * archival frame. Returns the final rendered string.
   *
   * `archive: false` unmounts WITHOUT printing a frame. A caller that will
   * print the authoritative answer itself (the REPL, which renders the final
   * `answer.content` rather than the raw token stream) must use it, or the
   * answer would be printed twice.
   */
  finish(opts: { archive?: boolean } = {}): string {
    const archive = opts.archive ?? true;
    if (this.closed) return '';
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.ink) {
      try {
        this.ink.unmount();
      } catch {
        /* best-effort */
      }
      this.ink = null;
    }
    if (!archive) return '';
    // The final frame is the archival output and is always printed. Non-rich
    // streams get the raw markdown, byte-identical to the pre-layer behaviour.
    const out = this.r.rich
      ? renderMarkdown(this.text, { theme: this.r.theme, width: this.r.width, color: this.r.color })
      : this.text;
    if (out) this.r.stream.write(out + (out.endsWith('\n') ? '' : '\n'));
    return out;
  }
}
