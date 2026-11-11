/**
 * Federation server capacity + terminal-result tests.
 *
 * These exercise the two defects the ADG review called F1 and F2, with an
 * injected executor so nothing races a real agent run:
 *
 *   F2 — a node at capacity must answer 429 with a retry hint, not accept the
 *        work and silently slow every task down.
 *   F1 — a polling caller must be able to learn the TERMINAL verdict by task id;
 *        "not currently active" is not the same claim as "succeeded".
 */

import { describe, it, expect } from 'vitest';

import { createFederationServer } from '../../src/federation/server.js';
import type { DelegatedTaskExecutor, TaskResult } from '../../src/federation/protocol.js';

const SECRET = 'capacity-secret';

interface Harness {
  port: number;
  token: string;
  close: () => Promise<void>;
}

async function startServer(executor: DelegatedTaskExecutor, maxConcurrentTasks = 1): Promise<Harness> {
  const server = createFederationServer({
    secret: SECRET,
    port: 0,
    host: '127.0.0.1',
    maxConcurrentTasks,
    executor,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  const handshake = await fetch(`http://127.0.0.1:${port}/federation/handshake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, clientId: 'capacity-test', capabilities: ['writer'] }),
  });
  const body = (await handshake.json()) as { payload: { sessionToken: string } };

  return {
    port,
    token: body.payload.sessionToken,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function delegate(port: number, token: string, goal: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/federation/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ goal, agentType: 'writer', streamProgress: false }),
  });
}

function taskStatus(port: number, token: string, taskId: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/federation/task/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('Federation server — capacity (F2)', () => {
  it('rejects work past maxConcurrentTasks with 429 and a retry hint', async () => {
    let release: (result: TaskResult) => void = () => {};
    const executor: DelegatedTaskExecutor = (_request, taskId) =>
      new Promise<TaskResult>((resolve) => {
        release = (result) => resolve({ taskId, ...result });
      });

    const harness = await startServer(executor, 1);
    try {
      const first = await delegate(harness.port, harness.token, 'hold this task open');
      expect(first.status).toBe(202);
      const accepted = (await first.json()) as { payload: { taskId: string } };

      const second = await delegate(harness.port, harness.token, 'should be refused');
      expect(second.status).toBe(429);
      expect(second.headers.get('retry-after')).toBe('5');
      const refusal = (await second.json()) as {
        payload: { status: string; reason?: string; estimatedWaitMs?: number };
      };
      expect(refusal.payload.status).toBe('rejected');
      expect(refusal.payload.reason).toContain('capacity');
      expect(refusal.payload.estimatedWaitMs).toBe(5000);

      release({ success: true, summary: 'done', durationMs: 1 });
      await taskStatus(harness.port, harness.token, accepted.payload.taskId);
    } finally {
      await harness.close();
    }
  });
});

describe('Federation server — terminal results (F1)', () => {
  it('reports running, then the recorded failure, and frees the slot', async () => {
    let release: (result: TaskResult) => void = () => {};
    const executor: DelegatedTaskExecutor = (_request, taskId) =>
      new Promise<TaskResult>((resolve) => {
        release = (result) => resolve({ taskId, ...result });
      });

    const harness = await startServer(executor, 1);
    try {
      const acceptedResponse = await delegate(harness.port, harness.token, 'fail this task');
      expect(acceptedResponse.status).toBe(202);
      const { payload } = (await acceptedResponse.json()) as { payload: { taskId: string } };
      const taskId = payload.taskId;

      const running = await taskStatus(harness.port, harness.token, taskId);
      expect(running.status).toBe(200);
      expect(((await running.json()) as { payload: { status: string } }).payload.status).toBe('running');

      release({ success: false, summary: 'gate failed', error: 'tests failed', durationMs: 7 });

      let recorded: { success?: boolean; error?: string } = {};
      for (let i = 0; i < 40 && typeof recorded.success !== 'boolean'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const res = await taskStatus(harness.port, harness.token, taskId);
        recorded = ((await res.json()) as { payload: { success?: boolean; error?: string } }).payload;
      }

      // The verdict is the failure, not an inferred success.
      expect(recorded.success).toBe(false);
      expect(recorded.error).toBe('tests failed');

      // The slot is released, so the next packet is accepted.
      const next = await delegate(harness.port, harness.token, 'next packet');
      expect(next.status).toBe(202);
    } finally {
      await harness.close();
    }
  });

  it('answers 404 for a task id it never ran, rather than implying success', async () => {
    const executor: DelegatedTaskExecutor = async (_request, taskId) => ({
      taskId,
      success: true,
      summary: 'unused',
      durationMs: 0,
    });

    const harness = await startServer(executor, 2);
    try {
      const res = await taskStatus(harness.port, harness.token, 'fed-never-existed');
      expect(res.status).toBe(404);
    } finally {
      await harness.close();
    }
  });
});
