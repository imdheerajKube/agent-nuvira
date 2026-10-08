/**
 * Cluster G — a turn with NO workspace must ASK where the file goes.
 *
 * The dashboard chat can run with nothing attached: no folder in the request,
 * none attached earlier in the conversation, none named in the user's message,
 * and no configured `dashboard.cwd`. Its `ctx.cwd` then falls back to the
 * directory the DASHBOARD PROCESS was started from — a deployment directory
 * that belongs to nobody asking the question.
 *
 * Two things had to be true, and each is a test below:
 *
 * 1. A write must NOT land there silently. Before this, an ask that slipped past
 *    the turn-level workspace guard (one with no project noun and no file noun,
 *    e.g. "create a react app") ran and the model wrote `package.json` into
 *    whatever directory the dashboard happened to be started from.
 * 2. The refusal must be an ASK, not a dead end. The user's own words: "we can
 *    gently ask before file write if folder is not attached and as user gives
 *    folder either path via chat … we can use it". So the result names the
 *    exact `ask_user` to make, and a folder the user then names in their REPLY
 *    is ADOPTED as the workspace — `ctx.cwd` moves, the flag clears, and the
 *    retry lands inside the folder instead of failing the same way again.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { runWriteFile, runEditFile } from '../../src/tools/coding-tools.js';
import { getTool } from '../../src/tools/registry.js';
import type { ToolContext } from '../../src/tools/registry.js';

let root: string;
/** The "server cwd" — must never receive the file. */
let serverCwd: string;
/** The folder the user names in their reply. */
let chosen: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'buff-unscoped-'));
  serverCwd = join(root, 'server-cwd');
  chosen = join(root, 'chosen-project');
  mkdirSync(serverCwd, { recursive: true });
  mkdirSync(chosen, { recursive: true });
  writeFileSync(join(chosen, 'index.ts'), 'export const a = 1;\nexport const b = 2;\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('write_file / edit_file with an unscoped workspace', () => {
  it('refuses to write, and does not touch the server cwd', async () => {
    const ctx: ToolContext = { configManager: {}, cwd: serverCwd, workspaceUnscoped: true };
    const out = await runWriteFile({ path: 'app/package.json', content: '{}' }, ctx);

    expect(out).toContain('no project folder is attached');
    expect(out).toContain('nothing was written');
    expect(existsSync(join(serverCwd, 'app', 'package.json'))).toBe(false);
  });

  it('asks, naming ask_user and the ways out — not a bare refusal', async () => {
    const ctx: ToolContext = { configManager: {}, cwd: serverCwd, workspaceUnscoped: true };
    const out = await runWriteFile({ path: 'index.html', content: '<html></html>' }, ctx);

    expect(out).toContain('ask_user');
    // The reply path is what makes the ask survivable — the user types a folder
    // and the NEXT write must land in it.
    expect(out).toMatch(/absolute path in their reply/i);
    // And the model must not claim success.
    expect(out).toMatch(/do NOT say the file was created/i);
  });

  it('refuses an edit too, and a dry_run is still allowed (it writes nothing)', async () => {
    const ctx: ToolContext = { configManager: {}, cwd: serverCwd, workspaceUnscoped: true };
    const out = await runEditFile({ path: 'index.ts', old_string: 'a', new_string: 'b' }, ctx);
    expect(out).toContain('no project folder is attached');
    expect(existsSync(join(serverCwd, 'index.ts'))).toBe(false);

    const dry = await runEditFile(
      { path: 'index.ts', old_string: 'a', new_string: 'b', dry_run: true },
      ctx,
    );
    // A dry run only read a (missing) file — it must not report the WORKSPACE
    // problem, which would be a lie about why nothing was written.
    expect(dry).not.toContain('no project folder is attached');
  });

  it('a SCOPED turn is untouched — the flag is the only gate', async () => {
    // `confirm: true` puts the autonomy gate aside so this test measures the
    // WORKSPACE gate alone; that gate is a different feature with its own tests.
    const ctx: ToolContext = { configManager: {}, cwd: chosen };
    const out = await runWriteFile(
      { path: 'new.ts', content: 'export const x = 1;\n', confirm: true },
      ctx,
    );
    expect(out).toContain("created 'new.ts'");
    expect(readFileSync(join(chosen, 'new.ts'), 'utf-8')).toContain('export const x = 1;');
  });
});

