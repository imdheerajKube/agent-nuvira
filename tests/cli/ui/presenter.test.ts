/**
 * Presenter tests — the contract that matters is the TTY/plain split and the
 * final-frame behaviour: streamed text must survive `finish()` as an archival
 * frame, and non-TTY output must stay plain.
 */

import { Writable } from 'node:stream';

import { describe, it, expect } from 'vitest';

import {
  AnswerStream,
  presentAnswer,
  renderAnswer,
  shouldUseRichUi,
} from '../../../src/cli/ui/presenter.js';

function makeStream(chunks: string[], tty = false): NodeJS.WriteStream {
  const stream = new Writable({
    write(chunk: unknown, _encoding: BufferEncoding, cb: () => void) {
      chunks.push(String(chunk));
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  Object.defineProperty(stream, 'isTTY', { value: tty, configurable: true });
  (stream as unknown as { columns: number }).columns = 80;
  return stream;
}

describe('shouldUseRichUi', () => {
  it('is off for a non-TTY stream (pipes, CI)', () => {
    expect(shouldUseRichUi({ stream: makeStream([]), env: {} })).toBe(false);
  });

  it('is on for a TTY', () => {
    expect(shouldUseRichUi({ stream: makeStream([], true), env: {} })).toBe(true);
  });

  it('is off when NUVIRA_UI=plain even on a TTY', () => {
    expect(shouldUseRichUi({ stream: makeStream([], true), env: { NUVIRA_UI: 'plain' } })).toBe(false);
  });
});

describe('presentAnswer', () => {
  it('passes markdown through byte-identically on a non-TTY stream', () => {
    const md = '# Hi\n\n- one\n\n```ts\nconst x = 1\n```';
    const chunks: string[] = [];
    presentAnswer(md, { stream: makeStream(chunks), env: {}, color: false });
    // Scripts/CI must see exactly what they saw before this layer existed.
    expect(chunks.join('')).toBe(md + '\n');
  });

  it('renders rich structure for a TTY stream', () => {
    const chunks: string[] = [];
    presentAnswer('```ts\nconst x = 1\n```', { stream: makeStream(chunks, true), env: {}, color: false });
    const out = chunks.join('');
    expect(out).toContain('┌');
    expect(out).toContain('const x = 1');
  });
});

describe('renderAnswer', () => {
  it('returns an empty string for empty input', () => {
    expect(renderAnswer('', { env: {}, color: false })).toBe('');
  });

  it('uses the plain path when rich UI is off', () => {
    expect(renderAnswer('# Hi', { env: {}, color: false })).toContain('Hi');
    expect(renderAnswer('# Hi', { env: {}, color: false })).not.toContain('▍');
  });
});

describe('AnswerStream', () => {
  it('does not mount Ink on a non-TTY stream', () => {
    const chunks: string[] = [];
    const s = new AnswerStream({ header: 'nuvira' }, { stream: makeStream(chunks), env: {} });
    s.begin();
    s.append('hello ');
    s.append('world');
    expect(s.current).toBe('hello world');
    const final = s.finish();
    expect(final).toContain('hello world');
    expect(chunks.join('')).toContain('hello world');
  });

  it('writes the archival frame on finish (rich path, no live mount)', () => {
    const chunks: string[] = [];
    const s = new AnswerStream({}, { stream: makeStream(chunks, true), env: {}, color: false });
    s.append('```ts\nconst x = 1\n```');
    const final = s.finish();
    expect(final).toContain('┌');
    expect(final).toContain('const x = 1');
    expect(chunks.join('')).toContain('┌');
  });

  it('is idempotent — finish() twice only writes once', () => {
    const chunks: string[] = [];
    const s = new AnswerStream({}, { stream: makeStream(chunks), env: {}, color: false });
    s.append('once');
    s.finish();
    const afterFirst = chunks.join('');
    s.finish();
    expect(chunks.join('')).toBe(afterFirst);
  });

  it('ignores empty deltas without dropping the answer', () => {
    const chunks: string[] = [];
    const s = new AnswerStream({}, { stream: makeStream(chunks), env: {}, color: false });
    s.append(undefined);
    s.append('kept');
    expect(s.finish()).toContain('kept');
  });

  it('writes a card into the transcript on a rich stream', () => {
    const chunks: string[] = [];
    const s = new AnswerStream({}, { stream: makeStream(chunks, true), tty: true, env: {}, color: false });
    s.card({ icon: '🔧', title: 'tool · read_file', role: 'info', lines: ['src/a.ts'] });
    const out = chunks.join('');
    expect(out).toContain('╭');
    expect(out).toContain('read_file');
    expect(out).toContain('src/a.ts');
  });

  it('does not write cards on a non-rich stream (byte parity)', () => {
    const chunks: string[] = [];
    const s = new AnswerStream({}, { stream: makeStream(chunks), env: {}, color: false });
    s.card({ icon: '🔧', title: 'tool · read_file' });
    expect(chunks.join('')).toBe('');
  });

  it('pause/resume preserve the accumulated text', () => {
    const chunks: string[] = [];
    const s = new AnswerStream({}, { stream: makeStream(chunks, true), tty: true, env: {}, color: false });
    s.append('half an answer');
    s.pause();
    expect(s.current).toBe('half an answer');
    s.resume();
    expect(s.current).toBe('half an answer');
    s.finish({ archive: false });
  });
});
