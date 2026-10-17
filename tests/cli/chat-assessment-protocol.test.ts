/**
 * The assessment protocol must reach the WIRE, and only for an assessment ask.
 *
 * The unit tests pin the classifier; this pins the two things only the real turn
 * can show:
 *
 *   1. An audit ask hands the model every evidence rule (rules 1-5 from the first
 *      side-by-side audit, 6-11 from the head-to-head one), on the messages the
 *      transport actually receives (not a block built and then dropped).
 *   2. The block rides in the USER turn, never in the system message. The stable
 *      system layer is the prompt-cache layer — the channel policy moved there for
 *      exactly that reason — so a per-ask rule set appended to it would make every
 *      audit turn a cache miss and change the system prompt of every other turn.
 *
 * The negative half is asserted too: an ordinary "fix this bug" turn must not
 * carry the protocol at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/cli/model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/model.js')>();
  return { ...actual, applyActiveModel: (options: { provider?: string; model?: string }) => options };
});

import { ChatCommand } from '../../src/cli/chat.js';
import { getCache } from '../../src/context/cache.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

type Proto = {
  getProvider: (o?: unknown) => Promise<{ type: string; provider: InferenceProvider }>;
  routeMessageAuto: (m: string) => Promise<{ type: string; provider: InferenceProvider; model?: string }>;
};

interface WireMessage {
  role: string;
  content: string;
}

/** A provider that records the messages each generation receives. */
function recordingProvider() {
  const seen: WireMessage[][] = [];
  const provider = {
    name: 'Mock',
    generateTools: vi.fn(async (messages: WireMessage[]) => {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      return { content: 'Assessment complete.', toolCalls: [] };
    }),
    generate: vi.fn().mockResolvedValue('Assessment complete.'),
    isAvailable: vi.fn().mockResolvedValue(true),
    getInfo: () => 'Mock',
    listModels: vi.fn().mockResolvedValue([]),
  } as unknown as InferenceProvider;
  return { provider, seen };
}

const AUDIT_ASK =
  'Assess the project in the current directory and identify the bugs in it. For every bug you find, ' +
  'report the file and line and a severity. Do not modify any files — this is an assessment only.';
const FIX_ASK = 'fix the bug in mathEngine.js';

describe('runChatAnswer — the assessment protocol reaches the wire', () => {
  let tempDir: string;
  let origMemory: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-assessment-protocol-'));
    origMemory = process.env.NUVIRA_MEMORY_DIR;
    origConfigDir = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (origMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = origMemory;
    if (origConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = origConfigDir;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function runTurn(ask: string): Promise<WireMessage[][]> {
    const { provider, seen } = recordingProvider();
    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider').mockResolvedValue({ type: 'deepseek', provider });
    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto').mockResolvedValue({
      type: 'deepseek',
      provider,
      model: 'deepseek-flash',
    });
    await (new ChatCommand() as unknown as { answerOnce: Function }).answerOnce(ask, {});
    return seen;
  }

  it('hands an audit ask every evidence rule', async () => {
    const seen = await runTurn(AUDIT_ASK);
    expect(seen.length).toBeGreaterThan(0);
    const all = seen.flat();
    const protocol = all.find((m) => m.content.includes('TASK PROTOCOL: PROJECT ASSESSMENT'));
    expect(protocol).toBeDefined();
    expect(protocol!.role).toBe('user');
    expect(protocol!.content).toContain('REACHABILITY BEFORE SEVERITY');
    expect(protocol!.content).toContain('QUANTIFY RESOURCE CLAIMS');
    expect(protocol!.content).toContain('GREEN TESTS ARE NOT COVERAGE');
    expect(protocol!.content).toContain('FINISH WHAT YOU REFERENCE');
    expect(protocol!.content).toContain('MEASURE THE ARTIFACT, NOT A COPY');
    expect(protocol!.content).toContain('CHECK THE SEAMS, NOT ONLY THE MODULES');
    expect(protocol!.content).toContain('RUN WHAT THE PROJECT ALREADY SHIPS');
    expect(protocol!.content).toContain('LEAVE THE TREE AS YOU FOUND IT');
    // The two ADDITIONS the shared seam carries, both proven on the wire rather
    // than assumed: this repository's own declared checks, and the bounded
    // performance probes that close the one class of claim nobody measured.
    expect(protocol!.content).toMatch(/This project's own checks/);
    expect(protocol!.content).toMatch(/Performance probes/);
  });

  it('keeps the stable system layer free of it (prompt-cache + every other turn)', async () => {
    const seen = await runTurn(AUDIT_ASK);
    const systemMessages = seen.flat().filter((m) => m.role === 'system');
    expect(systemMessages.length).toBeGreaterThan(0);
    for (const m of systemMessages) {
      expect(m.content).not.toContain('TASK PROTOCOL: PROJECT ASSESSMENT');
    }
  });

  it('does not inject the protocol for an ordinary change request', async () => {
    const seen = await runTurn(FIX_ASK);
    const all = seen.flat();
    expect(all.some((m) => m.content.includes('TASK PROTOCOL: PROJECT ASSESSMENT'))).toBe(false);
    // The ask itself still reaches the model untouched.
    expect(all.some((m) => m.content.includes(FIX_ASK))).toBe(true);
  });

  /**
   * An assessment must never be SERVED from the response cache.
   *
   * Observed live (2026-10-16): after a patched build was installed, the same audit
   * prompt in the same directory returned `cache.hit {chars:5744}` — the PRE-patch
   * report, identical down to a mid-sentence truncation, replayed as a fresh look at
   * the tree. The key is prompt + model + provider + workspace: exactly the set of
   * things that stays equal while the CODE changes underneath.
   *
   * Asserted by SPYING ON THE READ, not on the stored entry. Measured reason: this
   * harness never reaches the cache WRITE (the file is not even created), so an
   * assertion that "no entry was stored" would pass with the change reverted — a
   * vacuous test. The read gate is the half that decides whether a stale answer can
   * be replayed, and it IS reached on this path.
   */
  const spyOnCacheRead = () => {
    const cache = getCache();
    return vi.spyOn(cache, 'getEntry');
  };

  it('does not even LOOK in the response cache for an assessment ask', async () => {
    const read = spyOnCacheRead();
    await runTurn(AUDIT_ASK);
    expect(read).not.toHaveBeenCalled();
  });

  it('still consults the cache for an ordinary ask — the bypass is scoped to assessments', async () => {
    // The control: without it, the assertion above would pass if the cache were
    // simply unreachable on this path.
    const read = spyOnCacheRead();
    await runTurn(FIX_ASK);
    expect(read).toHaveBeenCalled();
  });
});
