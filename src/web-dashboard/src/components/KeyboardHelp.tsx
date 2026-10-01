import { useEffect, useId, useRef, useState } from 'react';

/** What the cheatsheet lists — one source, so it cannot drift from the handler. */
export interface Shortcut {
  keys: string[];
  description: string;
}

export const SHORTCUTS: Array<{ group: string; items: Shortcut[] }> = [
  {
    group: 'General',
    items: [
      { keys: ['?'], description: 'Show the shortcut cheatsheet' },
      { keys: ['F1'], description: 'Open the Help page' },
      { keys: ['Esc'], description: 'Close a dialog or panel' },
      { keys: ['g', 'c'], description: 'Go to Chat' },
      { keys: ['g', 'o'], description: 'Go to Overview' },
      { keys: ['g', 't'], description: 'Go to Tasks' },
      { keys: ['g', 'm'], description: 'Go to Models' },
      { keys: ['g', 's'], description: 'Go to System' },
      { keys: ['g', 'h'], description: 'Go to Agent Hub' },
    ],
  },
  {
    group: 'Navigation',
    items: [
      { keys: ['/'], description: 'Focus the navigation filter' },
      { keys: ['['], description: 'Collapse / expand the navigation drawer' },
    ],
  },
];

/** `g` then a letter. Kept here so the handler and the table cannot disagree. */
export const GO_TARGETS: Record<string, string> = {
  c: '/',
  o: '/overview',
  t: '/tasks',
  m: '/models',
  s: '/system',
  h: '/hub',
};

/**
 * Is the user typing?
 *
 * THE reason this module exists rather than a two-line keydown listener: a
 * global shortcut that fires while someone is typing in the chat box is worse
 * than no shortcut at all — `?` in a question would open a help dialog, and
 * `g` would navigate away mid-sentence. Contenteditable counts too, because the
 * chat transcript is not an input.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  // Both checks, because they disagree: `isContentEditable` is the reliable one
  // in a browser, and the ATTRIBUTE is the one that survives in environments
  // that do not implement the property (jsdom among them) — and an editor that
  // silently stops being recognised as one starts swallowing shortcuts.
  const editable = el.getAttribute?.('contenteditable');
  if (editable !== null && editable !== undefined && editable !== 'false') return true;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

/**
 * The shortcuts dialog.
 *
 * A real modal: `role="dialog" aria-modal="true"`, focus moves in and is
 * trapped, Esc closes, and focus returns to whatever opened it. The panel
 * content is inert to the pointer — a modal that lets you click the page behind
 * it is a modal that lies.
 */
export default function KeyboardHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );

    focusables()[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      // Without this, Tab walks out of the dialog and into the page behind it.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Focus goes back where it came from, not to <body>.
      restoreRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shortcuts-head">
          <h2 className="shortcuts-title" id={titleId}>
            ⌨️ Keyboard shortcuts
          </h2>
          <button type="button" className="btn-secondary" onClick={onClose} aria-label="Close keyboard shortcuts">
            ✕ Close
          </button>
        </div>

        {SHORTCUTS.map((group) => (
          <section className="shortcuts-group" key={group.group}>
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
          </section>
        ))}

        <p className="shortcuts-note">
          Shortcuts are ignored while you are typing, so <kbd className="shortcuts-key">?</kbd> in a question stays
          a question mark.
        </p>
      </div>
    </div>
  );
}
