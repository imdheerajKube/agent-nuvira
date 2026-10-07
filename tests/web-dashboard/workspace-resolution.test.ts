/**
 * Cluster G — where a dashboard chat turn's workspace comes from.
 *
 * The rule the server used to answer this with was two lines long (the path the
 * browser posted, else the operator's default, else nothing) and produced three
 * reported failures:
 *
 * 1. "agent keep refusing even after i attach the folder" — the composer only
 *    re-sends `projectPath` from React state, so a reload mid-conversation (or
 *    an attach whose response the UI never got) left the server folder-less
 *    while the CHAT still had one.
 * 2. "as user gives folder either path via chat … we can use it" — the guard
 *    already treated a typed absolute path as specific enough not to ask about,
 *    then discarded it instead of running there.
 * 3. A configured `dashboard.cwd` was indistinguishable, to the model, from the
 *    user's own project.
 *
 * These tests pin the priority order, the notice each source carries, and the
 * conservatism of the message rule — the last one matters most, because a rule
 * that adopts paths too eagerly is the "it went to kuttaaddon" defect again.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  isUsableDirectory,
  normalizeWorkspacePath,
  directoryFromMessage,
  resolveTurnWorkspace,
  formatWorkspaceNoticeText,
  defaultWorkspaceNotice,
} from '../../src/web-dashboard/workspace-resolution.js';

let root: string;
let attached: string;
let sessionDir: string;
let named: string;
let filePath: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'buff-ws-resolution-'));
  attached = join(root, 'attached-app');
  sessionDir = join(root, 'session-app');
  named = join(root, 'named-app');
  for (const d of [attached, sessionDir, named]) mkdirSync(d, { recursive: true });
  // A FILE, to prove a path that names a file is never adopted as a folder.
  filePath = join(root, 'notes.md');
  writeFileSync(filePath, '# notes\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isUsableDirectory', () => {
  it('accepts an existing directory and rejects everything else', () => {
    expect(isUsableDirectory(attached)).toBe(true);
    expect(isUsableDirectory(filePath)).toBe(false);
    expect(isUsableDirectory(join(root, 'nope'))).toBe(false);
    expect(isUsableDirectory(undefined)).toBe(false);
    expect(isUsableDirectory('')).toBe(false);
    expect(isUsableDirectory('   ')).toBe(false);
  });
});

describe('normalizeWorkspacePath', () => {
  it('expands ~ and makes absolute paths absolute', () => {
    expect(normalizeWorkspacePath('~')).toBe(realpathSync(homedir()));
    expect(normalizeWorkspacePath('~/Documents')).toBe(join(realpathSync(homedir()), 'Documents'));
    expect(normalizeWorkspacePath(attached)).toBe(attached);
  });

  it('strips wrapping quotes and rejects what it cannot act on', () => {
    expect(normalizeWorkspacePath(`"${attached}"`)).toBe(attached);
    expect(normalizeWorkspacePath('https://example.com/app')).toBeUndefined();
    expect(normalizeWorkspacePath('src/components')).toBeUndefined();
    expect(normalizeWorkspacePath('')).toBeUndefined();
  });
});

describe('directoryFromMessage — the conservative half', () => {
  it('adopts a folder the user actually named', () => {
    expect(directoryFromMessage(`work in ${named}`)).toBe(named);
    expect(directoryFromMessage(`create the app here ${named} please`)).toBe(named);
    // Trailing sentence punctuation and wrapping quotes are trimmed.
    expect(directoryFromMessage(`use ${named}.`)).toBe(named);
    expect(directoryFromMessage(`"${named}"`)).toBe(named);
  });

  it('refuses to relocate the turn to a FILE the message only mentions', () => {
    // The reported defect this rule exists to prevent: a path in a message is
    // usually a file the user is talking about, and adopting its folder would
    // silently scope the turn to a project nobody chose.
    expect(directoryFromMessage(`fix the bug in ${filePath}`)).toBeUndefined();
  });

  it('never resolves a RELATIVE path — that guess is the kuttaaddon defect', () => {
    expect(directoryFromMessage('create a file in src/components')).toBeUndefined();
    expect(directoryFromMessage('look at ./app')).toBeUndefined();
  });

  it('ignores URLs and empty messages', () => {
    expect(directoryFromMessage('summarise https://example.com/post')).toBeUndefined();
    expect(directoryFromMessage('')).toBeUndefined();
    expect(directoryFromMessage(undefined)).toBeUndefined();
  });
});

describe('resolveTurnWorkspace — the priority order', () => {
  it('the folder the user ATTACHED wins, and carries no notice', () => {
    const r = resolveTurnWorkspace({
      attachedPath: attached,
      sessionPath: sessionDir,
      configuredCwd: root,
      message: `use ${named}`,
    });
    expect(r).toMatchObject({ path: attached, source: 'attached', unscoped: false });
    expect(r.notice).toBeUndefined();
    // Nothing to caption: the user picked this folder themselves.
    expect(formatWorkspaceNoticeText(r)).toBeUndefined();
  });

  it('falls back to the SESSION when the request forgot the path (the refusal bug)', () => {
    const r = resolveTurnWorkspace({ sessionPath: sessionDir, configuredCwd: root });
    expect(r).toMatchObject({ path: sessionDir, source: 'session', unscoped: false });
    expect(r.notice).toMatch(/restored from this conversation/i);
    expect(formatWorkspaceNoticeText(r)).toBe(r.notice);
  });

  it('adopts a folder NAMED IN THE MESSAGE before falling back to the default', () => {
    const r = resolveTurnWorkspace({ configuredCwd: root, message: `create the app in ${named}` });
    expect(r).toMatchObject({ path: named, source: 'message', unscoped: false });
    expect(r.notice).toMatch(/named in their message/i);
  });

  it('the operator DEFAULT is last, and always warns', () => {
    const r = resolveTurnWorkspace({ configuredCwd: root });
    expect(r).toMatchObject({ path: root, source: 'default', unscoped: false });
    expect(r.notice).toBe(defaultWorkspaceNotice(root));
    expect(r.notice).toMatch(/no project folder is attached/i);
    expect(r.notice).toMatch(/default workspace/i);
  });

  it('with nothing at all the turn is UNSCOPED, and says so', () => {
    const r = resolveTurnWorkspace({});
    expect(r).toMatchObject({ source: 'none', unscoped: true });
    expect(r.path).toBeUndefined();
    expect(formatWorkspaceNoticeText(r)).toMatch(/UNSCOPED/);
  });

  it('a candidate that no longer exists is skipped, not crashed on', () => {
    const r = resolveTurnWorkspace({ attachedPath: join(root, 'deleted'), configuredCwd: root });
    expect(r.source).toBe('default');
    const none = resolveTurnWorkspace({ attachedPath: join(root, 'deleted') });
    expect(none.unscoped).toBe(true);
  });
});
