import { useId, useMemo, useState } from 'react';
// GENERATED — `npm run docs:commands` walks the LIVE commander tree and writes
// this. It is committed and drift-guarded (scripts/generate-commands-surface.mjs
// --check), so this picker cannot offer a command the CLI does not expose, and
// nothing here is hand-typed. The names omit the program prefix on purpose: the
// console runs `node dist/index.js <name>`, so a picked name runs as-is.
import catalog from '../generated/commands.json';

interface CommandRow {
  name: string;
  description: string;
  flags: string[];
}

interface CommandGroup {
  name: string;
  description: string;
  commands: CommandRow[];
}

const GROUPS = catalog.groups as CommandGroup[];

/** Case-insensitive match on the command name or its description. */
function rowMatches(row: CommandRow, needle: string): boolean {
  return row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle);
}

/**
 * Browse every command the CLI exposes, grouped and collapsible.
 *
 * WHY IT EXISTS. The run box was an empty input whose only help was a
 * placeholder naming four commands — which is a reference to a manual, not a
 * way to work. With 250 commands the user has to already know the name to use
 * the page at all. This turns the console from "type it if you know it" into
 * "find it, then run it".
 *
 * `<details>`/`<summary>` rather than a hand-built disclosure: the element
 * already IS the correct thing (keyboard-operable, screen-reader-announced as
 * expanded/collapsed, works with find-in-page, and needs no JS state per group).
 * The groups are forced open while a search is running, because a filter that
 * leaves its matches inside a collapsed section shows the user nothing.
 */
export default function CommandBrowser({ onPick }: { onPick: (command: string) => void }) {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const needle = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!needle) return GROUPS;
    return GROUPS.map((group) => {
      if (group.name.toLowerCase().includes(needle)) return group;
      return { ...group, commands: group.commands.filter((row) => rowMatches(row, needle)) };
    }).filter((group) => group.commands.length > 0);
  }, [needle]);

  const shown = filtered.reduce((total, group) => total + group.commands.length, 0);

  return (
    <section className="command-browser">
      <div className="command-browser-head">
        <h2 className="section-title command-browser-title">Browse commands</h2>
        <p className="command-browser-count">
          {needle
            ? `${shown} of ${catalog.commandCount} commands match “${query.trim()}”`
            : `${catalog.commandCount} commands in ${catalog.groupCount} groups`}
        </p>
      </div>

      <label className="sr-only" htmlFor={searchId}>
        Filter commands
      </label>
      <input
        id={searchId}
        type="search"
        className="admin-input command-browser-search"
        placeholder="Filter commands — e.g. eval, memory, gateway status"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoComplete="off"
        spellCheck={false}
      />

      {filtered.length === 0 ? (
        <p className="command-browser-empty">
          No command matches “{query.trim()}”. Clear the filter to see all {catalog.groupCount} groups.
        </p>
      ) : (
        <div className="command-browser-groups">
          {filtered.map((group) => (
            <details
              className="command-group"
              // The key carries the filter state on purpose: entering or leaving
              // a search REMOUNTS the group, which is how `open` below both
              // forces matches visible while filtering and returns to the user's
              // own expand/collapse once the filter is cleared. Within one mode
              // the key is stable, so typing does not collapse anything.
              key={`${group.name}:${needle ? 'filtering' : 'browsing'}`}
              open={needle ? true : undefined}
            >
              <summary className="command-group-summary">
                <code className="command-group-name">{group.name}</code>
                <span className="command-group-description">{group.description}</span>
                <span className="command-group-count">{group.commands.length}</span>
              </summary>
              <ul className="command-list">
                {group.commands.map((row) => (
                  <li className="command-item" key={row.name}>
                    <button
                      type="button"
                      className="command-use"
                      onClick={() => onPick(row.name)}
                      title={`Insert “${row.name}” into the command box`}
                    >
                      <span className="command-item-name">{row.name}</span>
                      <span className="command-item-description">{row.description}</span>
                      {row.flags.length > 0 && (
                        <span className="command-item-flags">
                          {row.flags.map((flag) => (
                            <code key={flag}>{flag}</code>
                          ))}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
