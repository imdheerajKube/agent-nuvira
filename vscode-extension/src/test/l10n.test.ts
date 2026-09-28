/**
 * l10n.ts — the localization wrapper.
 *
 * The contract that matters: `t()` must always return a usable English message,
 * whether or not VS Code's l10n API is present, and it must never throw. The
 * default `l10n/bundle.l10n.json` is empty (English source strings are the
 * keys), so the fallback path is the common one in tests and must substitute
 * placeholders itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('vscode', () => import('./__mocks__/vscode.js'));

import { l10n } from './__mocks__/vscode.js';
import { t, formatMessage } from '../l10n.js';

beforeEach(() => {
  delete l10n.t;
});
afterEach(() => {
  delete l10n.t;
});

describe('formatMessage', () => {
  it('substitutes indexed placeholders', () => {
    expect(formatMessage('Switched to {0} ({1})', ['groq', 'fast'])).toBe('Switched to groq (fast)');
  });

  it('leaves an out-of-range placeholder intact rather than printing undefined', () => {
    expect(formatMessage('value: {3}', ['a'])).toBe('value: {3}');
  });

  it('coerces non-string arguments', () => {
    expect(formatMessage('count={0}', [3])).toBe('count=3');
  });
});

describe('t()', () => {
  it('returns the English source, substituted, when the l10n API is absent', () => {
    expect(t('Switch failed: {0}', 'boom')).toBe('Switch failed: boom');
  });

  it('returns the plain message when there are no placeholders', () => {
    expect(t('🤖 Auto routing enabled')).toBe('🤖 Auto routing enabled');
  });

  it('delegates to vscode.l10n.t when available', () => {
    const spy = vi.fn((message: string) => `[fr] ${message}`);
    l10n.t = spy;

    expect(t('Hello {0}', 'world')).toBe('[fr] Hello {0}');
    expect(spy).toHaveBeenCalledWith('Hello {0}', 'world');
  });

  it('falls back to the local message when vscode.l10n.t throws', () => {
    l10n.t = () => { throw new Error('l10n exploded'); };

    expect(() => t('Switched to {0}', 'groq')).not.toThrow();
    expect(t('Switched to {0}', 'groq')).toBe('Switched to groq');
  });
});
