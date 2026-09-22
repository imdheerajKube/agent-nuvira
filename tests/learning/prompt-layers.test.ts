/**
 * Session 3 — layered prompt tracing.
 *
 * The prompt audit found the trace stored ONE flat digest of the whole thread,
 * so it could never show whether the stable (system) layer was byte-stable —
 * and the chat preview exposed only 80 chars of the system prompt. These tests
 * pin the splitter that makes prompt-caching reviewable.
 */

import { describe, it, expect } from 'vitest';
import { splitPromptLayers, digestPromptLayers, digestPrompt } from '../../src/learning/prompt-layers.js';

describe('splitPromptLayers — chat thread transport', () => {
  const chatPrompt = [
    '[System]',
    'You are Nuvira. END EVERY RESPONSE by calling suggest_followups.',
    '',
    '[User]',
    '[Project context]\napp.js, style.css',
    '',
    '[User]',
    'add keyboard support to the calculator',
    '',
    '[Assistant]',
    '',
    '[Tool result]',
    'read_file: ...',
  ].join('\n');

  it('separates the system layer', () => {
    const l = splitPromptLayers(chatPrompt);
    expect(l.system).toContain('You are Nuvira');
    expect(l.system).not.toContain('add keyboard support');
  });

  it('treats the LAST user block as the volatile ask', () => {
    const l = splitPromptLayers(chatPrompt);
    expect(l.volatile).toContain('add keyboard support');
    expect(l.volatile).not.toContain('Project context');
  });

  it('puts injected context + history into the context layer', () => {
    const l = splitPromptLayers(chatPrompt);
    expect(l.context).toContain('Project context');
    expect(l.context).toContain('[Tool result]');
    expect(l.context).not.toContain('You are Nuvira');
    expect(l.context).not.toContain('add keyboard support');
  });
});

describe('splitPromptLayers — assembled (orchestrator) transport', () => {
  const assembled = [
    'You are a senior software architect.',
    '',
    '# Project Context',
    'Primary language: typescript',
    '',
    '[Working state — carried from previous turns in THIS project]',
    '• Files changed: app.js',
    '',
    '## Task',
    'Add keyboard support',
    '',
    'Agent: writer',
  ].join('\n');

  it('splits stable / context / volatile on the headings', () => {
    const l = splitPromptLayers(assembled);
    expect(l.system).toContain('senior software architect');
    expect(l.system).not.toContain('Primary language');
    expect(l.context).toContain('Primary language');
    expect(l.context).toContain('Working state');
    expect(l.volatile).toContain('Add keyboard support');
  });
});

describe('splitPromptLayers — robustness', () => {
  it('is empty-safe', () => {
    const l = splitPromptLayers('');
    expect(l).toEqual({ system: '', context: '', volatile: '' });
  });

  it('falls back to a single stable layer for an unknown shape', () => {
    const l = splitPromptLayers('just some prose with no markers at all');
    expect(l.system).toBe('just some prose with no markers at all');
    expect(l.context).toBe('');
    expect(l.volatile).toBe('');
  });
});

describe('digestPromptLayers — the review primitive', () => {
  it('reports sizes and stable digests', () => {
    const layers = splitPromptLayers('[System]\nYou are Nuvira.\n\n[User]\nhi');
    const d = digestPromptLayers(layers);
    expect(d.systemChars).toBe(layers.system.length);
    expect(d.volatileChars).toBe(layers.volatile.length);
    expect(d.systemDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('KEEPS the system digest identical when only the volatile ask changes (cacheable)', () => {
    const a = digestPrompt('[System]\nYou are Nuvira.\n\n[User]\nask one');
    const b = digestPrompt('[System]\nYou are Nuvira.\n\n[User]\nask two');
    expect(a.digests.systemDigest).toBe(b.digests.systemDigest);
    expect(a.digests.volatileDigest).not.toBe(b.digests.volatileDigest);
  });

  it('CHANGES the system digest when the system layer changes (cache-busting)', () => {
    const a = digestPrompt('[System]\nYou are Nuvira.\n\n[User]\nask');
    const b = digestPrompt('[System]\nYou are Nuvira, revised persona.\n\n[User]\nask');
    expect(a.digests.systemDigest).not.toBe(b.digests.systemDigest);
  });

  it('is deterministic', () => {
    const p = '[System]\nS\n\n[User]\nU';
    expect(digestPrompt(p).digests).toEqual(digestPrompt(p).digests);
  });
});
