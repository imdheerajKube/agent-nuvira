/**
 * The command palette — one keyboard-first way to reach every destination and
 * the actions that are otherwise buried in a panel.
 *
 * WHY IT EXISTS. The shell now links 30+ destinations across a top bar and a
 * rail. The rail has a filter, but only after you have found the rail row it
 * belongs to; the cheatsheet lists nine `g` chords, and a chord table does not
 * scale to thirty. `⌘K` is the pattern users already know from their editor and
 * their browser, and it gives the dashboard a single "go anywhere, do the
 * obvious thing" surface without a second navigation model that can disagree
 * with the first.
 *
 * WHY IT IS BUILT FROM THE NAV MODEL. `PRIMARY_NAV` and `NAV_GROUPS` are the
 * same arrays the rail renders and the Help page documents, so a new page is
 * reachable here the moment it is reachable anywhere — and a palette entry can
 * never point at a route that does not exist. The actions are real operations
 * (`onRefresh`, the appearance switches) rather than a decorative list.
 *
 * ACCESSIBILITY. This is a modal dialog containing one combobox: focus stays in
 * the input (Tab is held there), options are exposed as a listbox via
 * `aria-activedescendant`, and the active option is scrolled into view. Escape
 * closes and focus returns to whatever opened the palette. The palette never
 * traps a pointer outside itself: clicking the scrim dismisses it.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NAV_GROUPS, PRIMARY_NAV, type NavItem } from '../nav';
import { getTheme, setTheme, useTheme } from '../useTheme';
import { requestChatCommand } from '../chat-commands';

interface PaletteAction {
  id: string;
  label: string;
  group: string;
  icon: string;
  keywords: string;
  run: () => void;
}

interface PaletteItem extends PaletteAction {
  /** Everything a query is matched against, pre-lowered once. */
  haystack: string;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** The shell's refresh, so the palette cannot refresh a different set of things. */
  onRefresh: () => void;
  /** Opens the shortcuts dialog that the top bar's ⌨️ button opens. */
  onShortcuts: () => void;
}

/**
 * The modifier key as this platform spells it.
 *
 * Read from the user agent rather than `navigator.platform`: the latter is
 * deprecated and, in some privacy modes, blank. Falling back to `Ctrl` is the
 * safe direction — a Mac user seeing "Ctrl K" is a small cosmetic miss, while a
 * Windows user told "⌘K" has no key to press.
 */
export function paletteKeyLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl K';
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? '⌘K' : 'Ctrl K';
}

function toItem(
  nav: NavItem & { group: string },
  navigate: (path: string) => void,
  onClose: () => void,
): PaletteItem {
  return {
    id: `nav:${nav.path}`,
    label: nav.label,
    group: nav.group,
    icon: nav.icon,
    keywords: `${nav.path} ${nav.label}`,
    haystack: `${nav.label} ${nav.group} ${nav.path}`.toLowerCase(),
    run: () => {
      navigate(nav.path);
      onClose();
    },
  };
}

