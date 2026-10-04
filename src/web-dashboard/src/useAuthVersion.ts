/**
 * useAuthVersion — re-read the admin session when the token changes.
 *
 * The login control lives in the shell (`AccountMenu`), but the pages that
 * GATE on the session (Chat, Admin, Agent Hub, Tasks, the env editors) each read
 * `/api/admin/auth-status` once when they mount and hold that answer in local
 * state. Signing in from the top bar therefore updated the top bar and nothing
 * else: a page that was already open — the Chat page most visibly — kept showing
 * its signed-out message, because nothing told it the session had changed.
 *
 * The token is the single source of truth for the session, and `setAdminToken`
 * is the single place it is written (login, setup, logout, and a 401 all pass
 * through it). So the signal is emitted there and this hook subscribes: add
 * `const authVersion = useAuthVersion()` to a component and put `authVersion` in
 * its auth effect's dependency list, and it re-reads on any sign in/out,
 * regardless of which control caused it.
 */

import { useEffect, useState } from 'react';
import { subscribeAuthVersion, getAuthVersion } from './api';

export function useAuthVersion(): number {
  const [version, setVersion] = useState(getAuthVersion);
  useEffect(() => subscribeAuthVersion(setVersion), []);
  return version;
}
