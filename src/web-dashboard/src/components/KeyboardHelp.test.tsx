/**
 * The cheatsheet dialog, plus the one rule that decides whether global
 * shortcuts are usable at all: they must not fire while you are typing.
 *
 * That rule is why `isTypingTarget` is exported and tested directly rather than
 * only through a keystroke — it is the difference between `?` opening help and
 * `?` being a question mark in the chat box, and it is not visible in a
 * happy-path render.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import KeyboardHelp, { GO_TARGETS, SHORTCUTS, isTypingTarget } from './KeyboardHelp';

afterEach(cleanup);

/** The real arrangement: a control opens the dialog, the dialog closes it. */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open help
      </button>
      <KeyboardHelp open={open} onClose={() => setOpen(false)} />
    </>
  );
}

describe('isTypingTarget', () => {
  it('recognises every place a user types', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    // The ATTRIBUTE, which is what React's `contentEditable` renders and what
    // jsdom actually reflects. The property-only case is covered separately.
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');

    for (const el of [input, textarea, select, editable]) {
      expect(isTypingTarget(el), el.tagName).toBe(true);
    }
  });

  it('recognises a rich-text editor reported only via the property', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'isContentEditable', { value: true });
    expect(isTypingTarget(el)).toBe(true);
  });

  it('does not treat an switched-off editor as a place to type', () => {
    // `contenteditable="false"` is a real editor that has been made read-only.
    // Swallowing every shortcut inside one would be a silent dead zone.
    const el = document.createElement('div');
    el.setAttribute('contenteditable', 'false');
    expect(isTypingTarget(el)).toBe(false);
  });

  it('does not claim buttons, the page, or nothing at all', () => {
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('shortcuts table', () => {
  it('documents every destination the chord can reach', () => {
    const listed = SHORTCUTS.flatMap((g) => g.items)
      .filter((i) => i.keys[0] === 'g')
      .map((i) => i.keys[1]);
    // A chord that works but is not written down is a chord nobody finds; a
    // chord that is written down but does not work is worse.
    expect(listed.sort()).toEqual(Object.keys(GO_TARGETS).sort());
  });
});

describe('KeyboardHelp', () => {
  it('renders nothing at all when closed', () => {
    const { container } = render(<KeyboardHelp open={false} onClose={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('is a labelled modal dialog and moves focus into itself', () => {
    render(<KeyboardHelp open onClose={() => {}} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Named by its own heading, not by its role alone.
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)?.textContent).toContain('Keyboard shortcuts');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape and hands focus back to the control that opened it', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'open help' });

    // `fireEvent.click` does not move focus the way a real mousedown does, so the
    // focus is placed by hand — otherwise the dialog would record <body> as the
    // thing to restore, and the assertion below would test nothing.
    opener.focus();
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(document.activeElement).not.toBe(opener);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // Not <body>: otherwise the next Tab restarts at the top of the document.
    expect(document.activeElement).toBe(opener);
  });

  it('stays open when a click lands inside it, and closes on the scrim', () => {
    const onClose = vi.fn();
    render(<KeyboardHelp open onClose={onClose} />);

    fireEvent.click(screen.getByRole('heading', { name: /Keyboard shortcuts/ }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(document.querySelector('.modal-scrim') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab inside the dialog', () => {
    render(<KeyboardHelp open onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: /close keyboard shortcuts/i });
    close.focus();

    // Shift+Tab from the first control wraps to the last, so Tab cannot walk
    // out into the page behind the modal.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
