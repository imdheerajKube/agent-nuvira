/**
 * F1 regression: polling must never infer success.
 *
 * The old `delegateWithPolling` returned `{ success: true }` as soon as
 * `health.activeTasks === 0`, without ever fetching the task's result. With a
 * second task in flight, or after a failure, that reported delivery of work
 * that never happened. These tests pin the replacement: the caller gets the
 * task's OWN recorded verdict, or an explicit failure — never a guess.
 */

import { describe, it, expect, vi } from 'vitest';

import { FederationClient } from '../../src/federation/client.js';

function connectedClient(): FederationClient {
  const client = new FederationClient({
    host: '127.0.0.1',
    port: 8374,
    secret: 'test-secret',
    nodeId: 'test-node',
    taskTimeoutMs: 20_000,
  });
  // Bypass the handshake: these tests exercise the polling loop only.
  (client as unknown as { sessionToken: string }).sessionToken = 'token';
  (client as unknown as { status: string }).status = 'connected';
  return client;
}

function polling(client: FederationClient, impl: (path: string) => Promise<unknown>) {
  vi.spyOn(client as unknown as { makeRequest: (path: string) => Promise<unknown> }, 'makeRequest')
    .mockImplementation(impl as never);
  return (client as unknown as {
    delegateWithPolling: (r: { goal: string; agentType: string; timeoutMs?: number }) => Promise<{ success: boolean; summary: string }>;
  }).delegateWithPolling({ goal: 'do the thing', agentType: 'writer', timeoutMs: 20_000 });
}

describe('federation polling (F1)', () => {
  it('returns the recorded terminal failure instead of inferring success', async () => {
    const client = connectedClient();
    let statusCalls = 0;

    const result = await polling(client, async (path) => {
      if (path === '/federation/task') return { taskId: 't1', status: 'accepted' };
      statusCalls++;
      if (statusCalls === 1) return { status: 'running', taskId: 't1' };
      return { taskId: 't1', success: false, summary: '2 tests failed', durationMs: 42 };
    });

    expect(result.success).toBe(false);
    expect(result.summary).toBe('2 tests failed');
  }, 20_000);

  it('reports an unknown outcome instead of success when no result was recorded', async () => {
    const client = connectedClient();

    await expect(
      polling(client, async (path) => {
        if (path === '/federation/task') return { taskId: 't2', status: 'accepted' };
        throw new Error('Federation request failed (404): Unknown task: t2');
      }),
    ).rejects.toThrow(/unknown outcome/i);
  }, 20_000);

  it('surfaces a transport error rather than reading it as completion', async () => {
    const client = connectedClient();

    await expect(
      polling(client, async (path) => {
        if (path === '/federation/task') return { taskId: 't3', status: 'accepted' };
        throw new Error('Connection refused to 127.0.0.1:8374');
      }),
    ).rejects.toThrow(/Connection refused/);
  }, 20_000);

  it('surfaces a capacity rejection with its reason', async () => {
    const client = connectedClient();

    await expect(
      polling(client, async () => ({ taskId: '', status: 'rejected', reason: 'node at capacity (4/4 running)' })),
    ).rejects.toThrow(/capacity \(4\/4 running\)/);
  }, 20_000);
});
