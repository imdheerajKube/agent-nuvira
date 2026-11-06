/**
 * React binding for the theme.
 *
 * `theme.ts` owns the theme itself — validation, persistence, and the attributes
 * on `<html>`. What it cannot provide is a way for components to RE-RENDER when
 * the theme changes, because the theme deliberately lives outside the component
 * tree (on the element, and in localStorage). So the switcher would write a new
 * palette to `<html>`, restyle the whole dashboard, and keep rendering its own
 * stale selection.
 *
 * A module-level store rather than React context, for the same reason: the theme
 * already has a home, and a context would be a second source of truth that can
 * disagree with the DOM — which is how you get a control that shows "Dark" while
 * the page is light.
 */

import { useSyncExternalStore } from 'react';
import {
  applyTheme,
  loadTheme,
  resolveTheme,
  saveTheme,
  systemDefaultTheme,
  type ThemeState,
} from './theme';

let current: ThemeState = loadTheme();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The theme in force right now. */
export function getTheme(): ThemeState {
  return current;
}

/**
 * Apply a change, persist it, and notify subscribers.
 *
 * `resolveTheme` validates each field, so an unknown palette from a stale build
 * is ignored rather than written to the DOM. An update that changes nothing is
 * dropped: re-applying the attributes and re-writing localStorage on every
 * click, including clicks on the already-selected radio, is pointless work.
 */
export function setTheme(patch: Partial<ThemeState>): void {
  const next = resolveTheme(current, patch);
  const unchanged =
    next.palette === current.palette &&
    next.mode === current.mode &&
    next.a11y === current.a11y &&
    next.fontScale === current.fontScale &&
    next.glass === current.glass &&
    next.compact === current.compact &&
    next.motion === current.motion;
  if (unchanged) return;

  current = next;
  applyTheme(current);
  saveTheme(current);
  emit();
}

/** Forget the stored choice and go back to what the OS asks for. */
export function resetTheme(): void {
  current = systemDefaultTheme();
  applyTheme(current);
  saveTheme(current);
  emit();
}

/**
 * Follow the OS while `mode` is `system`.
 *
 * The resolution itself is synchronous and lives in `theme.ts`; what this adds is
 * the REACTION. Without it, `system` would behave exactly like a frozen snapshot
 * of the OS at load time: a machine that switches to dark at sunset would keep a
 * light dashboard until the next reload, which is the bug a `system` option is
 * supposed to fix. `applyTheme` re-resolves `data-mode` from `matchMedia`, so
 * there is no second copy of the rule here.
 *
 * Sits at module scope because there is exactly one document; a component effect
 * would register and drop a listener every time the switcher mounted.
 */
function watchSystemMode(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (current.mode !== 'system') return;
    applyTheme(current);
    // The switcher's announcement says which mode is in force, so it has to be
    // told that the RESOLUTION changed even though the choice did not.
    emit();
  };
  if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
  // Older Safari only has the deprecated form, and it is still the only one there.
  else query.addListener?.(onChange);
}

watchSystemMode();

/** The theme, re-rendering the caller whenever it changes. */
export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}
