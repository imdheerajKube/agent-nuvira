/**
 * Presenter tests — the contract that matters is the TTY/plain split and the
 * final-frame behaviour: streamed text must survive `finish()` as an archival
 * frame, and non-TTY output must stay plain.
 */

import { Writable } from 'node:stream';

import { describe, it, expect } from 'vitest';

import {
  AnswerStream,
  createRunStream,
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

  /**
   * A terminal that does not KNOW its size reports `columns` as 0 (or leaves it
   * undefined). `?? 80` only catches the undefined half, so a 0 reached the
   * renderer's 20-column floor: measured on a PTY with no window size, a code box
   * came out 14 columns wide with its lines cut mid-token ("const cap = 20 / 0;").
   */
  it('falls back to 80 columns when the stream reports no width', () => {
    const md = '```ts\nconst cap = 200;\nif (burst > cap) await throttle();\n```';

    const zeroChunks: string[] = [];
    const zeroWidth = makeStream(zeroChunks, true);
    (zeroWidth as unknown as { columns: number }).columns = 0;
    presentAnswer(md, { stream: zeroWidth, env: {}, color: false });
    const zeroOut = zeroChunks.join('');

    const unsetChunks: string[] = [];
    const unsetWidth = makeStream(unsetChunks, true);
    delete (unsetWidth as unknown as { columns?: number }).columns;
    presentAnswer(md, { stream: unsetWidth, env: {}, color: false });
    const unsetOut = unsetChunks.join('');

    const wideChunks: string[] = [];
    presentAnswer(md, { stream: makeStream(wideChunks, true), env: {}, color: false });
    const wideOut = wideChunks.join('');

    // Same rendering as an 80-column terminal — not the 20-column floor.
    expect(zeroOut).toBe(wideOut);
    expect(unsetOut).toBe(wideOut);
    expect(zeroOut).toContain('if (burst > cap) await throttle();');
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

/**
 * The LIVE EXECUTION view (`nuvira execute` / `nuvira chat` on a terminal).
 *
 * The contract that matters: off a terminal it is INERT (a piped or CI run keeps
 * its exact bytes), and on one the FINAL answer is written exactly ONCE — the
 * live frame is a preview of a stream the engine may discard.
 */
describe('createRunStream', () => {
  it('is inert off a terminal — no seams, and the plain answer is untouched', () => {
    const chunks: string[] = [];
    const run = createRunStream({ header: 'nuvira · execute' }, { stream: makeStream(chunks), env: {}, color: false });

    // No seams at all: a caller spreads `overrides` into the engine, so absent
    // keys mean the engine takes its normal path (unchanged logger output).
    expect(Object.keys(run.overrides)).toEqual([]);

    run.start();
    run.commit('The limiter is fixed.');
    run.stop();

    expect(chunks.join('')).toBe('The limiter is fixed.\n');
  });

  it('offers the live seams on a TTY (token stream, tool cards, progress note)', () => {
    const run = createRunStream({ header: 'nuvira · execute' }, { stream: makeStream([], true), env: {}, color: false });
    expect(typeof run.overrides.onToken).toBe('function');
    expect(typeof run.overrides.onToolCall).toBe('function');
    expect(typeof run.overrides.onGitDiff).toBe('function');
    expect(typeof run.overrides.onProgress).toBe('function');
  });

  it('prints the FINAL answer once, even after tokens streamed', () => {
    const chunks: string[] = [];
    const run = createRunStream({ header: 'nuvira · execute' }, { stream: makeStream(chunks, true), env: {}, color: false });

    // A streamed PREVIEW (what the model was writing) that the engine then
    // rejects/replaces — the classic reason the frame must not be archived.
    run.overrides.onToken?.('half-written preamble the engine discarded');
    run.commit('# Limiter fixed\n\nBurst cap is now **200**.');

    const out = chunks.join('');
    expect(out).toContain('Limiter fixed');
    expect(out).toContain('200');
    // The preview is NOT archived, and the answer is not written twice.
    expect(out).not.toContain('half-written preamble the engine discarded');
    expect(out.split('Limiter fixed').length - 1).toBe(1);
  });

  it('stop() is idempotent (a caller stops on the failure path AND in a finally)', () => {
    const run = createRunStream({}, { stream: makeStream([], true), env: {}, color: false });
    run.start();
    expect(() => {
      run.stop();
      run.stop();
    }).not.toThrow();
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
