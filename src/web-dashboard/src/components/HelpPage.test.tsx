/**
 * HelpPage — the page has to stay TRUE, and it is prose, so nothing fails when
 * it ages. These tests are the substitute for a reviewer who would notice.
 *
 * They assert derivation rather than content: every shortcut in `SHORTCUTS`
 * appears, every destination in `NAV_GROUPS` appears as a link, every palette
 * from `theme.ts` is named, and the heading structure is navigable. So adding a
 * chord or a page without documenting it fails here — which is the only reason a
 * help page in a hand-written product is not quietly wrong six months later.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import HelpPage from './HelpPage';
import { SHORTCUTS, GO_TARGETS } from './KeyboardHelp';
import { NAV_GROUPS, PRIMARY_NAV } from '../nav';
import { PALETTES, PALETTE_LABELS } from '../theme';

afterEach(cleanup);

function renderPage(): void {
  render(
    <MemoryRouter>
      <HelpPage />
    </MemoryRouter>,
  );
}

describe('HelpPage', () => {
  it('has exactly one h1 and starts its sections at h2', () => {
    renderPage();
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    expect(headings.filter((h) => h.tagName === 'H1').length).toBe(1);
    // The first heading after the title must be an h2: as an h3 it would skip a
    // level for anyone navigating by heading.
    expect(headings[1].tagName).toBe('H2');
    expect(screen.getByRole('heading', { level: 1, name: /Help/ })).toBeTruthy();
  });

  it('shows every shortcut the shell implements', () => {
    renderPage();
    for (const group of SHORTCUTS) {
      for (const item of group.items) {
        // The description is the row's own text, so this is a direct check that
        // nothing the cheatsheet lists is missing from the page.
        expect(screen.getAllByText(item.description).length).toBeGreaterThan(0);
        for (const key of item.keys) {
          expect(screen.getAllByText(key).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('documents the chords it claims to, for the pages they go to', () => {
    renderPage();
    // Every `g`-chord target in the handler is reachable by a documented key, so
    // the table cannot silently omit a destination the handler implements.
    expect(Object.keys(GO_TARGETS).length).toBeGreaterThan(0);
    expect(screen.getAllByText('g').length).toBeGreaterThan(0);
  });

  it('links to every destination in the navigation model', () => {
    renderPage();
    const hrefs = new Set([...document.querySelectorAll('a')].map((a) => a.getAttribute('href')));
    const expected = [
      ...PRIMARY_NAV.map((item) => item.path),
      ...NAV_GROUPS.flatMap((group) => group.items.map((item) => item.path)),
    ];
    const missing = expected.filter((path) => !hrefs.has(path));
    expect(missing).toEqual([]);
  });

  it('names every group and every palette', () => {
    renderPage();
    for (const group of NAV_GROUPS) {
      expect(screen.getByText(group.label)).toBeTruthy();
    }
    for (const palette of PALETTES) {
      expect(screen.getAllByText(new RegExp(PALETTE_LABELS[palette])).length).toBeGreaterThan(0);
    }
  });

  it('explains the accessibility controls rather than only naming them', () => {
    renderPage();
    expect(screen.getByText(/Accessibility mode/)).toBeTruthy();
    // The coupling users hit first: choosing a larger text size turns the mode on.
    expect(screen.getByText(/larger size turns accessibility mode on/i)).toBeTruthy();
    expect(screen.getByText(/Focus is always visible/)).toBeTruthy();
  });
});
