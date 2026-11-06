/**
 * Chat focus mode — whether the conversation owns the whole window.
 *
 * WHY THIS IS A MODULE AND NOT COMPONENT STATE. The switch has to do two things
 * that live in different places: the Chat page draws the control and the
 * conversation, while the SHELL (top bar + navigation rail) has to step out of
 * the way. Chat is rendered inside `<Layout>` as `children`, so a `useState` in
 * either one cannot reach the other without threading a prop through the entire
 * route table. A module-level store is the same answer `useTheme.ts` gives for
 * the theme, and for the same reason: the state already has a home outside the
 * component tree.
 *
 * WHY THE DOM ATTRIBUTE. Hiding the chrome must not UNMOUNT it. The top bar owns
 * the live connection status and the navigation owns the drawer's focus state;
 * `display: none` keeps both intact (and keeps `Layout.test.tsx` honest, since
 * the controls it queries still exist). It also means the shell's CSS can react
 * without a re-render of the whole tree on every toggle.
 *
 * WHY sessionStorage, NOT localStorage. Focus is a WORKING MODE, not an
 * appearance preference — the same distinction the theme makes. A reload in the
 * same tab should come back to the conversation you were in (and does: ChatPage
 * resumes its active session from sessionStorage), while a new tab should open
 * the normal dashboard with its normal chrome, not inherit a full-screen state
 * from a tab you closed. It is deliberately NOT part of `ThemeState`: putting it
 * there would persist "the chat fills the window" as an appearance setting and
 * carry it onto pages that have no chat.
 */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'nuvira.dashboard.chat.focus';

function readStored(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    // Private mode / disabled storage: start unfocused rather than throw on boot.
    return false;
  }
}

let focused = readStored();
const listeners = new Set<() => void>();

/**
 * Put the state on `<html>`, where the stylesheet can see it.
 *
 * `off` is written explicitly rather than removing the attribute: one selector
 * (`[data-chat-focus='on']`) drives every override, so a stale `on` is the only
 * value that can break the layout, and it can never be left behind by a code
 * path that forgets to clean up.
 */
function paint(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-chat-focus', focused ? 'on' : 'off');
}

// Applied at import time, like the theme: the shell must not paint its chrome
// for a frame and then hide it. Layout imports this module, and Layout is
// imported by App, so this runs before the first render.
paint();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isChatFocused(): boolean {
  return focused;
}

export function setChatFocus(on: boolean): void {
  const next = Boolean(on);
  if (next === focused) return;
  focused = next;
  try {
    if (next) sessionStorage.setItem(STORAGE_KEY, 'on');
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* best-effort persistence — the mode still works for this page */
  }
  paint();
  emit();
}

export function toggleChatFocus(): void {
  setChatFocus(!focused);
}

/** The state in force right now, re-rendering the caller when it flips. */
export function useChatFocus(): boolean {
  return useSyncExternalStore(subscribe, isChatFocused, isChatFocused);
}

/**
 * Test seam only: forget both the in-memory state and the stored flag.
 *
 * A module-level store outlives `cleanup()`, exactly like the theme store, so a
 * test that focused the chat would otherwise leave the attribute on for the
 * next one. Exported (rather than reset in an `afterEach` inside the module)
 * because only the tests know when a boundary is.
 */
export function __resetChatFocusForTests(): void {
  focused = false;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  paint();
  emit();
}
