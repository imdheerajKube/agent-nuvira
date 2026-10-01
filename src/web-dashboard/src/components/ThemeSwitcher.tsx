import { useEffect, useId, useRef, useState } from 'react';
import {
  FONT_SCALES,
  MODES,
  PALETTES,
  PALETTE_LABELS,
  type FontScale,
  type Mode,
} from '../theme';
import { resetTheme, setTheme, useTheme } from '../useTheme';

const MODE_LABELS: Record<Mode, string> = { light: 'Light', dark: 'Dark' };
const SCALE_LABELS: Record<FontScale, string> = {
  100: '100%',
  112: '112%',
  125: '125%',
  150: '150%',
};

/**
 * Appearance: palette, mode, text size, accessibility mode.
 *
 * PATTERN — a disclosure, not a dialog. The panel is non-modal: the dashboard
 * stays usable behind it, so it needs no focus trap, and `aria-expanded` +
 * `aria-controls` is exactly what a screen reader expects from "a button that
 * revealed some content". A dialog role would promise modality this does not
 * have and leave a keyboard user looking for a way to escape it.
 *
 * WHY NATIVE CONTROLS. The palettes are real `<input type="radio">` inside a
 * real `<fieldset>` with a `<legend>`. That buys, for free, the three things a
 * hand-built widget usually gets wrong: NVDA and JAWS announce the group name
 * before the option ("Palette, Enterprise, radio button, 1 of 5"), arrow keys
 * move within a group, and the selection state is exposed natively rather than
 * inferred. The inputs are visually hidden but still focused, so focus is
 * painted onto the visible proxy beside them.
 *
 * KEYBOARD. Esc closes and hands focus back to the trigger, and tabbing out of
 * the panel closes it — so it never strands a keyboard user or traps them.
 */
export default function ThemeSwitcher() {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const panelId = `${baseId}-panel`;

  // Esc to close, and clicking anywhere outside to close.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      // Send focus back where it came from; otherwise it lands on <body> and the
      // next Tab restarts at the top of the document.
      triggerRef.current?.focus();
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (target && wrapperRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  // Put focus on the current selection when the panel opens, so a keyboard user
  // starts inside the thing they just revealed.
  useEffect(() => {
    if (!open) return;
    const selected = panelRef.current?.querySelector<HTMLElement>('input:checked');
    (selected ?? panelRef.current?.querySelector<HTMLElement>('input'))?.focus();
  }, [open]);

  const announcement =
    `${PALETTE_LABELS[theme.palette]} palette, ${MODE_LABELS[theme.mode].toLowerCase()} mode, ` +
    `text size ${SCALE_LABELS[theme.fontScale]}` +
    (theme.a11y ? ', accessibility mode on' : '');

  return (
    <div
      className="theme-switcher"
      ref={wrapperRef}
      onBlur={(event) => {
        // Tabbing past the last control should dismiss the panel — but ONLY a
        // real hand-off counts. A null relatedTarget must NOT close it.
        //
        // Chrome on macOS does not focus a form control on mouse-down, so
        // clicking one of these labels blurs the auto-focused input to <body>
        // with relatedTarget null — BEFORE the click/change that carries the
        // choice. Closing here unmounts the label mid-interaction, so mouseup
        // lands on a detached node and the radio never changes: the panel just
        // vanishes and nothing is selected. (Found only with real trusted input;
        // a synthetic .click() on the input skips the whole blur path.)
        //
        // Outside-click and Esc still close the panel, so ignoring a null
        // relatedTarget cannot strand it open.
        const next = event.relatedTarget as Node | null;
        if (next && !event.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        className="theme-trigger"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">🎨</span>
        <span>Appearance</span>
      </button>

      {open && (
        <div className="theme-panel" id={panelId} ref={panelRef}>
          <fieldset className="theme-group">
            <legend className="theme-group-label">Palette</legend>
            {PALETTES.map((palette) => (
              <label className="theme-option" key={palette}>
                <input
                  type="radio"
                  name={`${baseId}-palette`}
                  value={palette}
                  checked={theme.palette === palette}
                  onChange={() => setTheme({ palette })}
                />
                <span className="theme-swatch" data-swatch={palette} aria-hidden="true" />
                <span className="theme-option-label">{PALETTE_LABELS[palette]}</span>
              </label>
            ))}
          </fieldset>

          <fieldset className="theme-group">
            <legend className="theme-group-label">Mode</legend>
            {MODES.map((mode) => (
              <label className="theme-option" key={mode}>
                <input
                  type="radio"
                  name={`${baseId}-mode`}
                  value={mode}
                  checked={theme.mode === mode}
                  onChange={() => setTheme({ mode })}
                />
                <span className="theme-option-label">{MODE_LABELS[mode]}</span>
              </label>
            ))}
          </fieldset>

          <fieldset className="theme-group">
            <legend className="theme-group-label">Text size</legend>
            {FONT_SCALES.map((fontScale) => (
              <label className="theme-option" key={fontScale}>
                <input
                  type="radio"
                  name={`${baseId}-scale`}
                  value={fontScale}
                  checked={theme.fontScale === fontScale}
                  // Text size belongs to the accessibility layer: `resolveTheme`
                  // pins it to 100% while that layer is off, because a scale is
                  // help and would otherwise enlarge type for someone who never
                  // asked. So a size chosen here would be silently discarded —
                  // rather than ship a control that does nothing, asking for a
                  // larger size turns the layer on, which is the plain intent of
                  // the request. The switch below visibly flips, so the coupling
                  // is shown rather than hidden.
                  onChange={() => setTheme({ fontScale, a11y: theme.a11y || fontScale !== 100 })}
                />
                <span className="theme-option-label">{SCALE_LABELS[fontScale]}</span>
              </label>
            ))}
            {!theme.a11y && (
              <p className="theme-hint">
                A larger size turns on accessibility mode, which is what defines it.
              </p>
            )}
          </fieldset>

          <div className="theme-group">
            <label className="theme-switch">
              <input
                type="checkbox"
                checked={theme.a11y}
                onChange={(event) => setTheme({ a11y: event.target.checked })}
              />
              <span className="theme-switch-track" aria-hidden="true" />
              <span className="theme-option-label">Accessibility mode</span>
            </label>
            <p className="theme-hint">
              Larger targets, stronger borders and no motion. Off by default so it never
              changes the look for anyone who does not need it.
            </p>
          </div>

          <button type="button" className="theme-reset" onClick={resetTheme}>
            Reset to system default
          </button>

          {/* Announced after a change, so a screen-reader user hears the RESULT of
              their choice rather than only the name of the control they pressed. */}
          <p className="sr-only" role="status">
            {announcement}
          </p>
        </div>
      )}
    </div>
  );
}
