/**
 * I2 / WS4 (#26) — Hook registry tests.
 *
 * Covers: register/run semantics (serially, best-effort), the THREE tool phases
 * including the one that can stop a call (`before_tool_call` → `runBefore`), the
 * fail-open rule (a broken handler is REPORTED, never a veto), the event-bus
 * wiring that remains (execute:completed/failed → on_session_end), unsubscribe,
 * and the built-in session logger.
 *
 * WHY THERE IS NO LONGER A `tool:called` SUBSCRIPTION TO TEST. The tool phases
 * used to be driven off the event bus, which meant they only fired on a surface
 * that happened to put `tool:called` on it, could not stop a call, and would
 * double-fire once the execution seam (`src/tools/tool-loop.ts`) reported the
 * same call directly. A test asserting the subscription would pin exactly the
 * behaviour that made the capability unreachable, so the assertion is inverted
 * below: the bus must NOT reach a tool phase.
 *
 * NOTE: the registry is a singleton — each test registers its OWN distinct
 * handler function and asserts on that function only, so leftover registrations
 * from earlier tests can never flip an assertion.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { hooks, installHooks, registerBuiltinHooks } from '../../src/gateway/hooks.js';
import { getEventBus, EventNames } from '../../src/observability/event-bus.js';

let activeUnsub: (() => void) | null = null;

/**
 * Handlers this file registered on the before phase, removed after each test.
 *
 * The `before_tool_call` phase is the one where a leftover handler is not
 * harmless: `runBefore` returns the FIRST decision across every registered
 * handler, so an earlier test's deny would be the answer for every later one.
 */
const beforeHandlers: Array<(...args: never[]) => unknown> = [];

function registerBefore(handler: () => void | { deny: true; reason?: string; by?: string }): void {
  hooks.register('before_tool_call', handler as never);
  beforeHandlers.push(handler as never);
}

afterEach(() => {
  activeUnsub?.();
  activeUnsub = null;
  for (const handler of beforeHandlers.splice(0)) {
    hooks.unregister('before_tool_call', handler as never);
  }
});

/** Install wiring once per test; returns a capture handler that is asserted on. */
function wiredHandler(event: 'on_session_end'): ReturnType<typeof vi.fn> {
  const handler = vi.fn();
  hooks.register(event, handler as any);
  activeUnsub = installHooks();
  return handler;
}

describe('hooks registry — register/run', () => {
  it('runs handlers serially with the event context (best-effort on throw)', async () => {
    const seen: string[] = [];
    hooks.register('after_tool_call', (ctx) => {
      seen.push(`a:${ctx.tool}`);
    });
    hooks.register('after_tool_call', () => {
      seen.push('b');
      throw new Error('handler boom');
    });
    hooks.register('after_tool_call', (ctx) => {
      seen.push(`c:${ctx.ok}`);
    });

    await hooks.run('after_tool_call', { tool: 'code_search', ok: true, durationMs: 3 });
    expect(seen).toEqual(['a:code_search', 'b', 'c:true']);
  });

  it('tells the CALLER when a handler threw, because the seam fails open', async () => {
    // Without this the two cases are indistinguishable: a handler that silently
    // stopped working and one that approved everything.
    hooks.register('after_tool_call', () => {
      throw new Error('handler boom');
    });
    const problems: string[] = [];
    await hooks.run('after_tool_call', {
      tool: 'build',
      ok: true,
      report: (message) => problems.push(message),
    });
    expect(problems.join('\n')).toContain('handler boom');
  });

  it('unregister removes a handler (dynamic lifecycle)', async () => {
    const handler = vi.fn();
    hooks.register('after_tool_call', handler as any);
    expect(hooks.list().after_tool_call).toBeGreaterThan(0);
    hooks.unregister('after_tool_call', handler as any);
    await hooks.run('after_tool_call', { tool: 'build', ok: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('on_session_end handlers receive success + summary', async () => {
    const seen: Array<{ success: boolean; summary?: string }> = [];
    hooks.register('on_session_end', (ctx) => seen.push({ success: ctx.success, summary: ctx.summary }));
    await hooks.run('on_session_end', { success: true, summary: 'done' });
    await hooks.run('on_session_end', { success: false, summary: 'boom' });
    expect(seen).toEqual([
      { success: true, summary: 'done' },
      { success: false, summary: 'boom' },
    ]);
  });
});

describe('hooks registry — the veto (before_tool_call)', () => {
  it('returns the FIRST decision and never runs the later handlers', async () => {
    // A later handler cannot un-deny a call that has already been stopped, so it
    // must not be consulted at all — an ordering rule, not an optimization.
    const after = vi.fn(() => null);
    registerBefore(() => ({ deny: true, reason: 'no writes today', by: 'policy' }));
    registerBefore(after);

    const decision = await hooks.runBefore({ tool: 'edit_file' });
    expect(decision).toEqual({ deny: true, reason: 'no writes today', by: 'policy' });
    expect(after).not.toHaveBeenCalled();
  });

  it('allows the call when every handler returns nothing', async () => {
    registerBefore(() => undefined);
    expect(await hooks.runBefore({ tool: 'read_file' })).toBeNull();
  });

  it('is FAIL OPEN: a throwing handler is reported and the call is allowed', async () => {
    registerBefore(() => {
      throw new Error('policy exploded');
    });
    const problems: string[] = [];
    const decision = await hooks.runBefore({
      tool: 'read_file',
      report: (message) => problems.push(message),
    });
    expect(decision, 'a broken hook must never stop a call').toBeNull();
    expect(problems.join('\n')).toContain('policy exploded');
  });
});

describe('event-bus wiring', () => {
  it('does NOT drive a tool phase from the bus (the execution seam does)', async () => {
    // Both halves matter: the bus subscription would double-fire every hook on a
    // surface that also reports the call directly, and it is the reason the tool
    // phases used to reach the gateway and no other surface.
    const handler = vi.fn();
    hooks.register('after_tool_call', handler as any);
    hooks.register('failed_tool_call', handler as any);
    const unsub = installHooks();

    getEventBus().emit(EventNames.TOOL_CALLED, { tool: 'web_search', ok: false, error: 'net' });
    await new Promise((r) => setTimeout(r, 10));
    unsub();
    expect(handler).not.toHaveBeenCalled();
  });

  it('execute:completed drives on_session_end with success=true', async () => {
    const handler = wiredHandler('on_session_end');

    getEventBus().emit(EventNames.EXECUTE_COMPLETED, { success: true, summary: 'all green', goal: 'fix tests' });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, summary: 'all green', goal: 'fix tests' }),
    );
  });

  it('execute:failed drives on_session_end with success=false', async () => {
    const handler = wiredHandler('on_session_end');

    getEventBus().emit(EventNames.EXECUTE_FAILED, { error: 'budget exhausted' });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('unsubscribe stops the wiring', async () => {
    const handler = vi.fn();
    hooks.register('on_session_end', handler as any);
    const unsub = installHooks();
    unsub();
    activeUnsub = null;

    getEventBus().emit(EventNames.EXECUTE_COMPLETED, { success: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('built-in hooks', () => {
  it('registers the built-in session logger at module load (idempotent)', () => {
    registerBuiltinHooks();
    expect(hooks.list().on_session_end).toBeGreaterThanOrEqual(1);
  });
});
