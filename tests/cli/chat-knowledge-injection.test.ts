/**
 * The knowledge pre-step at the REAL seam (`ChatCommand.runChatAnswer`).
 *
 * This is the capability guarantee, measured on the thread the model actually
 * receives rather than on the builder in isolation. A `#tag` marker is the only
 * thing that can put knowledge in a turn, and when it is absent — or names a tag
 * the user does not have — the turn must carry no knowledge and no passage
 * labelled as the user's own data.
 *
 * The retrieval-ON half (a resolvable tag that matches) is covered with an
 * injected embedder in `tests/learning/knowledge-turn.test.ts`; here every case
 * stays on the paths that never touch the embedder, so this suite is hermetic
 * and offline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatCommand } from '../../src/cli/chat.js';
import { ingestKnowledge } from '../../src/learning/knowledge-base.js';
import { resetVectorBackendSelection } from '../../src/memory/vector-store.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import type { InferenceProvider, ToolMessage } from '../../src/inference/interface.js';

interface Captured {
  messages: ToolMessage[];
}

/** A mock provider that records the messages it was handed. */
function mockProvider(captured: Captured): InferenceProvider {
  return {
    name: 'Mock',
    generateTools: vi.fn(async (messages: ToolMessage[]) => {
      if (captured.messages.length === 0) captured.messages = messages;
      return { content: 'ok', toolCalls: [] };
    }),
    generate: vi.fn().mockResolvedValue('unused'),
    isAvailable: vi.fn().mockResolvedValue(true),
    getInfo: () => 'Mock',
    listModels: vi.fn().mockResolvedValue([]),
  } as unknown as InferenceProvider;
}

async function runTurn(message: string, captured: Captured): Promise<void> {
  const provider = mockProvider(captured);
  const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
  await cmd.runChatAnswer(
    message,
    [],
    { type: 'groq', provider, model: 'mock-model' },
    {},
    false,
    { auto: false },
  );
}

/** Every message body in the turn, joined — the model's whole view. */
const view = (captured: Captured): string => captured.messages.map((m) => m.content ?? '').join('\n');
const systemPrompt = (captured: Captured): string =>
  captured.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');

describe('knowledge pre-step — inert unless the message opens with a tag', () => {
  let tempDir: string;
  let originalMemoryDir: string | undefined;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-chat-knowledge-'));
    originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    originalConfigDir = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    resetModelRegistry();
    resetVectorBackendSelection();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
    if (originalConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = originalConfigDir;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Materialize a real tag, so "no injection" is not mere absence of data. */
  async function seedSpecTag(): Promise<void> {
    const docPath = join(tempDir, 'spec.md');
    writeFileSync(docPath, 'The auth flow refreshes tokens 5 minutes before expiry.', 'utf-8');
    await ingestKnowledge('spec', [docPath], { embedFn: async () => new Array(384).fill(0.1) });
  }

  it('carries NO knowledge for a plain message, even when tags exist', async () => {
    await seedSpecTag();
    const captured: Captured = { messages: [] };
    await runTurn('how does the auth flow work?', captured);

    expect(view(captured)).not.toContain('[Knowledge]');
    expect(view(captured)).not.toContain('knowledge tag');
    expect(view(captured)).not.toContain('USER DATA');
  });

  it('carries NO knowledge for a stray leading `#word` when the user has no tags', async () => {
    const captured: Captured = { messages: [] };
    await runTurn('#include <stdio.h>\nwhy does this not compile?', captured);

    expect(view(captured)).not.toContain('[Knowledge]');
    expect(view(captured)).not.toContain('USER DATA');
  });

  it('suggests rather than serving when the marker names a tag the user does not have', async () => {
    await seedSpecTag();
    const captured: Captured = { messages: [] };
    await runTurn('#specp tell me about the auth flow', captured);

    expect(view(captured)).toContain("No knowledge tag '#specp'");
    expect(view(captured)).toContain('#spec');
    // Nothing was retrieved, so nothing is presented as the user's own data.
    expect(view(captured)).not.toContain('USER DATA');
  });

  it('never touches the stable layer — the marker changes the context, not the persona', async () => {
    await seedSpecTag();
    const plain: Captured = { messages: [] };
    const marked: Captured = { messages: [] };
    await runTurn('how does the auth flow work?', plain);
    await runTurn('#nope how does the auth flow work?', marked);

    // The block is a user-turn message, so the system prompt is byte-identical:
    // persona, tool contract and reasoning instructions are untouched, and the
    // prompt stays cacheable.
    expect(systemPrompt(marked)).toBe(systemPrompt(plain));
    expect(systemPrompt(marked)).not.toContain('[Knowledge]');
  });
});
