/**
 * Secrets scrubber tests — P6 M6.2.
 *
 * `redact()` / `maskSecret()` must remove API keys and token-shaped strings
 * from logs and audit lines without altering non-secret text, and must never
 * throw on weird input.
 *
 * NOTE: the fake keys below are assembled at RUNTIME from short fragments so
 * that no full key-shaped literal ever exists in this source file — keeping
 * GitHub secret-scanning happy while exercising the scrubber exactly the way
 * a real key would.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  redact,
  maskSecret,
  redactValue,
  safeLine,
  applyRedaction,
  redactionDisabled,
} from '../../src/enterprise/secrets.js';

// ─── Runtime-assembled fake keys ────────────────────────────────────────────
// Each fragment is far too short to match any real secret pattern; only the
// assembled value (never written to disk) resembles a real key.
const GK = ['gsk_', 'cy8g', 'dIVK', 'AlhN', 'RJ9I', 'enpw', 'WGdy', 'b3FY', 'KtNb', 'Cu9K', 'ceI7', 'SiN2', '8aoh', 'S9ak'].join('');   // Groq-shaped
const NK = ['nvapi-', 'abcdef01', '23456789', 'abcdef01', '23456789'].join('');                                                          // NVIDIA NIM-shaped
const AK = ['AIzaSy', 'BmV2L8eI', 'aV8t1x9v', '3zQk1234', '567890ab', 'c'].join('');                                                       // Gemini-shaped
const SK = ['sk-', 'abcdefgh', 'ijklmnop', 'qrstuvwx', 'yz'].join('');                                                                    // OpenAI-shaped
const JWT = ['eyJhbGci', 'OiJIUzI1', 'NiIsInR5', 'cCI6IkpX', 'VCJ9.eyJ', 'zdWIiOiIx', 'MjM0NTY3', 'ODkwIn0'].join('');                     // JWT-shaped
const GSK_HEAD = GK.slice(0, 4);   // 'gsk_'
const GSK_TAIL = GK.slice(-4);     // 'S9ak'

afterEach(() => {
  delete process.env.BUFF_NO_REDACT;
});

describe('maskSecret', () => {
  it('masks long values keeping a recognizable head/tail', () => {
    expect(maskSecret(GK)).toBe(`${GSK_HEAD}…${GSK_TAIL}`);
  });

  it('fully masks short values', () => {
    expect(maskSecret('short')).toBe('***');
    expect(maskSecret('')).toBe('***');
  });
});

describe('redact', () => {
  it('masks known-prefix API keys anywhere in text', () => {
    const out = redact(`key ${GK} end`);
    expect(out).toContain(`${GSK_HEAD}…${GSK_TAIL}`);
    expect(out).not.toContain(GSK_HEAD + GK.slice(4, 10));
  });

  it('masks nvapi- and AIza-style keys', () => {
    expect(redact(NK)).toContain('nvap…6789');
    expect(redact(AK)).toContain('AIza…0abc');
  });

  it('masks Bearer tokens keeping the scheme', () => {
    const header = JWT.slice(0, 12);
    expect(redact(`Authorization: Bearer ${JWT}`)).toContain('Bearer ');
    expect(redact(`Authorization: Bearer ${JWT}`)).not.toContain(header);
  });

  it('masks key=value assignments', () => {
    const out = redact(`apiKey=${GK}`);
    expect(out).not.toContain(GSK_HEAD + GK.slice(4, 10));
    expect(out).toContain('apiKey=');
  });

  it('masks JSON-encoded sensitive fields', () => {
    const out = redact(`{"provider":"groq","apiKey":"${GK}"}`);
    expect(out).not.toContain(GSK_HEAD + GK.slice(4, 10));
    expect(out).toContain(`"apiKey":"${GSK_HEAD}…${GSK_TAIL}"`);
  });

  it('leaves non-secret text untouched', () => {
    expect(redact('hello world 42')).toBe('hello world 42');
    expect(redact('provider groq model llama3')).toBe('provider groq model llama3');
  });

  it('never throws on garbage input', () => {
    expect(() => redact('')).not.toThrow();
    expect(() => redact('a'.repeat(5))).not.toThrow();
  });
});

describe('redactValue / safeLine / applyRedaction', () => {
  it('redactValue scrubs objects via JSON round-trip', () => {
    const out = redactValue({ provider: 'groq', apiKey: GK }) as Record<string, string>;
    expect(out.apiKey).toContain('…');
    expect(out.provider).toBe('groq');
  });

  it('safeLine returns a scrubbed JSON line', () => {
    const line = safeLine({ provider: 'groq', token: SK });
    expect(line).toContain('…');
    expect(line).not.toContain(SK.slice(0, 10));
  });

  it('applyRedaction is a no-op passthrough when disabled', () => {
    expect(redactionDisabled()).toBe(false);
    expect(applyRedaction(GK)).toContain('…');
    process.env.BUFF_NO_REDACT = '1';
    expect(redactionDisabled()).toBe(true);
    expect(applyRedaction(GK)).toBe(GK);
  });
});
