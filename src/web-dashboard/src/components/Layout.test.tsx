/**
 * The shell — every route reachable, and the drawer usable without a mouse.
 *
 * The first test is the one that matters most. `Layout` is the only place that
 * puts a link on a route, and `/bedrock` was already a route with no link
 * anywhere in the UI: it existed, it worked, and the only way in was to type the
 * URL. A test that hard-codes its own list of destinations cannot catch that —
 * it would have been written from the same nav array that caused the bug. So it
 * reads the paths out of `App.tsx` and asserts the shell links to each one.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './Layout';

/** Where the router currently is — asserted for the `g` chords. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

afterEach(cleanup);

function renderShell(props: Partial<Parameters<typeof Layout>[0]> = {}) {
  return render(
    <MemoryRouter initialEntries={['/overview']}>
      <Layout
        connected
        lastUpdated="17:54:48"
        onRefresh={() => {}}
        {...props}
      >
        <p>panel body</p>
      </Layout>
    </MemoryRouter>,
  );
}

const toggle = () => screen.getByRole('button', { name: /toggle navigation/i });
const rail = () => document.getElementById('app-nav') as HTMLElement;

describe('shell navigation', () => {
  it('links to every route App declares', () => {
    // Resolved from the vitest root rather than `import.meta.url`, which the
    // test transform rewrites to a non-file URL.
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const declared = [...appSource.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);

    // `/chat` is a redirect to `/` and `*` is the catch-all: neither is a
    // destination, so neither should be linked.
    const destinations = declared.filter((path) => path !== '/chat' && path !== '*');
    expect(destinations.length).toBeGreaterThan(15);

    renderShell();

    const hrefs = new Set(
      [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    );
    const missing = destinations.filter((path) => !hrefs.has(path));
    expect(missing).toEqual([]);
  });

  it('groups destinations under real headings', () => {
    renderShell();
    // h2, not a styled div: a screen reader lists the groups as structure.
    expect(screen.getByRole('heading', { name: 'Agent Management' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Analysis & Monitoring' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Resources' })).toBeDefined();
  });

  it('filters the rail by section label and by group, and says when nothing matches', () => {
    renderShell();
    expect(screen.getByRole('link', { name: /Costs/ })).toBeDefined();

    fireEvent.change(screen.getByLabelText(/filter navigation/i), {
      target: { value: 'gateway' },
    });
    expect(screen.getByRole('link', { name: /Gateway/ })).toBeDefined();
    expect(screen.queryByRole('link', { name: /Costs/ })).toBeNull();
    // The group label still frames the surviving match, so the reader keeps the
    // context of where the result lives.
    expect(screen.getByRole('heading', { name: 'Integrations' })).toBeDefined();

    // A group-level query keeps the whole group.
    fireEvent.change(screen.getByLabelText(/filter navigation/i), {
      target: { value: 'analysis' },
    });
    expect(screen.getByRole('link', { name: /Costs/ })).toBeDefined();
    expect(screen.queryByRole('link', { name: /Gateway/ })).toBeNull();

    fireEvent.change(screen.getByLabelText(/filter navigation/i), {
      target: { value: 'zzz-no-such-panel' },
    });
    expect(screen.getByText(/No sections match/)).toBeDefined();
    expect(document.querySelectorAll('.nav-link')).toHaveLength(0);
  });

  it('marks the current destination, and only the exact one for /models', () => {
    render(
      <MemoryRouter initialEntries={['/models/timeline']}>
        <Layout connected lastUpdated="17:54:48" onRefresh={() => {}}>
          <p>panel body</p>
        </Layout>
      </MemoryRouter>,
    );

    const active = [...document.querySelectorAll('.nav-link.active')].map((a) =>
      a.textContent?.trim(),
    );
    expect(active).toEqual(['📅Timeline']);
    // The Models tab must not light up for the Timeline page: they are separate
    // destinations, and `NavLink` matches by prefix unless told not to.
    expect(document.querySelector('.primary-link.active')).toBeNull();
  });
});

describe('shell drawer', () => {
  it('is a labelled disclosure: aria-expanded + aria-controls, Esc closes it', () => {
    renderShell();

    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(rail().classList.contains('open')).toBe(false);

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(toggle().getAttribute('aria-controls')).toBe('app-nav');
    expect(rail().classList.contains('open')).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(rail().classList.contains('open')).toBe(false);
    // Focus goes back to the control that opened it, not to <body>.
    expect(document.activeElement).toBe(toggle());
  });

  it('moves focus into the drawer on open, and the scrim closes it', () => {
    renderShell();

    fireEvent.click(toggle());
    expect(document.activeElement).toBe(screen.getByLabelText(/filter navigation/i));

    const scrim = document.querySelector('.nav-scrim') as HTMLElement;
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim);
    expect(rail().classList.contains('open')).toBe(false);
    expect(document.querySelector('.nav-scrim')).toBeNull();
  });

  it('closes the drawer after navigating, since that is what it is for', () => {
    render(
      <MemoryRouter initialEntries={['/overview']}>
        <Layout connected lastUpdated="17:54:48" onRefresh={() => {}}>
          <p>panel body</p>
        </Layout>
      </MemoryRouter>,
    );

    fireEvent.click(toggle());
    expect(rail().classList.contains('open')).toBe(true);

    fireEvent.click(screen.getByRole('link', { name: /Costs/ }));
    expect(rail().classList.contains('open')).toBe(false);
  });
});

describe('keyboard layer', () => {
  /** The shell plus a route table, so a chord has somewhere to navigate to. */
  function renderRouted() {
    return render(
      <MemoryRouter initialEntries={['/overview']}>
        <Layout connected lastUpdated="17:54:48" onRefresh={() => {}}>
          <Routes>
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </Layout>
      </MemoryRouter>,
    );
  }

  it('opens the cheatsheet on ? and on the visible trigger', () => {
    renderRouted();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.keyDown(document, { key: '?' });
    expect(screen.getByRole('dialog')).toBeDefined();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /shortcuts/i }));
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('navigates on a g-chord, but not on a bare g', () => {
    renderRouted();
    expect(screen.getByTestId('path').textContent).toBe('/overview');

    // A prefix on its own changes nothing — otherwise a stray keypress while the
     // user reaches for the mouse would navigate away.
    fireEvent.keyDown(document, { key: 'g' });
    expect(screen.getByTestId('path').textContent).toBe('/overview');

    act(() => {
      fireEvent.keyDown(document, { key: 'g' });
      fireEvent.keyDown(document, { key: 't' });
    });
    expect(screen.getByTestId('path').textContent).toBe('/tasks');
  });

  it('focuses the navigation filter on /', () => {
    renderRouted();
    fireEvent.keyDown(document, { key: '/' });
    expect(document.activeElement).toBe(screen.getByLabelText(/filter navigation/i));
  });

  it('toggles the drawer on [', () => {
    renderRouted();
    fireEvent.keyDown(document, { key: '[' });
    expect(rail().classList.contains('open')).toBe(true);
    fireEvent.keyDown(document, { key: '[' });
    expect(rail().classList.contains('open')).toBe(false);
  });

  it('ignores shortcuts while the user is typing', () => {
    renderRouted();
    const search = screen.getByLabelText(/filter navigation/i);
    search.focus();

    // `?` in a chat box has to stay a question mark: the listener must bail out
    // on a typing target before it looks at the key at all.
    fireEvent.keyDown(search, { key: '?' });
    fireEvent.keyDown(search, { key: 'g' });
    fireEvent.keyDown(search, { key: 't' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('path').textContent).toBe('/overview');
  });

  it('does not steal modifier combinations from the browser', () => {
    renderRouted();
    fireEvent.keyDown(document, { key: '?', metaKey: true });
    fireEvent.keyDown(document, { key: 't', ctrlKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('path').textContent).toBe('/overview');
  });
});

describe('shell status and actions', () => {
  it('reports the connection state and the last update', () => {
    renderShell({ connected: true, lastUpdated: '17:54:48' });
    expect(screen.getByText('Connected')).toBeDefined();
    expect(screen.getByText('17:54:48')).toBeDefined();
    expect(document.querySelector('.status-dot.connected')).not.toBeNull();

    cleanup();
    renderShell({ connected: false });
    expect(screen.getByText('Reconnecting...')).toBeDefined();
    // Reconnecting is a WARNING, not an error — the dot colour must differ.
    expect(document.querySelector('.status-dot.reconnecting')).not.toBeNull();
  });

  it('refreshes through the callback it was given, and says it is working', () => {
    const onRefresh = vi.fn();
    renderShell({ onRefresh });
    expect(screen.queryByText(/Refreshing/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    cleanup();
    renderShell({ onRefresh, refreshing: true });
    const button = screen.getByRole('button', { name: /refreshing/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});
