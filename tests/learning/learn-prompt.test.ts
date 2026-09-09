/**
 * P6a — learn-prompt tests (`tests/learning/learn-prompt.test.ts`).
 *
 * The learn prompt is the AUTHORING CONTRACT for /learn-style skill drafts:
 * it must (a) always instruct a SKILL.md following the bundled-skill
 * standards, (b) never let the agent save directly — the preview card is the
 * gate, (c) name the skill_manage create path explicitly, and (d) carry the
 * user's requested source verbatim when one is given (and fall back to the
 * conversation transcript when not). These tests pin those invariants so the
 * prompt cannot silently drift away from the draft-store flow.
 */

import { describe, it, expect } from 'vitest';

import { AUTHORING_STANDARDS, buildLearnPrompt } from '../../src/learning/learn-prompt.js';

describe('AUTHORING_STANDARDS — the house skill standard', () => {
  it('requires the sandboxed skill id allowlist (^[a-z0-9-]+$)', () => {
    expect(AUTHORING_STANDARDS).toContain('^[a-z0-9-]+$');
  });

  it('requires ordered steps with agent types and dependencies', () => {
    expect(AUTHORING_STANDARDS).toMatch(/## Steps/);
    expect(AUTHORING_STANDARDS).toMatch(/agentType/);
    expect(AUTHORING_STANDARDS).toMatch(/depends on: step N/);
  });

  it('requires parameters and a verification step', () => {
    expect(AUTHORING_STANDARDS).toMatch(/## Parameters/);
    expect(AUTHORING_STANDARDS).toMatch(/verification step/);
  });

  it('covers required_environment_variables frontmatter (secure setup on load)', () => {
    expect(AUTHORING_STANDARDS).toMatch(/required_environment_variables:/);
  });
});

describe('buildLearnPrompt', () => {
  it('defaults to learning from the current conversation when no source is given', () => {
    const prompt = buildLearnPrompt();
    expect(prompt).toMatch(/THIS conversation/);
    expect(prompt).toMatch(/transcript/);
  });

  it('carries the requested source verbatim (URLs, dirs, descriptions)', () => {
    const prompt = buildLearnPrompt('https://docs.example.com/api/quickstart');
    expect(prompt).toContain('https://docs.example.com/api/quickstart');
    const prompt2 = buildLearnPrompt('the release checklist we just walked through');
    expect(prompt2).toContain('the release checklist we just walked through');
  });

  it('never lets the agent save directly — the preview card is the gate', () => {
    const prompt = buildLearnPrompt('some workflow');
    // The skill_manage create path is named as the ONLY save mechanism.
    expect(prompt).toMatch(/action: create/);
    expect(prompt).toMatch(/preview card/);
    // And the direct-save prohibition is explicit.
    expect(prompt).toMatch(/Do NOT save anything yourself/);
  });

  it('always includes the authoring standards block', () => {
    const prompt = buildLearnPrompt('x');
    expect(prompt).toContain(AUTHORING_STANDARDS);
  });

  it('treats whitespace-only requests as no-source (conversation default)', () => {
    const prompt = buildLearnPrompt('   \n\t  ');
    expect(prompt).toMatch(/THIS conversation/);
  });
});
