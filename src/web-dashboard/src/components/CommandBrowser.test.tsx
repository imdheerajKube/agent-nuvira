/**
 * CommandBrowser — the picker over the generated CLI catalogue.
 *
 * The catalogue is generated from the live commander tree and drift-guarded, so
 * these tests deliberately do NOT hard-code what it contains (a test that lists
 * commands would fail every time the CLI gains one, and would have to be edited
 * by hand — the thing the generator exists to remove). They assert the SHAPE and
 * the contract instead: groups are collapsible, filtering narrows and says how
 * much it found, an empty result says so, and picking inserts the exact name.
 *
 * One generated fact IS pinned: `eval run` exists. That is the command the page's
 * own placeholder advertises, so if the catalogue ever stops containing it, the
 * help text in the UI is wrong and this should fail.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import CommandBrowser from './CommandBrowser';
import catalog from '../generated/commands.json';

afterEach(cleanup);

const browser = () => render(<CommandBrowser onPick={() => {}} />);
const groupSummaries = () => document.querySelectorAll('.command-group-summary');

/**
 * The row button for an exact command name.
 *
 * NOT `getByRole('button', { name })`: a row's accessible name is its name plus
 * its description plus its flags, so a substring match like /eval run/ also hits
 * every longer command that starts with it. Matching the name element exactly is
 * what makes these assertions about one specific row.
 */
function rowButton(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.command-use')].find(
    (candidate) => candidate.querySelector('.command-item-name')?.textContent === name,
  );
  if (!button) throw new Error(`no command row for ${name}`);
  return button;
}

describe('CommandBrowser', () => {
  it('renders every group in the generated catalogue, collapsed', () => {
    browser();
    expect(groupSummaries().length).toBe(catalog.groupCount);
    // Collapsed by default: 50 open groups would bury the run form.
    expect(document.querySelectorAll('.command-group[open]').length).toBe(0);
  });

  it('states the size of what it is showing, from the catalogue itself', () => {
    browser();
    expect(
      screen.getByText(new RegExp(`${catalog.commandCount} commands in ${catalog.groupCount} groups`)),
    ).toBeTruthy();
  });

  it('includes the command the page advertises, with its description', () => {
    browser();
    const input = screen.getByLabelText(/filter commands/i);
    fireEvent.change(input, { target: { value: 'eval run' } });
    expect(screen.getByText('eval run')).toBeTruthy();
    // The description is what makes the list usable without a manual.
    expect(screen.getByText(/Run the evaluation suite/)).toBeTruthy();
  });

  it('narrows to the matching rows and reports how many matched', () => {
    browser();
    fireEvent.change(screen.getByLabelText(/filter commands/i), { target: { value: 'gateway status' } });

    expect(screen.getByText('gateway status')).toBeTruthy();
    expect(screen.getByText(/of \d+ commands match/)).toBeTruthy();
    // A filter that matched one row must not still be showing all 50 groups.
    expect(groupSummaries().length).toBeLessThan(catalog.groupCount);
  });

  it('forces matching groups open, so a match is never hidden inside a section', () => {
    browser();
    fireEvent.change(screen.getByLabelText(/filter commands/i), { target: { value: 'eval' } });
    // Everything still on screen is open — a result the user cannot see is not a
    // result, which is the failure mode of filtering an accordion.
    expect(document.querySelectorAll('.command-group:not([open])').length).toBe(0);
  });

  it('filters on the description as well as the name', () => {
    browser();
    // "evaluation" appears in eval's group blurb and in row descriptions, not in
    // any command name, so this fails if the filter only looks at names.
    fireEvent.change(screen.getByLabelText(/filter commands/i), { target: { value: 'evaluation' } });
    expect(groupSummaries().length).toBeGreaterThan(0);
    expect(screen.queryByText(/No command matches/)).toBeNull();
  });

  it('says so when nothing matches, instead of rendering an empty box', () => {
    browser();
    fireEvent.change(screen.getByLabelText(/filter commands/i), { target: { value: 'zzz-no-such-command' } });
    expect(screen.getByText(/No command matches/)).toBeTruthy();
    expect(document.querySelectorAll('.command-group').length).toBe(0);
  });

  it('is a list of real buttons, so Enter and Space work without extra handlers', () => {
    browser();
    fireEvent.change(screen.getByLabelText(/filter commands/i), { target: { value: 'eval run' } });
    const button = rowButton('eval run');
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
  });

  it('hands the picked command name to its caller verbatim', () => {
    const onPick = vi.fn();
    render(<CommandBrowser onPick={onPick} />);
    fireEvent.change(screen.getByLabelText(/filter commands/i), { target: { value: 'memory stats' } });
    fireEvent.click(rowButton('memory stats'));
    // The name is what the console runs, so it must not be decorated, prefixed or
    // case-changed on the way out.
    expect(onPick).toHaveBeenCalledWith('memory stats');
  });

  it('shows a command’s flags when it has any', () => {
    browser();
    fireEvent.change(screen.getByLabelText(/filter commands/i), { target: { value: 'admin policy' } });
    // `nuvira admin policy` documents a --json flag in the generated surface.
    const flags = document.querySelectorAll('.command-item-flags code');
    expect(flags.length).toBeGreaterThan(0);
  });
});
