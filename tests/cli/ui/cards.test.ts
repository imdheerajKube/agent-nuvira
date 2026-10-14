/**
 * Card builder tests — pure event → card mapping.
 *
 * These are the contract for what a user SEES when a turn runs a tool, a shell
 * command or a git diff, asserted without a terminal (icon, title, body, role).
 */

import { Writable } from 'node:stream';

import { describe, it, expect, vi } from 'vitest';

import {
  attachShellCards,
  diffLineRole,
  formatDuration,
  gitDiffCard,
  shellCard,
  toolCallCard,
} from '../../../src/cli/ui/cards.js';
import { EventBus, EventNames, getEventBus } from '../../../src/observability/event-bus.js';
import { createCardSink } from '../../../src/cli/ui/presenter.js';

/** A fake terminal stream that records writes and reports itself as a TTY. */
function makeTtyStream(chunks: string[]): NodeJS.WriteStream {
  const stream = new Writable({
    write(chunk: unknown, _encoding: BufferEncoding, cb: () => void) {
      chunks.push(String(chunk));
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  (stream as unknown as { columns: number }).columns = 80;
  return stream;
}

describe('formatDuration', () => {
  it('formats milliseconds, seconds and minutes', () => {
    expect(formatDuration(840)).toBe('840ms');
    expect(formatDuration(3210)).toBe('3.2s');
    expect(formatDuration(64_000)).toBe('1m 04s');
  });

  it('never throws on nonsense', () => {
    expect(formatDuration(Number.NaN)).toBe('?');
    expect(formatDuration(-5)).toBe('?');
  });
});

describe('toolCallCard', () => {
  it('uses a success icon/role and previews arguments', () => {
    const card = toolCallCard({ tool: 'read_file', ok: true, args: { path: 'src/a.ts' }, result: 'ok', durationMs: 12 });
    expect(card.icon).toBe('🔧');
    expect(card.role).toBe('info');
    expect(card.title).toContain('read_file');
    expect(card.title).toContain('12ms');
    const lines = (card.lines ?? []).map((l) => (typeof l === 'string' ? l : `${l.role}:${l.text}`));
    expect(lines).toContain('muted:path: src/a.ts');
  });

  it('uses a failure icon and colours the error', () => {
    const card = toolCallCard({ tool: 'run_terminal', ok: false, error: 'exit 1 — boom' });
    expect(card.icon).toBe('⛔');
    expect(card.role).toBe('error');
    const errLine = (card.lines ?? []).find((l) => typeof l !== 'string' && l.role === 'error');
    expect(errLine).toMatchObject({ text: 'exit 1 — boom' });
  });

  it('truncates a huge detail and caps the argument preview', () => {
    const card = toolCallCard({
      tool: 'write_file',
      ok: true,
      args: { a: '1', b: '2', c: '3', d: '4', e: '5' },
      result: 'x'.repeat(500),
    });
    const lines = card.lines ?? [];
    // At most MAX_ARG_PREVIEWS args, plus one detail line.
    expect(lines.length).toBeLessThanOrEqual(4);
    const last = lines[lines.length - 1] as { text: string };
    expect(last.text.length).toBeLessThanOrEqual(72);
    expect(last.text.endsWith('…')).toBe(true);
  });
});

describe('shellCard', () => {
  it('reports a successful command with its exit code and duration', () => {
    const card = shellCard({ command: 'npm run build', exitCode: 0, success: true, durationMs: 3210 });
    expect(card.icon).toBe('💻');
    expect(card.role).toBe('info');
    expect(card.title).toContain('exit 0');
    expect(card.title).toContain('3.2s');
  });

  it('surfaces the failure reason from stderr', () => {
    const card = shellCard({ command: 'npm test', exitCode: 1, success: false, stderr: 'FAIL 1 test' });
    expect(card.icon).toBe('💥');
    expect(card.role).toBe('error');
    const errLine = (card.lines ?? []).find((l) => typeof l !== 'string' && l.role === 'error');
    expect(errLine).toMatchObject({ text: 'FAIL 1 test' });
  });

  it('says "timed out" when there is no output but the command timed out', () => {
    const card = shellCard({ command: 'sleep 999', exitCode: 1, success: false, timedOut: true });
    expect(card.lines?.some((l) => typeof l !== 'string' && l.text === 'timed out')).toBe(true);
  });
});

describe('gitDiffCard', () => {
  it('maps line prefixes to diff roles', () => {
    expect(diffLineRole('+added')).toBe('diffAdd');
    expect(diffLineRole('-removed')).toBe('diffDel');
    expect(diffLineRole('@@ -1 +1 @@')).toBe('diffHunk');
    expect(diffLineRole('+++ b/file')).toBe('muted');
    expect(diffLineRole('--- a/file')).toBe('muted');
    expect(diffLineRole(' context')).toBe('muted');
  });

  it('renders each file with coloured lines and bounds the output', () => {
    const card = gitDiffCard({
      summary: '2 files changed',
      files: [
        { path: 'a.ts', body: '+one\n-two' },
        { path: 'b.ts', body: '@@ hunk @@' },
      ],
    });
    expect(card.icon).toBe('📝');
    expect(card.title).toContain('2 files changed');
    const lines = (card.lines ?? []) as Array<{ text: string; role?: string }>;
    expect(lines.find((l) => l.text === 'a.ts')).toBeDefined();
    expect(lines.find((l) => l.role === 'diffAdd')?.text).toBe('  +one');
    expect(lines.find((l) => l.role === 'diffDel')?.text).toBe('  -two');
    expect(lines.find((l) => l.role === 'diffHunk')?.text).toBe('  @@ hunk @@');
  });

  it('caps files and lines with an explicit remainder note', () => {
    const files = Array.from({ length: 7 }, (_, i) => ({
      path: `f${i}.ts`,
      body: Array.from({ length: 30 }, (_, j) => `+line ${j}`).join('\n'),
    }));
    const card = gitDiffCard({ summary: '7 files changed', files });
    const text = (card.lines ?? []).map((l) => (typeof l === 'string' ? l : l.text)).join('\n');
    expect(card.title).toContain('+3 more file(s)');
    expect(text).toContain('more line(s)');
    // 4 files × (1 path + 12 lines + 1 remainder) = 56 maximum.
    expect((card.lines ?? []).length).toBeLessThanOrEqual(60);
  });
});

describe('attachShellCards', () => {
  it('forwards a completed shell command as a card and unsubscribes cleanly', () => {
    const bus = new EventBus();
    const received: Array<{ title: string }> = [];
    const detach = attachShellCards((card) => received.push({ title: card.title }), bus);

    bus.emit(EventNames.EXEC_SHELL_END, { command: 'ls', exitCode: 0, success: true, durationMs: 5 }, 'shell');
    expect(received).toHaveLength(1);
    expect(received[0].title).toContain('shell');

    detach();
    bus.emit(EventNames.EXEC_SHELL_END, { command: 'ls', exitCode: 0, success: true }, 'shell');
    expect(received).toHaveLength(1);
  });

  it('never lets a broken card sink break the loop', () => {
    const bus = new EventBus();
    const onCard = vi.fn(() => {
      throw new Error('boom');
    });
    const detach = attachShellCards(onCard, bus);
    expect(() =>
      bus.emit(EventNames.EXEC_SHELL_END, { command: 'ls', exitCode: 0, success: true }, 'shell'),
    ).not.toThrow();
    expect(onCard).toHaveBeenCalledTimes(1);
    detach();
  });
});

describe('createCardSink (the sink `execute` hands the loop)', () => {
  it('is inert off a real terminal', () => {
    const chunks: string[] = [];
    const sink = createCardSink({ stream: makeTtyStream(chunks), tty: false, env: {}, color: false });
    expect(sink.overrides).toEqual({});
    expect(() => sink.stop()).not.toThrow();
    sink.overrides.onToolCall?.('called', { tool: 'read_file', ok: true });
    expect(chunks.join('')).toBe('');
  });

  it('renders a completed tool call and refuses to card the started phase', () => {
    const chunks: string[] = [];
    const sink = createCardSink({ stream: makeTtyStream(chunks), tty: true, env: {}, color: false });

    sink.overrides.onToolCall?.('started', { tool: 'read_file', args: { path: 'a.ts' } });
    expect(chunks.join('')).toBe('');

    sink.overrides.onToolCall?.('called', { tool: 'read_file', ok: true, result: 'ok', durationMs: 7 });
    expect(chunks.join('')).toContain('╭');
    expect(chunks.join('')).toContain('read_file');
  });

  it('renders a git diff card', () => {
    const chunks: string[] = [];
    const sink = createCardSink({ stream: makeTtyStream(chunks), tty: true, env: {}, color: false });
    sink.overrides.onGitDiff?.({ summary: '1 file changed', files: [{ path: 'a.ts', body: '+x' }] });
    expect(chunks.join('')).toContain('git diff · 1 file changed');
  });

  it('renders shell cards from the turn and detaches on stop', () => {
    const chunks: string[] = [];
    const sink = createCardSink({ stream: makeTtyStream(chunks), tty: true, env: {}, color: false });

    getEventBus().emit(EventNames.EXEC_SHELL_END, { command: 'npm test', exitCode: 0, success: true, durationMs: 900 }, 'shell');
    expect(chunks.join('')).toContain('shell · exit 0');

    sink.stop();
    const settled = chunks.join('').length;
    getEventBus().emit(EventNames.EXEC_SHELL_END, { command: 'late', exitCode: 0, success: true }, 'shell');
    expect(chunks.join('').length).toBe(settled);
  });
});
