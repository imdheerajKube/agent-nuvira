import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import ThemeSwitcher from './ThemeSwitcher';
import AccountMenu from './AccountMenu';
import KeyboardHelp, { GO_TARGETS, isTypingTarget } from './KeyboardHelp';
import CommandPalette, { paletteKeyLabel } from './CommandPalette';
import { setChatFocus } from '../chat-focus';
// The navigation MODEL lives outside the shell: the Help page lists it too, and
// a page should not have to import the shell to describe where things are.
import { PRIMARY_NAV, filterGroups } from '../nav';

interface LayoutProps {
  children: ReactNode;
  connected: boolean;
  lastUpdated: string;
  /**
   * Re-fetch the whole dashboard payload. Supplied by App so the top bar's
   * Refresh control is wired to the same call the initial load uses — a Refresh
   * button that does not refresh is worse than no button.
   */
  onRefresh: () => void;
  /** True while an explicit refresh is in flight, so the control can say so. */
  refreshing?: boolean;
}

export default function Layout({
  children,
  connected,
  lastUpdated,
  onRefresh,
  refreshing = false,
}: LayoutProps) {
  const [navOpen, setNavOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const goArmedAt = useRef(0);
  const searchId = useId();
  const location = useLocation();
  const navigate = useNavigate();

  const statusClass = connected ? 'connected' : 'reconnecting';
  const statusText = connected ? 'Connected' : 'Reconnecting...';
  const groups = filterGroups(query);

  const closeNav = () => setNavOpen(false);

  /**
   * The keyboard layer.
   *
   * ONE listener for the whole shell, and it bails out on three things before
   * looking at the key: modifier combos (Cmd+K and friends belong to the browser
   * and the OS), a typing target, and the shortcuts dialog owning Esc while it is
   * open. The drawer's Esc lives here too — it used to be its own effect, which
   * meant two document listeners both closing on one Escape.
   *
   * The `g` prefix is a chord, not a mode: it expires after 1.5s so a stray `g`
   * followed by typing does not navigate somewhere unexpected five seconds later.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      if (event.key === 'Escape') {
        if (helpOpen) return; // the dialog closes itself
        if (navOpen) {
          setNavOpen(false);
          menuRef.current?.focus();
        }
        return;
      }

      if (event.key === '?') {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }

      // F1 is the platform's own "help" key and costs no chord, so the full Help
      // page has the conventional key while `?` keeps the quick cheatsheet.
      if (event.key === 'F1') {
        event.preventDefault();
        navigate('/help');
        return;
      }

      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }

      if (event.key === '[') {
        event.preventDefault();
        setNavOpen((value) => !value);
        return;
      }

      if (event.key === 'g') {
        goArmedAt.current = Date.now();
        return;
      }

      if (Date.now() - goArmedAt.current < 1500) {
        const target = GO_TARGETS[event.key.toLowerCase()];
        goArmedAt.current = 0;
        if (target) {
          event.preventDefault();
          navigate(target);
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [navOpen, helpOpen, navigate]);

  // Opening the drawer moves focus into it, starting at the search box — the
  // first thing in it and the fastest way through 21 destinations.
  useEffect(() => {
    if (!navOpen) return;
    searchRef.current?.focus();
  }, [navOpen]);

  // Navigating is the drawer's whole purpose, so it should not survive the
  // navigation it caused. Chat focus mode is a mode OF THE CHAT PAGE: leaving
  // that page with the shell hidden would strand the user on a page whose
  // navigation cannot be reached at all, so the mode ends with the navigation
  // that left it. The palette closes for the same reason — the destination it
  // opened is the answer, and it should not sit over it.
  useEffect(() => {
    closeNav();
    setPaletteOpen(false);
    if (location.pathname !== '/chat') setChatFocus(false);
  }, [location.pathname]);

  /**
   * ⌘K / Ctrl+K.
   *
   * A SECOND listener, not another branch of the shortcut handler below: that
   * one deliberately bails on any modifier combination, because Cmd+K belongs
   * to the browser unless we claim it. Claiming it is the whole point of a
   * palette, so it is handled here, before the type-ahead rules, and only for
   * this exact chord.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      setPaletteOpen((value) => !value);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="layout">
      <header className="topbar">
        <button
          type="button"
          ref={menuRef}
          className="topbar-menu"
          aria-label="Toggle navigation"
          aria-controls="app-nav"
          aria-expanded={navOpen}
          onClick={() => setNavOpen((value) => !value)}
        >
          <span aria-hidden="true">☰</span>
        </button>

        <div className="topbar-brand">
          <span className="topbar-logo" aria-hidden="true">
            🤖
          </span>
          <span className="topbar-title">Agent-Nuvira</span>
        </div>

        <nav className="primary-nav" aria-label="Primary">
          {PRIMARY_NAV.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end
              className={({ isActive }) => `primary-link${isActive ? ' active' : ''}`}
            >
              <span aria-hidden="true">{item.icon}</span> {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="topbar-actions">
          {/* The palette's visible door. The shortcut is printed on the control
              for the keyboard users who will use it, and the aria-label keeps
              it meaningful when the hint is hidden at narrow widths. */}
          <button
            type="button"
            className="topbar-action palette-trigger"
            onClick={() => setPaletteOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={paletteOpen}
            aria-label="Search and jump"
            title={`Search pages and actions (${paletteKeyLabel()})`}
          >
            <span aria-hidden="true">🔎</span>
            <kbd className="palette-trigger-key" aria-hidden="true">{paletteKeyLabel()}</kbd>
          </button>
          <button
            type="button"
            className="topbar-action"
            onClick={onRefresh}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            <span aria-hidden="true">⟳</span> {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {/* A shortcut nobody can discover is a shortcut nobody uses, so the
              cheatsheet has a visible trigger as well as the `?` key. */}
          <button
            type="button"
            className="topbar-action"
            aria-haspopup="dialog"
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen(true)}
          >
            <span aria-hidden="true">⌨️</span> Shortcuts
          </button>
          <ThemeSwitcher />
          {/* The project site: capabilities, command reference, setup guides.
              A first-time user should be able to reach the "what can this do"
              answer without leaving the product or finding a README. */}
          <a
            className="topbar-action"
            href="https://www.agent-nuvira.com"
            target="_blank"
            rel="noopener noreferrer"
            title="Agent-Nuvira website — capabilities, commands, docs, setup"
          >
            <span aria-hidden="true">🌐</span> Website
          </a>
          <AccountMenu />
        </div>
      </header>

      <div className="layout-body">
        {navOpen && <div className="nav-scrim" onClick={closeNav} aria-hidden="true" />}

        <nav className={`nav${navOpen ? ' open' : ''}`} id="app-nav" aria-label="Sections">
          <div className="nav-search">
            <label className="sr-only" htmlFor={searchId}>
              Filter navigation
            </label>
            <input
              id={searchId}
              ref={searchRef}
              type="search"
              className="nav-search-input"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="nav-links">
            {groups.map((group) => (
              <section className="nav-group" key={group.label}>
                <h2 className="nav-group-title">{group.label}</h2>
                {group.items.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    end={item.path === '/'}
                    className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
                  >
                    <span className="nav-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                    {item.label}
                  </NavLink>
                ))}
              </section>
            ))}
            {groups.length === 0 && (
              <p className="nav-empty">No sections match “{query}”.</p>
            )}
          </div>

          <div className="nav-footer">
            <span className={`status-dot ${statusClass}`} />
            <span className="status-text">{statusText}</span>
            <span className="last-updated">{lastUpdated}</span>
          </div>
        </nav>

        <main className="main">{children}</main>
      </div>

      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onRefresh={onRefresh}
        onShortcuts={() => setHelpOpen(true)}
      />
    </div>
  );
}
