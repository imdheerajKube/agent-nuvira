/**
 * I2 — Hook registry tests (Hermes hooks.py parity).
 *
 * Covers: register/run semantics (serially, best-effort), the event-bus
 * wiring (tool:called → post_tool_call; execute:completed/failed →
 * on_session_end), unsubscribe, and the built-in session logger.
 *
 * NOTE: the registry is a singleton (Hermes `hooks` module parity) without an
 * unregister — each test registers its OWN distinct handler function and
 * asserts on that function only, so leftover registrations from earlier
 * tests can never flip an assertion.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { hooks, installHooks, registerBuiltinHooks } from '../../src/gateway/hooks.js';
import { getEventBus, EventNames } from '../../src/observability/event-bus.js';

let activeUnsub: (() => void) | null = null;

afterEach(() => {
  activeUnsub?.();
  activeUnsub = null;
});

/** Install wiring once per test; returns a capture handler that is asserted on. */
function wiredHandler(event: 'post_tool_call' | 'on_session_end'): ReturnType<typeof vi.fn> {
  const handler = vi.fn();
  hooks.register(event, handler as any);
  activeUnsub = installHooks();
  return handler;
}

describe('hooks registry — register/run', () => {
  it('runs handlers serially with the event context (best-effort on throw)', async () => {
    const seen: string[] = [];
    hooks.register('post_tool_call', (ctx) => {
      seen.push(`a:${ctx.tool}`);
    });
    hooks.register('post_tool_call', () => {
      seen.push('b');
      throw new Error('handler boom');
    });
    hooks.register('post_tool_call', (ctx) => {
      seen.push(`c:${ctx.ok}`);
    });

    await hooks.run('post_tool_call', { tool: 'code_search', ok: true, durationMs: 3 });
    expect(seen).toEqual(['a:code_search', 'b', 'c:true']);
  });

  it('unregister removes a handler (dynamic lifecycle)', async () => {
    const handler = vi.fn();
    hooks.register('post_tool_call', handler as any);
    expect(hooks.list().post_tool_call).toBeGreaterThan(0);
    hooks.unregister('post_tool_call', handler as any);
    await hooks.run('post_tool_call', { tool: 'build', ok: true });
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

describe('event-bus wiring', () => {
  it('tool:called drives the post_tool_call hook', async () => {
    const handler = wiredHandler('post_tool_call');

    getEventBus().emit(EventNames.TOOL_CALLED, { tool: 'web_search', ok: false, error: 'net' });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'web_search', ok: false, error: 'net' }),
    );
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
    hooks.register('post_tool_call', handler as any);
    const unsub = installHooks();
    unsub();
    activeUnsub = null;

    getEventBus().emit(EventNames.TOOL_CALLED, { tool: 'build', ok: true });
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
