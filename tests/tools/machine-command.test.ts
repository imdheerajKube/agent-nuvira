/**
 * The long-tail OS command loop through `tool_search`.
 *
 * resolve checks a command/verb against THIS machine; record stores a command the
 * model derived; and a recorded command rides on the capability search so the
 * table grows by use. Isolated via `$NUVIRA_CONFIG_DIR`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getTool, type ToolContext } from '../../src/tools/registry.js';
import { detectMachineFacts } from '../../src/learning/machine-facts.js';

const ctx = {} as ToolContext;
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buff-machine-command-'));
  process.env.NUVIRA_CONFIG_DIR = dir;
});

afterEach(() => {
  delete process.env.NUVIRA_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: Record<string, unknown>) {
  const raw = await getTool('tool_search')!.run(args, ctx);
  return JSON.parse(String(raw)) as Record<string, any>;
}

describe('tool_search — action "resolve"', () => {
  it('checks a proposed command against the machine (presence is a fact)', async () => {
    const res = await run({ action: 'resolve', command: 'definitely-not-a-real-binary-xyz --go' });
    expect(res.os).toBe(detectMachineFacts().os);
    expect(Array.isArray(res.packageManagers)).toBe(true);
    expect(res.proposed.binary).toBe('definitely-not-a-real-binary-xyz');
    expect(res.proposed.present).toBe(false);
    expect(String(res.advice)).toContain('NOT on this machine');
  });

  it('says a known-present binary can run', async () => {
    // `node` is the process running this test, so it is on PATH by definition.
    const res = await run({ action: 'resolve', command: 'node --version' });
    expect(res.proposed.binary).toBe('node');
    expect(res.proposed.present).toBe(true);
    expect(String(res.advice)).toContain('can run');
  });

  it('reports when no command is known for a verb yet', async () => {
    const res = await run({ action: 'resolve', verb: 'frobnicate the widget' });
    expect(res.learned).toBeUndefined();
    expect(String(res.advice)).toContain('No command is known');
  });
});

describe('tool_search — action "record" / "list-commands" / "forget"', () => {
  it('records a derived command and offers it on the next resolve', async () => {
    const rec = await run({ action: 'record', verb: 'install java', command: 'brew install openjdk' });
    expect(rec.recorded.verb).toBe('install java');
    expect(rec.recorded.command).toBe('brew install openjdk');

    const res = await run({ action: 'resolve', verb: 'install java' });
    expect(res.learned.command).toBe('brew install openjdk');
    expect(res.learned.source).toBe('model');

    const list = await run({ action: 'list-commands' });
    expect(list.commands.some((c: { verb: string }) => c.verb === 'install java')).toBe(true);

    const forget = await run({ action: 'forget', verb: 'install java' });
    expect(forget.forgotten).toBe(true);

    const after = await run({ action: 'resolve', verb: 'install java' });
    expect(after.learned).toBeUndefined();
  });

  it('refuses a record with no verb or command', async () => {
    const rec = await run({ action: 'record', verb: 'install java' });
    expect(rec.recorded).toBeNull();
    expect(rec.error).toBeDefined();
  });
});

describe('tool_search — a learned command rides on the search', () => {
  it('surfaces learnedOnThisMachine for the capability ref it was recorded for', async () => {
    const os = detectMachineFacts().os;
    await run({ action: 'record', verb: 'install-system-tool', command: 'the-derived-install-command', os });

    const search = await run({ action: 'search', query: 'install a system tool' });
    const hit = search.capabilities.find((c: { id: string }) => c.id === 'action:install-system-tool');
    expect(hit).toBeTruthy();
    expect(hit.learnedOnThisMachine.command).toBe('the-derived-install-command');
    expect(hit.learnedOnThisMachine.source).toBe('model');
  });
});
