/**
 * `workspaceNeedForMissingFolder` — what an ask needs a folder FOR.
 *
 * The dashboard used to answer "does this ask need a workspace?" with a single
 * yes/no and, on yes, refuse until a folder was attached. That refusal was the
 * reported misery ("agent keep going mad and confused when project folder not
 * attached") for the case it should never have applied to: an ask that wants to
 * CREATE something, which an empty temporary folder serves perfectly. These tests
 * pin the split, both halves of it, and the vetoes that keep a DESCRIPTION of work
 * ("I want to test an agent on … build the application") out of the whole
 * mechanism — the bug that made the first draft of this rule refuse it.
 */

import { describe, it, expect } from 'vitest';

import {
  needsProjectAttachment,
  workspaceNeedForMissingFolder,
} from '../../src/utils/workspace-need.js';

describe('workspaceNeedForMissingFolder — produce', () => {
  it('serves a create ask from a temporary folder', () => {
    expect(workspaceNeedForMissingFolder('create a react app')).toBe('produce');
    expect(workspaceNeedForMissingFolder('write a python script that renames my photos')).toBe('produce');
    expect(workspaceNeedForMissingFolder('generate an image of a lighthouse at dawn')).toBe('produce');
    expect(workspaceNeedForMissingFolder('save this as notes.md')).toBe('produce');
  });

  it('still treats a NAMED path as the caller\'s business (the caller adopts it first)', () => {
    // A path in the message resolves to the `message` source before scratch is
    // ever consulted — so this function must not classify it at all.
    expect(workspaceNeedForMissingFolder('create the app in /Users/me/code/booking')).toBeNull();
    expect(workspaceNeedForMissingFolder('see https://example.com/docs and build that')).toBeNull();
  });
});

describe('workspaceNeedForMissingFolder — read', () => {
  it('keeps the folder prompt for work that must ALREADY exist', () => {
    // An empty scratch folder cannot answer any of these, so a temporary folder
    // would be the silent-wrong-tree defect ("it went to kuttaaddon") again.
    expect(workspaceNeedForMissingFolder('assess this project')).toBe('read');
    expect(workspaceNeedForMissingFolder('review the backend code')).toBe('read');
    expect(workspaceNeedForMissingFolder('fix the bug in src/app.ts')).toBe('read');
    expect(workspaceNeedForMissingFolder('create the project structure for a booking app')).toBe('read');
  });
});

describe('workspaceNeedForMissingFolder — the vetoes', () => {
  it('leaves a prose deliverable alone', () => {
    // The text IS the deliverable: answered in the reply, no folder involved.
    expect(workspaceNeedForMissingFolder('write a poem about the monsoon')).toBeNull();
    expect(workspaceNeedForMissingFolder('write an essay about my village')).toBeNull();
  });

  it('leaves a META ask alone, even when it says "build the application"', () => {
    // The live regression this rule was rewritten for: a capability description
    // containing a producing verb was read as a folder ask.
    expect(
      workspaceNeedForMissingFolder(
        'I want to test an agent on following capability - phased manner planning, testing, ' +
          'documentation, build the application, git and github capability, leveraging skills and tools.',
      ),
    ).toBeNull();
  });

  it('needs nothing for plain chat', () => {
    expect(workspaceNeedForMissingFolder('what is 2 + 2')).toBeNull();
    expect(workspaceNeedForMissingFolder('')).toBeNull();
  });
});

describe('the two halves agree about eligibility', () => {
  it('never reports a need where the guard sees none', () => {
    // `null` from the discriminator must coincide with `needsProjectAttachment`
    // false for the text-shaped asks — otherwise one surface would refuse an ask
    // the other answers, or vice versa.
    const asks = [
      'write a poem about the monsoon',
      'I want to test an agent on planning and build the application',
      'what is 2 + 2',
      'summarise this text in one line',
    ];
    for (const ask of asks) {
      expect(needsProjectAttachment(ask)).toBe(false);
      expect(workspaceNeedForMissingFolder(ask)).toBeNull();
    }
  });

  it('reports a need wherever the guard does', () => {
    const asks = ['assess this project', 'review the backend code', 'write a report to report.md'];
    for (const ask of asks) {
      expect(needsProjectAttachment(ask)).toBe(true);
      expect(workspaceNeedForMissingFolder(ask)).not.toBeNull();
    }
  });

  it('may classify a PRODUCE ask the old guard did not gate — that is the new rung', () => {
    // `needsProjectAttachment('create a react app')` is false: a fresh app can be
    // created without a folder, so the old rule left the turn unscoped and refused
    // at the WRITE (the "agent keep going mad" report). The discriminator is
    // deliberately broader here — 'produce' means "give this a temporary folder"
    // — and never softer: it cannot return null for an ask the guard gates.
    expect(needsProjectAttachment('create a react app')).toBe(false);
    expect(workspaceNeedForMissingFolder('create a react app')).toBe('produce');
  });
});
