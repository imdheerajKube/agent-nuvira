/**
 * Card builders — one pure function per event family.
 *
 * Cards are how a turn SHOWS what it did instead of only saying it: a tool call,
 * a shell command and a git diff each become a bordered block the user can read
 * at a glance. Keeping the mapping pure (event → `CardOptions`) means the card
 * content is unit-testable without a terminal, and both surfaces — chat and
 * execute — render the SAME card for the same event, so they cannot drift.
 *
 * These functions only shape data; the rendering (borders, colour, width) lives
 * in `render.ts` / `answer-view.tsx`.
 */

import { EventNames, getEventBus, type EventBus, type EventRecord } from '../../observability/event-bus.js';
import type { CardLine, CardOptions } from './render.js';
import type { GitDiffPayload } from '../../tools/git-tool.js';

/** The tool-call lifecycle payload (mirrors chat.ts `ToolCallInfo`). */
export interface ToolCallCardInfo {
  id?: string;
  tool: string;
  ok?: boolean;
  error?: string;
  result?: string;
  durationMs?: number;
  args?: Record<string, unknown>;
}

/** The `exec:shell-end` payload emitted by `runShell` / `runShellSync`. */
export interface ShellEndPayload {
  command: string;
  cwd?: string;
  exitCode?: number;
  success?: boolean;
  timedOut?: boolean;
  aborted?: boolean;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
}

/** How many arguments to preview on a tool card before summarising the rest. */
const MAX_ARG_PREVIEWS = 3;
/** Bounds so a huge diff or argument list cannot flood the transcript. */
const MAX_DIFF_FILES = 4;
const MAX_DIFF_LINES_PER_FILE = 12;
const MAX_DETAIL_CHARS = 72;

/** Compact duration: `840ms`, `3.2s`, `1m 04s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m ${String(rest).padStart(2, '0')}s`;
}

/** One-line, bounded preview of a value — never the whole multi-line blob. */
function clip(text: string, max = MAX_DETAIL_CHARS): string {
  const first = text.replace(/\s+/g, ' ').trim();
  return first.length > max ? first.slice(0, max - 1) + '…' : first;
}

function previewArgs(args: Record<string, unknown> | undefined): CardLine[] {
  if (!args) return [];
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null);
  return entries.slice(0, MAX_ARG_PREVIEWS).map(([k, v]) => ({
    text: `${k}: ${clip(typeof v === 'string' ? v : JSON.stringify(v))}`,
    role: 'muted',
  }));
}

/**
 * A tool call. Rendered on COMPLETION (the `called` phase), because only then is
 * the outcome known — a card that says "running" and is immediately replaced by
 * an outcome is noise in a transcript.
 */
export function toolCallCard(info: ToolCallCardInfo): CardOptions {
  const ok = info.ok !== false;
  const lines: CardLine[] = [...previewArgs(info.args)];
  const detail = info.error || info.result;
  if (detail) lines.push({ text: clip(detail), role: ok ? 'muted' : 'error' });
  const ms = typeof info.durationMs === 'number' ? ` · ${formatDuration(info.durationMs)}` : '';
  return {
    icon: ok ? '🔧' : '⛔',
    title: `tool · ${info.tool}${ms}`,
    role: ok ? 'info' : 'error',
    lines,
  };
}

/** A finished shell command, with the failure reason when there is one. */
export function shellCard(payload: ShellEndPayload): CardOptions {
  const ok = payload.success ?? payload.exitCode === 0;
  const lines: CardLine[] = [{ text: `$ ${clip(payload.command, 100)}`, role: 'muted' }];
  if (!ok) {
    const why = (payload.stderr || payload.stdout || '').trim();
    if (why) lines.push({ text: clip(why), role: 'error' });
    else if (payload.timedOut) lines.push({ text: 'timed out', role: 'error' });
    else if (payload.aborted) lines.push({ text: 'aborted', role: 'error' });
  }
  const bits = [`exit ${payload.exitCode ?? (ok ? 0 : '?')}`];
  if (typeof payload.durationMs === 'number') bits.push(formatDuration(payload.durationMs));
  return {
    icon: ok ? '💻' : '💥',
    title: `shell · ${bits.join(' · ')}`,
    role: ok ? 'info' : 'error',
    lines,
  };
}

/** Colour role for one line of a unified diff. */
export function diffLineRole(line: string): CardLine['role'] {
  if (line.startsWith('@@')) return 'diffHunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'muted';
  if (line.startsWith('+')) return 'diffAdd';
  if (line.startsWith('-')) return 'diffDel';
  return 'muted';
}

/** A `git diff`, one block per changed file, lines coloured by kind. */
export function gitDiffCard(payload: GitDiffPayload): CardOptions {
  const lines: CardLine[] = [];
  for (const file of payload.files.slice(0, MAX_DIFF_FILES)) {
    lines.push({ text: file.path, role: 'accent' });
    const body = file.body.split('\n');
    for (const l of body.slice(0, MAX_DIFF_LINES_PER_FILE)) {
      lines.push({ text: `  ${l}`, role: diffLineRole(l) });
    }
    if (body.length > MAX_DIFF_LINES_PER_FILE) {
      lines.push({ text: `  … ${body.length - MAX_DIFF_LINES_PER_FILE} more line(s)`, role: 'faint' });
    }
  }
  const more = payload.files.length > MAX_DIFF_FILES ? ` (+${payload.files.length - MAX_DIFF_FILES} more file(s))` : '';
  return { icon: '📝', title: `git diff · ${payload.summary}${more}`, role: 'accent', lines };
}

/**
 * Subscribe to shell completion events for the duration of one turn.
 *
 * Shell is the one event family driven by the GLOBAL bus rather than a turn
 * callback: `runShell` emits it from deep inside `utils/shell.ts`, which no
 * surface owns. Returns the unsubscribe function the caller must invoke (the
 * turn's `stop()` does).
 */
export function attachShellCards(onCard: (card: CardOptions) => void, bus?: EventBus): () => void {
  try {
    const source = bus ?? getEventBus();
    return source.on(EventNames.EXEC_SHELL_END, (record: EventRecord) => {
      try {
        onCard(shellCard(record.data as ShellEndPayload));
      } catch {
        // A card must never break the turn.
      }
    });
  } catch {
    return () => {};
  }
}
