/**
 * G14 — WHERE a messaging turn works, when the sender attached nothing.
 *
 * A message carries no folder and no flags, so the gateway's answer to "where do
 * I put this file?" is the whole question. It used to be `ctx.cwd` — whatever
 * directory the gateway process happened to be started in — which meant a
 * \"create a script\" ask wrote into a tree belonging to nobody asking. The
 * replacement is a LADDER, and these cases pin its three outcomes from the
 * sender's side (what the model was handed, and what the reply says):
 *
 *   1. a folder named in the message wins (the sender's own project);
 *   2. a PRODUCE ask with no folder gets this contact's TEMPORARY workspace, and
 *      the reply says where the file went and how to keep it — a file the sender
 *      cannot find is the failure the rung exists to remove;
 *   3. a READ ask gets NO workspace and is told to ask for the real folder, and
 *      an ISOLATED turn is never handed a scratch folder at all (it has no base
 *      commit to diff against — see `scratchWorkspaceForTurn`).
 *
 * The engine is injected, so these are assertions about the OPTIONS the gateway
 * chose, read at the same seam every other surface uses.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GatewayRegistry } from '../../src/gateway/registry.js';
import type { ChannelAdapter, MessageHandler } from '../../src/gateway/adapters.js';
import { scratchWorkspaceFor } from '../../src/config/scratch-workspace.js';

let cfgDir: string;
let ORIG_CONFIG_DIR: string | undefined;
let ORIG_MEMORY_DIR: string | undefined;
let ORIG_ISOLATE: string | undefined;

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'buff-gw-ws-'));
  ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
  ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;
  ORIG_ISOLATE = process.env.NUVIRA_ISOLATE;
  process.env.NUVIRA_CONFIG_DIR = cfgDir;
  process.env.NUVIRA_MEMORY_DIR = join(cfgDir, 'memory');
  delete process.env.NUVIRA_ISOLATE;
  writeFileSync(
    join(cfgDir, 'buffconfig.json'),
    JSON.stringify({
      defaultProvider: 'local',
      providers: { local: { runner: 'ollama', model: 'x', baseUrl: 'http://127.0.0.1:9' } },
    }),
  );
});

afterEach(() => {
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIG_MEMORY_DIR;
  if (ORIG_ISOLATE === undefined) delete process.env.NUVIRA_ISOLATE;
  else process.env.NUVIRA_ISOLATE = ORIG_ISOLATE;
  rmSync(cfgDir, { recursive: true, force: true });
});

class RecordingAdapter implements ChannelAdapter {
  readonly platform = 'mock' as const;
  readonly configured = true;
  sent: string[] = [];
  describe(): string {
    return 'Recording (test)';
  }
  async start(_onMessage: MessageHandler): Promise<void> {}
  async stop(): Promise<void> {}
  async send(_channelId: string, text: string): Promise<boolean> {
    this.sent.push(text);
    return true;
  }
}

/** The options the engine was called with, and a turn that writes a file. */
interface SeenTurn {
  opts?: Record<string, unknown>;
}

function writingEngine(seen: SeenTurn) {
  return {
    answerOnce: async (
      _message: string,
      opts?: {
        onToolCall?: (phase: 'started' | 'called', info: { tool: string; ok?: boolean }) => void;
      },
    ) => {
      seen.opts = opts as unknown as Record<string, unknown>;
      opts?.onToolCall?.('started', { tool: 'write_file' });
      opts?.onToolCall?.('called', { tool: 'write_file', ok: true });
      return { content: 'Wrote it.', followups: [], provider: 'groq', model: 'stub', transport: 'native' as const };
    },
  };
}

async function drive(
  text: string,
  channelId: string,
): Promise<{ opts?: Record<string, unknown>; sent: string[] }> {
  const seen: SeenTurn = {};
  const registry = new GatewayRegistry({
    streamEvents: false,
    chatEngine: writingEngine(seen) as never,
    deliveryConfigDir: cfgDir,
  });
  const adapter = new RecordingAdapter();
  registry.register(adapter);
  await registry.handleInbound(
    { platform: 'mock', channelId, text, from: 'parity', senderId: 'parity' },
    { forceKind: 'chat' },
  );
  return { opts: seen.opts, sent: adapter.sent };
}

describe('GatewayRegistry — the workspace ladder for a message', () => {
  it('a PRODUCE ask with no folder runs in a TEMPORARY workspace the sender is told about', async () => {
    const { opts, sent } = await drive('write a python script that prints hello', 'ws-produce');
    const scratch = scratchWorkspaceFor('mock:ws-produce');

    // The turn was GIVEN the scratch folder as its project…
    expect(opts?.projectPath).toBe(scratch);
    expect(existsSync(scratch), 'the scratch folder was not created').toBe(true);
    // …the model was told what that folder is, so it does not present it as the
    // sender's project…
    expect(String(opts?.projectContext)).toMatch(/TEMPORARY workspace/);
    // …and the reply NAMES it, because the file is the deliverable and a path the
    // sender never sees is the whole defect this replaces.
    const reply = sent.join('\n');
    expect(reply).toContain(scratch);
    expect(reply).toMatch(/temporary workspace/i);
    expect(reply).toMatch(/Send me the folder path/);
  });

  it('a READ ask gets NO workspace and is told to ask for the real folder', async () => {
    const { opts, sent } = await drive('assess this project and tell me what is wrong', 'ws-read');

    // No scratch folder: it is EMPTY, so it holds none of the work this ask is
    // about — handing it over would be the silent-wrong-tree defect again.
    expect(opts?.projectPath).toBeUndefined();
    expect(opts?.unscopedWorkspace).toBe(true);
    expect(String(opts?.projectContext)).toMatch(/Ask the user for its path/);
    expect(existsSync(scratchWorkspaceFor('mock:ws-read'))).toBe(false);
    // Nothing was created, so no temporary-workspace caption belongs on the reply.
    expect(sent.join('\n')).not.toMatch(/temporary workspace/i);
  });

  it('an ISOLATED turn is never handed a scratch folder — isolation needs a real base commit', async () => {
    // The deployment asks for isolation through the environment (`NUVIRA_ISOLATE`),
    // which is how a surface with no command line is configured. A scratch folder
    // has no commit to diff against, so substituting one turns the isolation
    // request into a refusal; the turn keeps the surface's own directory instead.
    process.env.NUVIRA_ISOLATE = '1';
    const { opts } = await drive('write a python script that prints hello', 'ws-isolated');

    expect(opts?.projectPath).toBeUndefined();
    expect(existsSync(scratchWorkspaceFor('mock:ws-isolated'))).toBe(false);
  });

  it('plain chat is untouched: no folder, no scope warning, no path talk', async () => {
    const { opts, sent } = await drive('what is a monad', 'ws-chat');

    expect(opts?.projectPath).toBeUndefined();
    expect(opts?.projectContext).toBeUndefined();
    expect(opts?.unscopedWorkspace).toBeUndefined();
    expect(sent.join('\n')).not.toMatch(/temporary workspace/i);
  });
});
