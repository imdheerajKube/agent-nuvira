/**
 * G13 — the loop engine must not ask permission for work the request already
 * authorized.
 *
 * Two mechanisms are pinned here, both through the REAL registry tools:
 *
 *   1. `write_file` CREATING a file the request asked for is applied directly
 *      (the confirm gate's actual safety property — never clobber existing work
 *      without a human — is untouched).
 *   2. `ask_user` refuses a reflexive permission question about authorized work
 *      instead of turning it into a message to the user, while a question that
 *      names an IRREVERSIBLE action still reaches them.
 *
 * Hermetic: a temp workspace, no network, no TTY.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getTool, type ToolContext } from '../../src/tools/registry.js';
import { requestAuthorizesWrites } from '../../src/learning/autonomy-policy.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nuvira-autonomy-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The verdict the loop derives from the user's request (see tool-loop.ts). */
function auth(request: string): ToolContext['writesAuthorized'] {
  return requestAuthorizesWrites(request);
}

const STORY_ASK = 'write a 12 page story called Kharig Nights about a village boy who finds a lamp';

async function callWriteFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const tool = getTool('write_file');
  if (!tool) throw new Error('write_file not registered');
  return tool.run(args, ctx);
}

describe('write_file — authorized creation needs no round trip', () => {
  it('creates a file the request asked for, without confirm', async () => {
    const ctx: ToolContext = { configManager: {}, cwd: root, writesAuthorized: auth(STORY_ASK) };
    const result = await callWriteFile({ path: 'chapters/01-chapter-1.md', content: 'Chapter one prose.' }, ctx);

    expect(existsSync(join(root, 'chapters/01-chapter-1.md'))).toBe(true);
    expect(readFileSync(join(root, 'chapters/01-chapter-1.md'), 'utf-8')).toBe('Chapter one prose.');
    expect(result).toContain("created 'chapters/01-chapter-1.md'");
    // Reported, never silent — the model is told to state the decision.
    expect(result).toContain('Applied without asking');
  });

  it('still refuses without confirm when the request did NOT authorize writes', async () => {
    const ctx: ToolContext = { configManager: {}, cwd: root, writesAuthorized: auth('what does the writer agent do?') };
    const result = await callWriteFile({ path: 'chapters/01-chapter-1.md', content: 'x' }, ctx);

    expect(existsSync(join(root, 'chapters/01-chapter-1.md'))).toBe(false);
    expect(result).toContain('state-changing — NOT applied');
    expect(result).toContain('ask_user');
  });

  it('still refuses when there is no loop context at all (back-compat)', async () => {
    const ctx: ToolContext = { configManager: {}, cwd: root };
    const result = await callWriteFile({ path: 'x.md', content: 'x' }, ctx);
    expect(existsSync(join(root, 'x.md'))).toBe(false);
    expect(result).toContain('state-changing — NOT applied');
  });

  it('still refuses to OVERWRITE existing content the request asked for', async () => {
    const existing = join(root, 'kharig-nights.md');
    const ctx: ToolContext = { configManager: {}, cwd: root, writesAuthorized: auth(STORY_ASK) };
    // The first write creates it (authorized) …
    await callWriteFile({ path: 'kharig-nights.md', content: 'first draft' }, ctx);
    // … and the second must NOT silently replace it — a re-run cannot recover it.
    const second = await callWriteFile({ path: 'kharig-nights.md', content: 'overwritten' }, ctx);

    expect(second).toContain('state-changing — NOT applied');
    expect(readFileSync(existing, 'utf-8')).toBe('first draft');
  });

  it('honours an explicit confirm:true as before', async () => {
    const ctx: ToolContext = { configManager: {}, cwd: root, writesAuthorized: auth(STORY_ASK) };
    await callWriteFile({ path: 'kharig-nights.md', content: 'first draft' }, ctx);
    const second = await callWriteFile({ path: 'kharig-nights.md', content: 'approved', confirm: true }, ctx);

    expect(second).toContain("overwrote 'kharig-nights.md'");
    expect(readFileSync(join(root, 'kharig-nights.md'), 'utf-8')).toBe('approved');
  });

  it('emits an audit event when it decides autonomously', async () => {
    const emit = vi.fn();
    const ctx: ToolContext = { configManager: {}, cwd: root, writesAuthorized: auth(STORY_ASK), emit };
    await callWriteFile({ path: 'chapter.md', content: 'x' }, ctx);

    expect(emit).toHaveBeenCalledWith(
      'autonomy:write-applied',
      expect.objectContaining({ tool: 'write_file', path: 'chapter.md' }),
      'tool-loop',
    );
  });
});

describe('ask_user — no message to the user for authorized work', () => {
  async function callAskUser(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const tool = getTool('ask_user');
    if (!tool) throw new Error('ask_user not registered');
    return tool.run(args, ctx);
  }

  it('suppresses a reflexive permission question (never reaches the user)', async () => {
    const askUser = vi.fn(async () => ({ answer: 'Yes', index: 0 }));
    const ctx: ToolContext = { configManager: {}, cwd: root, writesAuthorized: auth(STORY_ASK), askUser };

    const result = await callAskUser(
      {
        question: 'Do you want me to create the full project structure with all the chapter files?',
        choices: [{ label: 'Yes, create it' }, { label: 'No' }],
      },
      ctx,
    );

    expect(askUser).not.toHaveBeenCalled();
    expect(result).toContain('Not shown to the user');
    expect(result).toContain('Recommended default: "Yes, create it"');
  });

  it('still reaches the user for an IRREVERSIBLE choice', async () => {
    const askUser = vi.fn(async () => ({ answer: 'No', index: 1 }));
    const ctx: ToolContext = { configManager: {}, cwd: root, writesAuthorized: auth(STORY_ASK), askUser };

    const result = await callAskUser(
      {
        question: 'Do you want me to overwrite the existing kharig-nights.md?',
        choices: [{ label: 'Overwrite' }, { label: 'Keep both' }],
      },
      ctx,
    );

    expect(askUser).toHaveBeenCalledTimes(1);
    expect(result).toContain('User answered: No');
  });

  it('still reaches the user for a genuine question about unrequested work', async () => {
    const askUser = vi.fn(async () => ({ answer: 'Python', index: 0 }));
    const ctx: ToolContext = {
      configManager: {},
      cwd: root,
      writesAuthorized: auth('what does the writer agent do?'),
      askUser,
    };

    const result = await callAskUser(
      { question: 'Which runtime should I use?', choices: [{ label: 'Python' }, { label: 'Node' }] },
      ctx,
    );

    expect(askUser).toHaveBeenCalledTimes(1);
    expect(result).toContain('User answered: Python');
  });
});
