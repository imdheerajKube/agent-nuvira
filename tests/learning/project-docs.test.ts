/**
 * Project documentation contract for SOFTWARE deliverables.
 *
 * The two invariants worth pinning: the guidance is proportionate (a README +
 * CHANGELOG always, heavier docs only when the shape warrants) and it NEVER
 * applies to an authored ask — a poem must not be handed a CHANGELOG.
 */

import { describe, it, expect } from 'vitest';
import {
  PROJECT_DOC_ARTIFACTS,
  requiredProjectDocs,
  missingProjectDocs,
  existingProjectDocs,
  softwareProjectGuidance,
  looksLikeLibraryOrService,
} from '../../src/learning/project-docs.js';

describe('requiredProjectDocs', () => {
  it('asks every software project for a README and a CHANGELOG', () => {
    expect(requiredProjectDocs()).toEqual(['README.md', 'CHANGELOG.md']);
  });

  it('does not demand an architecture diagram of a one-file script', () => {
    expect(requiredProjectDocs({})).not.toContain('ARCHITECTURE.md');
  });

  it('adds the heavier docs for a greenfield or consumed-surface build', () => {
    expect(requiredProjectDocs({ greenfield: true })).toContain('ARCHITECTURE.md');
    expect(requiredProjectDocs({ isLibraryOrService: true })).toEqual(
      expect.arrayContaining(['ARCHITECTURE.md', 'docs/api.md', 'docs/usage.md']),
    );
    expect(requiredProjectDocs({ docsRequested: true })).toContain('docs/api.md');
    expect(requiredProjectDocs({ hasTests: true })).toContain('CONTRIBUTING.md');
  });

  it('never lists a path twice', () => {
    const docs = requiredProjectDocs({ greenfield: true, isLibraryOrService: true, docsRequested: true, hasTests: true });
    expect(new Set(docs).size).toBe(docs.length);
  });
});

describe('missing / existing split (update in place, never duplicate)', () => {
  it('splits required docs by what is already on disk', () => {
    const shape = { isLibraryOrService: true, existingDocs: ['README.md', 'docs/api.md'] };
    expect(missingProjectDocs(shape)).toContain('CHANGELOG.md');
    expect(missingProjectDocs(shape)).not.toContain('README.md');
    expect(existingProjectDocs(shape)).toEqual(expect.arrayContaining(['README.md', 'docs/api.md']));
  });

  it('normalises a leading ./ before comparing', () => {
    expect(missingProjectDocs({ existingDocs: ['./README.md'] })).not.toContain('README.md');
  });
});

describe('softwareProjectGuidance', () => {
  it('returns nothing for an authored ask (never a README/CHANGELOG for a poem)', () => {
    expect(softwareProjectGuidance('creative', true)).toBe('');
    expect(softwareProjectGuidance('document', true)).toBe('');
    // Even if a caller mislabels the class, `authored` alone vetoes it.
    expect(softwareProjectGuidance('code', true)).toBe('');
  });

  it('returns nothing for non-code deliverables', () => {
    for (const cls of ['document', 'creative', 'data', 'research']) {
      expect(softwareProjectGuidance(cls, false), cls).toBe('');
    }
  });

  it('names the files to create and to update', () => {
    const text = softwareProjectGuidance('code', false, {
      greenfield: true,
      isLibraryOrService: true,
      existingDocs: ['README.md'],
    });
    expect(text).toMatch(/PROJECT DOCUMENTATION/);
    expect(text).toMatch(/`CHANGELOG\.md`/);
    expect(text).toMatch(/`ARCHITECTURE\.md`/);
    // README already exists → it belongs in the UPDATE list, not the CREATE list.
    expect(text).toMatch(/Update IN PLACE/);
    expect(text).toMatch(/duplicate CHANGELOG/);
  });

  it('never invents a file the plan did not build', () => {
    const text = softwareProjectGuidance('code', false, {});
    expect(text).toMatch(/never invent features/);
  });
});

describe('looksLikeLibraryOrService', () => {
  it('recognises consumed surfaces', () => {
    for (const goal of [
      'build a small npm package for retries',
      'create a Rust library for parsing dates',
      'implement a CLI tool',
      'add an HTTP API service',
    ]) {
      expect(looksLikeLibraryOrService(goal), goal).toBe(true);
    }
  });

  it('does not classify an end-user app as a consumed surface', () => {
    for (const goal of ['build a website', 'make a mobile app', 'write a game']) {
      expect(looksLikeLibraryOrService(goal), goal).toBe(false);
    }
  });
});

describe('PROJECT_DOC_ARTIFACTS', () => {
  it('pairs every path with a purpose (a document without a job is filler)', () => {
    for (const a of PROJECT_DOC_ARTIFACTS) {
      expect(a.path).toBeTruthy();
      expect(a.purpose.length).toBeGreaterThan(10);
    }
  });
});
