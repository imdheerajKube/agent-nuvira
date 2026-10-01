import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import ThemeSwitcher from './ThemeSwitcher';
import KeyboardHelp, { GO_TARGETS, isTypingTarget } from './KeyboardHelp';
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
  // navigation it caused.
  useEffect(() => {
    closeNav();
  }, [location.pathname]);

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
    </div>
  );
}
