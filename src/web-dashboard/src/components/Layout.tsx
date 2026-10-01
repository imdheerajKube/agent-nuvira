import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import ThemeSwitcher from './ThemeSwitcher';
import KeyboardHelp, { GO_TARGETS, isTypingTarget } from './KeyboardHelp';

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

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

/**
 * The four destinations the reference design keeps in the top bar. They are
 * cross-cutting views of the whole system rather than one per section below,
 * which is why they are not also in the sidebar.
 */
const PRIMARY_NAV: NavItem[] = [
  { path: '/overview', label: 'Overview', icon: '📊' },
  { path: '/tasks', label: 'Tasks', icon: '🚀' },
  { path: '/models', label: 'Models', icon: '🧠' },
  { path: '/system', label: 'System', icon: '⚙️' },
];

interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Every route App declares has a home here. The grouping is the reference's
 * editorial split (what the agent does / what we measured / what it reads /
 * what it talks to / how it runs), and it replaces one 23-item flat list where
 * "Chat" and "Process Env" sat at the same level.
 *
 * `/bedrock` used to be a route with no link anywhere in the UI — reachable
 * only by typing the URL. It is listed here so the page can be found.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Agent Management',
    items: [
      // Chat is the front door (the lobby); the other rooms are panels.
      { path: '/', label: 'Chat', icon: '💬' },
      { path: '/dag', label: 'Execution', icon: '🔀' },
      { path: '/routing', label: 'Routing', icon: '🤖' },
      { path: '/requests', label: 'Requests', icon: '📨' },
      { path: '/hub', label: 'Agent Hub', icon: '🧰' },
    ],
  },
  {
    label: 'Analysis & Monitoring',
    items: [
      { path: '/traces', label: 'Traces', icon: '🔍' },
      { path: '/evals', label: 'Evals', icon: '🏆' },
      { path: '/benchmarks', label: 'Benchmarks', icon: '📈' },
      { path: '/costs', label: 'Costs', icon: '💰' },
    ],
  },
  {
    label: 'Resources',
    items: [
      { path: '/memory', label: 'Memory', icon: '💾' },
      { path: '/history', label: 'History', icon: '📝' },
      { path: '/env', label: 'Env Config', icon: '🔐' },
      { path: '/process-env', label: 'Process Env', icon: '🌱' },
    ],
  },
  {
    label: 'Integrations',
    items: [
      { path: '/platforms', label: 'Platforms', icon: '🌐' },
      { path: '/gateway', label: 'Gateway', icon: '📡' },
      { path: '/contacts', label: 'Contacts', icon: '📇' },
      { path: '/bedrock', label: 'Bedrock', icon: '🪨' },
    ],
  },
  {
    label: 'Runtime',
    items: [
      { path: '/models/timeline', label: 'Timeline', icon: '📅' },
      { path: '/executions', label: 'Executions', icon: '📜' },
      { path: '/admin', label: 'Admin', icon: '🛠️' },
    ],
  },
];

/** Case-insensitive match on the item label or its group's label. */
function filterGroups(query: string): NavGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return NAV_GROUPS;
  return NAV_GROUPS.map((group) => {
    if (group.label.toLowerCase().includes(needle)) return group;
    return { ...group, items: group.items.filter((i) => i.label.toLowerCase().includes(needle)) };
  }).filter((group) => group.items.length > 0);
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
