/**
 * Chat focus mode store.
 *
 * The shell's chrome and the chat page's control read the SAME state, so the
 * rules worth pinning are small and unforgiving: the attribute must be written
 * before anything paints, `off` must never be a missing attribute (a stale `on`
 * is the only value that hides navigation), and a reload in the same tab must
 * come back to the mode while a new tab must not.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  __resetChatFocusForTests,
  isChatFocused,
  setChatFocus,
  toggleChatFocus,
} from './chat-focus';

const attr = () => document.documentElement.getAttribute('data-chat-focus');

afterEach(() => {
  __resetChatFocusForTests();
});

describe('chat focus mode', () => {
  it('writes an explicit on/off attribute, never a missing one', () => {
    expect(attr()).toBe('off');
    setChatFocus(true);
    expect(attr()).toBe('on');
    setChatFocus(false);
    expect(attr()).toBe('off');
  });

  it('persists the mode for this tab only, and reads it back', () => {
    setChatFocus(true);
    expect(sessionStorage.getItem('nuvira.dashboard.chat.focus')).toBe('on');
    // NOT localStorage. Some test runtimes expose one storage and not the other,
    // so the negative only runs where the API exists.
    if (typeof localStorage !== 'undefined') {
      expect(localStorage.getItem('nuvira.dashboard.chat.focus')).toBeNull();
    }

    setChatFocus(false);
    expect(sessionStorage.getItem('nuvira.dashboard.chat.focus')).toBeNull();
  });

  it('ignores a repeat and toggles from the current value', () => {
    setChatFocus(true);
    setChatFocus(true);
    expect(isChatFocused()).toBe(true);

    toggleChatFocus();
    expect(isChatFocused()).toBe(false);
    expect(attr()).toBe('off');
  });
});
