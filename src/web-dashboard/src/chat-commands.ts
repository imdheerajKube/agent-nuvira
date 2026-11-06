/**
 * Commands the shell can send to the chat page.
 *
 * WHY A QUEUE, AND NOT A PROP. The palette lives in `Layout`; the actions it now
 * offers ("start a new chat", "attach a project folder") belong to `ChatPage`,
 * which is mounted as `children` — one level deeper, behind the persistent
 * `display: none` wrapper App uses to keep a turn's SSE stream alive. Threading a
 * callback through the route table for two actions would couple the shell to the
 * page's internals; a queue keeps the shell able to say WHAT it wants and the page
 * the one deciding how to do it.
 *
 * WHY IT MUST QUEUE AT ALL. `⌘K → Start a new chat` navigates to `/chat`, but the
 * page is not mounted yet when the palette runs the action (App mounts it the
 * first time the route is reached). A plain event fired at that moment lands on
 * nobody. So a command with no listener waits, and the page consumes it when it
 * mounts. When the page IS open, the listener runs immediately — the two paths
 * share one implementation instead of a second, racy "navigate then dispatch".
 *
 * DELIVERY IS AT-LEAST-ONCE PER REQUEST AND AT-MOST-ONCE PER LISTENER: a command
 * is handed to every current subscriber, and kept only if there are none. It is
 * not a broadcast history — replaying old intents on every remount would start a
 * new chat each time the user came back to the tab.
 */

export type ChatCommand = 'new-chat' | 'attach-project';

let pending: ChatCommand[] = [];
const listeners = new Set<(command: ChatCommand) => void>();

/** Ask the chat page to do something, now if it is open, later if it is not. */
export function requestChatCommand(command: ChatCommand): void {
  if (listeners.size > 0) {
    for (const listener of listeners) listener(command);
    return;
  }
  pending.push(command);
}

/**
 * Take the commands waiting for a page that is about to mount.
 *
 * Called once per mount, before the page's own resume logic runs: a pending
 * `new-chat` has to win over restoring the conversation from sessionStorage, or
 * the page would resume the very chat the user asked to replace.
 */
export function takePendingChatCommands(): ChatCommand[] {
  if (pending.length === 0) return [];
  const taken = pending;
  pending = [];
  return taken;
}

/** Subscribe a mounted page. Returns the unsubscribe. */
export function onChatCommand(listener: (command: ChatCommand) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: module state outlives cleanup, like the theme and focus stores. */
export function __resetChatCommandsForTests(): void {
  pending = [];
  listeners.clear();
}
