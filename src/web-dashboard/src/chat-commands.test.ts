/**
 * The chat command queue.
 *
 * The bug this exists to prevent is small and silent: the palette navigates to
 * `/chat`, the page is not mounted yet, and the intent is dropped. So the tests
 * pin the two halves separately — delivered immediately to a live page, and held
 * for a page that has not mounted.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  __resetChatCommandsForTests,
  onChatCommand,
  requestChatCommand,
  takePendingChatCommands,
} from './chat-commands';

afterEach(() => {
  __resetChatCommandsForTests();
});

describe('chat command queue', () => {
  it('delivers to a mounted page immediately, and does not also queue it', () => {
    const listener = vi.fn();
    onChatCommand(listener);

    requestChatCommand('new-chat');
    expect(listener).toHaveBeenCalledWith('new-chat');
    expect(takePendingChatCommands()).toEqual([]);
  });

  it('holds a command for a page that has not mounted, and hands it over once', () => {
    requestChatCommand('attach-project');
    expect(takePendingChatCommands()).toEqual(['attach-project']);
    // Taking is destructive: a reload later must not replay the intent.
    expect(takePendingChatCommands()).toEqual([]);
  });

  it('fans out to every mounted listener', () => {
    const first = vi.fn();
    const second = vi.fn();
    onChatCommand(first);
    onChatCommand(second);

    requestChatCommand('attach-project');
    expect(first).toHaveBeenCalledWith('attach-project');
    expect(second).toHaveBeenCalledWith('attach-project');
  });

  it('stops delivering after unsubscribe', () => {
    const listener = vi.fn();
    const off = onChatCommand(listener);
    off();

    requestChatCommand('new-chat');
    expect(listener).not.toHaveBeenCalled();
    // With nobody listening it is queued for the next mount instead.
    expect(takePendingChatCommands()).toEqual(['new-chat']);
  });
});