describe('ask_user adopts a folder the user names in their reply', () => {
  /**
   * Drive the registered ask_user tool with a stubbed renderer.
   *
   * The SAME `ctx` object must go in: adoption mutates it (`ctx.cwd`, the
   * unscoped flag), exactly as the loop's context is shared across steps — the
   * `clone_repo` precedent. A copy would test nothing.
   */
  async function ask(ctx: ToolContext, reply: { answer: string; index: number; custom?: string }) {
    const tool = getTool('ask_user')!;
    ctx.askUser = async () => reply;
    return tool.run(
      {
        question: 'Which folder should I create the app in?',
        choices: [{ label: 'Attach a folder in the dashboard' }, { label: 'Cancel' }],
        multi_select: false,
      },
      ctx,
    );
  }

  it('adopts the directory the user typed, and says the retry will now work', async () => {
    const ctx: ToolContext = { configManager: {}, cwd: serverCwd, workspaceUnscoped: true };
    const out = await ask(ctx, { answer: 'Cancel', index: 1, custom: `use ${chosen}` });

    expect(String(out)).toContain(`Workspace adopted: '${chosen}'`);
    expect(ctx.cwd).toBe(chosen);
    expect(ctx.workspaceUnscoped).toBe(false);
  });

  it('after adoption the very same write succeeds inside the chosen folder', async () => {
    const ctx: ToolContext = { configManager: {}, cwd: serverCwd, workspaceUnscoped: true };
    // The reply names the folder in a sentence, as a person would type it.
    await ask(ctx, { answer: 'Cancel', index: 1, custom: `use this one: ${chosen}` });

    const out = await runWriteFile(
      { path: 'app/index.html', content: '<html></html>', confirm: true },
      ctx,
    );
    // The reported path carries the platform separator (Windows: `app\index.html`).
    expect(out).toContain(`created '${join('app', 'index.html')}'`);
    expect(existsSync(join(chosen, 'app', 'index.html'))).toBe(true);
    // Still nothing in the server's own directory.
    expect(existsSync(join(serverCwd, 'app', 'index.html'))).toBe(false);
  });

  it('an AUTHORIZING request does not silence the ask — that was the deadlock', async () => {
    // "Which folder should I create the app in?" reads to the permission-seeking
    // heuristic like a permission question, and the G13 gate suppresses those
    // when the request already authorized the work. Suppressing it here means the
    // user is never asked, no folder is ever named, and every retry fails for the
    // same reason: the reported "keeps refusing". A missing workspace is a
    // required INPUT, not a decision the model may take on the user's behalf.
    const ctx: ToolContext = {
      configManager: {},
      cwd: serverCwd,
      workspaceUnscoped: true,
      writesAuthorized: { authorized: true, reason: 'the request asked for files' },
    };
    const out = await ask(ctx, { answer: 'Cancel', index: 1, custom: `create it in ${chosen}` });
    expect(String(out)).toContain(`Workspace adopted: '${chosen}'`);
    expect(ctx.cwd).toBe(chosen);
  });

  it('does NOT adopt a path that names a file, or a relative one', async () => {
    const ctx: ToolContext = { configManager: {}, cwd: serverCwd, workspaceUnscoped: true };
    const out = await ask(ctx, { answer: 'Cancel', index: 1, custom: 'the file src/app.ts' });
    expect(String(out)).not.toContain('Workspace adopted');
    expect(ctx.cwd).toBe(serverCwd);
    expect(ctx.workspaceUnscoped).toBe(true);
  });

  it('a SCOPED turn adopts nothing — the reply cannot relocate it', async () => {
    const ctx: ToolContext = { configManager: {}, cwd: chosen };
    const out = await ask(ctx, { answer: 'Cancel', index: 1, custom: `use ${serverCwd}` });
    expect(String(out)).not.toContain('Workspace adopted');
    expect(ctx.cwd).toBe(chosen);
  });
});