export default function CommandPalette({ open, onClose, onRefresh, onShortcuts }: CommandPaletteProps) {
  const navigate = useNavigate();
  const theme = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const titleId = useId();

  const items = useMemo<PaletteItem[]>(() => {
    const seen = new Set<string>();
    const destinations: Array<NavItem & { group: string }> = [];
    for (const item of PRIMARY_NAV) {
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      destinations.push({ ...item, group: 'Top bar' });
    }
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (seen.has(item.path)) continue;
        seen.add(item.path);
        destinations.push({ ...item, group: group.label });
      }
    }

    const actions: PaletteAction[] = [
      {
        id: 'action:refresh',
        label: 'Refresh dashboard data',
        group: 'Actions',
        icon: '⟳',
        keywords: 'reload update fetch',
        run: () => {
          onRefresh();
          onClose();
        },
      },
      {
        id: 'action:shortcuts',
        label: 'Keyboard shortcuts',
        group: 'Actions',
        icon: '⌨️',
        keywords: 'help keys cheatsheet',
        run: () => {
          onClose();
          onShortcuts();
        },
      },
      // Chat actions live in the palette because that is where a keyboard user
      // looks for "do the thing", not because the palette owns them: the page
      // decides whether a turn is running and what a new chat means, via the
      // command queue. Navigating first also mounts the page on a first visit.
      {
        id: 'action:new-chat',
        label: 'Start a new chat',
        group: 'Chat',
        icon: '💬',
        keywords: 'new conversation reset clear transcript',
        run: () => {
          navigate('/chat');
          requestChatCommand('new-chat');
          onClose();
        },
      },
      {
        id: 'action:attach-project',
        label: 'Attach a project folder…',
        group: 'Chat',
        icon: '📁',
        keywords: 'project workspace folder open context',
        run: () => {
          navigate('/chat');
          requestChatCommand('attach-project');
          onClose();
        },
      },
      {
        id: 'action:glass',
        label: theme.glass ? 'Turn glass mode off' : 'Turn glass mode on',
        group: 'Appearance',
        icon: '◐',
        keywords: 'frosted transparency blur surfaces',
        run: () => {
          setTheme({ glass: !getTheme().glass });
          onClose();
        },
      },
      {
        id: 'action:compact',
        label: theme.compact ? 'Turn compact layout off' : 'Turn compact layout on',
        group: 'Appearance',
        icon: '⇕',
        keywords: 'density spacing rows',
        run: () => {
          setTheme({ compact: !getTheme().compact });
          onClose();
        },
      },
      {
        id: 'action:motion',
        label: theme.motion ? 'Turn animation effects off' : 'Turn animation effects on',
        group: 'Appearance',
        icon: '✨',
        keywords: 'animation motion transitions reduced',
        run: () => {
          setTheme({ motion: !getTheme().motion });
          onClose();
        },
      },
    ];

    return [
      ...destinations.map((d) => toItem(d, navigate, onClose)),
      ...actions.map((a) => ({
        ...a,
        haystack: `${a.label} ${a.group} ${a.keywords}`.toLowerCase(),
      })),
    ];
  }, [navigate, onClose, onRefresh, onShortcuts, theme.glass, theme.compact, theme.motion]);

  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return items;
    return items.filter((item) => terms.every((term) => item.haystack.includes(term)));
  }, [items, query]);

  // Reset to the top of the results whenever the query changes, so Enter can
  // never run the option that was highlighted for the PREVIOUS query.
  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setActive(0);
    // The effect runs after the commit, so the input exists; focusing here (and
    // not from `autoFocus`) keeps the restore symmetric for tests and for the
    // real page.
    inputRef.current?.focus();
    return () => {
      restoreRef.current?.focus();
    };
  }, [open]);

  // Keep the highlighted option visible in a list taller than the dialog.
  useEffect(() => {
    if (!open) return;
    // Optional call: jsdom has no layout, so `scrollIntoView` is absent there
    // and an unguarded call would fail every palette test on an effect.
    document.getElementById(`palette-option-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open, filtered.length]);

  if (!open) return null;

  const optionId = (index: number) => `palette-option-${index}`;
  const activeItem = filtered[active];

  function run(item: PaletteItem | undefined) {
    if (!item) return;
    item.run();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) => (index + delta + filtered.length) % filtered.length);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : Math.max(0, filtered.length - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      run(activeItem);
      return;
    }
    // One focusable control inside a modal: Tab would walk into the page behind
    // it, so it stays here. Shift+Tab is caught by the same branch.
    if (event.key === 'Tab') {
      event.preventDefault();
      inputRef.current?.focus();
    }
  }

  return (
    <div className="modal-scrim palette-scrim" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 className="sr-only" id={titleId}>
          Search and jump
        </h2>

        <div className="palette-search">
          <span className="palette-search-icon" aria-hidden="true">🔎</span>
          <input
            ref={inputRef}
            className="palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? optionId(active) : undefined}
            aria-label="Search pages and actions"
            placeholder="Search pages and actions…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd className="palette-kbd">Esc</kbd>
        </div>

        <ul className="palette-results" id="palette-results" role="listbox" aria-label="Results">
          {filtered.map((item, index) => (
            <li
              key={item.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className={`palette-option${index === active ? ' palette-option-active' : ''}`}
              onMouseEnter={() => setActive(index)}
              // mousedown would move focus out of the input and close the
              // palette's keyboard path; the click still fires.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => run(item)}
            >
              <span className="palette-option-icon" aria-hidden="true">{item.icon}</span>
              <span className="palette-option-label">{item.label}</span>
              <span className="palette-option-group">{item.group}</span>
            </li>
          ))}
          {filtered.length === 0 ? (
            <li className="palette-empty">No page or action matches “{query.trim()}”.</li>
          ) : null}
        </ul>

        <div className="palette-foot" aria-hidden="true">
          <span><kbd className="palette-kbd">↑</kbd><kbd className="palette-kbd">↓</kbd> navigate</span>
          <span><kbd className="palette-kbd">↵</kbd> open</span>
          <span><kbd className="palette-kbd">Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
