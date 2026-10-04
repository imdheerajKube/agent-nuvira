import { Link } from 'react-router-dom';
import PageHeader from './PageHeader';
import { SHORTCUTS } from './KeyboardHelp';
import { PALETTES, PALETTE_LABELS, MODES } from '../theme';
import { PRIMARY_NAV, NAV_GROUPS } from '../nav';

/**
 * Help — the page a user reads before they know which of the other tabs they
 * want. That is why it sits in the primary nav next to Overview/Tasks/Models.
 *
 * EVERYTHING HERE IS DERIVED, not retyped:
 *   - the shortcut table comes from `SHORTCUTS`, the same constant the `?`
 *     cheatsheet and the key handler are built from, so a new chord appears in
 *     all three or in none;
 *   - the palette and mode names come from `theme.ts`;
 *   - the destination map comes from `nav.ts`, the list the rail actually
 *     renders.
 *
 * A help page is the easiest thing in a product to leave quietly wrong: it is
 * prose, nothing fails when it ages, and it is usually written once. Deriving it
 * is the only version of this page that stays true.
 */
export default function HelpPage() {
  return (
    <div className="panel">
      <PageHeader
        icon="❓"
        title="Help"
        description="What this dashboard is, how to get work done in it, and every keyboard shortcut."
      />

      <section className="help-section">
        <h2 className="section-title">Start here</h2>
        <ol className="help-steps">
          <li>
            <strong>Talk to the agent in Chat.</strong> It is the front door — the other pages are views of what has
            already happened. <Link to="/chat">Open Chat</Link>.
          </li>
          <li>
            <strong>Run a command from Tasks.</strong> The Command Console executes the same CLI you would type in a
            terminal, and it can group-browse every command for you.{' '}
            <Link to="/tasks">Open Command Console</Link>.
          </li>
          <li>
            <strong>Sign in for anything that changes something.</strong> Running a task, editing environment secrets
            and the Agent Hub toggles all need an admin session. Controls that need one are disabled and say so.{' '}
            <Link to="/admin">Go to Admin</Link>.
          </li>
        </ol>
      </section>

      <section className="help-section">
        <h2 className="section-title">How the dashboard is laid out</h2>
        <dl className="help-anatomy">
          <dt>Top bar</dt>
          <dd>
            The cross-cutting views on the left; on the right, <strong>Refresh</strong> (re-fetches everything the page
            shows), <strong>Shortcuts</strong> (the cheatsheet), and <strong>Appearance</strong> (theme and
            accessibility).
          </dd>
          <dt>Navigation rail</dt>
          <dd>
            Every remaining destination, grouped by what it is for. The filter box narrows it as you type. Below the
            width where it becomes a drawer, it opens from the ☰ button.
          </dd>
          <dt>Page body</dt>
          <dd>
            One page per destination. Each starts with its own title and, where it has one, a short description of what
            you are looking at.
          </dd>
          <dt>Status footer</dt>
          <dd>
            Whether the dashboard is connected to the local server, and when it last received data. &ldquo;Reconnecting&rdquo;
            means the live stream dropped and is being retried — the pages keep the last data they had.
          </dd>
        </dl>
      </section>

      <section className="help-section">
        <h2 className="section-title">Keyboard shortcuts</h2>
        <div className="help-shortcuts">
          {SHORTCUTS.map((group) => (
            <div className="shortcuts-group" key={group.group}>
              <h3 className="shortcuts-group-title">{group.group}</h3>
              <dl className="shortcuts-list">
                {group.items.map((item) => (
                  <div className="shortcuts-row" key={item.description}>
                    <dt className="shortcuts-keys">
                      {item.keys.map((key) => (
                        <kbd className="shortcuts-key" key={key}>
                          {key}
                        </kbd>
                      ))}
                    </dt>
                    <dd className="shortcuts-description">{item.description}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
        <p className="help-note">
          Shortcuts are ignored while you are typing, so <kbd className="shortcuts-key">?</kbd> in a question stays a
          question mark. The <kbd className="shortcuts-key">g</kbd> chords expire about a second and a half after the
          prefix, so a stray <kbd className="shortcuts-key">g</kbd> cannot navigate somewhere later.
        </p>
      </section>

      <section className="help-section">
        <h2 className="section-title">Appearance &amp; accessibility</h2>
        <p className="help-body">
          <strong>Appearance</strong> in the top bar offers {PALETTES.length} palettes in light and dark, plus a text
          size and an accessibility mode. Your choice is remembered in this browser only — nothing is sent anywhere.
        </p>
        <dl className="help-anatomy">
          <dt>Palette</dt>
          <dd>
            {PALETTES.map((palette) => PALETTE_LABELS[palette]).join(' · ')}. The{' '}
            {PALETTE_LABELS.contrast} palette is the one to pick when you need maximum legibility.
          </dd>
          <dt>Mode</dt>
          <dd>
            {MODES.map((mode) => mode.charAt(0).toUpperCase() + mode.slice(1)).join(' or ')}. &ldquo;Reset to system
            default&rdquo; goes back to what your operating system asks for.
          </dd>
          <dt>Text size</dt>
          <dd>
            Scales the whole interface, not just the body text. Choosing a larger size turns accessibility mode on,
            because that is what defines it.
          </dd>
          <dt>Accessibility mode</dt>
          <dd>
            Larger click targets, a thicker focus ring and no motion. Off by default so it never changes the look for
            anyone who does not need it.
          </dd>
        </dl>
        <p className="help-note">
          Focus is always visible: every control draws a ring when reached by keyboard. Opportunistic hover-only
          effects are never the only cue for a state, and a selected state is carried by a filled shape plus weight
          rather than a faint tint.
        </p>
      </section>

      <section className="help-section">
        <h2 className="section-title">Where everything lives</h2>
        <dl className="help-anatomy">
          <dt>Top bar</dt>
          <dd className="help-links">
            {PRIMARY_NAV.map((item) => (
              <Link key={item.path} to={item.path}>
                <span aria-hidden="true">{item.icon}</span> {item.label}
              </Link>
            ))}
          </dd>
        </dl>
        {NAV_GROUPS.map((group) => (
          <dl className="help-anatomy help-group" key={group.label}>
            <dt>{group.label}</dt>
            <dd className="help-links">
              {group.items.map((item) => (
                <Link key={item.path} to={item.path}>
                  <span aria-hidden="true">{item.icon}</span> {item.label}
                </Link>
              ))}
            </dd>
          </dl>
        ))}
      </section>

      <section className="help-section">
        <h2 className="section-title">If something looks wrong</h2>
        <dl className="help-anatomy">
          <dt>A control is disabled</dt>
          <dd>
            It needs an admin session. Sign in from <Link to="/admin">Admin</Link>; the page will say which session it
            wants.
          </dd>
          <dt>A task failed</dt>
          <dd>
            Open it from the Command Console&apos;s History — the full output and the exit code are kept per run.
          </dd>
          <dt>The footer says &ldquo;Reconnecting&rdquo;</dt>
          <dd>
            The live stream dropped. The dashboard retries on its own and keeps showing the last data it received;
            Refresh forces a fresh fetch.
          </dd>
          <dt>A page is empty</dt>
          <dd>
            Most pages report &ldquo;no data yet&rdquo; rather than a zero, because a zero and an absent source look
            identical. Check <Link to="/system">System</Link> for the health checks behind it.
          </dd>
        </dl>
      </section>
    </div>
  );
}
