/**
 * Gateway chat turns report their TOOL lifecycle.
 *
 * The gateway used to pass no `onToolCall` to the shared chat engine, so a chat
 * turn that ran tools reported none: a `list_dir` that succeeded and one that
 * failed looked identical from the surface, and `tool-call-lifecycle@gateway-chat`
 * could not be proven. `runInboundChat` now wires the seam, records each executed
 * call's outcome on its own return, and writes the same list to the
 * `inbound.chat` log — where a messaging run has to live, since there is no
 * terminal to scroll afterwards.
 *
 * This is the direct unit test for that: the log record and the sender's view are
 * both asserted. The parity harness (`src/parity/drivers.ts`, run by the parity
 * suite and by `nuvira parity run`) proves the same facts against the other
 * surfaces.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GatewayRegistry } from '../../src/gateway/registry.js';
import type { ChannelAdapter, MessageHandler } from '../../src/gateway/adapters.js';
import { readGatewayLog } from '../../src/gateway/gateway-log.js';

const cfgDir = mkdtempSync(join(tmpdir(), 'buff-gw-tool-'));
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeAll(() => {
  process.env.NUVIRA_CONFIG_DIR = cfgDir;
  process.env.NUVIRA_MEMORY_DIR = join(cfgDir, 'memory');
  writeFileSync(
    join(cfgDir, 'buffconfig.json'),
    JSON.stringify({
      defaultProvider: 'local',
      providers: { local: { runner: 'ollama', model: 'x', baseUrl: 'http://127.0.0.1:9' } },
    }),
  );
});

afterAll(() => {
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIG_MEMORY_DIR;
  rmSync(cfgDir, { recursive: true, force: true });
});

class RecordingAdapter implements ChannelAdapter {
  readonly platform = 'mock' as const;
  readonly configured = true;
  sent: string[] = [];
  private handler: MessageHandler | null = null;
  describe(): string {
    return 'Recording (test)';
  }
  async start(onMessage: MessageHandler): Promise<void> {
    this.handler = onMessage;
  }
  async stop(): Promise<void> {
    this.handler = null;
  }
  async send(_channelId: string, text: string): Promise<boolean> {
    this.sent.push(text);
    return true;
  }
}

/** A chat engine that reports one successful tool call and the attribution triple. */
function toolReportingEngine() {
  return {
    answerOnce: async (
      _message: string,
      opts?: {
        onToolCall?: (
          phase: 'started' | 'called',
          info: { tool: string; ok?: boolean },
        ) => void;
      },
    ) => {
      opts?.onToolCall?.('started', { tool: 'list_dir' });
      opts?.onToolCall?.('called', { tool: 'list_dir', ok: true });
      return {
        content: 'Listed.',
        followups: [],
        provider: 'groq',
        model: 'parity-stub-model',
        transport: 'native' as const,
      };
    },
  };
}

describe('GatewayRegistry — chat tool lifecycle', () => {
  it('records each executed call and its outcome, and never leaks it to the sender', async () => {
    const registry = new GatewayRegistry({
      streamEvents: false,
      chatEngine: toolReportingEngine() as never,
      deliveryConfigDir: cfgDir,
    });
    const adapter = new RecordingAdapter();
    registry.register(adapter);

    await registry.handleInbound(
      {
        platform: 'mock',
        channelId: 'tool-lifecycle-1',
        text: 'list the working directory',
        from: 'parity',
        senderId: 'parity',
      },
      { forceKind: 'chat' },
    );

    const record = readGatewayLog(50).find(
      (r) => r.event === 'inbound.chat' && r.channelId === 'tool-lifecycle-1',
    );
    expect(record, 'the gateway did not record the chat turn').toBeDefined();
    // Attribution still lands (run-attribution)…
    expect(record).toMatchObject({ provider: 'groq', model: 'parity-stub-model', transport: 'native' });
    // …and now the tool lifecycle does too: the call AND its outcome, in order.
    expect(record?.toolCalls).toEqual([{ tool: 'list_dir', ok: true }]);
    // The lifecycle is internal: the sender gets the answer, not a tool frame.
    expect(adapter.sent.some((s) => s.includes('list_dir'))).toBe(false);
    expect(adapter.sent.some((s) => s.includes('Listed.'))).toBe(true);
  });
});
