/**
 * Localization helper.
 *
 * VS Code resolves `vscode.l10n.t(message)` against `l10n/bundle.l10n.<locale>.json`
 * at runtime, using the ENGLISH source string as the lookup key. The default
 * `l10n/bundle.l10n.json` is therefore empty — the source strings are already
 * English — and a translation is added by shipping `bundle.l10n.<locale>.json`
 * (English key → localized text), plus a `package.nls.<locale>.json` for the
 * manifest strings.
 *
 * This wrapper adds two things the raw API does not:
 *   1. It never throws when the `l10n` namespace is missing (older VS Code, and
 *      the unit-test environment, where `vscode` is mocked).
 *   2. Its fallback performs `{0}`-style placeholder substitution, so a message
 *      stays readable — and assertable — without the API present.
 */

import * as vscode from 'vscode';

interface L10nNamespace {
  t(message: string, ...args: unknown[]): string;
}

function l10nNamespace(): L10nNamespace | undefined {
  try {
    return (vscode as unknown as { l10n?: L10nNamespace }).l10n;
  } catch {
    // Reading a missing namespace member can throw (vitest module mocks do).
    return undefined;
  }
}

/** Substitute `{0}`, `{1}`, … placeholders; unknown indices are left intact. */
export function formatMessage(message: string, args: unknown[]): string {
  return message.replace(/\{(\d+)\}/g, (whole, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Translate a user-facing message.
 *
 * @param message English source string (also the lookup key in the l10n bundle)
 * @param args    values for `{0}`, `{1}`, … placeholders
 */
export function t(message: string, ...args: unknown[]): string {
  const l10n = l10nNamespace();
  if (l10n && typeof l10n.t === 'function') {
    try {
      return l10n.t(message, ...args);
    } catch {
      // Fall through to the local, substitution-aware fallback.
    }
  }
  return formatMessage(message, args);
}
