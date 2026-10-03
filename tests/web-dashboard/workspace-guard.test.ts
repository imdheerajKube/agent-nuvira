/**
 * Workspace guard — when must an unattached chat turn ask for a folder?
 *
 * The rule is the whole feature, and it is a NARROW one: the dashboard used to
 * run an unattached turn in the server process's own directory, so
 * "assess this project" listed whatever checkout happened to sit there and
 * reported on it. These tests pin BOTH halves — the asks that must be gated, and
 * the ordinary chat that must NOT be (a guard that fires on "write a haiku"
 * would be worse than the bug it fixes).
 */

import { describe, it, expect } from 'vitest';
import {
  needsProjectAttachment,
  projectAttachmentPrompt,
  projectAttachmentFollowups,
} from '../../src/web-dashboard/workspace-guard.js';

describe('needsProjectAttachment — asks that need a workspace', () => {
  it('gates the phrase that started this: "assess this project"', () => {
    expect(needsProjectAttachment('assess this project')).toBe(true);
    expect(needsProjectAttachment("what's the current status of this project")).toBe(true);
    expect(needsProjectAttachment('review the repository')).toBe(true);
    expect(needsProjectAttachment('summarise the codebase')).toBe(true);
  });

  it('gates file-producing asks even when they never say "project"', () => {
    expect(needsProjectAttachment('create a file with the results')).toBe(true);
    expect(needsProjectAttachment('write a python script that renames the files')).toBe(true);
    expect(needsProjectAttachment('add a new component to the app')).toBe(true);
    expect(needsProjectAttachment('update the readme')).toBe(true);
  });

  it('gates media generation', () => {
    expect(needsProjectAttachment('generate an image of a sunset')).toBe(true);
    expect(needsProjectAttachment('create a logo for my startup')).toBe(true);
    expect(needsProjectAttachment('make a diagram of the flow')).toBe(true);
  });

  it('gates project work that names a project-ish noun', () => {
    expect(needsProjectAttachment('refactor the backend')).toBe(true);
    expect(needsProjectAttachment('debug the server')).toBe(true);
    expect(needsProjectAttachment('run the tests')).toBe(true);
  });
});

describe('needsProjectAttachment — ordinary chat stays ungated', () => {
  it('lets general questions through', () => {
    expect(needsProjectAttachment('what is a monad?')).toBe(false);
    expect(needsProjectAttachment('explain how TCP handshakes work')).toBe(false);
    expect(needsProjectAttachment('what is 2 + 2')).toBe(false);
    expect(needsProjectAttachment('tell me a joke')).toBe(false);
  });

  it('lets an empty or whitespace message through (nothing to gate)', () => {
    expect(needsProjectAttachment('')).toBe(false);
    expect(needsProjectAttachment('   ')).toBe(false);
  });

  it('does not gate an ask that names its own subject', () => {
    // A URL or an absolute path IS the subject — asking to "attach a folder"
    // would be noise the user cannot act on.
    expect(needsProjectAttachment('summarise https://example.com/post')).toBe(false);
    expect(needsProjectAttachment('review the file /Users/me/app/src/index.ts')).toBe(false);
    expect(needsProjectAttachment('what does ~/.nuviraconfig.json do?')).toBe(false);
  });
});

describe('the refusal itself', () => {
  it('names the failure and gives the two ways forward', () => {
    const text = projectAttachmentPrompt();
    expect(text).toMatch(/folder/i);
    expect(text).toMatch(/attach/i);
    // It must not pretend to answer — a refusal that reads like an answer is the
    // original bug wearing a different hat.
    expect(text).toMatch(/will not/i);
  });

  it('offers a real next action, not filler', () => {
    const followups = projectAttachmentFollowups();
    expect(followups.length).toBeGreaterThan(0);
    for (const f of followups) {
      expect(f.prompt.length).toBeGreaterThan(0);
      expect(f.label.length).toBeGreaterThan(0);
    }
  });
});
